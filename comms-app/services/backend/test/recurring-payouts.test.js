// Recurring affiliate payouts, part one: the share rates and payout settings
// the owner sets from the admin dashboard, the migration that seeds them with
// what was paid before, both share recorders reading them, the overview of
// what live subscriptions will pay, and the administrator gate on every new
// route. Real services and the real admin router, against PGlite.
// (recurring-payout-statements.test.js has the monthly statements.)

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";

// env.js reads the environment when it is first imported.
process.env.JWT_SECRET ||= "recurring-payouts-test-secret-at-least-32-bytes";

const { db } = await import("../src/config/db.js");
const { issueAdminAccessToken } = await import("../src/services/auth.service.js");
const { grantProductEntitlement, revokeProductEntitlement } = await import("../src/services/entitlement.service.js");
const referral = await import("../src/services/referrals/referral.service.js");
const { DEFAULT_SHARE_RATE_BPS, shareCentsAt } = await import("../src/services/referrals/shareRates.js");
const { nextPayoutRun } = await import("../src/services/referrals/recurringPayouts.service.js");
const { up: migrateUp } = await import("../src/db/migrations/20260929_recurring_affiliate_payouts.js");
const { adminRouter } = await import("../src/routes/admin.routes.js");
const { DAY, makePeople, startAdminPayoutsApp } = await import("./helpers/admin-payouts-app.js");

const SYNC = "tabforge-subscription";
const PICKUP = "forgedrop-cloud-pickup";
// What the recorders paid before the rate could be set.
const FIVE_PERCENT = (paid) => Math.max(1, Math.round(paid * 0.05));
const AMOUNTS = [1, 9, 230, 250, 500, 999, 1000, 1500, 2500, 12345];

let app;
let person;
const beforeMigration = [];

before(async () => {
  app = await startAdminPayoutsApp({ db, adminRouter, issueAdminAccessToken });
  person = makePeople({
    db,
    grantProductEntitlement,
    ensureAffiliateReferralCode: referral.ensureAffiliateReferralCode,
    cashAppTagKey: referral.cashAppTagKey,
  });

  // Shares recorded while the settings tables do not exist yet: what runs
  // between this deploy and the migration.
  const ada = await person("ada", { owns: ["tabforge"], affiliate: true, cashApp: "$ada" });
  for (const cents of AMOUNTS) {
    const sam = await person("sam", { referredBy: ada });
    beforeMigration.push({
      cents,
      sync: await referral.recordSyncSubscriptionShare({ subscriberUserId: sam.id, invoiceRef: `in_pre_sync_${cents}`, netPaidCents: cents }),
      pickup: await referral.recordCloudPickupShare({ subscriberUserId: sam.id, invoiceRef: `in_pre_pickup_${cents}`, netPaidCents: cents }),
    });
  }

  await migrateUp(db);
});

after(async () => {
  await app?.stop();
});

const audits = (action) => db("admin_audit_log").where({ action }).orderBy("created_at", "asc");

test("the migration seeds every programme at 5% and on, and shares pay exactly what they paid before", async () => {
  assert.deepEqual(
    (await db("subscription_share_programs").orderBy("program_slug")).map((row) => [row.program_slug, row.label, row.rate_bps, row.enabled]),
    [
      [PICKUP, "ForgeDrop Cloud pickup", 500, true],
      [SYNC, "TabForge Private Sync", 500, true],
    ]
  );
  assert.deepEqual(
    (await db("affiliate_payout_settings")).map((row) => [row.id, row.minimum_payout_cents, row.payout_day]),
    [["default", 0, 15]]
  );
  assert.equal(DEFAULT_SHARE_RATE_BPS / 10000, referral.SYNC_SHARE_RATE);
  assert.equal(DEFAULT_SHARE_RATE_BPS / 10000, referral.CLOUD_PICKUP_SHARE_RATE);

  // Before the migration: no tables, the same 5%.
  for (const { cents, sync, pickup } of beforeMigration) {
    for (const result of [sync, pickup]) {
      assert.equal(result.recorded, true, result.reason);
      assert.equal(result.amountCents, FIVE_PERCENT(cents), `${cents} cents`);
      assert.equal(result.reward.reward_amount_cents, FIVE_PERCENT(cents));
      assert.deepEqual(
        [result.reward.metadata.share_rate, result.reward.metadata.share_rate_bps, result.reward.metadata.share_rate_source],
        [0.05, 500, "default"]
      );
    }
  }

  // After it, from its rows.
  const bea = await person("bea", { owns: ["tabforge"], affiliate: true, cashApp: "$bea" });
  for (const cents of AMOUNTS) {
    const sid = await person("sid", { referredBy: bea });
    const sync = await referral.recordSyncSubscriptionShare({ subscriberUserId: sid.id, invoiceRef: `in_post_sync_${cents}`, netPaidCents: cents });
    const pickup = await referral.recordCloudPickupShare({ subscriberUserId: sid.id, invoiceRef: `in_post_pickup_${cents}`, netPaidCents: cents });
    for (const result of [sync, pickup]) {
      assert.equal(result.amountCents, FIVE_PERCENT(cents), `${cents} cents`);
      assert.deepEqual(
        [result.reward.metadata.share_rate, result.reward.metadata.share_rate_bps, result.reward.metadata.share_rate_source],
        [0.05, 500, "program"]
      );
      assert.ok(Date.parse(result.reward.metadata.invoice_paid_at), "the month the share belongs to is recorded");
    }
  }

  // The arithmetic, for every price up to $1,000, and the helpers the tests
  // and callers already use.
  const differs = [];
  for (let paid = 1; paid <= 100000; paid += 1) if (shareCentsAt(paid, 500) !== FIVE_PERCENT(paid)) differs.push(paid);
  assert.deepEqual(differs, []);
  assert.deepEqual([500, 1000, 1500, 2500].map(referral.cloudPickupShareCents), [25, 50, 75, 125]);
  assert.deepEqual([500, 250, 230, 1, 0].map(referral.syncShareCents), [25, 13, 12, 1, 0]);

  // Running it again changes nothing, and never resets what the owner set.
  await db("subscription_share_programs").where({ program_slug: SYNC }).update({ rate_bps: 700, enabled: false });
  await db("affiliate_payout_settings").update({ minimum_payout_cents: 1000, payout_day: 3 });
  await migrateUp(db);
  assert.deepEqual(
    [await db("subscription_share_programs").where({ program_slug: SYNC }).first()].map((row) => [row.rate_bps, row.enabled]),
    [[700, false]]
  );
  assert.deepEqual(
    (await db("affiliate_payout_settings")).map((row) => [row.minimum_payout_cents, row.payout_day]),
    [[1000, 3]]
  );
  await db("subscription_share_programs").where({ program_slug: SYNC }).update({ rate_bps: 500, enabled: true });
  await db("affiliate_payout_settings").update({ minimum_payout_cents: 0, payout_day: 15 });
});

test("both recorders read the rate: an affiliate's own wins, 0 records nothing, and off is off for everyone", async () => {
  const mia = await person("mia", { owns: ["tabforge"], affiliate: true, cashApp: "$mia" });
  const lee = await person("lee", { owns: ["tabforge"], affiliate: true, cashApp: "$lee" });
  const zed = await person("zed", { owns: ["tabforge"], affiliate: true, cashApp: "$zed" });
  const [ofMia, ofLee, ofZed] = [await person("m", { referredBy: mia }), await person("l", { referredBy: lee }), await person("z", { referredBy: zed })];
  const sync = (subscriber, invoice, cents = 1000) =>
    referral.recordSyncSubscriptionShare({ subscriberUserId: subscriber.id, invoiceRef: invoice, netPaidCents: cents, metadata: { stripe_invoice_id: invoice } });
  const pickup = (subscriber, invoice, cents = 1000) =>
    referral.recordCloudPickupShare({ subscriberUserId: subscriber.id, invoiceRef: invoice, netPaidCents: cents, metadata: { stripe_invoice_id: invoice } });
  const rate = (row) => [row.reward_amount_cents, row.metadata.share_rate, row.metadata.share_rate_bps, row.metadata.share_rate_source];

  try {
    // As the dashboard sets them.
    assert.equal((await app.api("PATCH", `/recurring-payouts/programs/${SYNC}`, { rateBps: 750 })).code, 200);
    assert.equal((await app.api("PATCH", `/recurring-payouts/programs/${PICKUP}`, { rateBps: 1200 })).code, 200);
    for (const [who, program, rateBps] of [[lee, SYNC, 1000], [lee, PICKUP, 300], [zed, SYNC, 0], [zed, PICKUP, 0]]) {
      const set = await app.api("PUT", "/recurring-payouts/overrides", { userId: who.id, programSlug: program, rateBps });
      assert.equal(set.code, 200, JSON.stringify(set.body));
    }

    // The programme's rate, then an affiliate's own, for each recorder.
    assert.deepEqual(rate((await sync(ofMia, "in_mia_1")).reward), [75, 0.075, 750, "program"]);
    assert.deepEqual(rate((await sync(ofLee, "in_lee_1")).reward), [100, 0.1, 1000, "override"]);
    assert.deepEqual(rate((await pickup(ofMia, "in_mia_p1")).reward), [120, 0.12, 1200, "program"]);
    assert.deepEqual(rate((await pickup(ofLee, "in_lee_p1")).reward), [30, 0.03, 300, "override"]);

    // 0 for one affiliate: nothing is recorded, on either programme.
    assert.deepEqual(await sync(ofZed, "in_zed_1"), { recorded: false, reason: "share_rate_zero" });
    assert.deepEqual(await pickup(ofZed, "in_zed_p1"), { recorded: false, reason: "share_rate_zero" });
    assert.equal((await db("reward_queue").where({ user_id: zed.id })).length, 0);

    // Off stops the programme for everyone, an affiliate's own rate included,
    // and leaves the other programme alone.
    assert.equal((await app.api("PATCH", `/recurring-payouts/programs/${SYNC}`, { enabled: false })).code, 200);
    assert.deepEqual(await sync(ofMia, "in_mia_2"), { recorded: false, reason: "share_program_off" });
    assert.deepEqual(await sync(ofLee, "in_lee_2"), { recorded: false, reason: "share_program_off" });
    assert.equal((await pickup(ofMia, "in_mia_p2")).recorded, true);

    // One row per invoice still: a replay is dropped, and keeps the rate it was paid at.
    assert.equal((await app.api("PATCH", `/recurring-payouts/programs/${SYNC}`, { enabled: true, rateBps: 900 })).code, 200);
    assert.deepEqual(await sync(ofMia, "in_mia_1"), { recorded: false, reason: "duplicate_invoice" });
    assert.deepEqual(rate(await db("reward_queue").where({ reward_key: "sync_share:in_mia_1" }).first()), [75, 0.075, 750, "program"]);
    assert.deepEqual(rate((await sync(ofMia, "in_mia_3")).reward), [90, 0.09, 900, "program"]);

    // Clearing an affiliate's rate puts them back on the programme's.
    const cleared = await app.api("DELETE", `/recurring-payouts/overrides/${lee.id}/${SYNC}`);
    assert.equal(cleared.code, 200, JSON.stringify(cleared.body));
    assert.deepEqual(
      cleared.body.programs.map((entry) => [entry.slug, entry.rateBps, entry.rateSource, entry.overrideBps]),
      [[SYNC, 900, "program", null], [PICKUP, 300, "override", 300]]
    );
    assert.deepEqual(rate((await sync(ofLee, "in_lee_3")).reward), [90, 0.09, 900, "program"]);
  } finally {
    await app.api("PATCH", `/recurring-payouts/programs/${SYNC}`, { rateBps: 500, enabled: true });
    await app.api("PATCH", `/recurring-payouts/programs/${PICKUP}`, { rateBps: 500, enabled: true });
  }

  // Every change is in the audit log, with what it was before.
  const programAudits = await audits("recurring_payout.program.update");
  assert.ok(programAudits.length >= 4);
  const firstSync = programAudits.find((row) => row.resource_id === SYNC);
  assert.deepEqual([firstSync.before_value.rate_bps, firstSync.after_value.rate_bps], [500, 750]);
  assert.equal(firstSync.admin_email, "zadockplant@gmail.com");
  const overrideAudits = await audits("recurring_payout.override.set");
  assert.deepEqual(
    overrideAudits.filter((row) => row.resource_id.startsWith(lee.id)).map((row) => [row.resource_id, row.before_value, row.after_value.rate_bps]),
    [[`${lee.id}:${SYNC}`, null, 1000], [`${lee.id}:${PICKUP}`, null, 300]]
  );
  const clearAudits = await audits("recurring_payout.override.clear");
  assert.deepEqual(clearAudits.map((row) => [row.resource_id, row.before_value.rate_bps, row.after_value]), [[`${lee.id}:${SYNC}`, 1000, null]]);
});

test("the settings the dashboard reads and writes, and what they refuse", async () => {
  const read = await app.api("GET", "/recurring-payouts/settings");
  assert.equal(read.code, 200);
  assert.equal(read.body.ready, true);
  assert.deepEqual(
    read.body.programs.map((program) => [program.slug, program.label, program.rateBps, program.enabled]),
    [[SYNC, "TabForge Private Sync", 500, true], [PICKUP, "ForgeDrop Cloud pickup", 500, true]]
  );
  assert.deepEqual(read.body.payout.minimumPayoutCents, 0);
  assert.deepEqual(read.body.payout.payoutDay, 15);
  assert.deepEqual(
    [read.body.payout.nextRunDate, read.body.payout.nextRunPaysMonth],
    Object.values(nextPayoutRun(15, new Date()))
  );
  assert.ok(Array.isArray(read.body.overrides));

  // The next run: on the day, or the same day next month once it has passed,
  // and it pays the month before it.
  assert.deepEqual(nextPayoutRun(15, new Date("2026-09-15T23:00:00Z")), { date: "2026-09-15", paysMonth: "2026-08" });
  assert.deepEqual(nextPayoutRun(15, new Date("2026-09-16T00:00:00Z")), { date: "2026-10-15", paysMonth: "2026-09" });
  assert.deepEqual(nextPayoutRun(1, new Date("2026-12-02T00:00:00Z")), { date: "2027-01-01", paysMonth: "2026-12" });

  assert.deepEqual((await app.api("PATCH", "/recurring-payouts/programs/not-a-programme", { rateBps: 500 })).body, { error: "unknown_share_program" });
  assert.equal((await app.api("PATCH", `/recurring-payouts/programs/${SYNC}`, { rateBps: 10001 })).code, 400);
  assert.equal((await app.api("PATCH", `/recurring-payouts/programs/${SYNC}`, { rateBps: 2.5 })).code, 400, "basis points are whole");
  assert.equal((await app.api("PATCH", `/recurring-payouts/programs/${SYNC}`, {})).code, 400);
  assert.equal((await app.api("PUT", "/recurring-payouts/payout-settings", { payoutDay: 29 })).code, 400, "every month has the day");
  assert.equal((await app.api("PUT", "/recurring-payouts/payout-settings", { minimumPayoutCents: -1 })).code, 400);

  const saved = await app.api("PUT", "/recurring-payouts/payout-settings", { minimumPayoutCents: 500, payoutDay: 5 });
  assert.equal(saved.code, 200);
  assert.equal(saved.body.changed, true);
  assert.deepEqual([saved.body.payout.minimumPayoutCents, saved.body.payout.payoutDay, saved.body.payout.nextRunDate], [500, 5, nextPayoutRun(5, new Date()).date]);
  // Saving what is already saved writes nothing, and audits nothing.
  const before = (await audits("recurring_payout.settings.update")).length;
  const again = await app.api("PUT", "/recurring-payouts/payout-settings", { minimumPayoutCents: 500 });
  assert.equal(again.body.changed, false);
  assert.equal((await audits("recurring_payout.settings.update")).length, before);
  const [audit] = (await audits("recurring_payout.settings.update")).slice(-1);
  assert.deepEqual([audit.before_value.minimum_payout_cents, audit.after_value.minimum_payout_cents, audit.after_value.payout_day], [0, 500, 5]);
  assert.equal((await app.api("PUT", "/recurring-payouts/payout-settings", { minimumPayoutCents: 0, payoutDay: 15 })).body.changed, true);

  // Finding an affiliate, by email or by referral code.
  const kit = await person("kit", { affiliate: true, cashApp: "$kit", claimed: false });
  await person("kits-customer", { referredBy: kit });
  const byEmail = await app.api("GET", `/recurring-payouts/affiliates/find?q=${encodeURIComponent(kit.email.toUpperCase())}`);
  assert.equal(byEmail.code, 200, JSON.stringify(byEmail.body));
  assert.deepEqual(
    [byEmail.body.affiliate.email, byEmail.body.affiliate.cashAppTag, byEmail.body.affiliate.cashAppTagClaimed, byEmail.body.referredAccounts],
    [kit.email, "$kit", false, 1]
  );
  assert.deepEqual(
    byEmail.body.programs.map((program) => [program.slug, program.rateBps, program.rateSource, program.eligible]),
    [[SYNC, 500, "program", false], [PICKUP, 500, "program", true]],
    "an affiliate without TabForge Pro is not paid on Private Sync"
  );
  const byCode = await app.api("GET", `/recurring-payouts/affiliates/find?q=${kit.code.code.toLowerCase()}`);
  assert.equal(byCode.body.affiliate.userId, kit.id);
  assert.equal((await app.api("GET", "/recurring-payouts/affiliates/find?q=nobody%40example.com")).code, 404);
  assert.equal((await app.api("GET", "/recurring-payouts/affiliates/find?q=")).code, 400);
  assert.equal((await app.api("PUT", "/recurring-payouts/overrides", { userId: randomUUID(), programSlug: SYNC, rateBps: 100 })).code, 404);
});

test("the overview: each affiliate's live subscriptions, and the share they will pay each month at today's rate", async () => {
  const ann = await person("ann", { owns: ["tabforge"], affiliate: true, cashApp: "$ann" });
  const bob = await person("bob", { owns: ["tabforge"], cashApp: "$bob" });
  const monthly = (cents, interval = "month") => [{ price: { unit_amount: cents, recurring: { interval, interval_count: 1 } }, quantity: 1 }];
  async function subscribed(affiliate, plan, status, raw = {}) {
    const customer = await person("subscriber", { referredBy: affiliate });
    await db("subscriptions").insert({
      id: randomUUID(),
      user_id: customer.id,
      provider: "stripe",
      provider_subscription_id: `sub_${randomUUID()}`,
      plan,
      status,
      current_period_end: new Date(Date.now() + 20 * DAY),
      raw,
    });
    return customer;
  }

  // Ann: Private Sync at her own 10%, Cloud pickup at the programme's 5%.
  await app.api("PUT", "/recurring-payouts/overrides", { userId: ann.id, programSlug: SYNC, rateBps: 1000 });
  await subscribed(ann, "tabforge_private_sync", "active", { items: { data: monthly(500) } });
  await subscribed(ann, "tabforge_private_sync", "past_due", { items: { data: monthly(500) } });
  await subscribed(ann, "tabforge_private_sync", "active", { items: { data: monthly(6000, "year") } });
  await subscribed(ann, "tabforge_private_sync", "trialing", {}); // no items: the $5 list price
  await subscribed(ann, "tabforge_private_sync", "canceled", { items: { data: monthly(500) } });
  await subscribed(ann, "forgedrop_cloud_pickup", "active", { metadata: { tier: "250gb" }, items: { data: monthly(1000) } });
  await subscribed(ann, "forgedrop_cloud_pickup", "active", { metadata: { tier: "1tb" }, cancel_at_period_end: true });
  // Bob: owns Pro but is no ForgeDrop affiliate, so Cloud pickup pays him nothing.
  await subscribed(bob, "tabforge_private_sync", "active", { items: { data: monthly(500) } });
  await subscribed(bob, "forgedrop_cloud_pickup", "active", { metadata: { tier: "500gb" } });
  await subscribed(bob, "rts_subscription", "active", { items: { data: monthly(900) } });
  // Nobody above them, or themselves: no one is owed anything.
  const loner = await person("loner");
  await db("subscriptions").insert({ id: randomUUID(), user_id: loner.id, plan: "tabforge_private_sync", status: "active", raw: {} });
  const self = await person("self");
  await db("users").where({ id: self.id }).update({ referred_by_user_id: self.id });
  await db("subscriptions").insert({ id: randomUUID(), user_id: self.id, plan: "tabforge_private_sync", status: "active", raw: {} });

  const overview = await app.api("GET", "/recurring-payouts/overview");
  assert.equal(overview.code, 200, JSON.stringify(overview.body));
  const mine = overview.body.affiliates.filter((row) => [ann.id, bob.id].includes(row.userId));
  assert.deepEqual(mine.map((row) => [row.email, row.cashAppTag, row.expectedMonthlyShareCents]), [[ann.email, "$ann", 200], [bob.email, "$bob", 25]]);
  const [annRow, bobRow] = mine;
  assert.deepEqual(
    annRow.programs.map((p) => [p.slug, p.eligible, p.rateBps, p.rateSource, p.payingSubscriptions, p.trialSubscriptions, p.endingSubscriptions, p.monthlyRevenueCents, p.expectedMonthlyShareCents, p.afterTrialsShareCents]),
    [
      [SYNC, true, 1000, "override", 3, 1, 0, 1500, 150, 50],
      [PICKUP, true, 500, "program", 1, 0, 1, 1000, 50, 0],
    ]
  );
  assert.deepEqual(
    annRow.programs[1].subscribers.map((row) => [row.tier, row.monthlyCents, row.ending, row.shareCents]).sort(),
    [["1 TB", 2500, true, 0], ["250 GB", 1000, false, 50]]
  );
  assert.deepEqual(
    bobRow.programs.map((p) => [p.slug, p.eligible, p.payingSubscriptions, p.monthlyRevenueCents, p.expectedMonthlyShareCents]),
    [[SYNC, true, 1, 500, 25], [PICKUP, false, 1, 1500, 0]]
  );
  assert.ok(!overview.body.affiliates.some((row) => [loner.id, self.id].includes(row.userId)));

  // At today's rate: back on the programme's 5%, Ann's Private Sync halves.
  await app.api("DELETE", `/recurring-payouts/overrides/${ann.id}/${SYNC}`);
  const later = await app.api("GET", "/recurring-payouts/overview");
  assert.equal(later.body.affiliates.find((row) => row.userId === ann.id).expectedMonthlyShareCents, 75 + 50);
});

test("a Private Sync or Cloud pickup share can be approved, each behind its own programme's gate", async () => {
  const cy = await person("cy", { owns: ["tabforge"], affiliate: true, cashApp: "$cy" });
  const sue = await person("sue", { referredBy: cy });
  const waited = async (result) => {
    assert.equal(result.recorded, true, result.reason);
    await db("reward_queue").where({ id: result.reward.id }).update({ created_at: new Date(Date.now() - 11 * DAY) });
    return result.reward;
  };
  const syncShare = await waited(await referral.recordSyncSubscriptionShare({ subscriberUserId: sue.id, invoiceRef: "in_sue_sync", netPaidCents: 500 }));
  const pickupShare = await waited(await referral.recordCloudPickupShare({ subscriberUserId: sue.id, invoiceRef: "in_sue_pickup", netPaidCents: 1000 }));
  assert.ok(referral.isSubscriptionShareReward(syncShare) && referral.isSubscriptionShareReward(pickupShare));

  for (const share of [syncShare, pickupShare]) {
    const approved = await app.api("PATCH", `/rewards/${share.id}`, { status: "approved" });
    assert.equal(approved.code, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.item.status, "approved");
  }

  // The owner sets Cy to earn nothing on ForgeDrop: below the affiliate level,
  // so a Cloud pickup share cannot be paid, and the refusal says so.
  const later = await waited(await referral.recordCloudPickupShare({ subscriberUserId: sue.id, invoiceRef: "in_sue_pickup_2", netPaidCents: 1000 }));
  await referral.setReferralTerms(cy.code, { flatRates: { forgedrop: 0 } });
  const refused = await app.api("PATCH", `/rewards/${later.id}`, { status: "approved" });
  assert.deepEqual([refused.code, refused.body.error], [409, "referrer_not_forgedrop_affiliate"]);
  // Private Sync still asks for TabForge Pro.
  const syncLater = await waited(await referral.recordSyncSubscriptionShare({ subscriberUserId: sue.id, invoiceRef: "in_sue_sync_2", netPaidCents: 500 }));
  await revokeProductEntitlement(cy.id, "tabforge");
  const noPro = await app.api("PATCH", `/rewards/${syncLater.id}`, { status: "approved" });
  assert.deepEqual([noPro.code, noPro.body.error], [409, "referrer_tabforge_pro_required"]);
});

test("every new route is the administrator's alone", async () => {
  const outsider = await person("outsider");
  const outsiderToken = issueAdminAccessToken({ id: outsider.id, email: outsider.email });
  const someone = randomUUID();
  const routes = [
    ["GET", "/recurring-payouts/settings"],
    ["PATCH", `/recurring-payouts/programs/${SYNC}`, { rateBps: 100 }],
    ["PUT", "/recurring-payouts/payout-settings", { payoutDay: 3 }],
    ["GET", "/recurring-payouts/affiliates/find?q=a%40b.c"],
    ["PUT", "/recurring-payouts/overrides", { userId: someone, programSlug: SYNC, rateBps: 0 }],
    ["DELETE", `/recurring-payouts/overrides/${someone}/${SYNC}`],
    ["GET", "/recurring-payouts/statements"],
    ["POST", `/recurring-payouts/statements/2026-08/${someone}/approve`],
    ["POST", `/recurring-payouts/statements/2026-08/${someone}/pay`, { payoutReference: "x" }],
    ["POST", `/recurring-payouts/statements/2026-08/${someone}/reject`, { note: "x" }],
    ["GET", "/recurring-payouts/overview"],
  ];
  for (const [method, path, body] of routes) {
    assert.deepEqual(await app.api(method, path, body, null), { code: 401, body: { error: "missing_admin_token" } }, `${method} ${path}`);
    assert.deepEqual(await app.api(method, path, body, "not-a-token"), { code: 401, body: { error: "invalid_admin_token" } }, `${method} ${path}`);
    assert.deepEqual(await app.api(method, path, body, outsiderToken), { code: 403, body: { error: "admin_not_allowed" } }, `${method} ${path}`);
  }

  // Writes stop when admin writes are switched off; reading goes on.
  process.env.ADMIN_WRITES_ENABLED = "false";
  try {
    for (const [method, path, body] of routes) {
      const result = await app.api(method, path, body);
      if (method === "GET") assert.notEqual(result.code, 423, `${method} ${path}`);
      else assert.deepEqual(result, { code: 423, body: { error: "admin_writes_disabled" } }, `${method} ${path}`);
    }
  } finally {
    delete process.env.ADMIN_WRITES_ENABLED;
  }
  assert.equal((await db("subscription_share_programs").where({ program_slug: SYNC }).first()).rate_bps, 500, "nothing was written");

  // Mounted behind the admin gate, and nothing in it runs on a timer.
  const routesSource = await readFile(new URL("../src/routes/admin.routes.js", import.meta.url), "utf8");
  assert.ok(routesSource.indexOf("adminRouter.use(requireAdminAuth)") < routesSource.indexOf('"/recurring-payouts"'));
  for (const file of [
    "../src/routes/admin.recurringPayouts.routes.js",
    "../src/services/referrals/recurringPayouts.service.js",
    "../src/services/referrals/shareRates.js",
    "../src/db/migrations/20260929_recurring_affiliate_payouts.js",
  ]) {
    assert.doesNotMatch(await readFile(new URL(file, import.meta.url), "utf8"), /setInterval|setTimeout|cron|bullmq|schedule\(/, file);
  }
});
