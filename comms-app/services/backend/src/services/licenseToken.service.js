/**
 * Offline licence tokens.
 *
 * The customer JWT authenticates the activation call and is then thrown away.
 * It cannot be the licence: it expires in 24h and is capped at a 30-day
 * absolute session age, which is the opposite of what a perpetual offline
 * licence needs.
 *
 * So activation mints a separate, self-contained token that the installed app
 * verifies locally, forever, with an embedded public key. After activation the
 * app never contacts this server again - a network outage must never be able
 * to stop a local file transfer.
 *
 * Format:  FD1.<base64url(payload)>.<base64url(signature)>
 * signed over the ASCII bytes "FD1." + base64url(payload).
 *
 * Deliberately not a JWT. There is no algorithm field to confuse, no library
 * to keep current, and the verifying side is 20 lines of Python that only ever
 * accepts Ed25519.
 */

import crypto from "crypto";

export const LICENSE_TOKEN_PREFIX = "FD1";

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/**
 * Accepts the raw 32-byte Ed25519 seed, base64 or hex, and wraps it in the
 * PKCS#8 envelope Node's crypto wants. Storing the bare seed keeps the env var
 * short enough to paste without line-wrapping, which is what actually goes
 * wrong with PEM in a dashboard.
 */
function privateKeyFromSeed(seedText) {
  const raw = String(seedText || "").trim();
  if (!raw) throw new Error("license signing key is not configured");

  let seed;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    seed = Buffer.from(raw, "hex");
  } else {
    seed = Buffer.from(raw, "base64");
  }
  if (seed.length !== 32) {
    throw new Error("license signing key must be a 32-byte Ed25519 seed");
  }

  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  return crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

export function publicKeyHexFromSeed(seedText) {
  const priv = privateKeyFromSeed(seedText);
  const der = crypto
    .createPublicKey(priv)
    .export({ format: "der", type: "spki" });
  // SPKI for Ed25519 is a fixed 12-byte header followed by the 32-byte key.
  return der.subarray(12).toString("hex");
}

export function signLicenseToken(payload, { signingKey, kid }) {
  const priv = privateKeyFromSeed(signingKey);
  const body = { ...payload, kid };
  const encoded = b64url(JSON.stringify(body));
  const signingInput = `${LICENSE_TOKEN_PREFIX}.${encoded}`;
  const signature = crypto.sign(null, Buffer.from(signingInput, "ascii"), priv);
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * Used by the tests and by admin tooling. The desktop app does this in Python
 * against its own embedded key; this is not on the activation hot path.
 */
export function verifyLicenseToken(token, { publicKeyHex }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_TOKEN_PREFIX) return null;

  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(publicKeyHex, "hex"),
  ]);
  const pub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });

  const ok = crypto.verify(
    null,
    Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
    pub,
    Buffer.from(parts[2], "base64url")
  );
  if (!ok) return null;

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Codes read aloud over the phone and typed by hand, so the alphabet drops
 * the characters people confuse: no O/0, no I/1, no U (it gets heard as V).
 * 12 characters from 32 symbols is 60 bits.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTVWXYZ23456789";

export function generateActivationCode(prefix = "FD") {
  const groups = [];
  for (let g = 0; g < 3; g += 1) {
    let group = "";
    for (let i = 0; i < 4; i += 1) {
      group += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    groups.push(group);
  }
  return `${prefix}-${groups.join("-")}`;
}

/**
 * Typed by a human, so accept the shapes a human produces: lower case, missing
 * dashes, pasted with surrounding whitespace.
 */
export function normalizeActivationCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function formatActivationCode(normalized, prefix = "FD") {
  const body = normalizeActivationCode(normalized).replace(
    new RegExp(`^${prefix}`),
    ""
  );
  return `${prefix}-${body.match(/.{1,4}/g)?.join("-") || body}`;
}
