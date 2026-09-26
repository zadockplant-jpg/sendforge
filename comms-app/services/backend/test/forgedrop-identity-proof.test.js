// ForgeDrop devices prove they hold the identity key they report
// (identityProof.service.js). Before this, device_activations took the app's
// word for its fingerprint, so anyone activating their own copy could claim
// somebody else's key. The frozen vector at the top is also in ForgeDrop's
// tests/test_identity_proof.py: both sides must reproduce it exactly.

import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after, before } from "node:test";
import express from "express";

import { attachPglite } from "./helpers/pglite-db.js";

const SEED = crypto.randomBytes(32).toString("base64");
process.env.LICENSE_SIGNING_KEY = SEED;
process.env.LICENSE_SIGNING_KID = "fd-test";
process.env.JWT_SECRET ||= "forgedrop-identity-test-secret-at-least-32-bytes";

// env.js reads the environment when it is first imported.
const { db } = await import("../src/config/db.js");
const { grantProductEntitlement } = await import("../src/services/entitlement.service.js");
const { activateDevice, deactivateDevice, getOrCreateActivationCode } = await import(
  "../src/services/deviceActivation.service.js"
);
const { signLicenseToken } = await import("../src/services/licenseToken.service.js");
const {
  IdentityProofError,
  forgedropFingerprint,
  makeChallenge,
  serverKeys,
  verifyProof,
} = await import("../src/services/identityProof.service.js");
const { licensingRouter } = await import("../src/routes/licensing.routes.js");

// ------------------------------------------------------------ frozen vector

const VECTOR = {
  seed: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  serverPublic: "6735bef03da9a6a9c8b8753928f46abe639d954cb9019529726355ee690a5c59",
  nonce: "6465666768696a6b6c6d6e6f70717273",
  expires: 1790000000,
  challenge: "ZGVmZ2hpamtsbW5vcHFycwAAAABqsTuAwRAYUlQS6T2QSBVYQ_M_lw",
  devicePublic: "358072d6365880d1aeea329adf9121383851ed21a28e3b75e965d0d2cd166254",
  fingerprint: "8bca-e027-17b3-b84f",
  proof: "50a8409bf642e3be50f7bd01ebe9393a5912d2d5b0a5670e592fbda7642a9223",
};

test("the frozen vector: server key, challenge and proof match ForgeDrop's", () => {
  assert.equal(serverKeys(VECTOR.seed).publicHex, VECTOR.serverPublic);
  const made = makeChallenge(VECTOR.seed, {
    now: (VECTOR.expires - 600) * 1000,
    nonce: Buffer.from(VECTOR.nonce, "hex"),
  });
  assert.equal(made.challenge, VECTOR.challenge);
  assert.equal(made.version, "forgedrop-identity-proof-v1");
  const proven = verifyProof(
    VECTOR.seed,
    { publicKeyHex: VECTOR.devicePublic, challenge: VECTOR.challenge, proof: VECTOR.proof },
    { now: (VECTOR.expires - 60) * 1000 }
  );
  assert.deepEqual(proven, { publicKeyHex: VECTOR.devicePublic, fingerprint: VECTOR.fingerprint });
});

// --------------------------------------------------------- a device, in JS

const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");

function newDevice() {
  const privateRaw = crypto.randomBytes(32);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8, privateRaw]),
    format: "der",
    type: "pkcs8",
  });
  const publicRaw = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, publicHex: publicRaw.toString("hex"), fingerprint: forgedropFingerprint(publicRaw) };
}

/** What forgedrop/core/identity_proof.py prove() does. */
function prove(device, serverKeyHex, challenge) {
  const shared = crypto.diffieHellman({
    privateKey: device.privateKey,
    publicKey: crypto.createPublicKey({
      key: Buffer.concat([X25519_SPKI, Buffer.from(serverKeyHex, "hex")]),
      format: "der",
      type: "spki",
    }),
  });
  const key = Buffer.from(
    crypto.hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("sendforge/forgedrop-identity-proof/proof/v1"), 32)
  );
  const message = Buffer.concat([
    Buffer.from(`forgedrop-identity-proof-v1|${challenge}|`, "ascii"),
    Buffer.from(device.publicHex, "hex"),
  ]);
  return {
    identityPublicKey: device.publicHex,
    identityFingerprint: device.fingerprint,
    identityChallenge: challenge,
    identityProof: crypto.createHmac("sha256", key).update(message).digest("hex"),
  };
}

function code(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof IdentityProofError, String(error));
    return error.code;
  }
  return null;
}

test("a proof from the key's holder verifies; everything else is refused", () => {
  const device = newDevice();
  const { serverKey, challenge } = makeChallenge(SEED);
  const fields = prove(device, serverKey, challenge);
  const check = (overrides) =>
    code(() =>
      verifyProof(SEED, {
        publicKeyHex: fields.identityPublicKey,
        challenge: fields.identityChallenge,
        proof: fields.identityProof,
        ...overrides,
      })
    );

  assert.equal(check({}), null);
  // Someone else's key, with a proof they made for their own.
  assert.equal(check({ publicKeyHex: newDevice().publicHex }), "identity_proof_invalid");
  assert.equal(check({ proof: "00".repeat(32) }), "identity_proof_invalid");
  assert.equal(check({ proof: "short" }), "identity_proof_invalid");
  // A challenge we did not make, or one altered on the way.
  const other = makeChallenge(crypto.randomBytes(32).toString("base64")).challenge;
  assert.equal(check({ challenge: other }), "challenge_invalid");
  assert.equal(check({ challenge: `${challenge.slice(0, -2)}AA` }), "challenge_invalid");
  assert.equal(check({ challenge: "not base64url!!" }), "challenge_invalid");
  assert.equal(check({ publicKeyHex: "zz" }), "identity_key_invalid");
  // A low-order key makes an all-zero secret that anyone could compute.
  assert.equal(check({ publicKeyHex: "00".repeat(32) }), "identity_key_invalid");
});

test("a challenge is good for ten minutes", () => {
  const device = newDevice();
  const start = Date.parse("2026-09-26T12:00:00Z");
  const { serverKey, challenge } = makeChallenge(SEED, { now: start });
  const fields = prove(device, serverKey, challenge);
  const at = (ms) =>
    code(() =>
      verifyProof(
        SEED,
        { publicKeyHex: fields.identityPublicKey, challenge, proof: fields.identityProof },
        { now: start + ms }
      )
    );
  assert.equal(at(9 * 60 * 1000), null);
  assert.equal(at(11 * 60 * 1000), "challenge_expired");
});

// ------------------------------------------------------------- the routes

let detach;
let server;
let origin;

before(async () => {
  detach = await attachPglite(db);
  const app = express();
  app.use(express.json());
  app.use("/v1/licensing", licensingRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await detach?.();
});

async function call(path, { method = "POST", body, licence } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (licence !== undefined) headers["X-ForgeDrop-License"] = licence;
  const response = await fetch(`${origin}/v1/licensing${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function owner() {
  const id = randomUUID();
  await db("users").insert({ id, email: `${id}@example.com` });
  await grantProductEntitlement({ userId: id, productSlug: "forgedrop", source: "test" });
  const codeRow = await getOrCreateActivationCode(id, "forgedrop");
  return { id, code: codeRow.code };
}

async function row(userId, deviceId) {
  return db("device_activations").where({ user_id: userId, device_id: deviceId }).first();
}

test("activating with a proof records the proven key", async () => {
  const person = await owner();
  const device = newDevice();
  const { json: challenge } = await call("/identity-challenge", { method: "GET" });
  const { status, json } = await call("/activate", {
    body: {
      activationCode: person.code,
      deviceName: "Studio PC",
      ...prove(device, challenge.serverKey, challenge.challenge),
    },
  });
  assert.equal(status, 200);
  assert.equal(json.identityVerified, true);
  const saved = await row(person.id, json.license.deviceId);
  assert.equal(saved.identity_public_key, device.publicHex);
  assert.equal(saved.identity_fingerprint, device.fingerprint);
  assert.ok(saved.identity_verified_at);
});

test("activating without a proof works as before, unproven", async () => {
  const person = await owner();
  const { status, json } = await call("/activate", {
    body: { activationCode: person.code, deviceName: "Old app", identityFingerprint: "aaaa-bbbb-cccc-dddd" },
  });
  assert.equal(status, 200);
  assert.equal(json.identityVerified, false);
  const saved = await row(person.id, json.license.deviceId);
  assert.equal(saved.identity_fingerprint, "aaaa-bbbb-cccc-dddd");
  assert.equal(saved.identity_public_key, null);
  assert.equal(saved.identity_verified_at, null);
});

test("a bad proof never stops a paying customer from activating", async () => {
  const person = await owner();
  const device = newDevice();
  const { json: challenge } = await call("/identity-challenge", { method: "GET" });
  const fields = prove(device, challenge.serverKey, challenge.challenge);
  const { status, json } = await call("/activate", {
    body: { activationCode: person.code, ...fields, identityProof: "00".repeat(32) },
  });
  assert.equal(status, 200);
  assert.equal(json.identityVerified, false);
  assert.equal((await row(person.id, json.license.deviceId)).identity_verified_at, null);
});

test("claiming someone else's proven key does not take it over", async () => {
  const alice = await owner();
  const mallory = await owner();
  const device = newDevice();
  const { json: challenge } = await call("/identity-challenge", { method: "GET" });
  const proven = await call("/activate", {
    body: { activationCode: alice.code, ...prove(device, challenge.serverKey, challenge.challenge) },
  });
  // Mallory reports Alice's fingerprint, with no way to prove it.
  const claimed = await call("/activate", {
    body: { activationCode: mallory.code, identityFingerprint: device.fingerprint },
  });
  assert.equal(claimed.json.identityVerified, false);
  assert.equal((await row(mallory.id, claimed.json.license.deviceId)).identity_verified_at, null);
  assert.ok((await row(alice.id, proven.json.license.deviceId)).identity_verified_at);
});

test("reinstalling with a new key, unproven, clears the old proof", async () => {
  const person = await owner();
  const device = newDevice();
  const { json: challenge } = await call("/identity-challenge", { method: "GET" });
  const first = await call("/activate", {
    body: { activationCode: person.code, ...prove(device, challenge.serverKey, challenge.challenge) },
  });
  const deviceId = first.json.license.deviceId;
  const again = await call("/activate", {
    body: { activationCode: person.code, deviceId, identityFingerprint: device.fingerprint },
  });
  assert.equal(again.json.identityVerified, true, "same key, still proven");
  const changed = await call("/activate", {
    body: { activationCode: person.code, deviceId, identityFingerprint: "ffff-ffff-ffff-ffff" },
  });
  assert.equal(changed.json.identityVerified, false);
  const saved = await row(person.id, deviceId);
  assert.equal(saved.identity_public_key, null);
  assert.equal(saved.identity_fingerprint, "ffff-ffff-ffff-ffff");
});

function licenceFor(userId, deviceId, product = "forgedrop") {
  return signLicenseToken(
    { v: 1, product, uid: userId, did: deviceId, iat: 1758326400, exp: null, lim: 5 },
    { signingKey: SEED, kid: "fd-test" }
  );
}

test("an already-activated device proves its key with its licence", async () => {
  const person = await owner();
  const activated = await activateDevice({
    userId: person.id,
    productSlug: "forgedrop",
    deviceId: randomUUID(),
    deviceName: "Laptop",
    identityFingerprint: "1111-2222-3333-4444",
    deviceLimit: 5,
  });
  const device = newDevice();
  const { json: challenge } = await call("/identity-challenge", { method: "GET" });
  const { status, json } = await call("/identity", {
    licence: licenceFor(person.id, activated.deviceId),
    body: prove(device, challenge.serverKey, challenge.challenge),
  });
  assert.equal(status, 200);
  assert.deepEqual(json, { identityVerified: true, fingerprint: device.fingerprint });
  const saved = await row(person.id, activated.deviceId);
  assert.equal(saved.identity_public_key, device.publicHex);
  assert.equal(saved.identity_fingerprint, device.fingerprint);
});

test("proving a key needs a valid licence for an active ForgeDrop device", async () => {
  const person = await owner();
  const activated = await activateDevice({
    userId: person.id,
    productSlug: "forgedrop",
    deviceId: randomUUID(),
    deviceName: "Gone",
    deviceLimit: 5,
  });
  const device = newDevice();
  const { json: challenge } = await call("/identity-challenge", { method: "GET" });
  const body = prove(device, challenge.serverKey, challenge.challenge);

  assert.equal((await call("/identity", { body })).status, 401);
  assert.equal((await call("/identity", { body, licence: "FD1.bogus.token" })).status, 401);
  const otherProduct = licenceFor(person.id, activated.deviceId, "rose-colored-glasses");
  assert.equal((await call("/identity", { body, licence: otherProduct })).status, 401);

  await deactivateDevice(person.id, "forgedrop", activated.deviceId);
  const freed = await call("/identity", { body, licence: licenceFor(person.id, activated.deviceId) });
  assert.equal(freed.status, 403);
  assert.equal(freed.json.error, "device_inactive");

  const bad = await call("/identity", {
    body: { ...body, identityProof: "00".repeat(32) },
    licence: licenceFor(person.id, activated.deviceId),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "identity_proof_invalid");
});

test("the account page shows which devices proved their key", async () => {
  const { presentDevice } = await import("../src/services/deviceActivation.service.js");
  assert.equal(presentDevice({ identity_verified_at: new Date() }).identityVerified, true);
  assert.equal(presentDevice({ identity_verified_at: null }).identityVerified, false);
});
