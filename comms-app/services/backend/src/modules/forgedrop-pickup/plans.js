/**
 * Cloud pickup plans: how many bytes an account may send each calendar month
 * (UTC). The owner's tiers (ForgeDrop/docs/pickup.md): $5, $10, $15 and $25 a
 * month for 100 GB, 250 GB, 500 GB and 1 TB sent.
 *
 * A tier is held as a product entitlement, the way TabForge Private Sync is:
 * one row in product_entitlements per account and tier slug, active while
 * the subscription is. An account holding more than one gets the biggest:
 * a plan the customer cancelled runs to the end of its period beside the one
 * they chose next, and the allowance is the larger of the two until then.
 *
 * Each tier is sold as a product of the shared catalog checkout, under its
 * slug, at `monthlyCents` a month (billing.js builds the catalog entries from
 * this table), and the Stripe subscription webhook grants it. There are no
 * Stripe Price objects to set up: Checkout makes the monthly price inline.
 *
 * Sizes are binary, as Windows shows them, so a "100 GB" plan holds what
 * Explorer calls 100 GB. The table below is the one place to change that.
 */

export const GB = 2 ** 30;
export const TB = 2 ** 40;

export const CLOUD_PICKUP_TIERS = Object.freeze([
  Object.freeze({
    // The short name kept in the subscription's metadata.
    key: "100gb",
    // The catalog product slug and the entitlement slug alike.
    slug: "forgedrop-cloud-pickup-100gb",
    label: "100 GB",
    monthlyCents: 500,
    bytes: 100 * GB,
  }),
  Object.freeze({
    key: "250gb",
    slug: "forgedrop-cloud-pickup-250gb",
    label: "250 GB",
    monthlyCents: 1000,
    bytes: 250 * GB,
  }),
  Object.freeze({
    key: "500gb",
    slug: "forgedrop-cloud-pickup-500gb",
    label: "500 GB",
    monthlyCents: 1500,
    bytes: 500 * GB,
  }),
  Object.freeze({
    key: "1tb",
    slug: "forgedrop-cloud-pickup-1tb",
    label: "1 TB",
    monthlyCents: 2500,
    bytes: 1 * TB,
  }),
]);

const BY_SLUG = new Map(CLOUD_PICKUP_TIERS.map((tier) => [tier.slug, tier]));
const BY_KEY = new Map(CLOUD_PICKUP_TIERS.map((tier) => [tier.key, tier]));

export function cloudPickupTier(slug) {
  return BY_SLUG.get(String(slug || "").trim().toLowerCase()) || null;
}

/** The tier by its short name: "100gb", "250gb", "500gb" or "1tb". */
export function cloudPickupTierByKey(key) {
  return BY_KEY.get(String(key || "").trim().toLowerCase()) || null;
}

/**
 * The biggest tier among an account's entitlement rows, or null for none:
 * what the monthly allowance is held to. `rows` are active entitlements
 * (entitlement.service listProductEntitlements), so a cancelled plan still in
 * its last period counts beside a new one, and stops counting when it ends.
 */
export function tierFromEntitlements(rows) {
  let best = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const tier = cloudPickupTier(row?.product_slug);
    if (tier && (!best || tier.bytes > best.bytes)) best = tier;
  }
  return best;
}

/** The UTC calendar month holding `at`: [from, to). */
export function monthWindow(at) {
  const date = new Date(at);
  const from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { from, to };
}

/**
 * Bytes an account has sent this month: the sealed bytes of every pickup it
 * created in the month, whatever became of it, except one cancelled before
 * its upload was finished (uploaded_at is set when it is). A pickup still
 * uploading counts, so two at once cannot both fit in what is left: that
 * holds for as long as its sender could carry the upload on, the pickup's
 * whole life. One abandoned mid-upload is cancelled by the sweep when its
 * days are up (or by its sender before), and so not counted from then on.
 */
export async function bytesSentThisMonth(db, userId, at) {
  const { from, to } = monthWindow(at);
  const row = await db("forgedrop_pickups")
    .where({ sender_user_id: userId })
    .andWhere("created_at", ">=", from)
    .andWhere("created_at", "<", to)
    .whereNot((qb) => qb.where({ status: "cancelled" }).whereNull("uploaded_at"))
    .sum({ bytes: "total_bytes" })
    .first();
  return Number(row?.bytes || 0);
}
