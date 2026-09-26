// Recurring affiliate payouts, part two: the monthly statements. Each
// affiliate's subscription shares make one statement a month (UTC, by when
// the invoice was paid); the owner approves it, pays it under one Cash App
// reference, or rejects it with a note, and each invoice on it still passes
// the rules a single reward does. A statement under the minimum payout
// carries over to the next month. Real services and the real admin router,
// against PGlite, on months counted back from today.

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

// env.js reads the environment when it is first imported.
process.env.JWT_SECRET ||= "recurring-payout-statements-test-secret-32-bytes";

const { db } = await import("../src/config/db.js");
const { issueAdminAccessToken } = await import("../src/services/auth.service.js");
const { grantProductEntitlement, revokeProductEntitlement } = await import("../src/services/entitlement.service.js");
const referral = await import("../src/services/referrals/referral.service.js");
const { buildAffiliateStatements, monthOf, nextMonth } = await import("../src/services/referrals/recurringPayouts.service.js");
const { up: migrateUp } = await import("../src/db/migrations/20260929_recurring_affiliate_payouts.js");
const { adminRouter } = await import("../src/routes/admin.routes.js");
const { DAY, makePeople, startAdminPayoutsApp } = await import("./helpers/admin-payouts-app.js");

const previousMonth = (month) => {
  const [year, mon] = month.split("-").map(Number);
  return mon === 1 ? `${year - 1}-12` : `${year}-${String(mon - 1).padStart(2, "0")}`;
};
const CUR = monthOf(new Date());
const PREV = previousMonth(CUR);
const PREV2 = previousMonth(PREV);
const PREV3 = previousMonth(PREV2);

let app;
let person;

before(async () => {
  app = await startAdminPayoutsApp({ db, adminRouter, issueAdminAccessToken });
  person = makePeople({
    db,
    grantProductEntitlement,
    ensureAffiliateReferralCode: referral.ensureAffiliateReferralCode,
    cashAppTagKey: referral.cashAppTagKey,
  });
  await migrateUp(db);
});

after(async () => {
  await app?.stop();
});

// An affiliate who passes both programmes' gates: TabForge Pro, and a code on
// affiliate terms (the ForgeDrop affiliate level).
const affiliate = (name, extra = {}) => person(name, { owns: ["tabforge"], affiliate: true, cashApp: `$${name}`, ...extra });

/**
 * A share of one invoice, queued as the Stripe webhook queues it, paid in
 * `month`: on its 10th for a month gone by (long past the 10-day review
 * period), now for this month (still inside it). `ready: false` keeps a past
 * month's invoice inside its review period too.
 */
async function share(program, subscriber, invoice, cents, month, { ready = true } = {}) {
  const record = program === "sync" ? referral.recordSyncSubscriptionShare : referral.recordCloudPickupShare;
  const paidAt = month === CUR ? new Date() : new Date(`${month}-10T12:00:00.000Z`);
  const result = await record({
    subscriberUserId: subscriber.id,
    invoiceRef: invoice,
    netPaidCents: cents,
    metadata: { stripe_invoice_id: invoice, invoice_paid_at: paidAt.toISOString() },
  });
  assert.equal(result.recorded, true, result.reason);
  const update = {};
  if (month !== CUR) update.created_at = paidAt;
  if (!ready) {
    update.metadata = { ...result.reward.metadata, payout_ready_at: new Date(Date.now() + 5 * DAY).toISOString() };
  }
  if (Object.keys(update).length) await db("reward_queue").where({ id: result.reward.id }).update(update);
  return db("reward_queue").where({ id: result.reward.id }).first();
}

async function statements(who, query = "") {
  const listed = await app.api("GET", `/recurring-payouts/statements${query}`);
  assert.equal(listed.code, 200, JSON.stringify(listed.body));
  return listed.body.statements.filter((statement) => statement.userId === who.id);
}
const statementOf = async (who, month) => (await statements(who)).find((statement) => statement.month === month);
const act = (who, month, action, body) => app.api("POST", `/recurring-payouts/statements/${month}/${who.id}/${action}`, body);
const summary = (statement) => [statement.month, statement.status, statement.subscriberCount, statement.invoiceCount, statement.totalCents];

test("each affiliate's shares make one statement a month, by when the invoice was paid", async () => {
  const ada = await affiliate("ada");
  const [s1, s2] = [await person("s1", { referredBy: ada }), await person("s2", { referredBy: ada })];
  await share("sync", s1, "in_ada_1", 500, PREV2);
  await share("pickup", s1, "in_ada_2", 1000, PREV2);
  await share("sync", s2, "in_ada_3", 500, PREV2);
  await share("sync", s1, "in_ada_4", 500, PREV);
  await share("sync", s2, "in_ada_5", 1000, PREV);
  await share("pickup", s1, "in_ada_6", 2500, PREV);
  await share("sync", s1, "in_ada_7", 500, CUR);
  const bo = await affiliate("bo");
  await share("sync", await person("s3", { referredBy: bo }), "in_bo_1", 500, PREV);

  const mine = await statements(ada);
  assert.deepEqual(mine.map(summary), [
    [CUR, "open", 1, 1, 25],
    [PREV, "pending", 2, 3, 25 + 50 + 125],
    [PREV2, "pending", 2, 3, 25 + 50 + 25],
  ]);
  const prev = mine[1];
  assert.deepEqual([prev.email, prev.cashAppTag, prev.cashAppTagClaimed, prev.owedCents, prev.payableCents, prev.notReadyCount], [ada.email, "$ada", true, 200, 200, 0]);
  assert.deepEqual(prev.byProgram.map((entry) => [entry.label, entry.invoiceCount, entry.totalCents]), [
    ["TabForge Private Sync", 2, 75],
    ["ForgeDrop Cloud pickup", 1, 125],
  ]);
  assert.deepEqual(
    prev.rows.map((row) => [row.invoiceRef, row.subscriberEmail, row.amountCents, row.rateBps, row.invoiceMonth, row.ready, row.problem]),
    [
      ["in_ada_4", s1.email, 25, 500, PREV, true, null],
      ["in_ada_5", s2.email, 50, 500, PREV, true, null],
      ["in_ada_6", s1.email, 125, 500, PREV, true, null],
    ]
  );
  // This month's invoice is still inside its review period.
  const [open] = mine;
  assert.deepEqual([open.rows[0].ready, open.rows[0].problem, open.notReadyCount, open.payableCents], [false, "payout_hold_not_complete", 1, 0]);
  assert.ok(Date.parse(open.nextReadyAt) > Date.now());

  // Filters: a month, a status.
  const byMonth = await app.api("GET", `/recurring-payouts/statements?month=${PREV}`);
  assert.ok(byMonth.body.statements.every((statement) => statement.month === PREV));
  assert.deepEqual(byMonth.body.statements.filter((s) => [ada.id, bo.id].includes(s.userId)).map((s) => [s.email, s.totalCents]).sort(), [[ada.email, 200], [bo.email, 25]].sort());
  const opened = await app.api("GET", "/recurring-payouts/statements?status=open");
  assert.ok(opened.body.statements.length && opened.body.statements.every((statement) => statement.status === "open"));
  assert.ok(byMonth.body.months.includes(PREV2) && byMonth.body.months[0] === CUR);
  assert.equal((await app.api("GET", "/recurring-payouts/statements?month=2026-13")).code, 400);
  assert.equal((await app.api("GET", "/recurring-payouts/statements?status=sideways")).code, 400);
});

test("approve, then mark paid under one reference: invoices still under review are refused and move to next month", async () => {
  const cy = await affiliate("cy");
  const [t1, t2] = [await person("t1", { referredBy: cy }), await person("t2", { referredBy: cy })];
  const a = await share("sync", t1, "in_cy_1", 500, PREV);
  const b = await share("sync", t2, "in_cy_2", 500, PREV);
  const late = await share("pickup", t1, "in_cy_3", 1000, PREV, { ready: false });

  // Approve: two approved; the one under review stays pending, shown not ready.
  const approved = await act(cy, PREV, "approve");
  assert.equal(approved.code, 200, JSON.stringify(approved.body));
  assert.deepEqual(approved.body.approved.sort(), [a.id, b.id].sort());
  assert.deepEqual(approved.body.notReady.map((row) => [row.id, row.error]), [[late.id, "payout_hold_not_complete"]]);
  assert.equal(approved.body.statement.status, "approved");
  assert.deepEqual(
    approved.body.statement.rows.map((row) => [row.id, row.status, row.ready]).sort(),
    [[a.id, "approved", true], [b.id, "approved", true], [late.id, "pending", false]].sort()
  );
  assert.deepEqual([approved.body.statement.payableCents, approved.body.statement.notReadyCents], [50, 50]);

  // Paying needs the one reference.
  assert.deepEqual(await act(cy, PREV, "pay", {}), { code: 400, body: { error: "payout_reference_required" } });

  const paid = await act(cy, PREV, "pay", { payoutReference: "Cash App 2026-10-15 cy" });
  assert.equal(paid.code, 200, JSON.stringify(paid.body));
  assert.deepEqual([paid.body.paid.sort(), paid.body.paidCents], [[a.id, b.id].sort(), 50]);
  assert.deepEqual(paid.body.failed.map((row) => [row.id, row.error]), [[late.id, "payout_hold_not_complete"]]);
  assert.equal(paid.body.carriedToMonth, nextMonth(PREV));

  const rows = await db("reward_queue").whereIn("id", [a.id, b.id, late.id]);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  for (const row of [byId[a.id], byId[b.id]]) {
    assert.equal(row.status, "paid");
    assert.equal(row.payout_reference, `Cash App 2026-10-15 cy:${row.id}`, "one reference, suffixed per row as the unique index needs");
    assert.ok(row.paid_at && row.approved_at);
    assert.equal(row.metadata.statement_id, paid.body.record.id);
  }
  assert.equal(byId[late.id].status, "pending");
  const record = await db("affiliate_payout_statements").where({ user_id: cy.id, month: PREV }).first();
  assert.deepEqual(
    [record.status, record.payout_reference, record.total_cents, [...record.reward_ids].sort()],
    ["paid", "Cash App 2026-10-15 cy", 50, [a.id, b.id].sort()]
  );

  // The statement is closed and shows what it paid; the invoice it could not
  // pay is on the next month's statement, and so is one that arrives late.
  const closed = await statementOf(cy, PREV);
  assert.deepEqual([closed.status, closed.paidCents, closed.invoiceCount, closed.carriedOutCount, closed.record.payoutReference], ["paid", 50, 2, 1, "Cash App 2026-10-15 cy"]);
  const lateArrival = await share("sync", t2, "in_cy_4", 500, PREV);
  const next = await statementOf(cy, nextMonth(PREV));
  assert.deepEqual(next.rows.map((row) => row.id).sort(), [late.id, lateArrival.id].sort());
  assert.deepEqual([next.carriedInCount, next.carriedInCents], [2, 75]);
  assert.ok(next.rows.every((row) => row.carried));

  assert.deepEqual((await act(cy, PREV, "pay", { payoutReference: "again" })).body, { error: "statement_closed", status: "paid" });
  assert.deepEqual((await act(cy, PREV, "approve")).body, { error: "statement_closed", status: "paid" });
});

test("each invoice still passes the payout rules, and a statement where none does changes nothing", async () => {
  // A Cash App tag nobody has claimed for this account.
  const dee = await affiliate("dee", { claimed: false });
  const u = await person("u", { referredBy: dee });
  const one = await share("sync", u, "in_dee_1", 500, PREV);
  const two = await share("pickup", u, "in_dee_2", 1000, PREV);
  const shown = await statementOf(dee, PREV);
  assert.deepEqual([shown.cashAppTagClaimed, shown.payableCents, shown.problemCounts], [false, 0, { cash_app_tag_not_owned_by_reward_user: 2 }]);

  const auditsBefore = await db("admin_audit_log").count({ n: "id" }).first();
  const refused = await act(dee, PREV, "pay", { payoutReference: "CA-dee" });
  assert.equal(refused.code, 409);
  assert.equal(refused.body.error, "nothing_paid");
  assert.deepEqual(refused.body.failed.map((row) => row.error), ["cash_app_tag_not_owned_by_reward_user", "cash_app_tag_not_owned_by_reward_user"]);
  assert.deepEqual((await db("reward_queue").whereIn("id", [one.id, two.id])).map((row) => row.status), ["pending", "pending"]);
  assert.equal(await db("affiliate_payout_statements").where({ user_id: dee.id }).first(), undefined);
  assert.equal(Number((await db("admin_audit_log").count({ n: "id" }).first()).n), Number(auditsBefore.n), "nothing written, nothing audited");

  // Each programme's own gate: without TabForge Pro the Private Sync invoice
  // is refused, and the Cloud pickup one is paid.
  const eli = await affiliate("eli");
  const v = await person("v", { referredBy: eli });
  const syncRow = await share("sync", v, "in_eli_1", 500, PREV);
  const pickupRow = await share("pickup", v, "in_eli_2", 1000, PREV);
  await revokeProductEntitlement(eli.id, "tabforge");
  const partly = await act(eli, PREV, "pay", { payoutReference: "CA-eli" });
  assert.equal(partly.code, 200, JSON.stringify(partly.body));
  assert.deepEqual([partly.body.paid, partly.body.failed.map((row) => [row.id, row.error])], [[pickupRow.id], [[syncRow.id, "referrer_tabforge_pro_required"]]]);

  // One transaction: if anything fails part way, nothing is paid.
  const fay = await affiliate("fay");
  const w = await person("w", { referredBy: fay });
  const kept = [await share("sync", w, "in_fay_1", 500, PREV), await share("sync", w, "in_fay_2", 500, PREV)];
  await db.raw("ALTER TABLE admin_audit_log RENAME TO admin_audit_log_away");
  try {
    const broken = await act(fay, PREV, "pay", { payoutReference: "CA-fay" });
    assert.deepEqual(broken, { code: 500, body: { error: "server_error" } });
  } finally {
    await db.raw("ALTER TABLE admin_audit_log_away RENAME TO admin_audit_log");
  }
  assert.deepEqual((await db("reward_queue").whereIn("id", kept.map((row) => row.id))).map((row) => [row.status, row.payout_reference]), [["pending", null], ["pending", null]]);
  assert.equal(await db("affiliate_payout_statements").where({ user_id: fay.id }).first(), undefined);
  const retried = await act(fay, PREV, "pay", { payoutReference: "CA-fay" });
  assert.deepEqual([retried.code, retried.body.paidCents], [200, 50]);
});

test("nothing is approved while every invoice is still under review", async () => {
  const gus = await affiliate("gus");
  const x = await person("x", { referredBy: gus });
  const held = await share("sync", x, "in_gus_1", 500, PREV, { ready: false });
  const refused = await act(gus, PREV, "approve");
  assert.equal(refused.code, 409);
  assert.equal(refused.body.error, "nothing_to_approve");
  assert.deepEqual(refused.body.notReady.map((row) => [row.id, row.error]), [[held.id, "payout_hold_not_complete"]]);
  assert.equal((await db("reward_queue").where({ id: held.id }).first()).status, "pending");
});

test("a statement under the minimum payout carries over to the next month", async () => {
  assert.equal((await app.api("PUT", "/recurring-payouts/payout-settings", { minimumPayoutCents: 100 })).code, 200);
  try {
    const hal = await affiliate("hal");
    const y = await person("y", { referredBy: hal });
    const first = await share("sync", y, "in_hal_1", 500, PREV3); // 25 cents
    const second = await share("sync", y, "in_hal_2", 500, PREV2); // 25 cents
    const third = await share("pickup", y, "in_hal_3", 1200, PREV); // 60 cents

    const mine = await statements(hal);
    assert.deepEqual(
      mine.map((statement) => [statement.month, statement.status, statement.totalCents, statement.carriedInCount, statement.carriedToMonth]),
      [
        [PREV, "pending", 110, 2, null],
        [PREV2, "carried_over", 50, 1, PREV],
        [PREV3, "carried_over", 25, 0, PREV2],
      ]
    );
    // Nothing under the minimum counts as ready to pay.
    assert.deepEqual(mine.map((statement) => [statement.belowMinimum, statement.payableCents]), [[false, 110], [true, 0], [true, 0]]);
    // Under the minimum, a statement is not paid or approved on its own.
    const early = await act(hal, PREV3, "pay", { payoutReference: "CA-hal-early" });
    assert.deepEqual([early.code, early.body.error, early.body.owedCents, early.body.minimumPayoutCents], [409, "below_minimum_payout", 25, 100]);
    assert.equal((await act(hal, PREV2, "approve")).body.error, "below_minimum_payout");

    // Paid with the month it carried into, under one reference.
    const paid = await act(hal, PREV, "pay", { payoutReference: "CA-hal" });
    assert.equal(paid.code, 200, JSON.stringify(paid.body));
    assert.deepEqual([paid.body.paid.sort(), paid.body.paidCents], [[first.id, second.id, third.id].sort(), 110]);
    assert.deepEqual((await statements(hal)).map(summary), [[PREV, "paid", 1, 3, 110]], "the carried invoices are on the statement that paid them");

    // This month is never carried over while it runs, and is not paid under the minimum either.
    const ida = await affiliate("ida");
    await share("sync", await person("z", { referredBy: ida }), "in_ida_1", 500, CUR);
    const current = await statementOf(ida, CUR);
    assert.deepEqual([current.status, current.totalCents, current.belowMinimum, current.payableCents], ["open", 25, true, 0]);
    assert.equal((await act(ida, CUR, "pay", { payoutReference: "CA-ida" })).body.error, "below_minimum_payout");
  } finally {
    await app.api("PUT", "/recurring-payouts/payout-settings", { minimumPayoutCents: 0 });
  }
});

test("reject a statement with a note", async () => {
  const jo = await affiliate("jo");
  const q = await person("q", { referredBy: jo });
  const rows = [await share("sync", q, "in_jo_1", 500, PREV), await share("pickup", q, "in_jo_2", 1000, PREV, { ready: false })];
  assert.deepEqual(await act(jo, PREV, "reject", {}), { code: 400, body: { error: "rejection_note_required" } });
  assert.deepEqual(await act(jo, PREV, "reject", { note: "   " }), { code: 400, body: { error: "rejection_note_required" } });

  const rejected = await act(jo, PREV, "reject", { note: "Referred themselves through a second account" });
  assert.equal(rejected.code, 200, JSON.stringify(rejected.body));
  assert.deepEqual(rejected.body.rejected.sort(), rows.map((row) => row.id).sort(), "an invoice under review can still be rejected");
  for (const row of await db("reward_queue").whereIn("id", rows.map((r) => r.id))) {
    assert.deepEqual([row.status, row.admin_note], ["rejected", "Referred themselves through a second account"]);
  }
  const statement = await statementOf(jo, PREV);
  assert.deepEqual([statement.status, statement.rejectedCents, statement.record.note], ["rejected", 75, "Referred themselves through a second account"]);
  assert.equal((await act(jo, PREV, "reject", { note: "again" })).body.error, "statement_closed");
  assert.equal((await act(jo, "2001-01", "approve")).body.error, "statement_not_found");
});

test("every statement action is audited, with each invoice's own change", async () => {
  const log = await db("admin_audit_log").orderBy("created_at", "asc");
  const statementAudits = log.filter((row) => row.action.startsWith("recurring_payout.statement."));
  const byAction = (action) => statementAudits.filter((row) => row.action === action);
  assert.ok(byAction("recurring_payout.statement.approved").length >= 1);
  assert.ok(byAction("recurring_payout.statement.paid").length >= 3);
  assert.ok(byAction("recurring_payout.statement.rejected").length >= 1);

  const paid = byAction("recurring_payout.statement.paid").find((row) => row.metadata.payoutReference === "Cash App 2026-10-15 cy");
  const record = await db("affiliate_payout_statements").where({ payout_reference: "Cash App 2026-10-15 cy" }).first();
  assert.equal(paid.resource_type, "affiliate_payout_statement");
  assert.equal(paid.resource_id, record.id);
  assert.equal(paid.admin_email, "zadockplant@gmail.com");
  assert.deepEqual([paid.metadata.month, paid.metadata.userId], [PREV, record.user_id]);
  assert.equal(paid.before_value.status, "approved");
  assert.equal(paid.after_value.paidCents, 50);

  // Each invoice it paid has its own reward.paid entry too.
  for (const id of record.reward_ids) {
    assert.ok(log.some((row) => row.action === "reward.paid" && row.resource_id === id), id);
  }
  assert.ok(log.some((row) => row.action === "reward.rejected"));
  assert.ok(log.some((row) => row.action === "recurring_payout.settings.update"));
});

test("the month walk, on its own: carried, closed and pinned invoices", () => {
  const row = (id, month, cents, status = "pending", metadata = {}) => ({ id, user_id: "u", reward_amount_cents: cents, status, invoiceMonth: month, metadata });
  const built = (rows, records = [], minimum = 0, current = "2026-09") =>
    buildAffiliateStatements({ userId: "u", rows, records, minimumPayoutCents: minimum, currentMonth: current }).map((s) => [
      s.month,
      s.open.map((r) => r.id).join(","),
      s.settled.map((r) => r.id).join(","),
      s.carriedOver,
      s.inProgress,
    ]);

  // Under the minimum, through a month with nothing in it, into the running month.
  assert.deepEqual(built([row("a", "2026-05", 30), row("b", "2026-07", 30)], [], 100), [
    ["2026-05", "a", "", true, false],
    ["2026-06", "a", "", true, false],
    ["2026-07", "a,b", "", true, false],
    ["2026-08", "a,b", "", true, false],
    ["2026-09", "a,b", "", false, true],
  ]);
  // A paid statement is closed: what it did not pay moves on; what it paid stays on it.
  const paidRecord = { id: "r1", month: "2026-07", status: "paid" };
  assert.deepEqual(
    built([row("a", "2026-07", 30, "paid", { statement_id: "r1" }), row("b", "2026-07", 30), row("c", "2026-06", 30, "paid", { statement_id: "r1" })], [paidRecord]),
    [["2026-07", "", "a,c", false, false], ["2026-08", "b", "", false, false]]
  );
  // Approved through a statement: pinned to it, whatever the minimum.
  const approvedRecord = { id: "r2", month: "2026-07", status: "approved" };
  assert.deepEqual(built([row("a", "2026-06", 30, "approved", { statement_id: "r2" })], [approvedRecord], 1000), [
    ["2026-07", "a", "", false, false],
  ]);
});
