const nodeEnv = process.env.NODE_ENV || "development";
const port = Number(process.env.PORT || 3000);

// API base URL
let publicBaseUrl = process.env.PUBLIC_BASE_URL;

// Website base URL
let publicSiteUrl = process.env.PUBLIC_SITE_URL;

if (nodeEnv === "production") {
  if (!publicBaseUrl) {
    throw new Error(
      "PUBLIC_BASE_URL must be set in production (for example https://api.sendforge.app)"
    );
  }

  if (!publicSiteUrl) {
    publicSiteUrl = publicBaseUrl;
  }
} else {
  publicBaseUrl = publicBaseUrl || `http://localhost:${process.env.PORT || 3000}`;
  publicSiteUrl = publicSiteUrl || "http://localhost:8080";
}

export const env = {
  nodeEnv,
  port,

  publicBaseUrl,
  publicSiteUrl,

  jwtSecret: process.env.JWT_SECRET || "",
  databaseUrl: process.env.DATABASE_URL || "",
  redisUrl: process.env.REDIS_URL || "",

  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  stripePriceTabforge: process.env.STRIPE_PRICE_TABFORGE || "",
  stripePriceTabforgeSync:
    process.env.STRIPE_PRICE_TABFORGE_SYNC || "",
  stripePriceForgedrop: process.env.STRIPE_PRICE_FORGEDROP || "",

  // Ed25519 seed (32 bytes, base64 or hex) that signs offline device licences.
  // Never stored in Postgres. A licence signed by this key is trusted by an
  // installed app forever, with no channel to reach that machine and say
  // otherwise - rotating the kid keeps old licences valid, so rotation is not
  // revocation.
  //
  // One key signs every licensed product; the product is inside the signed
  // payload, so a ForgeDrop licence can never open Rose Colored Glasses. The
  // FORGEDROP_ names are the original ones and still work.
  licenseSigningKey:
    process.env.LICENSE_SIGNING_KEY ||
    process.env.FORGEDROP_LICENSE_SIGNING_KEY ||
    "",
  licenseSigningKid:
    process.env.LICENSE_SIGNING_KID ||
    process.env.FORGEDROP_LICENSE_SIGNING_KID ||
    "fd-2026-09",

  // Inmate Records merch fulfillment (backend only)
  printfulApiKey: process.env.PRINTFUL_API_KEY || "",
  printfulStoreId: process.env.PRINTFUL_STORE_ID || "",
  inmateRecordsSiteUrl:
    process.env.INMATE_RECORDS_SITE_URL ||
    process.env.PUBLIC_INMATE_RECORDS_SITE_URL ||
    "https://inmaterecordings.com",

  // Google Contacts OAuth (backend only)
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || "",
};
