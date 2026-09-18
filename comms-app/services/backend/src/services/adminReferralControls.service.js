// Pure helpers behind the owner dashboard: perk accounts, batch payouts and
// the commission (threshold) editor. Kept free of database access so every
// rule here is unit-testable; the routes in admin.routes.js do the I/O.

import { recurringTierFromProgram, tiersFromProgram } from "./referrals/referral.service.js";

// A perk account owns TabForge Pro and Private Sync without paying. Both
// slugs are the ones purchase fulfilment grants, so every downstream check
// (referral eligibility, sync access, the account page) sees a normal owner.
export const PERK_ENTITLEMENT_SLUGS = Object.freeze(["tabforge", "tabforge-subscription"]);
export const PERK_ENTITLEMENT_SOURCE = "admin_perk";

export function perkEntitlementMetadata({ adminEmail, note = "", grantedAt = new Date() } = {}) {
  return {
    perk: true,
    granted_by: String(adminEmail || "").trim().toLowerCase() || null,
    granted_at: new Date(grantedAt).toISOString(),
    note: String(note || "").trim() || null,
  };
}

export function isPerkEntitlement(row) {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return metadata.perk === true || String(row?.source || "") === PERK_ENTITLEMENT_SOURCE;
}

// Group entitlement rows (joined with the owner's email) into one perk
// account per user, so the dashboard lists people, not rows.
export function groupPerkAccounts(rows = []) {
  const byUser = new Map();
  for (const row of rows) {
    if (!isPerkEntitlement(row)) continue;
    const key = row.user_id || row.email;
    if (!byUser.has(key)) {
      byUser.set(key, {
        userId: row.user_id || null,
        email: row.email || null,
        products: [],
        active: false,
        grantedAt: null,
        grantedBy: null,
        note: null,
        referralCode: row.referral_code || null,
      });
    }
    const account = byUser.get(key);
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const active = String(row.status || "") === "active";
    account.products.push({ slug: row.product_slug, status: row.status || null, grantedAt: row.granted_at || null });
    account.active = account.active || active;
    if (!account.grantedAt || (row.granted_at && new Date(row.granted_at) < new Date(account.grantedAt))) {
      account.grantedAt = row.granted_at || account.grantedAt;
    }
    account.grantedBy ||= metadata.granted_by || row.source_ref || null;
    account.note ||= metadata.note || null;
    account.referralCode ||= row.referral_code || null;
  }
  return [...byUser.values()].sort((a, b) => String(b.grantedAt || "").localeCompare(String(a.grantedAt || "")));
}

// Every paid reward needs a payout reference that is unique across the
// queue (there is a unique index on it). A batch reference, such as the
// Cash App transfer date or a ledger id, is suffixed with the reward id so
// one batch never collides with itself.
export function batchPayoutReference(batchReference, rewardId) {
  const batch = String(batchReference || "").trim().replace(/\s+/g, " ");
  const id = String(rewardId || "").trim();
  return batch ? `${batch}:${id}` : `manual:${id}`;
}

// The commission editor speaks in two shapes: fixed milestones (N qualified
// purchases pays $X once) and a per-sale rule ($X every M purchases after
// the first N). Both are stored on the program's metadata, which is what
// the referral service already reads.
export function normalizeTierInput(tier) {
  const requiredPurchases = Number(tier?.requiredPurchases);
  const rewardAmountCents = Number(tier?.rewardAmountCents);
  if (!Number.isInteger(requiredPurchases) || requiredPurchases < 1 || requiredPurchases > 1000) return null;
  if (!Number.isInteger(rewardAmountCents) || rewardAmountCents < 0) return null;
  return { requiredPurchases, rewardAmountCents };
}

export function normalizeRecurringTierInput(input) {
  if (!input || typeof input !== "object") return null;
  const startAfterPurchases = Number(input.startAfterPurchases);
  const everyPurchases = Number(input.everyPurchases);
  const rewardAmountCents = Number(input.rewardAmountCents);
  if (!Number.isInteger(startAfterPurchases) || startAfterPurchases < 1) return null;
  if (!Number.isInteger(everyPurchases) || everyPurchases < 1) return null;
  if (!Number.isInteger(rewardAmountCents) || rewardAmountCents < 1) return null;
  return { startAfterPurchases, everyPurchases, rewardAmountCents };
}

// "$5 per sale" is a milestone at the first purchase plus the same amount
// every purchase after it. This turns that one intent into the two records.
export function perSaleCommission(rewardAmountCents) {
  const cents = Number(rewardAmountCents);
  if (!Number.isInteger(cents) || cents < 1) return null;
  return {
    tiers: [{ requiredPurchases: 1, rewardAmountCents: cents }],
    recurringTier: { startAfterPurchases: 1, everyPurchases: 1, rewardAmountCents: cents },
  };
}

export function programMetadataFromInput({
  existingMetadata = {},
  tiers = null,
  recurringTier,
  holdDays,
  qualification,
  extra = {},
} = {}) {
  const base = existingMetadata && typeof existingMetadata === "object" ? existingMetadata : {};
  const metadata = { ...base, ...(extra || {}) };
  metadata.qualification = qualification || base.qualification || "verified_purchase";
  if (Number.isInteger(Number(holdDays))) metadata.payout_hold_days = Number(holdDays);
  metadata.payout_hold_reason ||= "Fraud/refund verification window before manual Cash App payout.";
  const normalizedTiers = Array.isArray(tiers) ? tiers.map(normalizeTierInput).filter(Boolean) : null;
  if (normalizedTiers && normalizedTiers.length) {
    metadata.tiers = normalizedTiers.sort((a, b) => a.requiredPurchases - b.requiredPurchases);
  }
  // Explicit null switches the recurring rule off. The service treats an
  // object without valid numbers as "no recurring tier", and an absent key
  // as "use the built-in default", so the off switch has to be an object.
  if (recurringTier === null) metadata.recurringTier = { enabled: false };
  else if (recurringTier !== undefined) {
    const normalized = normalizeRecurringTierInput(recurringTier);
    if (normalized) metadata.recurringTier = normalized;
  }
  return metadata;
}

// What the dashboard shows and edits for a program row.
export function commissionSummary(program) {
  const tiers = tiersFromProgram(program);
  const recurring = recurringTierFromProgram(program);
  const perSale = Boolean(
    recurring &&
    recurring.everyPurchases === 1 &&
    recurring.startAfterPurchases === 1 &&
    tiers.length === 1 &&
    tiers[0].requiredPurchases === 1 &&
    tiers[0].rewardAmountCents === recurring.rewardAmountCents
  );
  return {
    productSlug: program?.product_slug || null,
    status: program?.status || null,
    holdDays: Number(program?.metadata?.payout_hold_days ?? program?.refund_hold_days ?? 0),
    tiers,
    recurringTier: recurring,
    mode: perSale ? "per_sale" : "milestones",
    perSaleRewardCents: perSale ? recurring.rewardAmountCents : null,
  };
}
