/**
 * Purchases made before an account exists (the owner, 2026-09-27): "all
 * product checkout flows should be, click button opens stripe purchase with
 * required email field that states this will be your sendforge login,
 * completed stripe purchase auto opens account creation with prefilled email,
 * once user enters pw an email verification is sent. clicking verify links
 * back to the download and automatically initiates the download".
 *
 * A guest checkout session carries metadata.guest_checkout = "1" and no
 * user. When Stripe reports it paid, the purchase is held here against the
 * email Stripe collected. It is fulfilled (the webhook's own
 * handleCheckoutSessionCompleted, with the user filled in) only for the
 * account whose VERIFIED email matches: at once if one already exists, or
 * the moment someone verifies that address. Held purchases are never
 * dropped: a checkout Stripe says was paid is recorded before anything else.
 */

import { randomUUID } from "node:crypto";
import { db } from "../config/db.js";
import { log } from "../utils/logger.js";
import { isFulfillableCheckoutPaymentStatus } from "./tabforgeBilling.service.js";

export const GUEST_PURCHASES_TABLE = "guest_purchases";
export const GUEST_CHECKOUT_FLAG = "1";

export function isGuestCheckoutSession(session) {
  return session?.metadata?.guest_checkout === GUEST_CHECKOUT_FLAG && !session?.metadata?.user_id;
}

export function guestCheckoutEmail(session) {
  return String(session?.customer_details?.email || session?.customer_email || "").trim().toLowerCase();
}

function stripeId(value) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id || null;
}

/** Creates the table the first time it is needed, so a missed migration cannot lose a purchase. */
let tableReady = null;
export function ensureGuestPurchasesTable(trx = db) {
  if (trx !== db) return createGuestPurchasesTable(trx);
  tableReady ||= createGuestPurchasesTable(db).catch((error) => {
    tableReady = null;
    throw error;
  });
  return tableReady;
}

export async function createGuestPurchasesTable(knex) {
  if (await knex.schema.hasTable(GUEST_PURCHASES_TABLE)) return;
  await knex.schema.createTable(GUEST_PURCHASES_TABLE, (t) => {
    t.uuid("id").primary();
    t.text("stripe_session_id").notNullable().unique();
    t.text("email").notNullable();
    t.text("product_slug");
    t.text("stripe_customer_id");
    t.bigInteger("amount_total");
    // The paid session as Stripe sent it, so fulfilling later needs no lookup.
    t.jsonb("session").notNullable();
    t.text("status").notNullable().defaultTo("pending"); // pending | claiming | claimed
    t.uuid("claimed_user_id");
    t.timestamp("claimed_at", { useTz: true });
    t.text("last_error");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["email", "status"]);
  });
}

/** Records a paid guest checkout once, however often Stripe replays it. */
export async function holdGuestPurchase(session, trx = db) {
  const email = guestCheckoutEmail(session);
  if (!email) return { held: false, reason: "no_email" };
  await ensureGuestPurchasesTable(trx);
  await trx(GUEST_PURCHASES_TABLE)
    .insert({
      id: randomUUID(),
      stripe_session_id: String(session.id),
      email,
      product_slug: String(session.metadata?.product_slug || "") || null,
      stripe_customer_id: stripeId(session.customer),
      amount_total: Number.isFinite(Number(session.amount_total)) ? Number(session.amount_total) : null,
      session: JSON.stringify(session),
    })
    .onConflict("stripe_session_id")
    .ignore();
  return { held: true, email };
}

/**
 * Fulfils every purchase held for this account's email, if the email is
 * verified. `fulfill` is the webhook's handleCheckoutSessionCompleted. Each
 * row is taken by exactly one caller (pending → claiming), and goes back to
 * pending with the error if fulfilment fails, to be tried again.
 */
export async function claimGuestPurchasesForUser(user, { stripe, fulfill, trx = db } = {}) {
  if (!user?.id || !user?.email_verified) return { claimed: 0, reason: "not_verified" };
  await ensureGuestPurchasesTable(trx);
  const email = String(user.email || "").trim().toLowerCase();
  const rows = await trx(GUEST_PURCHASES_TABLE).where({ email, status: "pending" }).orderBy("created_at", "asc");
  let claimed = 0;
  for (const row of rows) {
    const [taken] = await trx(GUEST_PURCHASES_TABLE)
      .where({ id: row.id, status: "pending" })
      .update({ status: "claiming", claimed_user_id: user.id, updated_at: trx.fn.now() })
      .returning("*");
    if (!taken) continue;
    try {
      const session = typeof taken.session === "string" ? JSON.parse(taken.session) : taken.session;
      const subscriptionId = stripeId(session.subscription);
      // A subscription bought as a guest (TabForge Pro's Private Sync) names
      // its account from now on, so later Stripe events find it.
      if (subscriptionId && stripe) {
        await stripe.subscriptions.update(subscriptionId, { metadata: { user_id: String(user.id) } });
      }
      await fulfill({ ...session, metadata: { ...session.metadata, user_id: String(user.id) } }, stripe);
      await trx(GUEST_PURCHASES_TABLE)
        .where({ id: row.id })
        .update({ status: "claimed", claimed_at: trx.fn.now(), last_error: null, updated_at: trx.fn.now() });
      claimed += 1;
      log("info", "guest_purchase_claimed", { userId: user.id, sessionId: row.stripe_session_id, productSlug: row.product_slug });
    } catch (error) {
      await trx(GUEST_PURCHASES_TABLE)
        .where({ id: row.id })
        .update({ status: "pending", claimed_user_id: null, last_error: String(error?.message || error).slice(0, 500), updated_at: trx.fn.now() });
      log("error", "guest_purchase_claim_failed", { userId: user.id, sessionId: row.stripe_session_id, error: String(error?.message || error) });
    }
  }
  return { claimed };
}

/**
 * What the webhook does with a paid guest session: hold it, then fulfil it at
 * once when a verified account already has that email.
 */
export async function holdOrClaimGuestCheckout(session, { stripe, fulfill, trx = db } = {}) {
  if (!isFulfillableCheckoutPaymentStatus(session?.payment_status)) return { held: false, reason: "not_paid" };
  const held = await holdGuestPurchase(session, trx);
  if (!held.held) {
    log("error", "guest_purchase_without_email", { sessionId: session?.id || null });
    return held;
  }
  const user = await trx("users").whereRaw("lower(email) = ?", [held.email]).first();
  if (user?.email_verified) {
    const result = await claimGuestPurchasesForUser(user, { stripe, fulfill, trx });
    return { held: true, claimed: result.claimed, account: "verified" };
  }
  log("info", "guest_purchase_held", { sessionId: session.id, account: user ? "unverified" : "none" });
  return { held: true, claimed: 0, account: user ? "unverified" : "none" };
}

/** For the page Stripe returns a guest to: who paid, for what, and whether an account exists. */
export async function guestCheckoutAccountState(email, trx = db) {
  const user = email ? await trx("users").whereRaw("lower(email) = ?", [email]).first() : null;
  if (!user) return "none";
  return user.email_verified ? "verified" : "unverified";
}
