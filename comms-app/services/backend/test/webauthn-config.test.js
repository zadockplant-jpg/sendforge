import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FORGEPASS_AAGUID,
  buildWebAuthnConfig,
} from "../src/config/webauthn.js";

test("WebAuthn development defaults target the first-party local backend", () => {
  const config = buildWebAuthnConfig({ values: {}, nodeEnv: "development", port: 3000 });

  assert.deepEqual(config, {
    rpName: "ForgePass",
    rpId: "localhost",
    origins: ["http://localhost:3000"],
    timeoutMs: 60_000,
    challengeTtlMs: 300_000,
    allowedAaguids: [DEFAULT_FORGEPASS_AAGUID],
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.origins), true);
  assert.equal(Object.isFrozen(config.allowedAaguids), true);
});

test("WebAuthn production config normalizes domains, origins, and AAGUIDs", () => {
  const config = buildWebAuthnConfig({
    values: {
      WEBAUTHN_RP_NAME: "ForgePass Production",
      WEBAUTHN_RP_ID: "SendForge.App",
      WEBAUTHN_ORIGINS:
        "https://sendforge.app/, https://api.sendforge.app:8443",
      WEBAUTHN_TIMEOUT_MS: "90000",
      WEBAUTHN_CHALLENGE_TTL_SECONDS: "120",
      WEBAUTHN_ALLOWED_AAGUIDS:
        "ccac9302-f70b-5904-a282-3658e8bca0a6, CCAC9302F70B5904A2823658E8BCA0A6",
    },
    nodeEnv: "production",
    port: 3000,
  });

  assert.equal(config.rpName, "ForgePass Production");
  assert.equal(config.rpId, "sendforge.app");
  assert.deepEqual(config.origins, [
    "https://sendforge.app",
    "https://api.sendforge.app:8443",
  ]);
  assert.equal(config.timeoutMs, 90_000);
  assert.equal(config.challengeTtlMs, 120_000);
  assert.deepEqual(config.allowedAaguids, [DEFAULT_FORGEPASS_AAGUID]);
});

test("WebAuthn production config rejects missing security boundaries", () => {
  const complete = {
    WEBAUTHN_RP_NAME: "ForgePass",
    WEBAUTHN_RP_ID: "sendforge.app",
    WEBAUTHN_ORIGINS: "https://sendforge.app",
    WEBAUTHN_ALLOWED_AAGUIDS: DEFAULT_FORGEPASS_AAGUID,
  };

  for (const name of [
    "WEBAUTHN_RP_NAME",
    "WEBAUTHN_RP_ID",
    "WEBAUTHN_ORIGINS",
    "WEBAUTHN_ALLOWED_AAGUIDS",
  ]) {
    assert.throws(
      () =>
        buildWebAuthnConfig({
          values: { ...complete, [name]: "" },
          nodeEnv: "production",
        }),
      new RegExp(`${name} must be set in production`)
    );
  }
});

test("WebAuthn config rejects insecure or cross-RP origins", () => {
  const base = {
    WEBAUTHN_RP_NAME: "ForgePass",
    WEBAUTHN_RP_ID: "sendforge.app",
    WEBAUTHN_ALLOWED_AAGUIDS: DEFAULT_FORGEPASS_AAGUID,
  };

  assert.throws(
    () =>
      buildWebAuthnConfig({
        values: { ...base, WEBAUTHN_ORIGINS: "http://sendforge.app" },
        nodeEnv: "production",
      }),
    /must use HTTPS/
  );
  assert.throws(
    () =>
      buildWebAuthnConfig({
        values: { ...base, WEBAUTHN_ORIGINS: "https://lookalike.app" },
        nodeEnv: "production",
      }),
    /outside RP ID/
  );
  assert.throws(
    () =>
      buildWebAuthnConfig({
        values: {
          ...base,
          WEBAUTHN_ORIGINS: "https://sendforge.app/login",
        },
        nodeEnv: "production",
      }),
    /cannot contain credentials, paths, queries, or fragments/
  );
});

test("WebAuthn config rejects malformed AAGUIDs and impractical timeouts", () => {
  assert.throws(
    () =>
      buildWebAuthnConfig({
        values: { WEBAUTHN_ALLOWED_AAGUIDS: "not-an-aaguid" },
      }),
    /Invalid ForgePass AAGUID/
  );
  assert.throws(
    () => buildWebAuthnConfig({ values: { WEBAUTHN_TIMEOUT_MS: "5000" } }),
    /must be an integer from 15000 to 300000/
  );
  assert.throws(
    () =>
      buildWebAuthnConfig({
        values: { WEBAUTHN_CHALLENGE_TTL_SECONDS: "30" },
      }),
    /must be an integer from 60 to 600/
  );
});
