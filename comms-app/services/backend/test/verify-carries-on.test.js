// Verifying an email carries straight on to where its reader was headed.
//
// The owner, 2026-09-27: buying took "like 10 clicks", and the verify link
// ended on a page of raw JSON. Now the emailed link carries `next` (a
// program's checkout on the website), and clicking it verifies, signs the
// reader in and sends them to the website with the session in the fragment.
// Scripts that ask for JSON still get JSON.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test, { after, before } from "node:test";
import bcrypt from "bcrypt";
import express from "express";

process.env.JWT_SECRET ||= "verify-carries-on-test-secret-at-least-32-bytes";

const { db } = await import("../src/config/db.js");
const { attachPglite } = await import("./helpers/pglite-db.js");
const { env } = await import("../src/config/env.js");
const { safeSitePath } = await import("../src/utils/sitePaths.js");
const { verificationRouter, verifiedPageUrl } = await import("../src/routes/verification.routes.js");
const { verificationLink, takeNewestSignupPassword } = await import("../src/routes/auth.routes.js");
const { verifyCustomerAccessToken } = await import("../src/services/auth.service.js");
const { licensedProduct } = await import("../src/services/licensedProducts.js");
const { DOWNLOADS } = await import("../src/routes/downloads.routes.js");

const SITE = new URL(env.publicSiteUrl).origin;
const CHECKOUT = "/get/index.html?product=forgedrop&promo=ART25";
let server;
let base;

before(async () => {
  await attachPglite(db);
  await db.schema.alterTable("users", (t) => {
    t.text("password_hash");
    t.text("verification_token_hash");
    t.timestamp("verification_sent_at", { useTz: true });
    t.timestamp("verified_at", { useTz: true });
    t.integer("auth_version").defaultTo(0);
  });
  const app = express();
  app.use("/v1/auth", verificationRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.destroy();
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function unverified(name, { sentAt = new Date() } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  const id = crypto.randomUUID();
  await db("users").insert({
    id,
    email: `${name}@example.com`,
    email_verified: false,
    password_hash: await bcrypt.hash("first-password", 4),
    verification_token_hash: sha256(token),
    verification_sent_at: sentAt,
  });
  return { id, token, email: `${name}@example.com` };
}

function click(path, accept = "text/html,application/xhtml+xml") {
  return fetch(`${base}${path}`, { headers: { accept }, redirect: "manual" });
}

function fragment(location) {
  return new URLSearchParams(new URL(location).hash.slice(1));
}

test("only a path on the site itself survives as the place to carry on to", () => {
  assert.equal(safeSitePath(CHECKOUT), CHECKOUT);
  assert.equal(safeSitePath("/account/index.html#forgedrop"), "/account/index.html#forgedrop");
  for (const bad of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "javascript:alert(1)",
    "get/index.html", "", `/${"a".repeat(400)}`, null, 42]) {
    assert.equal(safeSitePath(bad), "", String(bad));
  }
  assert.equal(safeSitePath("//evil.example", "/account/index.html"), "/account/index.html");
});

test("the emailed link carries where its reader was headed, and nothing off the site", () => {
  assert.equal(verificationLink("abc", CHECKOUT),
    `${env.publicBaseUrl}/v1/auth/verify?token=abc&next=${encodeURIComponent(CHECKOUT)}`);
  assert.equal(verificationLink("abc"), `${env.publicBaseUrl}/v1/auth/verify?token=abc`);
  assert.equal(verificationLink("abc", "https://evil.example/pay"), `${env.publicBaseUrl}/v1/auth/verify?token=abc`);
});

test("the session goes in the fragment, a problem in the query", () => {
  assert.equal(verifiedPageUrl({ token: "t.o.k", next: "/get/index.html?product=forgedrop" }),
    `${SITE}/verified.html#token=t.o.k&next=%2Fget%2Findex.html%3Fproduct%3Dforgedrop`);
  assert.equal(verifiedPageUrl({ error: "token_expired" }), `${SITE}/verified.html?error=token_expired`);
});

test("clicking the link verifies, signs in and carries on to checkout", async () => {
  const person = await unverified("buyer");
  const res = await click(`/v1/auth/verify?token=${person.token}&next=${encodeURIComponent(CHECKOUT)}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const location = res.headers.get("location");
  assert.ok(location.startsWith(`${SITE}/verified.html#token=`), location);
  const back = fragment(location);
  assert.equal(back.get("next"), CHECKOUT);
  const claims = verifyCustomerAccessToken(back.get("token"));
  assert.equal(claims.sub, person.id);
  assert.equal(claims.email, person.email);

  const row = await db("users").where({ id: person.id }).first();
  assert.equal(row.email_verified, true);
  assert.equal(row.verification_token_hash, null, "the link works once");

  // A second click (or a mail scanner's) is told so, and keeps the way on.
  const again = await click(`/v1/auth/verify?token=${person.token}&next=${encodeURIComponent(CHECKOUT)}`);
  assert.equal(again.status, 302);
  assert.equal(again.headers.get("location"),
    `${SITE}/verified.html?error=invalid_or_used_token&next=${encodeURIComponent(CHECKOUT)}`);
});

test("a link that points off the site still verifies but goes nowhere else", async () => {
  const person = await unverified("wary");
  const res = await click(`/v1/auth/verify?token=${person.token}&next=${encodeURIComponent("https://evil.example/")}`);
  const location = res.headers.get("location");
  assert.ok(location.startsWith(`${SITE}/verified.html#token=`));
  assert.equal(fragment(location).get("next"), null);
});

test("an expired link says so", async () => {
  const person = await unverified("late", { sentAt: new Date(Date.now() - 25 * 3600 * 1000) });
  const res = await click(`/v1/auth/verify?token=${person.token}`);
  assert.equal(res.headers.get("location"), `${SITE}/verified.html?error=token_expired`);
  assert.equal((await db("users").where({ id: person.id }).first()).email_verified, false);
});

test("anything that asks for JSON still gets JSON", async () => {
  const person = await unverified("script");
  const ok = await click(`/v1/auth/verify?token=${person.token}`, "application/json");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  const used = await click(`/v1/auth/verify?token=${person.token}`, "application/json");
  assert.equal(used.status, 400);
  assert.deepEqual(await used.json(), { ok: false, error: "invalid_or_used_token" });
  const none = await click("/v1/auth/verify", "application/json");
  assert.deepEqual(await none.json(), { ok: false, error: "missing_token" });
});

test("signing up again before verifying makes that signup's password the account's", async () => {
  // The link signs in whoever clicks it, so a password typed earlier by
  // someone else with this address must not survive the owner's signup.
  const person = await unverified("again");
  await takeNewestSignupPassword(person.id, "owner-password");
  const row = await db("users").where({ id: person.id }).first();
  assert.ok(await bcrypt.compare("owner-password", row.password_hash));

  // A verified account is its owner's: a signup attempt changes nothing.
  await db("users").where({ id: person.id }).update({ email_verified: true });
  await takeNewestSignupPassword(person.id, "someone-else");
  const kept = await db("users").where({ id: person.id }).first();
  assert.ok(await bcrypt.compare("owner-password", kept.password_hash));
});

test("TuneForge activates on five devices with TF codes, and downloads for owners only", () => {
  const product = licensedProduct("tuneforge");
  assert.equal(product.deviceLimit, 5);
  assert.equal(product.seatBased, false);
  assert.equal(product.codePrefix, "TF");
  assert.equal(product.entitlementSlug, "tuneforge");
  assert.equal(DOWNLOADS.tuneforge.entitlement, "tuneforge");
  assert.equal(DOWNLOADS.tuneforge.filename, "Install TuneForge.exe");
});
