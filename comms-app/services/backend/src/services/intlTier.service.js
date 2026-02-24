import { INTL_MULTIPLIER } from "../config/pricingpolicy.js";

// Keep this simple; expand later.
const TIER1 = new Set(["GB", "IE", "FR", "DE", "ES", "IT", "NL", "BE", "SE", "NO", "DK", "FI", "AT", "CH", "PT", "AU", "NZ"]);
const TIER2 = new Set(["BR", "MX", "AR", "CL", "CO", "PE", "JP"]);

// Tier3 = everything else (high-risk) unless you add allowlist entries
export function getIntlTier(countryCode) {
  if (TIER1.has(countryCode)) return "tier1";
  if (TIER2.has(countryCode)) return "tier2";
  return "tier3";
}

export function isTierBlocked(tier) {
  return tier === "tier3";
}

export function getMultiplierForTier(tier) {
  return INTL_MULTIPLIERS[tier] ?? null;
}
