/**
 * Checking that a ForgeDrop device holds the identity key it claims.
 *
 * `device_activations.identity_fingerprint` used to be whatever the app sent,
 * so anyone activating their own copy could claim somebody else's device key.
 * That is harmless for a device list and not for anything that routes by the
 * key (finding a contact, delivering a file for pickup), so those only trust a
 * key proven here.
 *
 * X25519 keys cannot sign, so the proof is a key agreement. This server has an
 * X25519 key of its own, derived from the licence signing seed with HKDF under
 * its own label (so it needs no new secret to configure). It hands out a
 * short-lived challenge; the device combines its private key with our public
 * key and MACs the challenge; we recompute the MAC with our private key.
 *
 * Wire format "forgedrop-identity-proof-v1", matched byte for byte by
 * ForgeDrop's forgedrop/core/identity_proof.py. The frozen vector in
 * test/forgedrop-identity-proof.test.js is in both test suites.
 */

import crypto from "crypto";

export const PROOF_VERSION = "forgedrop-identity-proof-v1";
const SERVER_KEY_INFO = "sendforge/forgedrop-identity-proof/server-key/v1";
const CHALLENGE_MAC_INFO = "sendforge/forgedrop-identity-proof/challenge-mac/v1";
const PROOF_INFO = "sendforge/forgedrop-identity-proof/proof/v1";
const CHALLENGE_TAG = Buffer.from("fdip1");

/** How long a challenge stays good: long enough for a slow activation. */
export const CHALLENGE_SECONDS = 10 * 60;

const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export class IdentityProofError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function seedBytes(seedText) {
  const raw = String(seedText || "").trim();
  if (!raw) throw new IdentityProofError("proof_unavailable");
  const seed = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (seed.length !== 32) throw new IdentityProofError("proof_unavailable");
  return seed;
}

function hkdf(ikm, info) {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(info), 32));
}

function x25519Private(raw) {
  return crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function x25519Public(raw) {
  return crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/** The server's proof keys, from the licence signing seed. */
export function serverKeys(seedText) {
  const seed = seedBytes(seedText);
  const privateRaw = hkdf(seed, SERVER_KEY_INFO);
  const privateKey = x25519Private(privateRaw);
  const publicRaw = crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  return { privateKey, publicHex: publicRaw.toString("hex"), macKey: hkdf(seed, CHALLENGE_MAC_INFO) };
}

function challengeTag(macKey, nonce, expires) {
  return crypto
    .createHmac("sha256", macKey)
    .update(Buffer.concat([CHALLENGE_TAG, nonce, expires]))
    .digest()
    .subarray(0, 16);
}

/**
 * A challenge that needs no storage: a nonce and an expiry, tagged with a
 * key only this server holds, so it can be checked when it comes back.
 */
export function makeChallenge(seedText, { now = Date.now(), nonce = crypto.randomBytes(16) } = {}) {
  const { publicHex, macKey } = serverKeys(seedText);
  const expires = Buffer.alloc(8);
  expires.writeBigUInt64BE(BigInt(Math.floor(now / 1000) + CHALLENGE_SECONDS));
  const challenge = Buffer.concat([nonce, expires, challengeTag(macKey, nonce, expires)]);
  return { version: PROOF_VERSION, serverKey: publicHex, challenge: challenge.toString("base64url"), expiresInSeconds: CHALLENGE_SECONDS };
}

/** ForgeDrop's fingerprint of a raw 32-byte X25519 public key. */
export function forgedropFingerprint(publicRaw) {
  const digest = crypto
    .createHash("sha256")
    .update(Buffer.from("forgedrop-fingerprint-v1"))
    .update(publicRaw)
    .digest()
    .subarray(0, 8)
    .toString("hex");
  return digest.match(/.{4}/g).join("-");
}

/**
 * Check a proof. Returns { publicKeyHex, fingerprint } for a proven key and
 * throws IdentityProofError with a stable code for anything else.
 */
export function verifyProof(seedText, { publicKeyHex, challenge, proof }, { now = Date.now() } = {}) {
  const { privateKey, macKey } = serverKeys(seedText);

  const publicText = String(publicKeyHex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(publicText)) throw new IdentityProofError("identity_key_invalid");
  const publicRaw = Buffer.from(publicText, "hex");

  const challengeText = String(challenge || "").trim();
  let raw;
  try {
    raw = Buffer.from(challengeText, "base64url");
  } catch {
    throw new IdentityProofError("challenge_invalid");
  }
  if (raw.length !== 40 || raw.toString("base64url") !== challengeText) {
    throw new IdentityProofError("challenge_invalid");
  }
  const nonce = raw.subarray(0, 16);
  const expires = raw.subarray(16, 24);
  if (!crypto.timingSafeEqual(raw.subarray(24, 40), challengeTag(macKey, nonce, expires))) {
    throw new IdentityProofError("challenge_invalid");
  }
  if (Number(expires.readBigUInt64BE()) * 1000 < now) {
    throw new IdentityProofError("challenge_expired");
  }

  let shared;
  try {
    shared = crypto.diffieHellman({ privateKey, publicKey: x25519Public(publicRaw) });
  } catch {
    throw new IdentityProofError("identity_key_invalid");
  }
  // A low-order point gives an all-zero secret that anyone could compute.
  if (shared.every((byte) => byte === 0)) throw new IdentityProofError("identity_key_invalid");

  const message = Buffer.concat([Buffer.from(`${PROOF_VERSION}|${challengeText}|`, "ascii"), publicRaw]);
  const expected = crypto.createHmac("sha256", hkdf(shared, PROOF_INFO)).update(message).digest();
  const given = Buffer.from(String(proof || "").trim().toLowerCase(), "hex");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new IdentityProofError("identity_proof_invalid");
  }
  return { publicKeyHex: publicText, fingerprint: forgedropFingerprint(publicRaw) };
}
