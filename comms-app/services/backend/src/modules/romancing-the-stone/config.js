export const RTS_VERSION = "1.0.0";

// Product, entitlement and plan names. The subscription and the permanent
// licence are separate entitlements on purpose: product_entitlements keeps one
// row per account and product, so sharing a slug would let a subscription
// status change overwrite (and later revoke) a permanent licence.
export const RTS_SUBSCRIPTION_PRODUCT_SLUG = "romancing-the-stone";
export const RTS_PERMANENT_PRODUCT_SLUG = "romancing-the-stone-permanent";
export const RTS_SUBSCRIPTION_ENTITLEMENT = "romancing-the-stone-subscription";
export const RTS_PERMANENT_ENTITLEMENT = "romancing-the-stone-permanent";
export const RTS_SUBSCRIPTION_PLAN = "rts_subscription";

// $30 today covers the first six months; then $5/month until canceled.
export const RTS_START_PRICE_CENTS = 3000;
export const RTS_RENEWAL_PRICE_CENTS = 500;
export const RTS_INCLUDED_MONTHS = 6;
export const RTS_INCLUDED_DAYS = 183;
export const RTS_PERMANENT_PRICE_CENTS = 12000;

// One licence covers the buyer's circles: every phone, tablet and browser that
// opens them counts toward the same ten.
export const RTS_DEVICE_LIMIT = 10;

export const RTS_LIMITS = Object.freeze({
  circlesPerUser: 20,
  membersPerCircle: 30,
  questsPerCircle: 200,
  pathsPerCircle: 200,
  graphBytes: 200_000,
});

const emailList = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

export function getRtsConfig(environment = process.env) {
  const appUrl = String(environment.RTS_APP_URL || "").trim();
  let safeAppUrl = "";
  try {
    const url = new URL(appUrl);
    if (url.protocol === "https:" || url.hostname === "localhost") safeAppUrl = url.toString();
  } catch {
    safeAppUrl = "";
  }
  return Object.freeze({
    enabled: environment.RTS_ENABLED === "true",
    // Accounts that hold a complimentary licence (the owner's own testing).
    compEmails: emailList(
      environment.RTS_COMP_EMAILS ??
        environment.TABFORGE_CLOUD_OWNER_EMAIL ??
        environment.ADMIN_LIVE_TEST_OWNER_EMAIL ??
        "zadockplant@gmail.com"
    ),
    // Where Stripe sends people back to. Blank means the app is served from the
    // storefront at PUBLIC_SITE_URL/romancing-the-stone/.
    appUrl: safeAppUrl,
    bodyLimit: "256kb",
  });
}

export const RTS_APP_PATH = "/romancing-the-stone/";
