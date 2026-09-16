import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

import { googleIdentityFromPayload } from "../src/routes/auth.routes.js";

const routeSource = readFileSync(
  new URL("../src/routes/auth.routes.js", import.meta.url),
  "utf8"
);

describe("Google sign-in", () => {
  test("only a Google-verified address becomes an identity", () => {
    assert.deepEqual(
      googleIdentityFromPayload({ email: "Person@Example.com", email_verified: true }),
      { email: "person@example.com" },
      "the address is normalized to lowercase so it matches the users table"
    );

    // The security-critical case: Google says the address is unverified, so we
    // must not let the caller claim it.
    assert.equal(
      googleIdentityFromPayload({ email: "person@example.com", email_verified: false }),
      null
    );
    // A missing flag is not a truthy flag.
    assert.equal(googleIdentityFromPayload({ email: "person@example.com" }), null);
    // Nor is a string "true".
    assert.equal(
      googleIdentityFromPayload({ email: "person@example.com", email_verified: "true" }),
      null
    );
  });

  test("malformed payloads never produce an identity", () => {
    assert.equal(googleIdentityFromPayload(null), null);
    assert.equal(googleIdentityFromPayload(undefined), null);
    assert.equal(googleIdentityFromPayload("person@example.com"), null);
    assert.equal(googleIdentityFromPayload({ email_verified: true }), null);
    assert.equal(googleIdentityFromPayload({ email: "", email_verified: true }), null);
    assert.equal(googleIdentityFromPayload({ email: "   ", email_verified: true }), null);
    assert.equal(googleIdentityFromPayload({ email: "not-an-email", email_verified: true }), null);
  });

  test("the token is verified against our own client id", () => {
    // Without an explicit audience, a token minted for any other Google app
    // would be accepted.
    assert.match(routeSource, /audience: env\.googleClientId/);
    assert.match(routeSource, /verifyIdToken\(\{/);
    assert.match(routeSource, /new OAuth2Client\(env\.googleClientId\)/);
  });

  test("the route is rate limited and refuses to run unconfigured", () => {
    assert.match(routeSource, /authRouter\.post\("\/google", googleSignInRateLimiter/);
    assert.match(routeSource, /if \(!env\.googleClientId\) \{[\s\S]*?google_signin_unavailable/);
    assert.match(routeSource, /if \(!env\.jwtSecret\) \{[\s\S]*?server_misconfigured/);
  });

  test("new Google accounts satisfy the NOT NULL password column with an unusable hash", () => {
    // password_hash is NOT NULL, and a Google account has no password, so the
    // column is filled with random bytes that no password can ever match.
    assert.match(
      routeSource,
      /const unusableHash = await bcrypt\.hash\(\s*crypto\.randomBytes\(32\)\.toString\("hex"\),/
    );
    assert.match(routeSource, /password_hash: unusableHash,/);
    assert.match(routeSource, /email_verified: true,/);
  });

  test("the response shape matches /login so every client keeps working", () => {
    assert.match(routeSource, /issueCustomerAccessToken\(\{[\s\S]*?authVersion: user\.auth_version \|\| 0,/);
    assert.match(routeSource, /return res\.json\(\{ token \}\);/);
  });
});
