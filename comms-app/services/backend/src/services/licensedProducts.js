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
 *
 * Two ways a product counts its devices:
 *
 *  - A fixed `deviceLimit`: one purchase covers that many machines (ForgeDrop,
 *    five).
 *  - `seatBased`: every purchase is one device, and the limit is the number of
 *    paid seats on the account (see productSeats.service.js). `deviceLimit` is
 *    then only the floor used for an entitlement granted by hand, with no
 *    purchase behind it.
 *
 * `codePrefix` starts the activation code a person reads off their account
 * page, so a code says at a glance which product it opens.
 */

export const LICENSED_PRODUCTS = Object.freeze([
  Object.freeze({
    slug: "forgedrop",
    displayName: "ForgeDrop",
    entitlementSlug: "forgedrop",
    deviceLimit: 5,
    seatBased: false,
    codePrefix: "FD",
  }),
  Object.freeze({
    slug: "rose-colored-glasses",
    displayName: "Rose Colored Glasses",
    entitlementSlug: "rose-colored-glasses",
    deviceLimit: 1,
    seatBased: true,
    codePrefix: "RC",
  }),
]);

const BY_SLUG = new Map(LICENSED_PRODUCTS.map((p) => [p.slug, p]));

export function licensedProduct(slug) {
  return BY_SLUG.get(String(slug || "").trim().toLowerCase()) || null;
}

// ForgeDrop codes predate per-product prefixes, so it is the fallback.
export function codePrefixFor(slug) {
  return licensedProduct(slug)?.codePrefix || "FD";
}
