// ForgeDrop Cloud pickup billing: the checkout for the four monthly plans, the
// subscription webhook that grants, moves and removes a plan, and the 5% share
// of every paid invoice for the ForgeDrop affiliate who brought the customer.
//
// Runs the real checkout handler, the real Stripe event handling, the real
// referral service and the real Cloud pickup router against an in-process
// Postgres (PGlite). Stripe is a stand-in that answers from memory, so nothing
// here reaches Stripe. The allowance is checked through the pickup router
// itself, with a desktop signed in by a real licence and an R2 that only
// hands out links.

import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import express from "express";

import { attachPglite } from "./helpers/pglite-db.js";

const PRICES = Object.freeze({
  "100gb": "price_test_pickup_100gb",
  "250gb": "price_test_pickup_250gb",
  "500gb": "price_test_pickup_500gb",
  "1tb": "price_test_pickup_1tb",
});

// env.js reads the environment when it is first imported, so everything that
// touches it is imported after these are set. The price ids are read per
// request, so a test can take one away and put it back. No Stripe key, ever:
// the real router must stop at stripe_not_configured, never reach Stripe.
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
process.env.JWT_SECRET ||= "forgedrop-pickup-billing-test-secret-at-least-32-bytes";
process.env.LICENSE_SIGNING_KEY = crypto.randomBytes(32).toString("base64");
process.env.LICENSE_SIGNING_KID = "fd-test";
process.env.PUBLIC_SITE_URL = "https://sendforge.test";
process.env.STRIPE_PRICE_FORGEDROP_PICKUP_100GB = PRICES["100gb"];
process.env.STRIPE_PRICE_FORGEDROP_PICKUP_250GB = PRICES["250gb"];
process.env.STRIPE_PRICE_FORGEDROP_PICKUP_500GB = PRICES["500gb"];
process.env.STRIPE_PRICE_FORGEDROP_PICKUP_1TB = PRICES["1tb"];

const { db } = await import("../src/config/db.js");
const { env } = await import("../src/config/env.js");
const { issueCustomerAccessToken } = await import("../src/services/auth.service.js");
const { requireAuth } = await import("../src/middleware/auth.js");
const { grantProductEntitlement, hasProductEntitlement, listProductEntitlements } = await import(
  "../src/services/entitlement.service.js"
);
const { activateDevice } = await import("../src/services/deviceActivation.service.js");
const { billingRouter, createCloudPickupCheckoutHandler } = await import("../src/routes/billing.routes.js");
const { handleStripeEvent } = await import("../src/routes/stripe.webhooks.routes.js");
const { CLOUD_PICKUP_TIERS, GB, tierFromEntitlements } = await import("../src/modules/forgedrop-pickup/plans.js");
const { cloudPickupInvoice, isCloudPickupSubscription } = await import("../src/modules/forgedrop-pickup/billing.js");
const { createForgeDropPickupRouter } = await import("../src/modules/forgedrop-pickup/router.js");
const {
  cloudPickupShareCents,
  isCloudPickupShareReward,
  isForgeDropAffiliateCode,
  recordCloudPickupShare,
  rewardPayoutEligibility,
} = await import("../src/services/referrals/referral.service.js");
const { up: billingUp } = await import("../src/db/migrations/004_billing.js");
const { up: checkoutIntegrityUp } = await import("../src/db/migrations/20260718_tabforge_checkout_integrity_1_1_9.js");
const { up: pickupsUp } = await import("../src/db/migrations/20260928_create_forgedrop_pickups.js");

const src = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const TIER_SLUGS = CLOUD_PICKUP_TIERS.map((tier) => tier.slug);
const SITE = "https://sendforge.test";
const SUCCESS_URL = `${SITE}/account/index.html?purchase_context=forgedrop-cloud-pickup&checkout=success&session_id={CHECKOUT_SESSION_ID}#forgedrop`;
const SWITCHED_URL = `${SITE}/account/index.html?purchase_context=forgedrop-cloud-pickup&checkout=plan_changed#forgedrop`;
const CANCEL_URL = `${SITE}/products/forgedrop/index.html?checkout=cancelled#cloud-pickup`;
const DAY = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------ a stand-in Stripe

function stripeError(message, extra = {}) {
  return Object.assign(new Error(message), {
    type: "StripeInvalidRequestError",
    rawType: "invalid_request_error",
    statusCode: 400,
    ...extra,
  });
}

const missing = (what, id) => stripeError(`No such ${what}: '${id}'`, { code: "resource_missing", statusCode: 404 });

// Ids are unique across the whole file, as Stripe's are: a new stand-in per
// test must not hand out a customer or session id an earlier one did.
let n = 0;
const next = (prefix) => `${prefix}_${(n += 1)}`;

/** Stripe as far as these flows use it, answering from memory, and a log of every call. */
function fakeStripe() {
  const state = {
    calls: [],
    customers: new Map(),
    subscriptions: new Map(),
    sessions: [],
    portals: [],
    // The customer portal's settings list no prices to switch to.
    portalRefusesSwitch: false,
  };
  const called = (name, args) => state.calls.push([name, args]);
  const copy = (value) => structuredClone(value);

  return {
    state,
    addSubscription({ customer, metadata = {}, price, status = "active" }) {
      const id = next("sub_test");
      const now = Math.floor(Date.now() / 1000);
      const subscription = {
        id,
        object: "subscription",
        customer,
        status,
        metadata: { ...metadata },
        current_period_start: now,
        current_period_end: now + 30 * 86400,
        items: {
          object: "list",
          data: [{ id: `si_${id}`, object: "subscription_item", quantity: 1, price: { id: price, object: "price", metadata: {} } }],
        },
      };
      state.subscriptions.set(id, subscription);
      return copy(subscription);
    },
    /** What Stripe holds for a subscription after the customer switched tier in the billing portal. */
    setPrice(id, price) {
      state.subscriptions.get(id).items.data[0].price = { id: price, object: "price", metadata: {} };
    },
    setStatus(id, status) {
      state.subscriptions.get(id).status = status;
    },
    subscription(id) {
      return copy(state.subscriptions.get(id));
    },
    customers: {
      async retrieve(id) {
        called("customers.retrieve", id);
        if (!state.customers.has(id)) throw missing("customer", id);
        return copy(state.customers.get(id));
      },
      async create(params) {
        called("customers.create", params);
        const customer = { id: next("cus_test"), object: "customer", ...params };
        state.customers.set(customer.id, customer);
        return copy(customer);
      },
      async update(id, params) {
        called("customers.update", [id, params]);
        Object.assign(state.customers.get(id), params);
        return copy(state.customers.get(id));
      },
    },
    prices: {
      async retrieve(id) {
        called("prices.retrieve", id);
        if (!Object.values(PRICES).includes(id)) throw missing("price", id);
        return { id, object: "price", active: true, recurring: { interval: "month" } };
      },
    },
    subscriptions: {
      async list(params) {
        called("subscriptions.list", params);
        return { data: [...state.subscriptions.values()].filter((sub) => sub.customer === params.customer).map(copy) };
      },
      async retrieve(id) {
        called("subscriptions.retrieve", id);
        if (!state.subscriptions.has(id)) throw missing("subscription", id);
        return copy(state.subscriptions.get(id));
      },
    },
    checkout: {
      sessions: {
        async create(config, options) {
          called("checkout.sessions.create", config);
          const id = next("cs_test");
          state.sessions.push({ id, config: copy(config), options });
          return { id, url: `https://checkout.stripe.test/c/pay/${id}`, expires_at: Math.floor(Date.now() / 1000) + 86400 };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          called("billingPortal.sessions.create", params);
          if (params.flow_data && state.portalRefusesSwitch) {
            throw stripeError(
              "The price specified in flow_data.subscription_update_confirm.items[0].price is not in the configuration's features.subscription_update.products."
            );
          }
          const session = { id: next("bps_test"), url: `https://billing.stripe.test/p/session/${n}` };
          state.portals.push({ params: copy(params), url: session.url });
          return session;
        },
      },
    },
  };
}

// ------------------------------------------------------------------ fixtures

let stripe = fakeStripe();
let detach;
let server;
let origin;
let pickupRouter;

before(async () => {
  detach = await attachPglite(db);
  // What the auth middleware and the invoice handler read, beyond the shared helper's users.
  await db.schema.alterTable("users", (t) => {
    t.integer("auth_version").defaultTo(0);
    t.boolean("stripe_payment_method_attached").defaultTo(false);
    t.integer("intl_spend_since_charge_cents").defaultTo(0);
    t.text("intl_blocked_reason").nullable();
  });
  // The real subscriptions and checkout-attempt tables, and the pickups.
  await db.schema.dropTable("billing_checkout_attempts");
  await billingUp(db);
  await checkoutIntegrityUp(db);
  await pickupsUp(db);

  // R2 as far as leaving a small link pickup goes: it only hands out links.
  const r2 = {
    presignPut: (key, size) => `https://r2.test/${key}?size=${size}`,
    presignUploadPart: (key, uploadId, part) => `https://r2.test/${key}?part=${part}`,
    createMultipartUpload: async () => "upload-1",
    abortMultipartUpload: async () => {},
  };
  pickupRouter = createForgeDropPickupRouter({
    db,
    hasProductEntitlement,
    listProductEntitlements,
    signingKey: () => env.licenseSigningKey,
    r2,
    sweepEveryMs: 0,
    rate: { createPerMinute: 1e6, requestsPerMinute: 1e6 },
    rateLimitPrefix: "fdp-billing-test",
  });

  const app = express();
  app.use("/v1/forgedrop/pickup", pickupRouter);
  app.use(express.json());
  app.post("/checkout", requireAuth, createCloudPickupCheckoutHandler({ getStripe: () => stripe }));
  // The real router, with no Stripe key: the route is there, and says so.
  app.use("/v1/billing", billingRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  pickupRouter?.stop();
  server?.closeAllConnections?.();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await detach?.();
});

function useStripe() {
  stripe = fakeStripe();
  return stripe;
}

let people = 0;
async function signUp(name, { owns = [], referredBy = null, code = null, cashApp = null } = {}) {
  people += 1;
  const id = randomUUID();
  const email = `${name}-${people}@example.com`;
  await db("users").insert({
    id,
    email,
    referred_by_user_id: referredBy?.id || null,
    referral_code_id: code?.id || null,
    cash_app_tag: cashApp,
  });
  for (const slug of owns) await grantProductEntitlement({ userId: id, productSlug: slug, source: "test" });
  return { id, email, token: issueCustomerAccessToken({ id, email }) };
}

async function referralCode(person, metadata = {}, status = "active") {
  const row = {
    id: randomUUID(),
    user_id: person.id,
    email: person.email,
    code: `C${crypto.randomBytes(5).toString("hex").toUpperCase()}`,
    status,
    metadata,
  };
  await db("referral_codes").insert(row);
  return row;
}

async function checkout(person, body, path = "/checkout") {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(person ? { Authorization: `Bearer ${person.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

let events = 0;
const event = (type, object) => ({ id: `evt_test_${(events += 1)}`, type, data: { object: structuredClone(object) } });

/** Stripe finishing a Checkout Session this backend opened: the subscription, and the event. */
function completeCheckout(fake, sessionId) {
  const { config } = fake.state.sessions.find((session) => session.id === sessionId);
  const price = config.line_items[0].price;
  const subscription = fake.addSubscription({
    customer: config.customer,
    metadata: config.subscription_data.metadata,
    price,
  });
  const tier = CLOUD_PICKUP_TIERS.find((each) => PRICES[each.key] === price);
  return {
    subscription,
    completed: event("checkout.session.completed", {
      id: sessionId,
      object: "checkout.session",
      mode: "subscription",
      customer: config.customer,
      subscription: subscription.id,
      client_reference_id: config.client_reference_id,
      payment_status: "paid",
      amount_total: tier.monthlyCents,
      metadata: config.metadata,
    }),
  };
}

/** A subscription bought and fulfilled, as the tests after the checkout ones need one. */
async function subscribed(person, tierKey) {
  const opened = await checkout(person, { tier: tierKey });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const { subscription, completed } = completeCheckout(stripe, opened.body.sessionId);
  await handleStripeEvent(completed, stripe);
  return subscription;
}

function paidInvoice({ id, subscription, price, amountPaid, billingReason = "subscription_cycle" }) {
  return {
    id,
    object: "invoice",
    customer: subscription.customer,
    subscription: subscription.id,
    status: "paid",
    amount_paid: amountPaid,
    amount_remaining: 0,
    billing_reason: billingReason,
    lines: {
      object: "list",
      data: [{ id: `il_${id}`, type: "subscription", price: { id: price, metadata: {} }, metadata: {} }],
    },
  };
}

async function pickupPlans(userId) {
  const rows = await db("product_entitlements")
    .where({ user_id: userId })
    .whereIn("product_slug", TIER_SLUGS)
    .orderBy("product_slug");
  return rows.map((row) => [row.product_slug, row.status]);
}

async function heldTier(userId) {
  return tierFromEntitlements(await listProductEntitlements(userId))?.key || null;
}

async function shares(userId) {
  const rows = await db("reward_queue")
    .where({ user_id: userId, product_slug: "forgedrop-cloud-pickup" })
    .orderBy("reward_key");
  return rows.map((row) => [row.reward_key, row.reward_amount_cents, row.status]);
}

// ------------------------------------------------------------------ checkout

test("each tier opens Stripe Checkout for a monthly subscription on its own price, with what the webhook needs", async () => {
  useStripe();
  for (const tier of CLOUD_PICKUP_TIERS) {
    const buyer = await signUp(`buyer-${tier.key}`, { owns: ["forgedrop"] });
    const res = await checkout(buyer, { tier: tier.key });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const { id, config, options } = stripe.state.sessions.at(-1);
    const customer = (await db("users").where({ id: buyer.id }).first()).stripe_customer_id;
    const item = {
      kind: "subscription",
      slug: "forgedrop-cloud-pickup",
      displayName: `ForgeDrop Cloud pickup — ${tier.label}`,
      entitlementSlug: tier.slug,
      tier: tier.key,
      unitAmountCents: tier.monthlyCents,
      quantity: 1,
    };
    assert.deepEqual(res.body, {
      ok: true,
      url: `https://checkout.stripe.test/c/pay/${id}`,
      sessionId: id,
      reused: false,
      tier: tier.key,
      checkout: { items: [item] },
    });

    assert.equal(config.mode, "subscription");
    assert.deepEqual(config.line_items, [{ price: PRICES[tier.key], quantity: 1 }], "the tier's own price, from its env var");
    assert.deepEqual(config.payment_method_types, ["card"]);
    assert.ok(customer?.startsWith("cus_test_"), "the account's own Stripe customer");
    assert.equal(config.customer, customer);
    assert.equal(config.client_reference_id, buyer.id);
    assert.equal(config.success_url, SUCCESS_URL);
    assert.equal(config.cancel_url, CANCEL_URL);
    assert.deepEqual(config.metadata, {
      user_id: buyer.id,
      product_slug: "forgedrop-cloud-pickup",
      fulfillment_type: "multi_entitlement_cart",
      checkout_items: JSON.stringify([item]),
    });
    assert.deepEqual(config.subscription_data.metadata, {
      user_id: buyer.id,
      product_slug: "forgedrop-cloud-pickup",
      entitlement_slug: tier.slug,
      plan: "forgedrop_cloud_pickup",
      tier: tier.key,
      fulfillment_type: "subscription_entitlement",
      checkout_items: JSON.stringify([item]),
    });
    assert.equal(config.payment_method_collection, "always");
    assert.equal(
      config.custom_text.submit.message,
      `Cloud pickup, ${tier.label} sent a month, renews automatically at $${tier.monthlyCents / 100}/month until canceled from your SendForge account.`
    );
    assert.match(options.idempotencyKey, /^tabforge-checkout-v4:[0-9a-f]{64}$/);

    const attempt = await db("billing_checkout_attempts").where({ stripe_checkout_session_id: id }).first();
    assert.deepEqual([attempt.user_id, attempt.product_slug, attempt.status], [buyer.id, "forgedrop-cloud-pickup", "open"]);

    // A second click on the same tier reopens the same session.
    const again = await checkout(buyer, { tier: tier.key.toUpperCase() });
    assert.deepEqual([again.body.sessionId, again.body.reused], [id, true]);
  }
  assert.equal(stripe.state.sessions.length, 4, "one Stripe session per tier, none for the repeats");
  // "$5, $10, $15 and $25 a month for 100 GB, 250 GB, 500 GB and 1 TB sent"
  assert.deepEqual(
    stripe.state.sessions.map(({ config }) => config.custom_text.submit.message.match(/at (\$\d+)\/month/)[1]),
    ["$5", "$10", "$15", "$25"]
  );
});

test("a tier whose price id is not set answers 503 plan_unavailable, and Stripe is not asked", async () => {
  useStripe();
  const kim = await signUp("kim", { owns: ["forgedrop"] });

  const saved = process.env.STRIPE_PRICE_FORGEDROP_PICKUP_1TB;
  try {
    delete process.env.STRIPE_PRICE_FORGEDROP_PICKUP_1TB;
    assert.deepEqual(await checkout(kim, { tier: "1tb" }), { status: 503, body: { error: "plan_unavailable", tier: "1tb" } });
    process.env.STRIPE_PRICE_FORGEDROP_PICKUP_1TB = "   ";
    assert.deepEqual(await checkout(kim, { tier: "1tb" }), { status: 503, body: { error: "plan_unavailable", tier: "1tb" } });
  } finally {
    process.env.STRIPE_PRICE_FORGEDROP_PICKUP_1TB = saved;
  }
  assert.deepEqual(stripe.state.calls, [], "no customer, no session");
  assert.equal((await db("users").where({ id: kim.id }).first()).stripe_customer_id, null);

  // A price id Stripe does not know under this key (made in test mode, say) is not on sale either.
  const saved500 = process.env.STRIPE_PRICE_FORGEDROP_PICKUP_500GB;
  try {
    process.env.STRIPE_PRICE_FORGEDROP_PICKUP_500GB = "price_made_under_the_test_key";
    assert.deepEqual(await checkout(kim, { tier: "500gb" }), { status: 503, body: { error: "plan_unavailable", tier: "500gb" } });
  } finally {
    process.env.STRIPE_PRICE_FORGEDROP_PICKUP_500GB = saved500;
  }
  assert.equal(stripe.state.sessions.length, 0);

  // Only the four tiers, and only for someone signed in.
  for (const body of [{}, { tier: "2tb" }, { tier: "forgedrop-cloud-pickup-100gb" }, { tier: 100 }]) {
    assert.deepEqual(await checkout(kim, body), { status: 400, body: { error: "invalid_input" } }, JSON.stringify(body));
  }
  assert.equal((await checkout(null, { tier: "100gb" })).status, 401);

  // The real billing router carries the route: without a Stripe key it gets as far as Stripe.
  const path = "/v1/billing/forgedrop-pickup/checkout-session";
  assert.deepEqual(await checkout(kim, { tier: "100gb" }, path), { status: 500, body: { error: "stripe_not_configured" } });
  delete process.env.STRIPE_PRICE_FORGEDROP_PICKUP_100GB;
  try {
    assert.deepEqual(await checkout(kim, { tier: "100gb" }, path), { status: 503, body: { error: "plan_unavailable", tier: "100gb" } });
  } finally {
    process.env.STRIPE_PRICE_FORGEDROP_PICKUP_100GB = PRICES["100gb"];
  }
});

test("one plan per account: the same tier is already_subscribed, another tier is a switch in the billing portal", async () => {
  useStripe();
  const ray = await signUp("ray", { owns: ["forgedrop"] });
  const opened = await checkout(ray, { tier: "100gb" });
  // Paid, and no webhook yet: Stripe's own list of the customer's subscriptions still counts.
  const { subscription, completed } = completeCheckout(stripe, opened.body.sessionId);
  const customer = subscription.customer;
  const sessionsBefore = stripe.state.sessions.length;

  const same = await checkout(ray, { tier: "100gb" });
  assert.deepEqual(same, {
    status: 409,
    body: {
      error: "already_subscribed",
      tier: "100gb",
      message: "This account already has Cloud pickup 100 GB. Manage it from Account.",
    },
  });

  const upgrade = await checkout(ray, { tier: "1tb" });
  const portal = stripe.state.portals.at(-1);
  assert.deepEqual(upgrade, {
    status: 200,
    body: { ok: true, url: portal.url, portal: true, tier: "1tb", currentTier: "100gb" },
  });
  assert.deepEqual(portal.params, {
    customer,
    return_url: CANCEL_URL,
    flow_data: {
      type: "subscription_update_confirm",
      subscription_update_confirm: {
        subscription: subscription.id,
        items: [{ id: `si_${subscription.id}`, price: PRICES["1tb"], quantity: 1 }],
      },
      after_completion: { type: "redirect", redirect: { return_url: SWITCHED_URL } },
    },
  });

  // Until the portal's settings list the four prices, Stripe refuses that deep
  // link, and the portal's front page opens instead.
  stripe.state.portalRefusesSwitch = true;
  const fallback = await checkout(ray, { tier: "500gb" });
  assert.deepEqual(fallback.body, {
    ok: true,
    url: stripe.state.portals.at(-1).url,
    portal: true,
    tier: "500gb",
    currentTier: "100gb",
  });
  assert.deepEqual(stripe.state.portals.at(-1).params, { customer, return_url: CANCEL_URL });
  assert.equal(stripe.state.sessions.length, sessionsBefore, "never a second Checkout");

  // Once the webhook has run, a subscription under a Stripe customer the
  // account no longer uses still counts, from the subscriptions table.
  await handleStripeEvent(completed, stripe);
  const replacement = await stripe.customers.create({ email: ray.email });
  await db("users").where({ id: ray.id }).update({ stripe_customer_id: replacement.id });
  assert.equal((await checkout(ray, { tier: "100gb" })).body.error, "already_subscribed");
  const elsewhere = await checkout(ray, { tier: "250gb" });
  assert.deepEqual([elsewhere.body.portal, elsewhere.body.currentTier], [true, "100gb"]);
  assert.deepEqual(stripe.state.portals.at(-1).params, { customer: replacement.id, return_url: CANCEL_URL });

  // A tier granted by hand is not bought again; another tier still can be.
  const hal = await signUp("hal", { owns: ["forgedrop", "forgedrop-cloud-pickup-250gb"] });
  assert.equal((await checkout(hal, { tier: "250gb" })).body.error, "already_subscribed");
  assert.equal((await checkout(hal, { tier: "1tb" })).status, 200);
});

// ------------------------------------------------------------------ webhooks

test("the webhook grants the tier that is paid for, follows a switch, and takes the plan away when it ends", async () => {
  useStripe();
  const pat = await signUp("pat", { owns: ["forgedrop"] });
  const opened = await checkout(pat, { tier: "100gb" });
  const { subscription, completed } = completeCheckout(stripe, opened.body.sessionId);
  const id = subscription.id;
  const sourceRef = `subscription:${id}:forgedrop-cloud-pickup`;

  // Events arrive in any order, and some more than once.
  await handleStripeEvent(event("customer.subscription.created", subscription), stripe);
  await handleStripeEvent(completed, stripe);
  await handleStripeEvent(completed, stripe);

  const plan = await db("product_entitlements").where({ user_id: pat.id, product_slug: "forgedrop-cloud-pickup-100gb" }).first();
  assert.deepEqual([plan.status, plan.source, plan.source_ref], ["active", "stripe_subscription", sourceRef]);
  assert.deepEqual(
    [plan.metadata.subscription_id, plan.metadata.cloud_pickup_tier, plan.metadata.monthly_bytes, plan.metadata.stripe_price_id],
    [id, "100gb", 100 * GB, PRICES["100gb"]]
  );
  assert.deepEqual(
    (await listProductEntitlements(pat.id)).map((row) => row.product_slug).sort(),
    ["forgedrop", "forgedrop-cloud-pickup-100gb"],
    "Cloud pickup and nothing else"
  );
  const row = await db("subscriptions").where({ provider_subscription_id: id }).first();
  assert.deepEqual([row.user_id, row.plan, row.status], [pat.id, "forgedrop_cloud_pickup", "active"]);
  assert.equal((await db("billing_checkout_attempts").where({ stripe_checkout_session_id: opened.body.sessionId }).first()).status, "completed");
  assert.equal(await heldTier(pat.id), "100gb");

  // A switch in the billing portal changes the price; the plan follows the price.
  stripe.setPrice(id, PRICES["500gb"]);
  await handleStripeEvent(event("customer.subscription.updated", stripe.subscription(id)), stripe);
  assert.deepEqual(await pickupPlans(pat.id), [
    ["forgedrop-cloud-pickup-100gb", "revoked"],
    ["forgedrop-cloud-pickup-500gb", "active"],
  ]);
  assert.equal(
    (await db("product_entitlements").where({ user_id: pat.id, product_slug: "forgedrop-cloud-pickup-100gb" }).first()).metadata.replaced_by,
    "forgedrop-cloud-pickup-500gb"
  );
  assert.equal(await heldTier(pat.id), "500gb");

  // A payment that failed keeps the plan through the seven days' grace...
  stripe.setStatus(id, "past_due");
  await handleStripeEvent(event("invoice.payment_failed", { id: "in_pat_late", customer: subscription.customer, subscription: id }), stripe);
  assert.equal(await heldTier(pat.id), "500gb");
  // ...and not past it.
  await db("subscriptions")
    .where({ provider_subscription_id: id })
    .update({ raw: db.raw("raw || ?::jsonb", [JSON.stringify({ past_due_since: new Date(Date.now() - 9 * DAY).toISOString() })]) });
  await handleStripeEvent(event("customer.subscription.updated", stripe.subscription(id)), stripe);
  assert.equal(await heldTier(pat.id), null);

  // Paid after all: back. Unpaid at the end of Stripe's retries: gone.
  stripe.setStatus(id, "active");
  await handleStripeEvent(event("customer.subscription.updated", stripe.subscription(id)), stripe);
  assert.equal(await heldTier(pat.id), "500gb");
  stripe.setStatus(id, "unpaid");
  await handleStripeEvent(event("customer.subscription.updated", stripe.subscription(id)), stripe);
  assert.equal(await heldTier(pat.id), null);
  assert.deepEqual(await pickupPlans(pat.id), [
    ["forgedrop-cloud-pickup-100gb", "revoked"],
    ["forgedrop-cloud-pickup-500gb", "revoked"],
  ]);

  // Cancelled: gone, and a replay of an older event does not bring it back.
  stripe.setStatus(id, "active");
  await handleStripeEvent(event("customer.subscription.updated", stripe.subscription(id)), stripe);
  const stale = event("customer.subscription.updated", stripe.subscription(id));
  stripe.setStatus(id, "canceled");
  await handleStripeEvent(event("customer.subscription.deleted", stripe.subscription(id)), stripe);
  assert.equal(await heldTier(pat.id), null);
  await handleStripeEvent(stale, stripe);
  assert.equal(await heldTier(pat.id), null, "the subscription's current status decides, not the event's");
  assert.deepEqual(await pickupPlans(pat.id), [
    ["forgedrop-cloud-pickup-100gb", "revoked"],
    ["forgedrop-cloud-pickup-500gb", "revoked"],
  ]);
  assert.equal((await db("subscriptions").where({ provider_subscription_id: id }).first()).status, "canceled");

  // A deletion Stripe can no longer look up is taken at its word.
  const val = await signUp("val", { owns: ["forgedrop"] });
  const valSub = await subscribed(val, "250gb");
  assert.equal(await heldTier(val.id), "250gb");
  stripe.state.subscriptions.delete(valSub.id);
  await handleStripeEvent(event("customer.subscription.deleted", { ...valSub, status: "canceled" }), stripe);
  assert.equal(await heldTier(val.id), null);
});

test("a tier granted by hand is left alone when a subscription ends", async () => {
  useStripe();
  const ivy = await signUp("ivy", { owns: ["forgedrop", "forgedrop-cloud-pickup-1tb"] });
  const sub = await subscribed(ivy, "100gb");
  assert.equal(await heldTier(ivy.id), "1tb", "the bigger plan counts");
  stripe.setStatus(sub.id, "canceled");
  await handleStripeEvent(event("customer.subscription.deleted", stripe.subscription(sub.id)), stripe);
  assert.deepEqual(await pickupPlans(ivy.id), [
    ["forgedrop-cloud-pickup-100gb", "revoked"],
    ["forgedrop-cloud-pickup-1tb", "active"],
  ]);
});

test("the pickup allowance sees the plan the webhook granted, and loses it when the plan ends", async () => {
  useStripe();
  const lee = await signUp("lee", { owns: ["forgedrop"] });
  const desktop = await activateDevice({
    userId: lee.id,
    productSlug: "forgedrop",
    deviceId: randomUUID(),
    deviceName: "Lee PC",
    platform: "windows",
    appVersion: "1.6.0",
    deviceLimit: 5,
  });
  const leave = async (bytes) => {
    const response = await fetch(`${origin}/v1/forgedrop/pickup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ForgeDrop-License": desktop.token },
      body: JSON.stringify({ recipient: { link: true }, objects: [bytes], manifestSize: 100 }),
    });
    return { status: response.status, body: await response.json() };
  };

  assert.deepEqual(await leave(1000), { status: 402, body: { error: "plan_required" } });

  const sub = await subscribed(lee, "250gb");
  // The plan's own size is what the allowance holds to.
  assert.deepEqual(await leave(250 * GB), {
    status: 403,
    body: { error: "allowance_used", allowance: { bytes: 250 * GB, used: 0 } },
  });
  const fits = await leave(1000);
  assert.equal(fits.status, 201, JSON.stringify(fits.body));

  // Switched up to 1 TB in the portal: the allowance grows with it.
  stripe.setPrice(sub.id, PRICES["1tb"]);
  await handleStripeEvent(event("customer.subscription.updated", stripe.subscription(sub.id)), stripe);
  assert.equal((await leave(250 * GB)).status, 201);

  stripe.setStatus(sub.id, "canceled");
  await handleStripeEvent(event("customer.subscription.deleted", stripe.subscription(sub.id)), stripe);
  assert.deepEqual(await leave(1000), { status: 402, body: { error: "plan_required" } });
});

// ----------------------------------------------------------- affiliate share

test("every paid Cloud pickup invoice pays the ForgeDrop affiliate 5%, once per invoice however often Stripe sends it", async () => {
  useStripe();
  // Gus referred Ada; Ada, an affiliate who owns nothing, referred Sam.
  const gus = await signUp("gus", { cashApp: "$gus" });
  const gusCode = await referralCode(gus, { affiliate: true });
  const ada = await signUp("ada", { cashApp: "$ada", referredBy: gus, code: gusCode });
  const adaCode = await referralCode(ada, { affiliate: true });
  const sam = await signUp("sam", { owns: ["forgedrop"], referredBy: ada, code: adaCode });
  const sub = await subscribed(sam, "250gb");

  const first = paidInvoice({ id: "in_sam_1", subscription: sub, price: PRICES["250gb"], amountPaid: 1000, billingReason: "subscription_create" });
  await handleStripeEvent(event("invoice.paid", first), stripe);
  await handleStripeEvent(event("invoice.paid", first), stripe);
  await handleStripeEvent(event("invoice.paid", first), stripe);
  assert.deepEqual(await shares(ada.id), [["cloud_pickup_share:in_sam_1", 50, "pending"]], "one row, however often it comes");

  const row = await db("reward_queue").where({ user_id: ada.id, reward_key: "cloud_pickup_share:in_sam_1" }).first();
  assert.deepEqual(
    [row.referral_code_id, row.email, row.cashapp_handle, row.reward_type],
    [adaCode.id, ada.email, "$ada", "cashapp_manual"]
  );
  assert.deepEqual(
    {
      kind: row.metadata.kind,
      level: row.metadata.level,
      rate: row.metadata.share_rate,
      invoice: row.metadata.invoice_ref,
      paid: row.metadata.net_paid_cents,
      subscriber: row.metadata.subscriber_user_id,
      subscription: row.metadata.stripe_subscription_id,
      tier: row.metadata.cloud_pickup_tier,
      reason: row.metadata.billing_reason,
    },
    {
      kind: "cloud_pickup_share",
      level: 1,
      rate: 0.05,
      invoice: "in_sam_1",
      paid: 1000,
      subscriber: sam.id,
      subscription: sub.id,
      tier: "250gb",
      reason: "subscription_create",
    }
  );

  // Each month is its own invoice; a switch to 1 TB pays 5% of $25; a free month pays nothing.
  await handleStripeEvent(event("invoice.paid", paidInvoice({ id: "in_sam_2", subscription: sub, price: PRICES["250gb"], amountPaid: 1000 })), stripe);
  await handleStripeEvent(event("invoice.paid", paidInvoice({ id: "in_sam_3", subscription: sub, price: PRICES["1tb"], amountPaid: 2500 })), stripe);
  await handleStripeEvent(event("invoice.paid", paidInvoice({ id: "in_sam_4", subscription: sub, price: PRICES["1tb"], amountPaid: 0 })), stripe);
  assert.deepEqual(await shares(ada.id), [
    ["cloud_pickup_share:in_sam_1", 50, "pending"],
    ["cloud_pickup_share:in_sam_2", 50, "pending"],
    ["cloud_pickup_share:in_sam_3", 125, "pending"],
  ]);
  assert.deepEqual([500, 1000, 1500, 2500].map(cloudPickupShareCents), [25, 50, 75, 125]);

  // One level: whoever referred Ada earns nothing on Sam.
  assert.deepEqual(await shares(gus.id), []);
  assert.equal((await db("reward_queue").where({ user_id: gus.id })).length, 0);

  // The owner can approve it: the payout gate is the affiliate level, and
  // the milestone count does not apply to a share of one invoice.
  assert.equal(await rewardPayoutEligibility(ada.id, "forgedrop-cloud-pickup"), true);
  assert.equal(isCloudPickupShareReward(row), true);
  assert.equal(isCloudPickupShareReward({ ...row, metadata: { kind: "sync_share" } }), false);

  // An invoice Stripe describes only by the subscription's metadata still counts.
  const described = paidInvoice({ id: "in_sam_5", subscription: sub, price: "price_not_one_of_ours", amountPaid: 1500 });
  described.subscription_details = { metadata: { plan: "forgedrop_cloud_pickup", tier: "500gb" } };
  await handleStripeEvent(event("invoice.paid", described), stripe);
  assert.deepEqual((await shares(ada.id)).at(-1), ["cloud_pickup_share:in_sam_5", 75, "pending"]);
});

test("no share for a referrer below the ForgeDrop affiliate level", async () => {
  useStripe();
  const referrer = async (name, { owns = [], metadata, status = "active" }) => {
    const person = await signUp(name, { owns, cashApp: `$${name}` });
    return { person, code: await referralCode(person, metadata, status) };
  };
  // Owns ForgeDrop, so holds an ordinary referral code, but is no affiliate.
  const owner = await referrer("owner", { owns: ["forgedrop"], metadata: { source: "auto_user_signup" } });
  // Owns TabForge Pro: the Private Sync gate, not this one.
  const pro = await referrer("pro", { owns: ["tabforge"], metadata: { source: "auto_user_signup" } });
  // An affiliate the owner set to earn nothing on ForgeDrop.
  const zeroed = await referrer("zeroed", { metadata: { affiliate: true, flat_rates: { forgedrop: 0 } } });
  // An affiliate whose code the owner switched off.
  const retired = await referrer("retired", { metadata: { affiliate: true }, status: "inactive" });

  for (const { person, code } of [owner, pro, zeroed, retired]) {
    const customer = await signUp(`customer-of-${person.email.split("@")[0]}`, { owns: ["forgedrop"], referredBy: person, code });
    const sub = await subscribed(customer, "100gb");
    await handleStripeEvent(event("invoice.paid", paidInvoice({ id: `in_${sub.id}`, subscription: sub, price: PRICES["100gb"], amountPaid: 500 })), stripe);
    assert.deepEqual(await shares(person.id), [], person.email);
    assert.equal(await rewardPayoutEligibility(person.id, "forgedrop-cloud-pickup"), false, person.email);
    assert.deepEqual(
      await recordCloudPickupShare({ subscriberUserId: customer.id, invoiceRef: `in_direct_${sub.id}`, netPaidCents: 500 }),
      { recorded: false, reason: "referrer_not_forgedrop_affiliate" }
    );
  }

  // A comp code's per-sale TabForge rate makes its holder an affiliate, and so
  // at the ForgeDrop affiliate level too, as it is for ForgeDrop sales.
  assert.equal(isForgeDropAffiliateCode({ status: "active", metadata: { commission: { mode: "per_sale", rewardAmountCents: 300 } } }), true);
  assert.equal(isForgeDropAffiliateCode({ status: "active", metadata: { affiliate: true, flat_rates: { forgedrop: 700 } } }), true);
  assert.equal(isForgeDropAffiliateCode({ status: "active", metadata: {} }), false);
  assert.equal(isForgeDropAffiliateCode(null), false);

  // Nobody referred, or referred by themselves: nothing.
  const loner = await signUp("loner", { owns: ["forgedrop"] });
  assert.deepEqual(
    await recordCloudPickupShare({ subscriberUserId: loner.id, invoiceRef: "in_loner", netPaidCents: 500 }),
    { recorded: false, reason: "no_referrer" }
  );
  await db("users").where({ id: loner.id }).update({ referred_by_user_id: loner.id });
  assert.deepEqual(
    await recordCloudPickupShare({ subscriberUserId: loner.id, invoiceRef: "in_loner", netPaidCents: 500 }),
    { recorded: false, reason: "self_referral" }
  );
});

// ------------------------------------------------------ everything else as it was

test("Private Sync, Romancing the Stone and one-off purchases go on as before", async () => {
  useStripe();

  // Private Sync: its own entitlement, its own 5% for a Pro-owning referrer, no Cloud pickup.
  const pro = await signUp("sync-referrer", { owns: ["tabforge"], cashApp: "$syncref" });
  const proCode = await referralCode(pro, { affiliate: true });
  const syncer = await signUp("syncer", { owns: ["tabforge"], referredBy: pro, code: proCode });
  const customer = (await stripe.customers.create({ email: syncer.email })).id;
  await db("users").where({ id: syncer.id }).update({ stripe_customer_id: customer });
  const sync = stripe.addSubscription({
    customer,
    price: "price_test_tabforge_sync",
    metadata: {
      user_id: syncer.id,
      product_slug: "tabforge-collections-subscription",
      entitlement_slug: "tabforge-subscription",
      plan: "tabforge_private_sync",
      initial_pro_purchase: "false",
    },
  });
  assert.equal(isCloudPickupSubscription(sync), false);
  await handleStripeEvent(event("customer.subscription.created", sync), stripe);
  assert.deepEqual(
    (await listProductEntitlements(syncer.id)).map((row) => [row.product_slug, row.source_ref]).sort(),
    [
      ["tabforge", null],
      ["tabforge-subscription", `subscription:${sync.id}:tabforge-sync-collections`],
    ]
  );
  assert.equal((await db("subscriptions").where({ provider_subscription_id: sync.id }).first()).plan, "tabforge_private_sync");

  const syncInvoice = {
    id: "in_sync_1",
    object: "invoice",
    customer,
    subscription: sync.id,
    status: "paid",
    amount_paid: 500,
    billing_reason: "subscription_cycle",
    lines: { data: [{ price: { id: "price_test_tabforge_sync", metadata: {} }, description: "1 × TabForge Private Sync (at $5.00 / month)" }] },
  };
  assert.equal(cloudPickupInvoice(syncInvoice), null);
  await handleStripeEvent(event("invoice.paid", syncInvoice), stripe);
  await handleStripeEvent(event("invoice.paid", syncInvoice), stripe);
  const proRewards = await db("reward_queue").where({ user_id: pro.id });
  assert.deepEqual(
    proRewards.map((row) => [row.product_slug, row.reward_key, row.reward_amount_cents]),
    [["tabforge-subscription", "sync_share:in_sync_1", 25]],
    "the Private Sync share, once, and no Cloud pickup share"
  );

  stripe.setStatus(sync.id, "canceled");
  await handleStripeEvent(event("customer.subscription.deleted", stripe.subscription(sync.id)), stripe);
  assert.deepEqual(
    (await db("product_entitlements").where({ user_id: syncer.id }).orderBy("product_slug")).map((row) => [row.product_slug, row.status]),
    [["tabforge", "active"], ["tabforge-subscription", "revoked"]]
  );

  // Romancing the Stone's subscription keeps its own entitlement.
  const rae = await signUp("rae");
  const rts = stripe.addSubscription({
    customer: "cus_test_rae",
    price: "price_test_rts",
    status: "trialing",
    metadata: { user_id: rae.id, plan: "rts_subscription", product_slug: "romancing-the-stone", entitlement_slug: "romancing-the-stone-subscription" },
  });
  await handleStripeEvent(event("customer.subscription.created", rts), stripe);
  assert.deepEqual((await listProductEntitlements(rae.id)).map((row) => row.product_slug), ["romancing-the-stone-subscription"]);

  // A one-off ForgeDrop purchase is still a licence and a referral, never a plan.
  const buyer = await signUp("fd-buyer", { referredBy: pro, code: proCode });
  await handleStripeEvent(
    event("checkout.session.completed", {
      id: "cs_test_fd_once",
      customer: "cus_test_fd_once",
      payment_intent: "pi_test_fd_once",
      payment_status: "paid",
      amount_total: 2000,
      metadata: {
        user_id: buyer.id,
        product_slug: "forgedrop",
        fulfillment_type: "multi_entitlement_cart",
        checkout_items: JSON.stringify([{ kind: "product", slug: "forgedrop", entitlementSlug: "forgedrop", displayName: "ForgeDrop" }]),
      },
    }),
    {}
  );
  assert.deepEqual((await listProductEntitlements(buyer.id)).map((row) => row.product_slug), ["forgedrop"]);
  assert.deepEqual(
    (await db("reward_queue").where({ user_id: pro.id }).orderBy("product_slug")).map((row) => [row.product_slug, row.reward_amount_cents]),
    [["forgedrop", 1000], ["tabforge-subscription", 25]],
    "the affiliate's $10 ForgeDrop sale, as before"
  );

  // A Checkout event never grants a plan on its own; only the subscription does.
  const eve = await signUp("eve");
  await handleStripeEvent(
    event("checkout.session.completed", {
      id: "cs_test_eve",
      customer: "cus_test_eve",
      payment_intent: "pi_test_eve",
      payment_status: "paid",
      amount_total: 500,
      metadata: {
        user_id: eve.id,
        product_slug: "forgedrop-cloud-pickup",
        fulfillment_type: "multi_entitlement_cart",
        checkout_items: JSON.stringify([{ kind: "subscription", slug: "forgedrop-cloud-pickup", entitlementSlug: "forgedrop-cloud-pickup-100gb" }]),
      },
    }),
    {}
  );
  assert.deepEqual(await pickupPlans(eve.id), []);
});

test("the webhook still checks Stripe's signature before it handles anything, and the owner can pay a share", async () => {
  const webhook = await src("../src/routes/stripe.webhooks.routes.js");
  const handler = webhook.slice(webhook.indexOf("export async function handleStripeWebhook"));
  assert.ok(handler.indexOf("stripe.webhooks.constructEvent(") > 0);
  assert.ok(
    handler.indexOf("stripe.webhooks.constructEvent(") < handler.indexOf("await handleStripeEvent(event, stripe)"),
    "the signature is verified first"
  );
  assert.match(webhook, /recordCloudPickupShare\(\{\s*subscriberUserId: user\.id,\s*invoiceRef: String\(invoice\.id \|\| ""\)/);

  // Payout approval: the gate (rewardPayoutEligibility) still applies; only
  // the purchase-count check is skipped, and only for a Cloud pickup share.
  const admin = await src("../src/routes/admin.routes.js");
  const approval = admin.slice(admin.indexOf("async function applyRewardStatusChange"));
  assert.ok(approval.indexOf("rewardPayoutEligibility(") < approval.indexOf("!isCloudPickupShareReward(existing) &&"));
  assert.match(approval, /!isCloudPickupShareReward\(existing\) &&\s*\(!requiredPurchases \|\| verifiedCount < requiredPurchases\)/);
});
