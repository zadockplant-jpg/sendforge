// Rose Colored Glasses: one device per purchase, $5 then $4, and $1 per
// referral to the referrer, paid at the milestones. ForgeDrop's referral
// milestones and affiliate level ride the same checkout path, so they are
// proved here too.
//
// Runs the real services and the real Stripe webhook handlers against an
// in-process Postgres (PGlite), because every rule here is a counting rule and
// counting rules fail in the database, not on paper.

import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const SEED = crypto.randomBytes(32).toString("base64");
process.env.LICENSE_SIGNING_KEY = SEED;
process.env.LICENSE_SIGNING_KID = "sf-test";

// env.js reads the environment when it is first imported, so everything that
// touches it is imported after the key is set.
const { db } = await import("../src/config/db.js");
const { activateDevice, DeviceLimitReached, getOrCreateActivationCode } = await import(
  "../src/services/deviceActivation.service.js"
);
const { licensedProduct } = await import("../src/services/licensedProducts.js");
const {
  countActiveSeats,
  deviceLimitFor,
  nextDeviceCents,
  seatLinesTotalCents,
  seatPriceLines,
} = await import("../src/services/productSeats.service.js");
const { publicKeyHexFromSeed, verifyLicenseToken } = await import(
  "../src/services/licenseToken.service.js"
);
const {
  canHoldReferralCode,
  hasReferralProgramEligibility,
  productReferralSummary,
  recordVerifiedReferralPurchases,
  rewardPayoutEligibility,
} = await import("../src/services/referrals/referral.service.js");
const { handleCheckoutSessionCompleted, handleReferralPaymentReversal } = await import(
  "../src/routes/stripe.webhooks.routes.js"
);
const { up: devicesUp } = await import(
  "../src/db/migrations/20260921_create_device_activations.js"
);
const { up: seatsUp } = await import(
  "../src/db/migrations/20260924_create_product_seat_purchases.js"
);

const RCG = "rose-colored-glasses";
const product = licensedProduct(RCG);
let pg;

before(async () => {
  pg = new PGlite();
  await pg.waitReady;
  // One connection, straight into PGlite. PGlite is a single session, so a
  // pool of several "connections" would share it: advisory locks would be
  // re-entrant and transactions would interleave, and a race test would pass
  // or fail for reasons that have nothing to do with the code. With one
  // connection, a query issued outside the transaction holding it waits
  // forever, so a missing `trx` in the code under test shows up as a hang.
  if (db.client.pool) await db.client.destroy();
  db.client.initializeDriver();
  db.client.initializePool({ ...db.client.config, pool: { min: 0, max: 1 } });
  db.client.acquireRawConnection = async () => ({
    query(config, callback) {
      pg.query(config.text, config.values).then(
        (result) =>
          callback(null, {
            rows: result.rows,
            rowCount: result.affectedRows,
            command: config.text.trim().split(/\s/)[0].toUpperCase(),
          }),
        callback
      );
    },
  });
  db.client.destroyRawConnection = async () => {};

  await db.schema.createTable("users", (t) => {
    t.uuid("id").primary();
    t.text("email").unique();
    t.boolean("email_verified").defaultTo(true);
    t.uuid("referred_by_user_id").nullable();
    t.uuid("referral_code_id").nullable();
    t.text("cash_app_tag").nullable();
    t.text("stripe_customer_id").nullable();
  });
  await db.schema.createTable("product_entitlements", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable();
    t.text("product_slug").notNullable();
    t.text("source");
    t.text("source_ref");
    t.text("status");
    t.timestamp("granted_at", { useTz: true });
    t.timestamp("expires_at", { useTz: true });
    t.jsonb("metadata").defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true });
    t.unique(["user_id", "product_slug"]);
  });
  await db.schema.createTable("referral_codes", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id");
    t.text("email");
    t.text("code").unique();
    t.text("cashapp_handle");
    t.text("status");
    t.jsonb("metadata").defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true });
  });
  await db.schema.createTable("referral_events", (t) => {
    t.uuid("id").primary();
    t.uuid("referral_code_id");
    t.uuid("referrer_user_id");
    t.uuid("referred_user_id");
    t.text("product_slug");
    t.text("purchase_ref");
    t.text("event_type");
    t.text("status");
    t.jsonb("metadata").defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true });
    t.unique(["referral_code_id", "purchase_ref"]);
  });
  await db.schema.createTable("reward_queue", (t) => {
    t.uuid("id").primary();
    t.uuid("referral_code_id");
    t.uuid("user_id");
    t.text("email");
    t.text("product_slug");
    t.text("reward_key");
    t.integer("reward_amount_cents");
    t.text("reward_type");
    t.text("cashapp_handle");
    t.text("status");
    t.text("admin_note");
    t.jsonb("metadata").defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true });
    t.unique(["user_id", "product_slug", "reward_key"]);
  });
  await db.schema.createTable("referral_programs", (t) => {
    t.uuid("id").primary();
    t.text("product_slug").notNullable().unique();
    t.integer("required_purchases").notNullable().defaultTo(5);
    t.integer("reward_amount_cents").notNullable().defaultTo(1000);
    t.text("reward_type").notNullable().defaultTo("cashapp_manual");
    t.integer("refund_hold_days").notNullable().defaultTo(14);
    t.text("status").notNullable().defaultTo("active");
    t.jsonb("metadata").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
  });
  await db.schema.createTable("billing_checkout_attempts", (t) => {
    t.uuid("id").primary();
    t.text("stripe_checkout_session_id");
    t.text("status");
    t.timestamp("updated_at", { useTz: true });
  });
  await devicesUp(db);
  await seatsUp(db);
});

after(async () => {
  await db.destroy();
  await pg?.close();
});

async function user(email, extra = {}) {
  const id = randomUUID();
  await db("users").insert({ id, email, ...extra });
  return id;
}

let piCounter = 0;
function seatCheckout(userId, devices, amountCents) {
  piCounter += 1;
  return {
    id: `cs_test_${piCounter}`,
    customer: `cus_${userId.slice(0, 8)}`,
    payment_intent: `pi_test_${piCounter}`,
    payment_status: "paid",
    amount_total: amountCents,
    metadata: {
      user_id: userId,
      product_slug: RCG,
      fulfillment_type: "multi_entitlement_cart",
      checkout_items: JSON.stringify([
        {
          kind: "device_seat",
          slug: RCG,
          entitlementSlug: RCG,
          displayName: "Rose Colored Glasses",
          quantity: devices,
          amountCents,
        },
      ]),
    },
  };
}

function forgeDropCheckout(userId, amountCents = 2000) {
  piCounter += 1;
  return {
    id: `cs_test_${piCounter}`,
    customer: `cus_${userId.slice(0, 8)}`,
    payment_intent: `pi_test_${piCounter}`,
    payment_status: "paid",
    amount_total: amountCents,
    metadata: {
      user_id: userId,
      product_slug: "forgedrop",
      fulfillment_type: "multi_entitlement_cart",
      checkout_items: JSON.stringify([
        { kind: "product", slug: "forgedrop", entitlementSlug: "forgedrop", displayName: "ForgeDrop", amountCents },
      ]),
    },
  };
}

function refund(paymentIntent) {
  return handleReferralPaymentReversal({
    stripe: {},
    event: {
      id: `evt_${paymentIntent}`,
      type: "charge.refunded",
      data: { object: { id: `ch_${paymentIntent}`, payment_intent: paymentIntent, amount: 500, amount_refunded: 500, refunded: true } },
    },
  });
}

function activate(userId, deviceId) {
  return activateDevice({
    userId,
    productSlug: RCG,
    deviceId,
    deviceName: "Test PC",
    deviceLimit: (trx) => deviceLimitFor(userId, product, trx),
  });
}

async function entitlementStatus(userId) {
  const row = await db("product_entitlements").where({ user_id: userId, product_slug: RCG }).first();
  return row?.status || null;
}

test("the first device is $5 and every device after it is $4", () => {
  assert.deepEqual(seatPriceLines(RCG, 0, 1), [{ role: "first", unitAmountCents: 500, quantity: 1 }]);
  assert.equal(seatLinesTotalCents(seatPriceLines(RCG, 0, 3)), 500 + 400 + 400);
  assert.deepEqual(seatPriceLines(RCG, 1, 2), [{ role: "additional", unitAmountCents: 400, quantity: 2 }]);
  assert.equal(nextDeviceCents(RCG, 0), 500);
  assert.equal(nextDeviceCents(RCG, 4), 400);
  assert.deepEqual(seatPriceLines(RCG, 0, 0), [], "no devices, no charge");
  assert.deepEqual(seatPriceLines("forgedrop", 0, 1), [], "only seat products are priced here");
});

test("one purchase is one device, a replayed webhook is still one, and the referral counts once", async () => {
  const ann = await user("ann@example.com", { cash_app_tag: "$ann" });
  // Ann owns the product herself, which is what lets her refer.
  await handleCheckoutSessionCompleted(seatCheckout(ann, 1, 500), {});
  const bob = await user("bob@example.com", { referred_by_user_id: ann });

  const first = seatCheckout(bob, 1, 500);
  await handleCheckoutSessionCompleted(first, {});
  await handleCheckoutSessionCompleted(first, {}); // Stripe delivers twice

  assert.equal(await countActiveSeats(bob, RCG), 1);
  assert.equal(await entitlementStatus(bob), "active");

  // One referred customer: $1 is earned, and paid when Ann reaches 5.
  assert.equal((await db("reward_queue").where({ user_id: ann, product_slug: RCG })).length, 0);
  let [summary] = await productReferralSummary(ann);
  assert.equal(summary.productSlug, RCG);
  assert.equal(summary.mode, "milestones");
  assert.equal(summary.referredCustomers, 1);
  assert.deepEqual(summary.tiers[0], { requiredPurchases: 5, rewardAmountCents: 500, recurring: false, reached: false, remaining: 4 });

  // The machine: one fits, a second does not, the first again re-signs.
  const pcA = randomUUID();
  const pcB = randomUUID();
  const a = await activate(bob, pcA);
  assert.deepEqual(a.devices, { used: 1, limit: 1 });
  await assert.rejects(activate(bob, pcB), (err) => err instanceof DeviceLimitReached && err.limit === 1);
  const again = await activate(bob, pcA);
  assert.equal(again.reactivated, true, "reinstalling the same PC does not need a second purchase");

  // The licence is signed, for this product, for this machine, forever.
  const payload = verifyLicenseToken(a.token, { publicKeyHex: publicKeyHexFromSeed(SEED) });
  assert.equal(payload.product, RCG);
  assert.equal(payload.did, pcA);
  assert.equal(payload.exp, null);
  assert.equal(payload.kid, "sf-test");

  // A second device is a second purchase, at $4, and it is not a second referral.
  const second = seatCheckout(bob, 1, 400);
  await handleCheckoutSessionCompleted(second, {});
  assert.equal(await countActiveSeats(bob, RCG), 2);
  assert.equal((await activate(bob, pcB)).devices.limit, 2);
  await assert.rejects(activate(bob, randomUUID()), DeviceLimitReached);
  [summary] = await productReferralSummary(ann);
  assert.equal(summary.referredCustomers, 1);

  // Refunding the extra device takes that seat back and leaves the product.
  await refund(second.payment_intent);
  assert.equal(await countActiveSeats(bob, RCG), 1);
  assert.equal(await entitlementStatus(bob), "active");
  [summary] = await productReferralSummary(ann);
  assert.equal(summary.referredCustomers, 1, "the referral was the first purchase, which still stands");

  // Refunding the first purchase too: no seats, no product, no referral.
  await refund(first.payment_intent);
  assert.equal(await countActiveSeats(bob, RCG), 0);
  assert.equal(await entitlementStatus(bob), "revoked");
  [summary] = await productReferralSummary(ann);
  assert.equal(summary.referredCustomers, 0);
});

async function referredBuyers(referrerId, count, prefix, buy) {
  const buyers = [];
  for (let i = 0; i < count; i += 1) {
    const buyer = await user(`${prefix}${i}@example.com`, { referred_by_user_id: referrerId });
    const session = buy(buyer);
    await handleCheckoutSessionCompleted(session, {});
    buyers.push({ id: buyer, session });
  }
  return buyers;
}

async function rewardsFor(userId, productSlug) {
  return (await db("reward_queue").where({ user_id: userId, product_slug: productSlug }).orderBy("created_at"))
    .map((row) => ({ at: Number(row.metadata?.tier_required_purchases), cents: row.reward_amount_cents, status: row.status }));
}

test("Rose Colored Glasses pays $1 per referral, settled at 5, 15, 25 and 50", async () => {
  const rae = await user("rae@example.com", { cash_app_tag: "$rae" });
  await handleCheckoutSessionCompleted(seatCheckout(rae, 1, 500), {});

  await referredBuyers(rae, 4, "rcg-a", (buyer) => seatCheckout(buyer, 1, 500));
  assert.deepEqual(await rewardsFor(rae, RCG), [], "four referrals: nothing to pay yet");

  await referredBuyers(rae, 1, "rcg-b", (buyer) => seatCheckout(buyer, 1, 500));
  assert.deepEqual(await rewardsFor(rae, RCG), [{ at: 5, cents: 500, status: "pending" }], "the fifth settles $5");

  await referredBuyers(rae, 10, "rcg-c", (buyer) => seatCheckout(buyer, 1, 500));
  assert.deepEqual(await rewardsFor(rae, RCG), [
    { at: 5, cents: 500, status: "pending" },
    { at: 15, cents: 1000, status: "pending" },
  ], "the fifteenth settles the next $10: $15 for 15 referrals");

  const [summary] = await productReferralSummary(rae);
  assert.equal(summary.referredCustomers, 15);
  assert.equal(summary.earnedCents, 1500);
  assert.deepEqual(summary.tiers.find((tier) => !tier.reached), { requiredPurchases: 25, rewardAmountCents: 1000, recurring: false, reached: false, remaining: 10 });
});

test("a customer already paid the old flat $1 is never paid twice", async () => {
  const leo = await user("leo@example.com");
  await handleCheckoutSessionCompleted(seatCheckout(leo, 1, 500), {});
  const code = { id: randomUUID() };
  await db("referral_codes").insert({ id: code.id, user_id: leo, email: "leo@example.com", code: "LEO1234", status: "active", metadata: {} });
  // Three customers from before the milestones: a flat $1 each, already queued.
  for (let i = 0; i < 3; i += 1) {
    const old = await user(`legacy${i}@example.com`, { referred_by_user_id: leo });
    await db("reward_queue").insert({ id: randomUUID(), referral_code_id: code.id, user_id: leo, email: "leo@example.com", product_slug: RCG, reward_key: `first_purchase:${old}`, reward_amount_cents: 100, reward_type: "cashapp_manual", status: "paid", metadata: { kind: "flat_referral" } });
    await db("referral_events").insert({ id: randomUUID(), referral_code_id: code.id, referrer_user_id: leo, referred_user_id: old, product_slug: RCG, purchase_ref: `legacy:${i}`, event_type: "purchase", status: "verified", metadata: { qualification: "flat_referral", initial_net_paid_cents: 500 } });
  }

  await referredBuyers(leo, 4, "leo-a", (buyer) => seatCheckout(buyer, 1, 500));
  assert.deepEqual((await rewardsFor(leo, RCG)).filter((row) => row.at), [], "the old three do not count towards the first milestone");
  await referredBuyers(leo, 1, "leo-b", (buyer) => seatCheckout(buyer, 1, 500));
  assert.deepEqual((await rewardsFor(leo, RCG)).filter((row) => row.at), [{ at: 5, cents: 500, status: "pending" }]);
  // 8 customers, $8: $3 flat before, $5 at the milestone.
  const total = (await db("reward_queue").where({ user_id: leo, product_slug: RCG })).reduce((sum, row) => sum + row.reward_amount_cents, 0);
  assert.equal(total, 800);
});

test("ForgeDrop pays $25, $50, $60 and $175 at 5, 15, 25 and 50, and a refund takes a milestone back", async () => {
  const fay = await user("faye@example.com", { cash_app_tag: "$faye" });
  await handleCheckoutSessionCompleted(forgeDropCheckout(fay), {});

  const buyers = await referredBuyers(fay, 5, "fd-a", (buyer) => forgeDropCheckout(buyer));
  assert.deepEqual(await rewardsFor(fay, "forgedrop"), [{ at: 5, cents: 2500, status: "pending" }]);

  // Before it is paid, one of the five refunds: the milestone is no longer reached.
  await refund(buyers[2].session.payment_intent);
  assert.deepEqual(await rewardsFor(fay, "forgedrop"), [{ at: 5, cents: 2500, status: "canceled" }]);

  const [, summary] = await productReferralSummary(fay);
  assert.equal(summary.productSlug, "forgedrop");
  assert.equal(summary.referredCustomers, 4);
  assert.deepEqual(summary.tiers.map((tier) => [tier.requiredPurchases, tier.rewardAmountCents]), [[5, 2500], [15, 5000], [25, 6000], [50, 17500]]);
  assert.equal(await rewardPayoutEligibility(fay, "forgedrop"), true);
});

test("a ForgeDrop affiliate is paid $10 on every ForgeDrop sale", async () => {
  const ace = await user("ace@example.com", { cash_app_tag: "$ace" });
  // An affiliate owns nothing: the owner made them one.
  await db("referral_codes").insert({ id: randomUUID(), user_id: ace, email: "ace@example.com", code: "ACE10", status: "active", metadata: { affiliate: true } });

  await referredBuyers(ace, 3, "ace-a", (buyer) => forgeDropCheckout(buyer));
  assert.deepEqual((await rewardsFor(ace, "forgedrop")).map((row) => row.cents), [1000, 1000, 1000]);
  assert.deepEqual((await rewardsFor(ace, RCG)), [], "Rose Colored Glasses stays on its milestones for an affiliate");

  const [rcg, drop] = await productReferralSummary(ace, await db("referral_codes").where({ code: "ACE10" }).first());
  assert.equal(rcg.mode, "milestones");
  assert.deepEqual({ mode: drop.mode, perSaleCents: drop.perSaleCents, earnedCents: drop.earnedCents }, { mode: "per_sale", perSaleCents: 1000, earnedCents: 3000 });
});

test("a purchase made before the email is verified counts once it is", async () => {
  const una = await user("una@example.com");
  await handleCheckoutSessionCompleted(forgeDropCheckout(una), {});
  const buyers = [];
  for (let i = 0; i < 5; i += 1) {
    const buyer = await user(`unverified${i}@example.com`, { referred_by_user_id: una, email_verified: i < 4 });
    await handleCheckoutSessionCompleted(forgeDropCheckout(buyer), {});
    buyers.push(buyer);
  }
  assert.deepEqual(await rewardsFor(una, "forgedrop"), [], "the fifth buyer has not verified yet");

  await db("users").where({ id: buyers[4] }).update({ email_verified: true });
  const result = await recordVerifiedReferralPurchases({ referredUserId: buyers[4] });
  assert.equal(result.promoted, 1);
  assert.deepEqual(await rewardsFor(una, "forgedrop"), [{ at: 5, cents: 2500, status: "pending" }]);
});

// Five installs fired together. With one connection they queue rather than
// truly overlap, so this proves the count, not the lock; the advisory lock
// that makes real overlapping connections safe is asserted in
// forgedrop-licensing.test.js.
test("five installs at once on a one-device purchase activate exactly one", async () => {
  const cat = await user("cat@example.com");
  await handleCheckoutSessionCompleted(seatCheckout(cat, 1, 500), {});

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => activate(cat, randomUUID()))
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await db("device_activations").where({ user_id: cat, status: "active" })).length,
    1
  );
});

test("buying three devices in one checkout gives three", async () => {
  const dee = await user("dee@example.com");
  await handleCheckoutSessionCompleted(seatCheckout(dee, 3, 1300), {});
  assert.equal(await countActiveSeats(dee, RCG), 3);
  for (let i = 0; i < 3; i += 1) await activate(dee, randomUUID());
  await assert.rejects(activate(dee, randomUUID()), DeviceLimitReached);
});

test("owning Rose Colored Glasses earns on it, never on TabForge", async () => {
  const eve = await user("eve@example.com");
  await handleCheckoutSessionCompleted(seatCheckout(eve, 1, 500), {});

  assert.equal(await canHoldReferralCode(eve), true);
  assert.equal(await rewardPayoutEligibility(eve, RCG), true);
  assert.equal(await hasReferralProgramEligibility(eve, "tabforge"), false);
  assert.equal(await rewardPayoutEligibility(eve, "tabforge"), false);
  assert.equal(await rewardPayoutEligibility(eve, "tabforge-subscription"), false);
});

test("a hand-granted entitlement with no purchase still activates one device", async () => {
  const fay = await user("fay@example.com");
  await db("product_entitlements").insert({
    id: randomUUID(),
    user_id: fay,
    product_slug: RCG,
    source: "manual",
    status: "active",
  });
  assert.equal(await deviceLimitFor(fay, product), 1);
  await activate(fay, randomUUID());
  await assert.rejects(activate(fay, randomUUID()), DeviceLimitReached);
});

test("activation codes for Rose Colored Glasses start with RC", async () => {
  const gus = await user("gus@example.com");
  const row = await getOrCreateActivationCode(gus, RCG);
  assert.match(row.code, /^RC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test("a Rose Colored Glasses device never moves to another PC", async () => {
  const { readFile } = await import("node:fs/promises");
  const routes = await readFile(new URL("../src/routes/licensing.routes.js", import.meta.url), "utf8");
  const deactivate = routes.slice(routes.indexOf('"/devices/:deviceId/deactivate"'));
  // Refused before any row is touched: $5 buys the product for that device.
  assert.ok(
    deactivate.indexOf("device_moves_not_allowed") < deactivate.indexOf("deactivateDevice("),
    "the seat-based refusal comes before the slot is freed"
  );
  assert.match(deactivate, /if \(product\.seatBased\) \{\s*return res\.status\(403\)/);
});
