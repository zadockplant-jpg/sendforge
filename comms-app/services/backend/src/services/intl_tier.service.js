// services/backend/src/services/intl_tier.service.js
const TIER1 = new Set([
  "GB","IE","FR","DE","ES","IT","NL","BE","SE","NO","DK","FI","AT","CH","PT",
  "AU","NZ",
]);

const TIER2 = new Set([
  "BR","MX","AR","CL","CO","PE","JP",
]);

export function getIntlTier(countryCode) {
  if (TIER1.has(countryCode)) return "tier1";
  if (TIER2.has(countryCode)) return "tier2";
  return "tier3"; // blocked/manual
}
