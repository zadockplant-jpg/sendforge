/**
 * Products that hand out offline device licences.
 *
 * Kept separate from PRODUCT_CATALOG in billing.routes.js on purpose: that
 * catalog is about taking money, this list is about what an installed app may
 * activate. Most products will never appear here.
 *
 * The device limit lives per product rather than as one shared constant,
 * because the next licensed product will want a different number and a shared
 * constant is how that turns into a silent change to this one.
 */

export const LICENSED_PRODUCTS = Object.freeze([
  Object.freeze({
    slug: "forgedrop",
    displayName: "ForgeDrop",
    entitlementSlug: "forgedrop",
    deviceLimit: 5,
  }),
]);

const BY_SLUG = new Map(LICENSED_PRODUCTS.map((p) => [p.slug, p]));

export function licensedProduct(slug) {
  return BY_SLUG.get(String(slug || "").trim().toLowerCase()) || null;
}
