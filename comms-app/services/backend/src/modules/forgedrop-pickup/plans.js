/**
 * Cloud pickup plans: how many bytes an account may send each calendar month
 * (UTC). The owner's tiers (ForgeDrop/docs/pickup.md): $5, $10, $15 and $25 a
 * month for 100 GB, 250 GB, 500 GB and 1 TB sent.
 *
 * A tier is held as a product entitlement, the way TabForge Private Sync is:
 * one row in product_entitlements per account and tier slug, active while
 * the subscription is. An account holding more than one (an upgrade whose
 * old tier has not been revoked yet) gets the biggest.
 *
 * Nothing grants these yet: the Stripe prices do not exist. See
 * tierForStripePrice at the bottom.
 *
 * Sizes are binary, as Windows shows them, so a "100 GB" plan holds what
 * Explorer calls 100 GB. The table below is the one place to change that.
 */

export const GB = 2 ** 30;
export const TB = 2 ** 40;

export const CLOUD_PICKUP_TIERS = Object.freeze([
  Object.freeze({
    slug: "forgedrop-cloud-pickup-100gb",
    label: "100 GB",
    monthlyCents: 500,
    bytes: 100 * GB,
    stripePriceEnv: "STRIPE_PRICE_FORGEDROP_PICKUP_100GB",
  }),
  Object.freeze({
    slug: "forgedrop-cloud-pickup-250gb",
    label: "250 GB",
    monthlyCents: 1000,
    bytes: 250 * GB,
    stripePriceEnv: "STRIPE_PRICE_FORGEDROP_PICKUP_250GB",
  }),
  Object.freeze({
    slug: "forgedrop-cloud-pickup-500gb",
    label: "500 GB",
    monthlyCents: 1500,
    bytes: 500 * GB,
    stripePriceEnv: "STRIPE_PRICE_FORGEDROP_PICKUP_500GB",
  }),
  Object.freeze({
    slug: "forgedrop-cloud-pickup-1tb",
    label: "1 TB",
    monthlyCents: 2500,
    bytes: 1 * TB,
    stripePriceEnv: "STRIPE_PRICE_FORGEDROP_PICKUP_1TB",
  }),
]);

const BY_SLUG = new Map(CLOUD_PICKUP_TIERS.map((tier) => [tier.slug, tier]));

export function cloudPickupTier(slug) {
  return BY_SLUG.get(String(slug || "").trim().toLowerCase()) || null;
}

/**
 * The biggest tier among an account's entitlement rows, or null for none.
 * `rows` are active entitlements (entitlement.service listProductEntitlements).
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
 * uploading counts, so two at once cannot both fit in what is left.
 * A pickup abandoned mid-upload is cancelled by the sweep, and so not
 * counted either.
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

// ---------------------------------------------------------------------------
// STRIPE PRICE IDS -> TIERS: NOT WIRED YET.
//
// The four monthly prices do not exist yet (ForgeDrop/docs/pickup.md, "Needs
// the owner"). When they do:
//   1. put each price id in Render under its tier's `stripePriceEnv` name;
//   2. have the subscription webhook (routes/stripe.webhooks.routes.js) call
//      this with the subscription's price, grant that tier's slug while the
//      subscription is active and revoke the other three, the way
//      syncTabForgeSubscriptionEntitlements keeps Private Sync in step;
//   3. pay the affiliate share through the existing referral code.
// Until then nothing calls this, and an account has a tier only if one is
// granted by hand.
// ---------------------------------------------------------------------------
export function tierForStripePrice(priceId, env = process.env) {
  const id = String(priceId || "").trim();
  if (!id) return null;
  return CLOUD_PICKUP_TIERS.find((tier) => String(env?.[tier.stripePriceEnv] || "").trim() === id) || null;
}
