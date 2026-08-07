import { buildWebAuthnConfig } from "./webauthn.js";

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

const webAuthn = buildWebAuthnConfig({ nodeEnv, port });

export const env = {
  nodeEnv,
  port,

  publicBaseUrl,
  publicSiteUrl,

  webAuthnRpName: webAuthn.rpName,
  webAuthnRpId: webAuthn.rpId,
  webAuthnOrigins: webAuthn.origins,
  webAuthnTimeoutMs: webAuthn.timeoutMs,
  webAuthnChallengeTtlMs: webAuthn.challengeTtlMs,
  webAuthnAllowedAaguids: webAuthn.allowedAaguids,

  jwtSecret: process.env.JWT_SECRET || "",
  databaseUrl: process.env.DATABASE_URL || "",
  redisUrl: process.env.REDIS_URL || "",

  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  stripePriceTabforge: process.env.STRIPE_PRICE_TABFORGE || "",
  stripePriceTabforgeSync:
    process.env.STRIPE_PRICE_TABFORGE_SYNC || "",

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
