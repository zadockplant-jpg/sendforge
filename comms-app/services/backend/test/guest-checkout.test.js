// Checkout before there is an account. The owner, 2026-09-27: "all product
// checkout flows should be, click button opens stripe purchase with required
// email field that states this will be your sendforge login, completed
// stripe purchase auto opens account creation with prefilled email, once
// user enters pw an email verification is sent. clicking verify links back
// to the download and automatically initiates the download".
//
// Runs the real guest checkout, the real Stripe webhook handler and the real
// verify route against an in-process Postgres (PGlite). Stripe is a stand-in
// that answers from memory, so nothing here reaches Stripe.

import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import http from "node:http";
import test, { after, before } from "node:test";
import bcrypt from "bcrypt";
import express from "express";

// env.js reads the environment when it is first imported. No Stripe key and
// no price ids: every line item is priced inline, as it is when a price id
// is missing under the current key.
for (const name of [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_TABFORGE",
  "STRIPE_PRICE_TABFORGE_SYNC",
  "STRIPE_PRICE_FORGEDROP",
]) {
  delete process.env[name];
}
process.env.JWT_SECRET ||= "guest-checkout-test-secret-at-least-32-bytes-long";
process.env.PUBLIC_SITE_URL = "https://sendforge.test";

const { db } = await import("../src/config/db.js");
const { attachPglite } = await import("./helpers/pglite-db.js");
const { createGuestCheckoutHandlers, GUEST_CHECKOUT_LOGIN_NOTE, GUEST_CHECKOUT_PRODUCTS } = await import(
  "../src/routes/billing.routes.js"
);
const { handleCheckoutSessionCompleted } = await import("../src/routes/stripe.webhooks.routes.js");
const { verificationRouter } = await import("../src/routes/verification.routes.js");
const { authRouter } = await import("../src/routes/auth.routes.js");
const { claimGuestPurchasesForUser, GUEST_PURCHASES_TABLE, holdGuestPurchase } = await import(
  "../src/services/guestPurchases.service.js"
);
const { up: seatsUp } = await import("../src/db/migrations/20260924_create_product_seat_purchases.js");

const SITE = "https://sendforge.test";
const SUCCESS_URL = (slug) =>
  `${SITE}/get/index.html?product=${slug}&checkout=success&session_id={CHECKOUT_SESSION_ID}`;

// ------------------------------------------------------------ a stand-in Stripe

let n = 0;
const next = (prefix) => `${prefix}${(n += 1)}xxxxxxxxxxxx`;

function missing(what, id) {
  return Object.assign(new Error(`No such ${what}: '${id}'`), {
    type: "StripeInvalidRequestError",
    code: "resource_missing",
    statusCode: 404,
  });
}

function fakeStripe() {
  const state = { created: [], sessions: new Map(), subscriptionUpdates: [] };
  return {
    state,
    prices: {
      async retrieve(id) {
        throw missing("price", id);
      },
    },
    subscriptions: {
      async update(id, params) {
        state.subscriptionUpdates.push([id, structuredClone(params)]);
        return { id, ...params };
      },
    },
    checkout: {
      sessions: {
        async create(config, options) {
          const id = next("cs_test_");
          state.created.push({ id, config: structuredClone(config), options });
          return { id, url: `https://checkout.stripe.test/c/pay/${id}` };
        },
        async retrieve(id) {
          if (!state.sessions.has(id)) throw missing("checkout session", id);
          return structuredClone(state.sessions.get(id));
        },
      },
    },
  };
}

// ------------------------------------------------------------------ fixtures

let stripe = fakeStripe();
let server;
let base;

before(async () => {
  await attachPglite(db);
  await db.schema.alterTable("users", (t) => {
    t.text("password_hash");
    t.text("verification_token_hash");
    t.timestamp("verification_sent_at", { useTz: true });
    t.timestamp("verified_at", { useTz: true });
    t.integer("auth_version").defaultTo(0);
  });
  await seatsUp(db);

  const guest = createGuestCheckoutHandlers({ getStripe: () => stripe });
  const app = express();
  app.use(express.json());
  app.post("/guest-checkout", guest.checkout);
  app.get("/guest-checkout/:sessionId", guest.info);
  app.use("/v1/auth", authRouter);
  app.use("/v1/auth", verificationRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.destroy();
});

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json() };
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function account(email, { verified = true, customer = null } = {}) {
  const id = randomUUID();
  const token = crypto.randomBytes(32).toString("hex");
  await db("users").insert({
    id,
    email,
    email_verified: verified,
    stripe_customer_id: customer,
    verification_token_hash: verified ? null : sha256(token),
    verification_sent_at: verified ? null : new Date(),
  });
  return { id, token, email };
}

/** A guest checkout as Stripe sends it when it is paid: no account, the email Stripe asked for. */
function paidGuestSession({ email, product = "forgedrop", amount = 2000, customer, paymentStatus = "paid" }) {
  const id = next("cs_test_guest");
  return {
    id,
    object: "checkout.session",
    status: paymentStatus === "paid" ? "complete" : "open",
    payment_status: paymentStatus,
    customer: customer || next("cus_guest"),
    payment_intent: next("pi_guest"),
    amount_total: amount,
    customer_details: { email },
    metadata: {
      guest_checkout: "1",
      product_slug: product,
      fulfillment_type: "multi_entitlement_cart",
      checkout_items: JSON.stringify([
        { kind: "product", slug: product, entitlementSlug: product, displayName: product, unitAmountCents: amount, quantity: 1 },
      ]),
    },
  };
}

async function owns(userId, slug) {
  const row = await db("product_entitlements").where({ user_id: userId, product_slug: slug }).first();
  return row?.status === "active";
}

const held = (email) => db(GUEST_PURCHASES_TABLE).where({ email });

// ------------------------------------------------------------------ checkout

test("a signed-out visitor goes straight to Stripe, which asks for the email that will be their login", async () => {
  stripe = fakeStripe();
  // The flyer's sendforge.app/fd carries ART25: $20 → $15.
  const { status, json } = await post("/guest-checkout", { productSlug: "forgedrop", promoCode: "art25" });
  assert.equal(status, 200);
  assert.equal(json.url, `https://checkout.stripe.test/c/pay/${json.sessionId}`);
  assert.deepEqual(json.promo, { code: "ART25", percentOff: 25, listPriceCents: 2000, priceCents: 1500 });

  const [{ config, options }] = stripe.state.created;
  assert.equal(config.mode, "payment");
  assert.equal(config.customer, undefined, "no customer: Stripe asks for the email, and requires it");
  assert.equal(config.customer_email, undefined);
  assert.equal(config.customer_creation, "always");
  assert.equal(config.client_reference_id, undefined);
  assert.equal(GUEST_CHECKOUT_LOGIN_NOTE, "This email will be your SendForge login.");
  assert.deepEqual(config.custom_text, { submit: { message: "This email will be your SendForge login." } });
  assert.equal(config.line_items.length, 1);
  assert.equal(config.line_items[0].price_data.unit_amount, 1500);
  assert.equal(config.line_items[0].price_data.product_data.name, "DropForge (ART25, 25% off)");
  assert.equal(config.success_url, SUCCESS_URL("forgedrop"), "the session id is filled in by Stripe, so it is written as is");
  assert.equal(config.cancel_url, `${SITE}/products/forgedrop/index.html?checkout=cancelled`);
  assert.equal(config.metadata.guest_checkout, "1");
  assert.equal(config.metadata.user_id, undefined);
  assert.equal(config.metadata.product_slug, "forgedrop");
  assert.equal(config.metadata.promo_code, "ART25");
  assert.equal(config.metadata.fulfillment_type, "multi_entitlement_cart");
  assert.deepEqual(JSON.parse(config.metadata.checkout_items).map((item) => [item.kind, item.entitlementSlug]), [["product", "forgedrop"]]);
  assert.match(options.idempotencyKey, /^guest-checkout-v1:[0-9a-f-]{36}$/);
});

test("a referral link's code rides through checkout, and the page it came from is where cancelling returns", async () => {
  stripe = fakeStripe();
  const { status } = await post("/guest-checkout", {
    productSlug: "tuneforge",
    referralCode: "ANN-5",
    cancelPath: "/products/tuneforge/index.html#why-432",
  });
  assert.equal(status, 200);
  const [{ config }] = stripe.state.created;
  assert.equal(config.metadata.referral_code, "ANN-5");
  assert.equal(config.line_items[0].price_data.unit_amount, 2000);
  assert.equal(config.success_url, SUCCESS_URL("tuneforge"));
  assert.equal(config.cancel_url, `${SITE}/products/tuneforge/index.html?checkout=cancelled#why-432`);
  // A cancel path off the site falls back to the product page.
  await post("/guest-checkout", { productSlug: "tuneforge", cancelPath: "https://evil.example/x" });
  assert.equal(stripe.state.created[1].config.cancel_url, `${SITE}/products/tuneforge/index.html?checkout=cancelled`);
});

test("TabForge Pro sold to a guest names no account on its subscription until the email is verified", async () => {
  stripe = fakeStripe();
  const { status } = await post("/guest-checkout", { productSlug: "tabforge" });
  assert.equal(status, 200);
  const [{ config }] = stripe.state.created;
  assert.equal(config.mode, "subscription");
  assert.equal(config.customer_creation, undefined, "a subscription always makes its customer");
  assert.equal(config.subscription_data.trial_period_days, 60);
  assert.equal(config.subscription_data.metadata.user_id, undefined);
  assert.equal(config.subscription_data.metadata.guest_checkout, "1");
  assert.equal(config.subscription_data.metadata.initial_pro_purchase, "true");
  assert.equal(
    config.custom_text.submit.message,
    "This email will be your SendForge login. TabForge Pro is $10 today. Private Sync is free for 60 days, then renews automatically at $5/month until canceled from your SendForge account."
  );
  // Pro is granted from the payment; Private Sync only ever from the subscription.
  const items = JSON.parse(config.metadata.checkout_items);
  assert.deepEqual(items.map((item) => [item.kind, item.slug]), [["product", "tabforge"], ["subscription", "tabforge-collections-subscription"]]);
  assert.equal(config.success_url, SUCCESS_URL("tabforge"));
});

test("Rose Colored Glasses for a guest: the first device at the first-device price, the rest at $4", async () => {
  stripe = fakeStripe();
  const { status, json } = await post("/guest-checkout", { productSlug: "rose-colored-glasses", quantity: 3 });
  assert.equal(status, 200);
  const [{ config }] = stripe.state.created;
  assert.deepEqual(config.line_items.map((line) => [line.quantity, line.price_data.unit_amount]), [[1, 500], [2, 400]]);
  assert.deepEqual(json.checkout.items.map((item) => [item.kind, item.quantity, item.amountCents]), [["device_seat", 3, 1300]]);
});

test("only what a new customer buys outright is sold without an account", async () => {
  stripe = fakeStripe();
  assert.deepEqual([...GUEST_CHECKOUT_PRODUCTS], ["forgedrop", "tuneforge", "rose-colored-glasses", "tabforge"]);
  for (const productSlug of ["tabforge-collections-subscription", "forgedrop-cloud-pickup-100gb", "rts-permanent", "tabforge-page", "nope"]) {
    const { status, json } = await post("/guest-checkout", { productSlug });
    assert.equal(status, 404, productSlug);
    assert.equal(json.error, "unknown_product");
  }
  assert.equal((await post("/guest-checkout", { productSlug: "forgedrop", quantity: 2 })).json.error, "invalid_quantity");
  assert.equal((await post("/guest-checkout", { productSlug: "rose-colored-glasses", quantity: 11 })).json.error, "invalid_input");
  assert.equal((await post("/guest-checkout", { productSlug: "tuneforge", promoCode: "ART25" })).json.error, "promo_not_for_product");
  assert.equal((await post("/guest-checkout", { productSlug: "forgedrop", promoCode: "FREE" })).json.error, "promo_unknown");
  assert.equal(stripe.state.created.length, 0, "Stripe is never asked");
});

// ------------------------------------------------------------------ holding and claiming

test("a paid guest purchase waits for its email, and verifying that email hands it over and carries on to the download", async () => {
  const email = "newbuyer@example.com";
  const session = paidGuestSession({ email });
  await handleCheckoutSessionCompleted(session, null);
  await handleCheckoutSessionCompleted(session, null); // Stripe delivers twice
  let rows = await held(email);
  assert.equal(rows.length, 1, "held once, however often Stripe replays it");
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].product_slug, "forgedrop");
  assert.equal(Number(rows[0].amount_total), 2000);
  assert.equal((await db("product_entitlements").where({ product_slug: "forgedrop" })).length, 0, "nobody owns it yet");

  // Account creation with the email filled in: not verified, so still held.
  const buyer = await account(email, { verified: false });
  await handleCheckoutSessionCompleted(session, null);
  assert.equal(await owns(buyer.id, "forgedrop"), false);
  assert.equal((await claimGuestPurchasesForUser({ ...buyer, email_verified: false }, { fulfill: handleCheckoutSessionCompleted })).reason, "not_verified");

  // Someone else's verified account gets nothing of it.
  const other = await account("someone-else@example.com");
  await claimGuestPurchasesForUser({ ...other, email_verified: true }, { fulfill: handleCheckoutSessionCompleted });
  assert.equal(await owns(other.id, "forgedrop"), false);

  // Clicking the emailed link verifies, fulfils, and carries on to the download.
  const nextPath = "/account/index.html?purchase_context=forgedrop&download=forgedrop#programs";
  const res = await fetch(`${base}/v1/auth/verify?token=${buyer.token}&next=${encodeURIComponent(nextPath)}`, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, `${SITE}/verified.html`);
  const fragment = new URLSearchParams(location.hash.slice(1));
  assert.ok(fragment.get("token"), "signed in");
  assert.equal(fragment.get("next"), nextPath);

  assert.equal(await owns(buyer.id, "forgedrop"), true, "the purchase is theirs by the time the download page opens");
  rows = await held(email);
  assert.equal(rows[0].status, "claimed");
  assert.equal(rows[0].claimed_user_id, buyer.id);
  const user = await db("users").where({ id: buyer.id }).first();
  assert.equal(user.stripe_customer_id, session.customer, "a new account takes the customer Stripe made");

  // A late replay of the webhook changes nothing.
  await handleCheckoutSessionCompleted(session, null);
  assert.equal((await held(email)).length, 1);
  assert.equal((await held(email))[0].status, "claimed");
});

test("an account already verified gets a guest purchase at once, whatever the email's case, and keeps its own Stripe customer", async () => {
  const buyer = await account("returning@example.com", { customer: "cus_existing_1" });
  const session = paidGuestSession({ email: "Returning@Example.COM", product: "tuneforge" });
  await handleCheckoutSessionCompleted(session, null);
  assert.equal(await owns(buyer.id, "tuneforge"), true);
  const [row] = await held("returning@example.com");
  assert.equal(row.status, "claimed");
  const user = await db("users").where({ id: buyer.id }).first();
  assert.equal(user.stripe_customer_id, "cus_existing_1", "the account's subscriptions and billing portal stay found");
});

test("signing in hands over a purchase whose hand-over failed before", async () => {
  const email = "retry@example.com";
  const buyer = await account(email);
  await db("users").where({ id: buyer.id }).update({ password_hash: await bcrypt.hash("a-good-password", 4) });
  // Still held, as a failed hand-over leaves it.
  await holdGuestPurchase(paidGuestSession({ email, product: "tuneforge" }));
  assert.equal(await owns(buyer.id, "tuneforge"), false);

  const { status, json } = await post("/v1/auth/login", { email, password: "a-good-password" });
  assert.equal(status, 200);
  assert.ok(json.token);
  assert.equal(await owns(buyer.id, "tuneforge"), true);
  assert.equal((await held(email))[0].status, "claimed");
});

test("a checkout that is not paid is never held", async () => {
  const session = paidGuestSession({ email: "unpaid@example.com", paymentStatus: "unpaid" });
  await handleCheckoutSessionCompleted(session, null);
  assert.equal((await held("unpaid@example.com")).length, 0);
});

test("a guest subscription is given its account before it is fulfilled, and a failed fulfilment is tried again", async () => {
  stripe = fakeStripe();
  const email = "subscriber@example.com";
  const session = { ...paidGuestSession({ email, product: "tabforge", amount: 1000 }), subscription: "sub_guest_1" };
  const buyer = await account(email, { verified: false });
  await handleCheckoutSessionCompleted(session, stripe);
  assert.equal((await held(email))[0].status, "pending");

  const verified = { ...buyer, email_verified: true };
  let fails = true;
  const fulfilled = [];
  const fulfill = async (paid) => {
    if (fails) throw new Error("stripe is down");
    fulfilled.push(paid);
  };
  assert.equal((await claimGuestPurchasesForUser(verified, { stripe, fulfill })).claimed, 0);
  let [row] = await held(email);
  assert.equal(row.status, "pending", "back in line after a failure");
  assert.equal(row.claimed_user_id, null);
  assert.equal(row.last_error, "stripe is down");

  fails = false;
  assert.equal((await claimGuestPurchasesForUser(verified, { stripe, fulfill })).claimed, 1);
  assert.deepEqual(stripe.state.subscriptionUpdates.at(-1), ["sub_guest_1", { metadata: { user_id: buyer.id } }]);
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0].metadata.user_id, buyer.id, "fulfilled as a purchase by this account");
  assert.equal(fulfilled[0].metadata.guest_checkout, "1");
  [row] = await held(email);
  assert.equal(row.status, "claimed");
  assert.equal(row.last_error, null);
  // Nothing is fulfilled twice.
  assert.equal((await claimGuestPurchasesForUser(verified, { stripe, fulfill })).claimed, 0);
  assert.equal(fulfilled.length, 1);
});

// ------------------------------------------------------------------ the page Stripe returns to

test("the page Stripe returns a guest to learns who paid, and nothing about anyone else's checkout", async () => {
  stripe = fakeStripe();
  const paid = { ...paidGuestSession({ email: "Fresh@Example.com" }), metadata: { ...paidGuestSession({ email: "x" }).metadata, referral_code: "ANN-5" } };
  stripe.state.sessions.set(paid.id, paid);

  let { status, json } = await get(`/guest-checkout/${paid.id}`);
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, paid: true, email: "fresh@example.com", productSlug: "forgedrop", referralCode: "ANN-5", account: "none" });

  await account("fresh@example.com", { verified: false });
  assert.equal((await get(`/guest-checkout/${paid.id}`)).json.account, "unverified");
  await db("users").where({ email: "fresh@example.com" }).update({ email_verified: true });
  assert.equal((await get(`/guest-checkout/${paid.id}`)).json.account, "verified");

  // Not paid yet: no email.
  const open = paidGuestSession({ email: "open@example.com", paymentStatus: "unpaid" });
  stripe.state.sessions.set(open.id, open);
  ({ json } = await get(`/guest-checkout/${open.id}`));
  assert.equal(json.paid, false);
  assert.equal(json.email, "");

  // A signed-in customer's checkout is not a guest's: nothing about it.
  const mine = paidGuestSession({ email: "member@example.com" });
  delete mine.metadata.guest_checkout;
  mine.metadata.user_id = randomUUID();
  stripe.state.sessions.set(mine.id, mine);
  assert.equal((await get(`/guest-checkout/${mine.id}`)).status, 404);
  assert.equal((await get("/guest-checkout/cs_test_unknownxxxxxxxxxxxx")).status, 404);
  for (const bad of ["pi_123", "cs_test_short", "cs_live_x%2F..%2Fadmin"]) {
    assert.equal((await get(`/guest-checkout/${bad}`)).status, 400, bad);
  }
});
