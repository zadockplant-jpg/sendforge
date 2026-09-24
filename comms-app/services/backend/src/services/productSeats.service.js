/**
 * Per-device products: what a seat costs, and how many an account holds.
 *
 * Rose Colored Glasses is good for one device per purchase. The first device
 * is $5. Every device after that is $4 - the $1 a referral pays, taken off,
 * because buying a second copy for yourself is you referring yourself.
 *
 * A seat never moves. $5 buys the product for that device; a new PC is a new
 * purchase (see licensing.routes.js, which refuses to free a seat's slot).
 */

import crypto from "crypto";
import { db } from "../config/db.js";
import { log } from "../utils/logger.js";

export const ROSE_COLORED_GLASSES_SLUG = "rose-colored-glasses";

export const SEAT_PRICING = Object.freeze({
  [ROSE_COLORED_GLASSES_SLUG]: Object.freeze({
    firstDeviceCents: 500,
    additionalDeviceCents: 400,
    maxDevicesPerCheckout: 10,
  }),
});

export const SEAT_REVERSAL_STATUSES = Object.freeze([
  "refunded",
  "disputed",
  "payment_failed",
]);

function normalizeSlug(slug) {
  return String(slug || "").trim().toLowerCase();
}

export function seatPricing(productSlug) {
  return SEAT_PRICING[normalizeSlug(productSlug)] || null;
}

/**
 * The price lines for buying `quantity` devices when the account already
 * holds `ownedSeats`. Only an account with no seat pays the first-device
 * price, and only for one of them.
 */
export function seatPriceLines(productSlug, ownedSeats, quantity) {
  const pricing = seatPricing(productSlug);
  const count = Number(quantity);
  if (!pricing || !Number.isInteger(count) || count < 1) return [];

  const owned = Math.max(0, Number(ownedSeats) || 0);
  const lines = [];
  let remaining = count;
  if (owned === 0) {
    lines.push({ role: "first", unitAmountCents: pricing.firstDeviceCents, quantity: 1 });
    remaining -= 1;
  }
  if (remaining > 0) {
    lines.push({
      role: "additional",
      unitAmountCents: pricing.additionalDeviceCents,
      quantity: remaining,
    });
  }
  return lines;
}

export function seatLinesTotalCents(lines) {
  return (lines || []).reduce(
    (sum, line) => sum + Number(line.unitAmountCents || 0) * Number(line.quantity || 0),
    0
  );
}

/** What the next single device costs this account. */
export function nextDeviceCents(productSlug, ownedSeats) {
  return seatLinesTotalCents(seatPriceLines(productSlug, ownedSeats, 1));
}

export async function countActiveSeats(userId, productSlug, trx = db) {
  if (!userId) return 0;
  const row = await trx("product_seat_purchases")
    .where({ user_id: userId, product_slug: normalizeSlug(productSlug), status: "active" })
    .sum({ seats: "quantity" })
    .first();
  return Number(row?.seats || 0);
}

/**
 * How many machines a licensed product may run on for this account.
 *
 * A seat-based product counts its paid seats. An entitlement granted by hand
 * has no seat behind it, so the product's own `deviceLimit` is the floor -
 * callers only reach this after checking the entitlement.
 */
export async function deviceLimitFor(userId, product, trx = db) {
  if (!product) return 0;
  const floor = Number(product.deviceLimit) || 1;
  if (!product.seatBased) return floor;
  const seats = await countActiveSeats(userId, product.slug, trx);
  return Math.max(seats, floor);
}

/**
 * Seats split by where they came from: bought through checkout, or given by
 * the owner (a perk, an invite). Both count toward the device limit.
 */
export async function seatBreakdown(userId, productSlug, trx = db) {
  const rows = await trx("product_seat_purchases")
    .select(trx.raw("coalesce(metadata->>'perk', 'false') as perk"))
    .sum({ seats: "quantity" })
    .where({ user_id: userId, product_slug: normalizeSlug(productSlug), status: "active" })
    .groupByRaw("coalesce(metadata->>'perk', 'false')");
  let paid = 0;
  let perk = 0;
  for (const row of rows) {
    if (row.perk === "true") perk += Number(row.seats || 0);
    else paid += Number(row.seats || 0);
  }
  return { paid, perk, total: paid + perk };
}

/**
 * Set how many devices the owner has given this account, replacing any
 * earlier gift. Paid seats are never touched. Zero removes the gift.
 *
 * The old gift row is retired, not deleted, so the record of what was given
 * and when survives the change.
 */
export async function setPerkSeats(
  { userId, productSlug, seats, grantedBy = null, source = "admin_perk", note = null },
  trx = db
) {
  const slug = normalizeSlug(productSlug);
  const count = Math.max(0, Math.min(1000, Math.round(Number(seats) || 0)));
  if (!userId || !slug) return { perk: 0 };

  await trx("product_seat_purchases")
    .where({ user_id: userId, product_slug: slug, status: "active" })
    .whereRaw("metadata->>'perk' = 'true'")
    .update({ status: "revoked", reversed_at: trx.fn.now(), updated_at: trx.fn.now() });

  if (count > 0) {
    await trx("product_seat_purchases").insert({
      id: crypto.randomUUID(),
      user_id: userId,
      product_slug: slug,
      purchase_ref: `perk:${crypto.randomUUID()}`,
      quantity: count,
      amount_cents: 0,
      status: "active",
      metadata: {
        perk: true,
        source,
        granted_by: grantedBy,
        granted_at: new Date().toISOString(),
        note: note ? String(note).slice(0, 500) : null,
      },
      updated_at: trx.fn.now(),
    });
  }
  return { perk: count };
}

/**
 * Add the seats a paid checkout bought. Idempotent on `purchaseRef`: Stripe
 * delivers checkout events more than once, and a replay must not hand out a
 * second device.
 */
export async function recordSeatPurchase(
  {
    userId,
    productSlug,
    purchaseRef,
    quantity,
    amountCents = 0,
    paymentIntent = null,
    checkoutSessionId = null,
    metadata = {},
  },
  trx = db
) {
  const slug = normalizeSlug(productSlug);
  const ref = String(purchaseRef || "").trim();
  const count = Number(quantity);
  if (!userId || !slug || !ref || !Number.isInteger(count) || count < 1) {
    return { recorded: false, reason: "missing_input" };
  }

  const inserted = await trx("product_seat_purchases")
    .insert({
      id: crypto.randomUUID(),
      user_id: userId,
      product_slug: slug,
      purchase_ref: ref,
      quantity: count,
      amount_cents: Math.max(0, Number(amountCents) || 0),
      payment_intent: paymentIntent || null,
      checkout_session_id: checkoutSessionId || null,
      status: "active",
      metadata,
      updated_at: trx.fn.now(),
    })
    .onConflict("purchase_ref")
    .ignore()
    .returning("*");

  if (!inserted[0]) return { recorded: false, reason: "duplicate_purchase" };
  return { recorded: true, row: inserted[0] };
}

/**
 * A refund, dispute or failed payment takes that purchase's seats back.
 *
 * It cannot reach a machine already activated: the licence there is signed
 * and verified offline. What it does is stop new activations beyond the seats
 * still paid for, and when no seat is left, withdraw the purchase-granted
 * entitlement so the account no longer owns the product.
 *
 * The entitlement row holds one purchase's `source_ref` at a time, so the
 * generic "revoke by source_ref" path in the webhook may already have revoked
 * it for a later, smaller purchase. The recount here is authoritative and puts
 * it back when paid seats remain.
 */
export async function reverseSeatPurchases({
  paymentIntentId = "",
  reason = "refunded",
  providerEventId = "",
} = {}) {
  const pi = String(paymentIntentId || "").trim();
  if (!pi) return { reversed: 0, reason: "missing_payment_intent" };
  const status = SEAT_REVERSAL_STATUSES.includes(reason) ? reason : "refunded";

  return db.transaction(async (trx) => {
    const rows = await trx("product_seat_purchases")
      .where({ payment_intent: pi, status: "active" })
      .forUpdate();
    if (!rows.length) return { reversed: 0, reason: "not_found" };

    await trx("product_seat_purchases")
      .whereIn("id", rows.map((row) => row.id))
      .update({
        status,
        reversed_at: trx.fn.now(),
        metadata: trx.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [
          JSON.stringify({ reversal_reason: status, provider_event_id: providerEventId || null }),
        ]),
        updated_at: trx.fn.now(),
      });

    const touched = new Map();
    for (const row of rows) touched.set(`${row.user_id}:${row.product_slug}`, row);

    const accounts = [];
    for (const row of touched.values()) {
      const remaining = await countActiveSeats(row.user_id, row.product_slug, trx);
      const entitlement = await trx("product_entitlements")
        .where({ user_id: row.user_id, product_slug: row.product_slug })
        .first();

      // Only a purchase-granted entitlement follows the seats. One the owner
      // granted by hand stays exactly as they left it.
      if (entitlement && entitlement.source === "stripe") {
        const nextStatus = remaining > 0 ? "active" : "revoked";
        if (entitlement.status !== nextStatus) {
          await trx("product_entitlements")
            .where({ id: entitlement.id })
            .update({ status: nextStatus, updated_at: trx.fn.now() });
        }
      }

      accounts.push({ userId: row.user_id, productSlug: row.product_slug, remainingSeats: remaining });
    }

    log("info", "seat_purchases_reversed", { paymentIntentId: pi, status, accounts });
    return { reversed: rows.length, status, accounts };
  });
}
