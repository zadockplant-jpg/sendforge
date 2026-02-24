// Centralized pricing + plan rules (LOCKED)

export const PLAN = {
  FREE: "free",
  PRO: "pro",
  BUSINESS: "business",
};

// International SMS caps (USD cents)
// US / CA are NOT included here (domestic)
export const INTL_CAPS_CENTS = {
  pro: {
    soft_per_blast: 1000,   // $10
    hard_accum: 2000,       // $20
  },
  business: {
    soft_per_blast: 3000,   // $30
    hard_accum: 5000,       // $50
  },
};

// Region multipliers (applied to Twilio base cost)
export const INTL_MULTIPLIERS = {
  tier1: 1.3, // UK / EU / AU
  tier2: 1.6, // LATAM / JP
};

// US & Canada are treated as domestic
export function isDomesticUSCA(countryCode) {
  return countryCode === "US" || countryCode === "CA";
}
