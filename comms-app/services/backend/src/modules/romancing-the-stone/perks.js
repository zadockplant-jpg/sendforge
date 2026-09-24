/**
 * Licence perks. The structure is live; the perks themselves are still being
 * arranged, so each one is published as "coming soon" and cannot be claimed.
 * Turning one on is a status change here plus its fulfilment, nothing else.
 */

export const PERK_STATUS = Object.freeze({
  COMING_SOON: "coming_soon",
  AVAILABLE: "available",
});

export const RTS_PERKS = Object.freeze([
  Object.freeze({
    id: "subscriber-drops",
    audience: "subscription",
    title: "Subscriber deals & rewards",
    description: "New deals and rewards released for subscribers from time to time.",
    kind: "drop",
    status: PERK_STATUS.COMING_SOON,
  }),
  Object.freeze({
    id: "permanent-merch",
    audience: "permanent",
    title: "Exclusive merch",
    description: "Pick from a couple of exclusive merch items, only for permanent license holders.",
    kind: "choice",
    options: Object.freeze([]),
    status: PERK_STATUS.COMING_SOON,
  }),
  Object.freeze({
    id: "permanent-partner-deals",
    audience: "permanent",
    title: "Partner coupons & deals",
    description: "Coupons and deals from other companies, included with the permanent license perk package.",
    kind: "coupons",
    status: PERK_STATUS.COMING_SOON,
  }),
]);

export function perkById(id) {
  return RTS_PERKS.find((perk) => perk.id === id) || null;
}

/** Perks as the app shows them to this account. */
export function perksFor(license) {
  const plan = license?.plan || null;
  return RTS_PERKS.map((perk) => ({
    id: perk.id,
    audience: perk.audience,
    title: perk.title,
    description: perk.description,
    kind: perk.kind,
    status: perk.status,
    // Subscribers get the periodic drops; the permanent licence comes with the
    // perk package instead.
    eligible: plan === "comp" || plan === perk.audience,
  }));
}
