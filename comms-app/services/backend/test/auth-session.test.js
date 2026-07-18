import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET =
  process.env.JWT_SECRET || "sendforge-auth-session-test-secret-at-least-32-bytes";

const {
  ACCESS_TOKEN_TTL_SECONDS,
  ADMIN_TOKEN_AUDIENCE,
  ADMIN_TOKEN_TTL_SECONDS,
  CUSTOMER_TOKEN_AUDIENCE,
  CUSTOMER_TOKEN_ISSUER,
  MAX_CUSTOMER_SESSION_AGE_SECONDS,
  adminTokenMatchesUser,
  customerTokenMatchesUser,
  issueAdminAccessToken,
  issueCustomerAccessToken,
  verifyAdminAccessToken,
  verifyCustomerAccessToken,
} = await import("../src/services/auth.service.js");

const USER = {
  id: "9ba6e0bf-e1ab-49af-8c9f-90ae392af8f0",
  email: "owner@example.com",
  authVersion: 4,
};

test("customer access tokens carry bounded, audience-specific session claims", () => {
  const now = 2_000_000_000;
  const token = issueCustomerAccessToken(USER, { nowSeconds: now });
  const payload = verifyCustomerAccessToken(token, { nowSeconds: now });

  assert.equal(payload.sub, USER.id);
  assert.equal(payload.email, USER.email);
  assert.equal(payload.iss, CUSTOMER_TOKEN_ISSUER);
  assert.equal(payload.aud, CUSTOMER_TOKEN_AUDIENCE);
  assert.equal(payload.auth_version, 4);
  assert.equal(payload.session_started_at, now);
  assert.equal(payload.iat, now);
  assert.equal(payload.exp, now + ACCESS_TOKEN_TTL_SECONDS);

  assert.throws(
    () =>
      verifyCustomerAccessToken(token, {
        nowSeconds: now + ACCESS_TOKEN_TTL_SECONDS + 31,
      }),
    /expired/i
  );
});

test("refreshable access tokens preserve login time and cannot outlive 30 days", () => {
  const sessionStart = 2_000_000_000;
  const original = issueCustomerAccessToken(USER, { nowSeconds: sessionStart });
  const expiredClaims = verifyCustomerAccessToken(original, {
    allowExpired: true,
    nowSeconds: sessionStart + 2 * ACCESS_TOKEN_TTL_SECONDS,
  });

  const nearSessionEnd =
    sessionStart + MAX_CUSTOMER_SESSION_AGE_SECONDS - 60 * 60;
  const refreshed = issueCustomerAccessToken(
    {
      ...USER,
      sessionStartedAt: expiredClaims.session_started_at,
    },
    { nowSeconds: nearSessionEnd }
  );
  const refreshedClaims = verifyCustomerAccessToken(refreshed, {
    nowSeconds: nearSessionEnd,
  });

  assert.equal(refreshedClaims.session_started_at, sessionStart);
  assert.equal(
    refreshedClaims.exp,
    sessionStart + MAX_CUSTOMER_SESSION_AGE_SECONDS,
    "the last access token is shortened to the remaining session lifetime"
  );
  assert.throws(
    () =>
      verifyCustomerAccessToken(refreshed, {
        allowExpired: true,
        nowSeconds: sessionStart + MAX_CUSTOMER_SESSION_AGE_SECONDS,
      }),
    /invalid_customer_token_claims/
  );
  assert.throws(
    () =>
      issueCustomerAccessToken(
        { ...USER, sessionStartedAt: sessionStart },
        { nowSeconds: sessionStart + MAX_CUSTOMER_SESSION_AGE_SECONDS }
      ),
    /customer_session_expired/
  );
});

test("legacy and wrong-purpose JWTs cannot enter the customer refresh chain", () => {
  const now = 2_000_000_000;
  const legacy = jwt.sign(
    { sub: USER.id, email: USER.email },
    process.env.JWT_SECRET,
    { algorithm: "HS256" }
  );
  const admin = jwt.sign(
    { sub: USER.id, email: USER.email, admin: true },
    process.env.JWT_SECRET,
    {
      algorithm: "HS256",
      issuer: CUSTOMER_TOKEN_ISSUER,
      audience: "sendforge-admin",
      expiresIn: "8h",
    }
  );

  assert.throws(
    () =>
      verifyCustomerAccessToken(legacy, {
        allowExpired: true,
        nowSeconds: now,
      }),
    /issuer|audience|claims/i
  );
  assert.throws(
    () =>
      verifyCustomerAccessToken(admin, {
        allowExpired: true,
        nowSeconds: now,
      }),
    /audience/i
  );
});

test("password-reset auth_version changes and verification state revoke old tokens", () => {
  const now = 2_000_000_000;
  const token = issueCustomerAccessToken(USER, { nowSeconds: now });
  const claims = verifyCustomerAccessToken(token, { nowSeconds: now });
  const currentUser = {
    id: USER.id,
    email: USER.email,
    email_verified: true,
    auth_version: USER.authVersion,
  };

  assert.equal(customerTokenMatchesUser(claims, currentUser), true);
  assert.equal(
    customerTokenMatchesUser(claims, {
      ...currentUser,
      auth_version: USER.authVersion + 1,
    }),
    false,
    "the atomic password-reset increment invalidates every old access token"
  );
  assert.equal(
    customerTokenMatchesUser(claims, {
      ...currentUser,
      email_verified: false,
    }),
    false
  );
});

test("admin access is limited to eight hours and tied to current auth_version", () => {
  const now = 2_000_000_000;
  const token = issueAdminAccessToken(USER, { nowSeconds: now });
  const claims = verifyAdminAccessToken(token, { nowSeconds: now });
  const currentUser = {
    id: USER.id,
    email: USER.email,
    email_verified: true,
    auth_version: USER.authVersion,
  };

  assert.equal(claims.iss, CUSTOMER_TOKEN_ISSUER);
  assert.equal(claims.aud, ADMIN_TOKEN_AUDIENCE);
  assert.equal(claims.exp, now + ADMIN_TOKEN_TTL_SECONDS);
  assert.equal(adminTokenMatchesUser(claims, currentUser), true);
  assert.equal(
    adminTokenMatchesUser(claims, {
      ...currentUser,
      auth_version: USER.authVersion + 1,
    }),
    false,
    "password reset also revokes an already-issued admin token"
  );
  assert.throws(
    () =>
      verifyAdminAccessToken(token, {
        nowSeconds: now + ADMIN_TOKEN_TTL_SECONDS + 31,
      }),
    /expired/i
  );
});
