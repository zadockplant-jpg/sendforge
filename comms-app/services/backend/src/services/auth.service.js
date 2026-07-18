import jwt from "jsonwebtoken";
import { db } from "../config/db.js";
import { env } from "../config/env.js";

export const CUSTOMER_TOKEN_ISSUER = "sendforge-api";
export const CUSTOMER_TOKEN_AUDIENCE = "sendforge-customer";
export const CUSTOMER_TOKEN_USE = "customer_access";
export const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
export const MAX_CUSTOMER_SESSION_AGE_SECONDS = 30 * 24 * 60 * 60;
export const ADMIN_TOKEN_AUDIENCE = "sendforge-admin";
export const ADMIN_TOKEN_USE = "admin_access";
export const ADMIN_TOKEN_TTL_SECONDS = 8 * 60 * 60;
export const AUTH_STATE_CACHE_TTL_MS = 30 * 1000;

const CLOCK_TOLERANCE_SECONDS = 30;
const MAX_AUTH_STATE_CACHE_ENTRIES = 10_000;
const authStateCache = new Map();

function integerClaim(value) {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function tokenError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateCustomerClaims(payload, nowSeconds) {
  if (!payload || typeof payload !== "object") {
    throw tokenError("invalid_customer_token_claims");
  }

  const authVersion = integerClaim(payload.auth_version);
  const sessionStartedAt = integerClaim(payload.session_started_at);
  const issuedAt = integerClaim(payload.iat);
  const expiresAt = integerClaim(payload.exp);
  const subject = String(payload.sub || "");
  const email = String(payload.email || "").trim().toLowerCase();

  if (
    payload.token_use !== CUSTOMER_TOKEN_USE ||
    !subject ||
    subject.length > 128 ||
    !email ||
    authVersion === null ||
    authVersion < 0 ||
    sessionStartedAt === null ||
    issuedAt === null ||
    expiresAt === null ||
    sessionStartedAt > issuedAt ||
    issuedAt > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > ACCESS_TOKEN_TTL_SECONDS ||
    nowSeconds - sessionStartedAt >= MAX_CUSTOMER_SESSION_AGE_SECONDS
  ) {
    throw tokenError("invalid_customer_token_claims");
  }

  return {
    ...payload,
    sub: subject,
    email,
    auth_version: authVersion,
    session_started_at: sessionStartedAt,
    iat: issuedAt,
    exp: expiresAt,
  };
}

export function issueCustomerAccessToken(
  { id, email, authVersion = 0, sessionStartedAt = null },
  { nowSeconds = Math.floor(Date.now() / 1000) } = {}
) {
  if (!env.jwtSecret) throw new Error("JWT_SECRET missing");

  const subject = String(id || "");
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const version = integerClaim(authVersion);
  const sessionStart = integerClaim(sessionStartedAt ?? nowSeconds);

  if (
    !subject ||
    !normalizedEmail ||
    version === null ||
    version < 0 ||
    sessionStart === null ||
    sessionStart > nowSeconds + CLOCK_TOLERANCE_SECONDS
  ) {
    throw tokenError("invalid_customer_session");
  }

  const remainingSessionSeconds =
    sessionStart + MAX_CUSTOMER_SESSION_AGE_SECONDS - nowSeconds;
  const expiresIn = Math.min(ACCESS_TOKEN_TTL_SECONDS, remainingSessionSeconds);
  if (expiresIn <= 0) throw tokenError("customer_session_expired");

  return jwt.sign(
    {
      sub: subject,
      email: normalizedEmail,
      token_use: CUSTOMER_TOKEN_USE,
      auth_version: version,
      session_started_at: sessionStart,
      iat: nowSeconds,
    },
    env.jwtSecret,
    {
      algorithm: "HS256",
      issuer: CUSTOMER_TOKEN_ISSUER,
      audience: CUSTOMER_TOKEN_AUDIENCE,
      expiresIn,
    }
  );
}

export function verifyCustomerAccessToken(
  token,
  {
    allowExpired = false,
    nowSeconds = Math.floor(Date.now() / 1000),
  } = {}
) {
  if (!env.jwtSecret) throw new Error("JWT_SECRET missing");

  const payload = jwt.verify(token, env.jwtSecret, {
    algorithms: ["HS256"],
    issuer: CUSTOMER_TOKEN_ISSUER,
    audience: CUSTOMER_TOKEN_AUDIENCE,
    clockTimestamp: nowSeconds,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    ignoreExpiration: allowExpired,
  });

  return validateCustomerClaims(payload, nowSeconds);
}

export function issueAdminAccessToken(
  { id, email, authVersion = 0 },
  { nowSeconds = Math.floor(Date.now() / 1000) } = {}
) {
  if (!env.jwtSecret) throw new Error("JWT_SECRET missing");
  const subject = String(id || "");
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const version = integerClaim(authVersion);
  if (!subject || !normalizedEmail || version === null || version < 0) {
    throw tokenError("invalid_admin_session");
  }

  return jwt.sign(
    {
      sub: subject,
      email: normalizedEmail,
      admin: true,
      role: "owner",
      token_use: ADMIN_TOKEN_USE,
      auth_version: version,
      iat: nowSeconds,
    },
    env.jwtSecret,
    {
      algorithm: "HS256",
      issuer: CUSTOMER_TOKEN_ISSUER,
      audience: ADMIN_TOKEN_AUDIENCE,
      expiresIn: ADMIN_TOKEN_TTL_SECONDS,
    }
  );
}

export function verifyAdminAccessToken(
  token,
  { nowSeconds = Math.floor(Date.now() / 1000) } = {}
) {
  if (!env.jwtSecret) throw new Error("JWT_SECRET missing");
  const payload = jwt.verify(token, env.jwtSecret, {
    algorithms: ["HS256"],
    issuer: CUSTOMER_TOKEN_ISSUER,
    audience: ADMIN_TOKEN_AUDIENCE,
    clockTimestamp: nowSeconds,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  });
  const authVersion = integerClaim(payload?.auth_version);
  const issuedAt = integerClaim(payload?.iat);
  const expiresAt = integerClaim(payload?.exp);
  if (
    payload?.token_use !== ADMIN_TOKEN_USE ||
    payload?.admin !== true ||
    payload?.role !== "owner" ||
    !payload?.sub ||
    !payload?.email ||
    authVersion === null ||
    authVersion < 0 ||
    issuedAt === null ||
    expiresAt === null ||
    issuedAt > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > ADMIN_TOKEN_TTL_SECONDS
  ) {
    throw tokenError("invalid_admin_token_claims");
  }
  return {
    ...payload,
    email: String(payload.email).trim().toLowerCase(),
    auth_version: authVersion,
    iat: issuedAt,
    exp: expiresAt,
  };
}

export function customerTokenMatchesUser(payload, user) {
  if (!payload || !user || !user.email_verified) return false;
  return (
    String(payload.sub) === String(user.id) &&
    String(payload.email).toLowerCase() ===
      String(user.email || "").trim().toLowerCase() &&
    Number(payload.auth_version) === Number(user.auth_version || 0)
  );
}

export function adminTokenMatchesUser(payload, user) {
  return (
    payload?.admin === true &&
    payload?.role === "owner" &&
    customerTokenMatchesUser(payload, user)
  );
}

function pruneAuthStateCache(nowMs) {
  for (const [key, entry] of authStateCache) {
    if (entry.expiresAt <= nowMs) authStateCache.delete(key);
  }
  if (authStateCache.size >= MAX_AUTH_STATE_CACHE_ENTRIES) {
    const oldestKey = authStateCache.keys().next().value;
    if (oldestKey !== undefined) authStateCache.delete(oldestKey);
  }
}

export async function getCurrentCustomerAuthState(
  userId,
  {
    database = db,
    nowMs = Date.now(),
    useCache = database === db,
  } = {}
) {
  const cacheKey = String(userId || "");
  if (!cacheKey) return null;

  if (useCache) {
    const cached = authStateCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) return cached.user;
    if (cached) authStateCache.delete(cacheKey);
  }

  const user = await database("users")
    .select("id", "email", "email_verified", "auth_version")
    .where({ id: cacheKey })
    .first();

  const normalized = user
    ? {
        id: user.id,
        email: String(user.email || "").trim().toLowerCase(),
        email_verified: Boolean(user.email_verified),
        auth_version: Number(user.auth_version || 0),
      }
    : null;

  if (useCache) {
    pruneAuthStateCache(nowMs);
    authStateCache.set(cacheKey, {
      user: normalized,
      expiresAt: nowMs + AUTH_STATE_CACHE_TTL_MS,
    });
  }

  return normalized;
}

export function clearCustomerAuthStateCache(userId) {
  authStateCache.delete(String(userId || ""));
}
