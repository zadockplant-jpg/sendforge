// src/config/env.js

const nodeEnv = process.env.NODE_ENV || "development";
const port = Number(process.env.PORT || 3000);

// PUBLIC_BASE_URL rules:
// - REQUIRED in production
// - Optional in development (falls back to localhost)
let publicBaseUrl = process.env.PUBLIC_BASE_URL;

if (nodeEnv === "production") {
  if (!publicBaseUrl) {
    throw new Error(
      "PUBLIC_BASE_URL must be set in production (e.g. https://comms-app-1w0o.onrender.com)"
    );
  }
} else {
  // development fallback only
  publicBaseUrl =
    publicBaseUrl || `http://localhost:${process.env.PORT || 3000}`;
}

export const env = {
  nodeEnv,
  port,
  publicBaseUrl,

  jwtSecret: process.env.JWT_SECRET || "",
  databaseUrl: process.env.DATABASE_URL || "",
  redisUrl: process.env.REDIS_URL || "",

  // Google Contacts OAuth (backend only)
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || "",
};
