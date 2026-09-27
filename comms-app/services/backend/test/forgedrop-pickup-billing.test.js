// ForgeDrop Cloud pickup billing: the four monthly plans sold through the
// shared catalog checkout, the subscription webhook that grants, moves and
// removes a plan, and the 5% share of every paid invoice for the ForgeDrop
// affiliate who brought the customer.
//
// Runs the real catalog checkout, the real Stripe event handling, the real
// referral service and the real Cloud pickup router against an in-process
// Postgres (PGlite). Stripe is a stand-in that answers from memory, so nothing
// here reaches Stripe; like Stripe, it hands out a subscription item's product
// as an id unless asked to expand it. The allowance is checked through the
// pickup router itself, with a desktop signed in by a real licence and an R2
// that only hands out links.

import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import express from "express";

import { attachPglite } from "./helpers/pglite-db.js";

// env.js reads the environment when it is first imported, so everything that
// touches it is imported after these are set. No Stripe key and no price ids,
// ever: the real router must stop at stripe_not_configured, and Cloud pickup
// never needs a Stripe Price object.
for (const name of [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_TABFORGE",
  "STRIPE_PRICE_TABFORGE_SYNC",
  "STRIPE_PRICE_FORGEDROP",
]) {
  delete process.env[name];
}
process.env.JWT_SECRET ||= "forgedrop-pickup-billing-test-secret-at-least-32-bytes";
process.env.LICENSE_SIGNING_KEY = crypto.randomBytes(32).toString("base64");
process.env.LICENSE_SIGNING_KID = "fd-test";
process.env.PUBLIC_SITE_URL = "https://sendforge.test";
// Cloud pickup is on sale only while R2 is set up, as it is on Render once
// the owner adds the bucket's key. The pickup router here is handed its own
// stand-in R2, so nothing below ever reaches Cloudflare.
process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
process.env.R2_ACCESS_KEY_ID = "test-access-key";
process.env.R2_SECRET_ACCESS_KEY = "test-secret-access-key";
process.env.R2_BUCKET = "forgedrop-pickup-test";

const { db } = await import("../src/config/db.js");
const { env } = await import("../src/config/env.js");
const { issueCustomerAccessToken } = await import("../src/services/auth.service.js");
const { requireAuth } = await import("../src/middleware/auth.js");
const { grantProductEntitlement, hasProductEntitlement, listProductEntitlements, revokeProductEntitlement } =
  await import("../src/services/entitlement.service.js");
const { activateDevice } = await import("../src/services/deviceActivation.service.js");
const { billingRouter, createCatalogCheckoutHandler } = await import("../src/routes/billing.routes.js");
const { handleStripeEvent } = await import("../src/routes/stripe.webhooks.routes.js");
const { CLOUD_PICKUP_TIERS, cloudPickupTierByKey, GB, tierFromEntitlements } = await import(
  "../src/modules/forgedrop-pickup/plans.js"
);
const { cloudPickupInvoice, cloudPickupSubscriptionIsEnding, isCloudPickupSubscription } = await import(
  "../src/modules/forgedrop-pickup/billing.js"
);
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
const CATALOG_ROUTE = "/v1/billing/catalog/checkout-session";
// The catalog checkout's own return URLs, as it builds them for every product.
const SUCCESS_URL = `${SITE}/account/index.html?purchase_context=forgedrop-cloud-pickup&checkout=success&session_id=%7BCHECKOUT_SESSION_ID%7D#forgedrop`;
const CANCEL_URL = `${SITE}/products/forgedrop/index.html?checkout=cancelled#cloud-pickup`;
const DAY = 24 * 60 * 60 * 1000;
const tierOf = (key) => cloudPickupTierByKey(key);

/** The line the catalog checkout builds for a tier: an inline monthly price on an inline product. */
function catalogLine(tier) {
  return {
    currency: "usd",
    unit_amount: tier.monthlyCents,
    recurring: { interval: "month" },
    product_data: {
      name: `ForgeDrop Cloud pickup — ${tier.label}`,
      metadata: { kind: "subscription", slug: tier.slug, entitlement_slug: tier.slug },
    },
  };
}

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
    products: new Map(),
    subscriptions: new Map(),
    sessions: [],
    portals: [],
  };
  const called = (name, args) => state.calls.push([name, args]);
  const copy = (value) => structuredClone(value);

  /** What Checkout makes of an inline price_data line: a product carrying its metadata, and a price on it. */
  const priceFrom = (priceData) => {
    const product = { id: next("prod_test"), object: "product", ...copy(priceData.product_data) };
    state.products.set(product.id, product);
    return {
      id: next("price_test"),
      object: "price",
      product: product.id,
      unit_amount: priceData.unit_amount,
      recurring: copy(priceData.recurring),
      metadata: {},
    };
  };

  /** A subscription as Stripe returns it: each item's product an id, unless asked to expand it. */
  const present = (subscription, expand = []) => {
    const out = copy(subscription);
    if (expand.includes("items.data.price.product")) {
      for (const item of out.items.data) item.price.product = copy(state.products.get(item.price.product));
    }
    return out;
  };

  return {
    state,
    addSubscription({ customer, metadata = {}, priceData, status = "active" }) {
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
          data: [{ id: `si_${id}`, object: "subscription_item", quantity: 1, price: priceFrom(priceData) }],
        },
      };
      state.subscriptions.set(id, subscription);
      return present(subscription);
    },
    /** The item moved onto another catalog product, as the owner can do in Stripe's dashboard. */
    moveTo(id, priceData) {
      state.subscriptions.get(id).items.data[0].price = priceFrom(priceData);
    },
    setStatus(id, status) {
      state.subscriptions.get(id).status = status;
    },
    /** Cancelled in the billing portal: it stays active, and ends with its period. */
    setEnding(id) {
      const subscription = state.subscriptions.get(id);
      subscription.cancel_at_period_end = true;
      subscription.cancel_at = subscription.current_period_end;
      subscription.canceled_at = Math.floor(Date.now() / 1000);
    },
    subscription(id) {
      return present(state.subscriptions.get(id));
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
        throw missing("price", id);
      },
    },
    subscriptions: {
      async list(params) {
        called("subscriptions.list", params);
        return {
          data: [...state.subscriptions.values()].filter((sub) => sub.customer === params.customer).map((sub) => present(sub)),
        };
      },
      async retrieve(id, params = {}) {
        called("subscriptions.retrieve", [id, params]);
        if (!state.subscriptions.has(id)) throw missing("subscription", id);
        return present(state.subscriptions.get(id), params.expand || []);
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

  // R2 as far as leaving a link pickup goes: it only hands out links.
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
  // The catalog checkout the store calls, handed the stand-in Stripe.
  app.post("/catalog", requireAuth, createCatalogCheckoutHandler({ getStripe: () => stripe }));
  // The same, on a server whose R2 settings are missing.
  app.post("/catalog-without-r2", requireAuth, createCatalogCheckoutHandler({ getStripe: () => stripe, r2Env: {} }));
  // The real router, with no Stripe key.
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

async function checkout(person, body, path = "/catalog") {
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
  const priceData = config.line_items[0].price_data;
  const subscription = fake.addSubscription({
    customer: config.customer,
    metadata: config.subscription_data.metadata,
    priceData,
  });
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
      amount_total: priceData.unit_amount,
      metadata: config.metadata,
    }),
  };
}

/** A plan bought through the catalog and fulfilled, as the tests after the checkout ones need one. */
async function subscribed(person, key) {
  const opened = await checkout(person, { productSlug: tierOf(key).slug });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const { subscription, completed } = completeCheckout(stripe, opened.body.sessionId);
  await handleStripeEvent(completed, stripe);
  return subscription;
}

/**
 * A paid invoice as Stripe sends it to the webhook: the line's product is an
 * id, and the line carries the subscription's metadata.
 */
function paidInvoice({ id, subscription, amountPaid, billingReason = "subscription_cycle" }) {
  const item = subscription.items.data[0];
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
      data: [
        {
          id: `il_${id}`,
          type: "subscription",
          price: { id: item.price.id, product: item.price.product, metadata: {} },
          metadata: { ...subscription.metadata },
        },
      ],
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

test("each tier is a catalog subscription at its monthly price, with the catalog's metadata and what the webhook needs", async () => {
  useStripe();
  for (const tier of CLOUD_PICKUP_TIERS) {
    const buyer = await signUp(`buyer-${tier.key}`, { owns: ["forgedrop"] });
    const res = await checkout(buyer, { productSlug: tier.slug });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const { id, config, options } = stripe.state.sessions.at(-1);
    const customer = (await db("users").where({ id: buyer.id }).first()).stripe_customer_id;
    const item = {
      kind: "subscription",
      slug: tier.slug,
      displayName: `ForgeDrop Cloud pickup — ${tier.label}`,
      entitlementSlug: tier.slug,
      unitAmountCents: tier.monthlyCents,
      quantity: 1,
    };
    assert.deepEqual(res.body, {
      ok: true,
      url: `https://checkout.stripe.test/c/pay/${id}`,
      sessionId: id,
      reused: false,
      checkout: { items: [item] },
    });

    assert.equal(config.mode, "subscription");
    // The catalog's own inline monthly price: no Stripe Price object.
    assert.deepEqual(config.line_items, [{ quantity: 1, price_data: catalogLine(tier) }]);
    assert.deepEqual(config.payment_method_types, ["card"]);
    assert.equal(config.allow_promotion_codes, true);
    assert.ok(customer?.startsWith("cus_test_"), "the account's own Stripe customer");
    assert.equal(config.customer, customer);
    assert.equal(config.client_reference_id, buyer.id);
    assert.equal(config.success_url, SUCCESS_URL);
    assert.equal(config.cancel_url, CANCEL_URL);
    assert.deepEqual(config.metadata, {
      user_id: buyer.id,
      product_slug: tier.slug,
      fulfillment_type: "multi_entitlement_cart",
      checkout_items: JSON.stringify([item]),
    });
    // Cloud pickup's own subscription metadata, never Private Sync's.
    assert.deepEqual(config.subscription_data, {
      metadata: {
        user_id: buyer.id,
        product_slug: tier.slug,
        entitlement_slug: tier.slug,
        plan: "forgedrop_cloud_pickup",
        tier: tier.key,
        fulfillment_type: "subscription_entitlement",
        checkout_items: JSON.stringify([item]),
      },
    });
    assert.equal(config.payment_method_collection, "always");
    assert.equal(
      config.custom_text.submit.message,
      `Cloud pickup, ${tier.label} sent a month, renews automatically at $${tier.monthlyCents / 100}/month until canceled from your SendForge account.`
    );
    assert.match(options.idempotencyKey, /^tabforge-checkout-v4:[0-9a-f]{64}$/);

    const attempt = await db("billing_checkout_attempts").where({ stripe_checkout_session_id: id }).first();
    assert.deepEqual([attempt.user_id, attempt.product_slug, attempt.status], [buyer.id, tier.slug, "open"]);

    // A second click on the same tier reopens the same session.
    const again = await checkout(buyer, { productSlug: tier.slug.toUpperCase() });
    assert.deepEqual([again.body.sessionId, again.body.reused], [id, true]);
  }
  assert.equal(stripe.state.sessions.length, 4, "one Stripe session per tier, none for the repeats");
  assert.deepEqual(
    stripe.state.sessions.map(({ config }) => [config.line_items[0].price_data.unit_amount, config.line_items[0].price_data.product_data.name]),
    [
      [500, "ForgeDrop Cloud pickup — 100 GB"],
      [1000, "ForgeDrop Cloud pickup — 250 GB"],
      [1500, "ForgeDrop Cloud pickup — 500 GB"],
      [2500, "ForgeDrop Cloud pickup — 1 TB"],
    ]
  );
  assert.deepEqual(stripe.state.calls.filter(([name]) => name === "prices.retrieve"), [], "no Stripe Price is ever looked up");
});

test("only a ForgeDrop owner can buy a plan: anyone else is forgedrop_required, before Stripe is asked anything", async () => {
  useStripe();
  const refused = {
    status: 403,
    body: { error: "forgedrop_required", message: "Cloud pickup is for ForgeDrop owners." },
  };
  const noah = await signUp("noah");
  // Another product's licence is not ForgeDrop.
  const rosa = await signUp("rosa", { owns: ["rose-colored-glasses"] });
  // A ForgeDrop purchase that was taken back no longer counts.
  const rex = await signUp("rex", { owns: ["forgedrop"] });
  await revokeProductEntitlement(rex.id, "forgedrop");

  for (const person of [noah, rosa, rex]) {
    for (const tier of CLOUD_PICKUP_TIERS) {
      assert.deepEqual(await checkout(person, { productSlug: tier.slug }), refused, `${person.email} ${tier.key}`);
    }
  }
  // The real route asks it too, ahead of its own Stripe key check.
  assert.deepEqual(await checkout(noah, { productSlug: "forgedrop-cloud-pickup-1tb" }, CATALOG_ROUTE), refused);
  assert.deepEqual(stripe.state.calls, [], "no customer, no subscription lookup, no session");
  for (const person of [noah, rosa, rex]) {
    assert.equal((await db("users").where({ id: person.id }).first()).stripe_customer_id, null);
    assert.equal((await db("billing_checkout_attempts").where({ user_id: person.id })).length, 0);
  }

  // An owner gets as far as Stripe on the real route, which has no key here.
  const kim = await signUp("kim", { owns: ["forgedrop"] });
  assert.deepEqual(await checkout(kim, { productSlug: "forgedrop-cloud-pickup-1tb" }, CATALOG_ROUTE), {
    status: 500,
    body: { error: "stripe_not_configured" },
  });
  // Only the four tiers, one at a time, for someone signed in.
  assert.deepEqual(await checkout(kim, { productSlug: "forgedrop-cloud-pickup-2tb" }), { status: 404, body: { error: "unknown_product" } });
  assert.deepEqual(await checkout(kim, { productSlug: "forgedrop-cloud-pickup-100gb", quantity: 2 }), {
    status: 400,
    body: { error: "invalid_quantity" },
  });
  assert.equal((await checkout(null, { productSlug: "forgedrop-cloud-pickup-100gb" })).status, 401);

  // Once the account owns ForgeDrop, the same request opens Checkout.
  await grantProductEntitlement({ userId: noah.id, productSlug: "forgedrop", source: "test" });
  const opened = await checkout(noah, { productSlug: "forgedrop-cloud-pickup-1tb" });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.deepEqual(stripe.state.sessions.map(({ config }) => config.line_items[0].price_data.unit_amount), [2500]);
});

test("no plan is sold while Cloud pickup cannot run: without R2 it is pickup_unavailable, before anything else is asked", async () => {
  useStripe();
  const unavailable = {
    status: 503,
    body: { error: "pickup_unavailable", message: "Cloud pickup isn't available right now. Try again later." },
  };
  const owner = await signUp("olga", { owns: ["forgedrop"] });
  const stranger = await signUp("stan");
  for (const person of [owner, stranger]) {
    for (const tier of CLOUD_PICKUP_TIERS) {
      assert.deepEqual(
        await checkout(person, { productSlug: tier.slug }, "/catalog-without-r2"),
        unavailable,
        `${person.email} ${tier.key}`
      );
    }
  }
  assert.deepEqual(stripe.state.calls, [], "no customer, no subscription lookup, no session");
  assert.equal((await db("billing_checkout_attempts").where({ user_id: owner.id })).length, 0);
  // One bad setting is as good as none.
  const half = createCatalogCheckoutHandler({ getStripe: () => stripe, r2Env: { ...process.env, R2_BUCKET: "" } });
  let answered;
  await half(
    { body: { productSlug: "forgedrop-cloud-pickup-100gb" }, user: { sub: owner.id } },
    { status: (code) => ({ json: (body) => (answered = { status: code, body }) }) }
  );
  assert.deepEqual(answered, unavailable);
  // The rest of the catalog does not depend on R2.
  assert.deepEqual(await checkout(owner, { productSlug: "forgedrop-cloud-pickup-2tb" }, "/catalog-without-r2"), {
    status: 404,
    body: { error: "unknown_product" },
  });
  // With R2 set up, the same owner reaches Checkout.
  const opened = await checkout(owner, { productSlug: "forgedrop-cloud-pickup-100gb" });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
});

/** The 409 the catalog gives an account whose plan runs on. */
function alreadySubscribed(requested, current) {
  const label = tierOf(current).label;
  return {
    status: 409,
    body: {
      error: "already_subscribed",
      productSlug: tierOf(requested).slug,
      currentProductSlug: tierOf(current).slug,
      message:
        requested === current
          ? `This account already has Cloud pickup ${label}. Manage it from Account.`
          : `This account has Cloud pickup ${label}. To change plans, cancel it under Account and choose the new one.`,
    },
  };
}

test("one plan per account: while a plan runs on, any tier is already_subscribed; once it is cancelled, another is bought at once", async () => {
  useStripe();
  const ray = await signUp("ray", { owns: ["forgedrop"] });
  const opened = await checkout(ray, { productSlug: "forgedrop-cloud-pickup-100gb" });
  // Paid, and no webhook yet: Stripe's own list of the customer's subscriptions still counts.
  const { subscription, completed } = completeCheckout(stripe, opened.body.sessionId);
  const sessionsBefore = stripe.state.sessions.length;

  assert.deepEqual(await checkout(ray, { productSlug: "forgedrop-cloud-pickup-100gb" }), alreadySubscribed("100gb", "100gb"));
  assert.deepEqual(await checkout(ray, { productSlug: "forgedrop-cloud-pickup-1tb" }), alreadySubscribed("1tb", "100gb"));
  assert.equal(
    alreadySubscribed("1tb", "100gb").body.message,
    "This account has Cloud pickup 100 GB. To change plans, cancel it under Account and choose the new one."
  );
  assert.equal(stripe.state.sessions.length, sessionsBefore, "never a second Checkout");

  // Once the webhook has run, a plan under a Stripe customer the account no
  // longer uses still counts, from the subscriptions table.
  await handleStripeEvent(completed, stripe);
  const original = subscription.customer;
  const replacement = await stripe.customers.create({ email: ray.email });
  await db("users").where({ id: ray.id }).update({ stripe_customer_id: replacement.id });
  assert.deepEqual(await checkout(ray, { productSlug: "forgedrop-cloud-pickup-250gb" }), alreadySubscribed("250gb", "100gb"));
  await db("users").where({ id: ray.id }).update({ stripe_customer_id: original });

  // Ray cancels under Account. The plan runs to the end of its period, and
  // no longer holds the account to it.
  stripe.setEnding(subscription.id);
  await handleStripeEvent(event("customer.subscription.updated", stripe.subscription(subscription.id)), stripe);
  assert.equal(cloudPickupSubscriptionIsEnding(stripe.subscription(subscription.id)), true);
  assert.equal(await heldTier(ray.id), "100gb", "still his until the period ends");
  // The same tier is his until then: nothing to buy.
  assert.deepEqual(await checkout(ray, { productSlug: "forgedrop-cloud-pickup-100gb" }), alreadySubscribed("100gb", "100gb"));
  // Another tier is bought straight away.
  const bigger = await checkout(ray, { productSlug: "forgedrop-cloud-pickup-1tb" });
  assert.equal(bigger.status, 200, JSON.stringify(bigger.body));
  assert.equal(stripe.state.sessions.at(-1).config.line_items[0].price_data.unit_amount, 2500);
  const { completed: biggerPaid } = completeCheckout(stripe, bigger.body.sessionId);
  await handleStripeEvent(biggerPaid, stripe);
  // Now the 1 TB plan is the one that runs on.
  assert.deepEqual(await checkout(ray, { productSlug: "forgedrop-cloud-pickup-250gb" }), alreadySubscribed("250gb", "1tb"));
  assert.deepEqual(await checkout(ray, { productSlug: "forgedrop-cloud-pickup-1tb" }), alreadySubscribed("1tb", "1tb"));
  assert.deepEqual(stripe.state.calls.filter(([name]) => name.startsWith("billingPortal")), [], "no billing portal on the way");

  assert.equal(cloudPickupSubscriptionIsEnding({ cancel_at_period_end: true }), true);
  assert.equal(cloudPickupSubscriptionIsEnding({ cancel_at: 1790000000 }), true);
  assert.equal(cloudPickupSubscriptionIsEnding({ cancel_at_period_end: false, cancel_at: null }), false);

  // A tier granted by hand is not bought again; another tier still can be.
  const hal = await signUp("hal", { owns: ["forgedrop", "forgedrop-cloud-pickup-250gb"] });
  assert.deepEqual(await checkout(hal, { productSlug: "forgedrop-cloud-pickup-250gb" }), alreadySubscribed("250gb", "250gb"));
  assert.equal((await checkout(hal, { productSlug: "forgedrop-cloud-pickup-1tb" })).status, 200);
});

// ------------------------------------------------------------------ webhooks

test("the webhook grants the tier its item's product names, follows it, and takes the plan away when it ends", async () => {
  useStripe();
  const pat = await signUp("pat", { owns: ["forgedrop"] });
  const opened = await checkout(pat, { productSlug: "forgedrop-cloud-pickup-100gb" });
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
    [plan.metadata.subscription_id, plan.metadata.cloud_pickup_tier, plan.metadata.monthly_bytes],
    [id, "100gb", 100 * GB]
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

  // The subscription's item moves to the 500 GB product, and only the item
  // says so: the subscription's own metadata still reads 100 GB. The plan
  // follows the product.
  stripe.moveTo(id, catalogLine(tierOf("500gb")));
  await handleStripeEvent(event("customer.subscription.updated", stripe.subscription(id)), stripe);
  assert.equal(stripe.subscription(id).metadata.entitlement_slug, "forgedrop-cloud-pickup-100gb");
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

  // Every lookup the webhook made asked Stripe for the item's product.
  const lookups = stripe.state.calls.filter(([name]) => name === "subscriptions.retrieve");
  assert.ok(lookups.length >= 8);
  for (const [, [, params]] of lookups) assert.ok(params.expand.includes("items.data.price.product"), JSON.stringify(params));

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

/**
 * A licensed desktop of `person`'s, and what leaving a link pickup of `bytes`
 * (plus a 100-byte manifest) answers through the real pickup router.
 */
async function desktopOf(person) {
  const desktop = await activateDevice({
    userId: person.id,
    productSlug: "forgedrop",
    deviceId: randomUUID(),
    deviceName: "Test PC",
    platform: "windows",
    appVersion: "1.6.0",
    deviceLimit: 5,
  });
  return async (bytes) => {
    const response = await fetch(`${origin}/v1/forgedrop/pickup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ForgeDrop-License": desktop.token },
      body: JSON.stringify({ recipient: { link: true }, objects: [bytes], manifestSize: 100 }),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("the pickup allowance sees the plan the webhook granted, and loses it when the plan ends", async () => {
  useStripe();
  const lee = await signUp("lee", { owns: ["forgedrop"] });
  const leave = await desktopOf(lee);

  assert.deepEqual(await leave(1000), { status: 402, body: { error: "plan_required" } });

  const sub = await subscribed(lee, "250gb");
  // The plan's own size is what the allowance holds to.
  assert.deepEqual(await leave(250 * GB), {
    status: 403,
    body: { error: "allowance_used", allowance: { bytes: 250 * GB, used: 0 } },
  });
  const fits = await leave(1000);
  assert.equal(fits.status, 201, JSON.stringify(fits.body));

  // Moved to the 1 TB product: the allowance grows with it.
  stripe.moveTo(sub.id, catalogLine(tierOf("1tb")));
  await handleStripeEvent(event("customer.subscription.updated", stripe.subscription(sub.id)), stripe);
  assert.equal((await leave(250 * GB)).status, 201);

  stripe.setStatus(sub.id, "canceled");
  await handleStripeEvent(event("customer.subscription.deleted", stripe.subscription(sub.id)), stripe);
  assert.deepEqual(await leave(1000), { status: 402, body: { error: "plan_required" } });
});

test("while a cancelled plan runs out beside the new one, the allowance is the larger of the two", async () => {
  useStripe();
  const end = async (sub) => {
    stripe.setStatus(sub.id, "canceled");
    await handleStripeEvent(event("customer.subscription.deleted", stripe.subscription(sub.id)), stripe);
  };
  const cancelUnderAccount = async (sub) => {
    stripe.setEnding(sub.id);
    await handleStripeEvent(event("customer.subscription.updated", stripe.subscription(sub.id)), stripe);
  };

  // Up: 100 GB cancelled, 1 TB bought at once. The 1 TB allowance applies straight away.
  const uma = await signUp("uma", { owns: ["forgedrop"] });
  const umaLeaves = await desktopOf(uma);
  const small = await subscribed(uma, "100gb");
  assert.deepEqual(await umaLeaves(100 * GB), {
    status: 403,
    body: { error: "allowance_used", allowance: { bytes: 100 * GB, used: 0 } },
  });
  await cancelUnderAccount(small);
  await subscribed(uma, "1tb");
  assert.deepEqual(await pickupPlans(uma.id), [
    ["forgedrop-cloud-pickup-100gb", "active"],
    ["forgedrop-cloud-pickup-1tb", "active"],
  ]);
  assert.equal(await heldTier(uma.id), "1tb");
  assert.equal((await umaLeaves(100 * GB)).status, 201, "the larger plan's allowance");
  // The cancelled plan's period ends; the new plan is what is left.
  await end(small);
  assert.deepEqual(await pickupPlans(uma.id), [
    ["forgedrop-cloud-pickup-100gb", "revoked"],
    ["forgedrop-cloud-pickup-1tb", "active"],
  ]);
  assert.equal(await heldTier(uma.id), "1tb");

  // Down: 1 TB cancelled, 100 GB bought. The 1 TB allowance holds until its
  // period is over, then 100 GB, against what was already sent this month.
  const dan = await signUp("dan", { owns: ["forgedrop"] });
  const danLeaves = await desktopOf(dan);
  const big = await subscribed(dan, "1tb");
  await cancelUnderAccount(big);
  await subscribed(dan, "100gb");
  assert.equal(await heldTier(dan.id), "1tb");
  assert.equal((await danLeaves(150 * GB)).status, 201, "still the 1 TB allowance");
  await end(big);
  assert.equal(await heldTier(dan.id), "100gb");
  assert.deepEqual(await danLeaves(1000), {
    status: 403,
    body: { error: "allowance_used", allowance: { bytes: 100 * GB, used: 150 * GB + 100 } },
  });
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

  const first = paidInvoice({ id: "in_sam_1", subscription: sub, amountPaid: 1000, billingReason: "subscription_create" });
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

  // Each month is its own invoice; $25 pays $1.25; a free month pays nothing.
  await handleStripeEvent(event("invoice.paid", paidInvoice({ id: "in_sam_2", subscription: sub, amountPaid: 1000 })), stripe);
  await handleStripeEvent(event("invoice.paid", paidInvoice({ id: "in_sam_3", subscription: sub, amountPaid: 2500 })), stripe);
  await handleStripeEvent(event("invoice.paid", paidInvoice({ id: "in_sam_4", subscription: sub, amountPaid: 0 })), stripe);
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

  // An invoice Stripe describes only in its subscription details still counts,
  // and a line whose product came expanded is read from the product.
  const described = paidInvoice({ id: "in_sam_5", subscription: sub, amountPaid: 1500 });
  described.lines.data[0].metadata = {};
  described.subscription_details = { metadata: { plan: "forgedrop_cloud_pickup", tier: "500gb" } };
  await handleStripeEvent(event("invoice.paid", described), stripe);
  assert.deepEqual((await shares(ada.id)).at(-1), ["cloud_pickup_share:in_sam_5", 75, "pending"]);
  assert.equal(
    cloudPickupInvoice({ lines: { data: [{ price: { product: { metadata: catalogLine(tierOf("1tb")).product_data.metadata } } }] } }).tier.key,
    "1tb"
  );
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
    await handleStripeEvent(event("invoice.paid", paidInvoice({ id: `in_${sub.id}`, subscription: sub, amountPaid: 500 })), stripe);
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

  // The catalog still sells Private Sync its own way: Pro owners only, with its own words and metadata.
  const nopro = await signUp("no-pro");
  assert.deepEqual(await checkout(nopro, { productSlug: "tabforge-collections-subscription" }), {
    status: 403,
    body: {
      error: "tabforge_pro_required",
      message: "Private Sync can be re-subscribed from the account of an existing TabForge Pro owner.",
    },
  });
  const renewer = await signUp("renewer", { owns: ["tabforge"] });
  const resubscribe = await checkout(renewer, { productSlug: "tabforge-collections-subscription" });
  assert.equal(resubscribe.status, 200, JSON.stringify(resubscribe.body));
  const syncConfig = stripe.state.sessions.at(-1).config;
  assert.equal(syncConfig.subscription_data.metadata.plan, "tabforge_private_sync");
  assert.equal(syncConfig.subscription_data.metadata.tier, undefined);
  assert.equal(syncConfig.line_items[0].price_data.product_data.name, "TabForge Private Sync");
  assert.match(syncConfig.custom_text.submit.message, /Private Sync renews automatically at \$5\/month/);

  // Private Sync's webhook: its own entitlement, its own 5% for a Pro-owning referrer, no Cloud pickup.
  const pro = await signUp("sync-referrer", { owns: ["tabforge"], cashApp: "$syncref" });
  const proCode = await referralCode(pro, { affiliate: true });
  const syncer = await signUp("syncer", { owns: ["tabforge"], referredBy: pro, code: proCode });
  const customer = (await stripe.customers.create({ email: syncer.email })).id;
  await db("users").where({ id: syncer.id }).update({ stripe_customer_id: customer });
  const sync = stripe.addSubscription({
    customer,
    priceData: { currency: "usd", unit_amount: 500, recurring: { interval: "month" }, product_data: { name: "TabForge Private Sync" } },
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
    lines: { data: [{ price: { id: sync.items.data[0].price.id, product: sync.items.data[0].price.product, metadata: {} }, description: "1 × TabForge Private Sync (at $5.00 / month)" }] },
  };
  assert.equal(cloudPickupInvoice(syncInvoice), null);
  await handleStripeEvent(event("invoice.paid", syncInvoice), stripe);
  await handleStripeEvent(event("invoice.paid", syncInvoice), stripe);
  assert.deepEqual(
    (await db("reward_queue").where({ user_id: pro.id })).map((row) => [row.product_slug, row.reward_key, row.reward_amount_cents]),
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
    priceData: { currency: "usd", unit_amount: 500, recurring: { interval: "month" }, product_data: { name: "Romancing the Stone subscription" } },
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
        product_slug: "forgedrop-cloud-pickup-100gb",
        fulfillment_type: "multi_entitlement_cart",
        checkout_items: JSON.stringify([{ kind: "subscription", slug: "forgedrop-cloud-pickup-100gb", entitlementSlug: "forgedrop-cloud-pickup-100gb" }]),
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

  // Payout approval: the gate (rewardPayoutEligibility) still applies, and a
  // Cloud pickup share is spared only the count of referred customers.
  const admin = await src("../src/routes/admin.routes.js");
  const approval = admin.slice(admin.indexOf("async function applyRewardStatusChange"));
  assert.ok(approval.indexOf("rewardPayoutEligibility(") > 0);
  assert.ok(approval.indexOf("rewardPayoutEligibility(") < approval.indexOf("isCloudPickupShareReward(existing)"));
});

test("TuneForge sells once for $20, and a second purchase is refused", async () => {
  // The owner, 2026-09-27: $20 once, five devices (licensedProducts.js).
  useStripe();
  const buyer = await signUp("tuneforge-buyer");
  const bought = await checkout(buyer, { productSlug: "tuneforge" });
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
  const config = stripe.state.sessions.at(-1).config;
  assert.equal(config.mode, "payment");
  assert.equal(config.line_items[0].price_data.unit_amount, 2000);
  assert.equal(config.line_items[0].price_data.product_data.name, "TuneForge");

  const owner = await signUp("tuneforge-owner", { owns: ["tuneforge"] });
  const again = await checkout(owner, { productSlug: "tuneforge" });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "already_owned");
  // The flyer's code is ForgeDrop's alone.
  assert.equal((await checkout(buyer, { productSlug: "tuneforge", promoCode: "ART25" })).body.error,
    "promo_not_for_product");
});

test("ART25 takes 25% off ForgeDrop at the catalog's own price, and nothing else", async () => {
  // The art-competition flyer's code (2026-09-27): no Stripe coupon, the
  // inline price is lowered, and a code that is not good is refused plainly.
  useStripe();
  const buyer = await signUp("flyer-buyer");
  const full = await checkout(buyer, { productSlug: "forgedrop" });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.equal(full.body.promo, undefined);
  assert.equal(stripe.state.sessions.at(-1).config.line_items[0].price_data.unit_amount, 2000);

  const off = await checkout(buyer, { productSlug: "forgedrop", promoCode: " art25 " });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(off.body.promo, { code: "ART25", percentOff: 25, listPriceCents: 2000, priceCents: 1500 });
  assert.equal(off.body.reused, false, "never the full-price session again");
  const config = stripe.state.sessions.at(-1).config;
  assert.equal(config.line_items[0].price_data.unit_amount, 1500);
  assert.equal(config.line_items[0].price_data.product_data.name, "DropForge (ART25, 25% off)");
  assert.equal(config.metadata.promo_code, "ART25");
  assert.equal(off.body.checkout.items[0].unitAmountCents, 1500);

  assert.deepEqual(await checkout(buyer, { productSlug: "forgedrop", promoCode: "ART50" }), {
    status: 400,
    body: { error: "promo_unknown", message: "That code isn't one we have." },
  });
  const owner = await signUp("flyer-owner", { owns: ["forgedrop"] });
  assert.deepEqual(await checkout(owner, { productSlug: "forgedrop-cloud-pickup-100gb", promoCode: "ART25" }), {
    status: 400,
    body: { error: "promo_not_for_product", message: "That code isn't for this product." },
  });
});
