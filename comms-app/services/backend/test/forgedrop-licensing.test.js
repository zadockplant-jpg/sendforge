import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LICENSE_TOKEN_PREFIX,
  formatActivationCode,
  generateActivationCode,
  normalizeActivationCode,
  publicKeyHexFromSeed,
  signLicenseToken,
  verifyLicenseToken,
} from "../src/services/licenseToken.service.js";
import { LICENSED_PRODUCTS, licensedProduct } from "../src/services/licensedProducts.js";

const src = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const SEED = crypto.randomBytes(32).toString("base64");
const PUB = publicKeyHexFromSeed(SEED);

function mint(overrides = {}) {
  return signLicenseToken(
    {
      v: 1,
      product: "forgedrop",
      uid: "11111111-1111-4111-8111-111111111111",
      did: "22222222-2222-4222-8222-222222222222",
      iat: 1758326400,
      exp: null,
      lim: 5,
      ...overrides,
    },
    { signingKey: SEED, kid: "fd-2026-09" }
  );
}

test("a licence round-trips and says it never expires", () => {
  const payload = verifyLicenseToken(mint(), { publicKeyHex: PUB });
  assert.ok(payload, "verifies against the matching public key");
  assert.equal(payload.product, "forgedrop");
  assert.equal(payload.kid, "fd-2026-09");
  assert.equal(payload.exp, null, "perpetual, mirroring expires_at NULL");
  assert.equal(payload.lim, 5);
});

test("a tampered licence does not verify", () => {
  const token = mint();
  const [prefix, body, sig] = token.split(".");

  // Swap the payload for one claiming a bigger device allowance.
  const forged = Buffer.from(
    JSON.stringify({ ...verifyLicenseToken(token, { publicKeyHex: PUB }), lim: 500 })
  ).toString("base64url");

  assert.equal(verifyLicenseToken(`${prefix}.${forged}.${sig}`, { publicKeyHex: PUB }), null);
  assert.equal(
    verifyLicenseToken(`${prefix}.${body}.${sig.slice(0, -4)}AAAA`, { publicKeyHex: PUB }),
    null
  );
});

test("a licence signed by a different key is refused", () => {
  const otherPub = publicKeyHexFromSeed(crypto.randomBytes(32).toString("base64"));
  assert.equal(verifyLicenseToken(mint(), { publicKeyHex: otherPub }), null);
});

test("the token is deliberately not a JWT", () => {
  const token = mint();
  assert.ok(token.startsWith(`${LICENSE_TOKEN_PREFIX}.`));
  const header = verifyLicenseToken(token, { publicKeyHex: PUB });
  assert.equal(header.alg, undefined, "no algorithm field to confuse");
  assert.equal(verifyLicenseToken(token.replace("FD1.", "FD2."), { publicKeyHex: PUB }), null);
});

test("the signing seed is accepted as hex or base64, and nothing else", () => {
  const hex = Buffer.from(SEED, "base64").toString("hex");
  assert.equal(publicKeyHexFromSeed(hex), PUB, "same key either way");
  assert.throws(() => publicKeyHexFromSeed(""), /not configured/);
  assert.throws(() => publicKeyHexFromSeed(Buffer.alloc(16).toString("base64")), /32-byte/);
});

test("activation codes avoid the characters people mishear", () => {
  // Read aloud over the phone and typed by hand, so O/0, I/1 and U are out.
  for (let i = 0; i < 200; i += 1) {
    const code = generateActivationCode();
    assert.match(code, /^FD-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(/[OIU01]/.test(code.slice(3)), false, `${code} avoids confusables`);
  }
});

test("codes normalise the way people actually type them", () => {
  assert.equal(normalizeActivationCode(" fd-ab3k-9x2m-pq7r "), "FDAB3K9X2MPQ7R");
  assert.equal(normalizeActivationCode("FD AB3K 9X2M PQ7R"), "FDAB3K9X2MPQ7R");
  assert.equal(normalizeActivationCode("fdab3k9x2mpq7r"), "FDAB3K9X2MPQ7R");
  assert.equal(normalizeActivationCode(null), "");
});

test("a normalised code formats back into the printed form", () => {
  const code = generateActivationCode();
  assert.equal(formatActivationCode(normalizeActivationCode(code)), code);
});

test("ForgeDrop is registered as a licensed product with a 5-device limit", () => {
  const product = licensedProduct("ForgeDrop");
  assert.ok(product, "lookup is case-insensitive");
  assert.equal(product.deviceLimit, 5);
  assert.equal(product.entitlementSlug, "forgedrop");
  assert.equal(licensedProduct("tabforge"), null, "only licensed apps belong here");
  assert.equal(LICENSED_PRODUCTS.length, 1);
});

test("slot counting is serialised by an advisory lock", async () => {
  // The race is invisible in normal use and catastrophic in aggregate: five
  // concurrent activations each COUNT 4, each see room, and each INSERT a
  // different device_id, so the unique index never fires. Assert the lock is
  // still there rather than waiting to discover a 9-device licence.
  const source = await src("../src/services/deviceActivation.service.js");
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /db\.transaction/);
});

test("the $20 price and perpetual entitlement are wired into the catalog", async () => {
  const source = await src("../src/routes/billing.routes.js");
  assert.match(source, /forgedrop:\s*\{/);
  assert.match(source, /unitAmountCents:\s*2000/);
  assert.match(source, /mode:\s*"payment"/, "one-time, not a subscription");
});

test("activation refuses a product the account does not own", async () => {
  const source = await src("../src/routes/licensing.routes.js");
  // The code identifies the account, the entitlement grants the product. A
  // refund must stop new activations even though the owner kept the code.
  assert.match(source, /hasProductEntitlement/);
  assert.match(source, /entitlement_required/);
});
