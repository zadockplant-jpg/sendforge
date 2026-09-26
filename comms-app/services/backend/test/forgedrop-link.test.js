// ForgeDrop phone link: the signaling relay a phone's browser and a desktop
// use to swap WebRTC offers and answers (ForgeDrop/docs/phone-link.md).
//
// The HTTP tests run the real router, the real customer sign-in, real licence
// tokens minted by the activation service and real device_activations rows,
// against an in-process Postgres (PGlite). The store's clock is a dial the
// tests turn, so a minute of expiry takes no time; long-polls use real timers.

import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import express from "express";

import { attachPglite } from "./helpers/pglite-db.js";

const SEED = crypto.randomBytes(32).toString("base64");
process.env.LICENSE_SIGNING_KEY = SEED;
process.env.LICENSE_SIGNING_KID = "fd-test";
process.env.JWT_SECRET ||= "forgedrop-link-test-secret-at-least-32-bytes";

// env.js reads the environment when it is first imported, so everything that
// touches it is imported after the key is set.
const { db } = await import("../src/config/db.js");
const { env } = await import("../src/config/env.js");
const { requireAuth } = await import("../src/middleware/auth.js");
const { issueCustomerAccessToken } = await import("../src/services/auth.service.js");
const { grantProductEntitlement, hasProductEntitlement } = await import(
  "../src/services/entitlement.service.js"
);
const { activateDevice, deactivateDevice } = await import("../src/services/deviceActivation.service.js");
const { signLicenseToken } = await import("../src/services/licenseToken.service.js");
const { createForgeDropLinkRouter, LINK_LIMITS } = await import("../src/modules/forgedrop-link/router.js");
const { createLinkStore } = await import("../src/modules/forgedrop-link/store.js");
const { canonicalUuid, parseCaps, parseWait, cleanText } = await import("../src/modules/forgedrop-link/shapes.js");
const { forgedropLinkRouter, loadForgeDropLink } = await import("../src/modules/forgedrop-link/index.js");

const src = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

// ------------------------------------------------------------------ fixtures

let clock = Date.now();
const now = () => clock;
const advance = (ms) => {
  clock += ms;
};

const logged = [];
const log = (level, msg, meta) => logged.push({ level, msg, meta });
const stores = [];
const storeFor = () => {
  const made = createLinkStore({ now });
  stores.push(made);
  return made;
};

const store = storeFor();
const people = {};
const devices = {};
let detach;
let server;
let origin;

const mount = (overrides = {}) =>
  createForgeDropLinkRouter({
    db,
    requireAuth,
    hasProductEntitlement,
    signingKey: () => env.licenseSigningKey,
    now,
    log,
    store: storeFor(),
    // The limits themselves are tested on the real router further down;
    // here they would only make a long run of tests flaky.
    rate: { signalPerMinute: 1e6, pollPerMinute: 1e6, desktopsPerMinute: 1e6 },
    ...overrides,
  });

async function signUp(name, { owns = true } = {}) {
  const id = randomUUID();
  const email = `${name}@example.com`;
  await db("users").insert({ id, email });
  if (owns) await grantProductEntitlement({ userId: id, productSlug: "forgedrop", source: "test" });
  people[name] = { id, email, bearer: issueCustomerAccessToken({ id, email }) };
  return people[name];
}

async function activate(key, person, { name, platform = "windows", appVersion = "1.0.1", fingerprint }) {
  const result = await activateDevice({
    userId: person.id,
    productSlug: "forgedrop",
    deviceId: randomUUID(),
    deviceName: name,
    platform,
    appVersion,
    identityFingerprint: fingerprint,
    deviceLimit: 20,
  });
  devices[key] = { deviceId: result.deviceId, token: result.token, owner: person, address: `desktop:${result.deviceId}` };
  return devices[key];
}

before(async () => {
  detach = await attachPglite(db);
  // requireAuth reads auth_version; the shared helper's users table predates it.
  await db.schema.alterTable("users", (t) => t.integer("auth_version").defaultTo(0));

  const alice = await signUp("alice");
  const bob = await signUp("bob");
  const casey = await signUp("casey", { owns: false });
  const dana = await signUp("dana");
  await signUp("fran", { owns: false });

  await activate("studio", alice, { name: "Studio PC", fingerprint: "aaaa-aaaa-aaaa-aaaa", appVersion: "1.0.0" });
  await activate("laptop", alice, { name: "alice laptop", fingerprint: "bbbb-bbbb-bbbb-bbbb" });
  await activate("old", alice, { name: "Old PC" });
  await deactivateDevice(alice.id, "forgedrop", devices.old.deviceId);
  await activate("basement", alice, { name: "Basement PC", platform: "linux" });
  await activate("spare", alice, { name: "Spare PC" });
  await activate("fresh", alice, { name: "Test PC" });
  await activate("bobs", bob, { name: "Bob Desktop" });
  await activate("caseys", casey, { name: "Casey PC" });
  await activate("danas", dana, { name: "Dana PC" });
  await activate("frans", people.fran, { name: "Fran PC" });

  const app = express();
  // app.js runs the app-wide form parser ahead of every router; so does this.
  app.use(express.urlencoded({ extended: false }));
  app.use("/v1/forgedrop/link", mount({ store }));
  app.use("/nokey", mount({ signingKey: () => "", rateLimitPrefix: "fdl-nokey" }));
  app.use("/badkey", mount({ signingKey: () => "not an ed25519 seed", rateLimitPrefix: "fdl-badkey" }));
  app.use("/real", forgedropLinkRouter);
  app.use(
    "/broken",
    await loadForgeDropLink(
      async () => {
        throw new SyntaxError("Unexpected token in router.js");
      },
      { logger: log }
    )
  );
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const made of stores) made.stop();
  server?.closeAllConnections?.();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await detach?.();
});

// ------------------------------------------------------------------- helpers

async function call(path, { method = "POST", body, raw, licence, bearer, headers = {}, signal, base = "/v1/forgedrop/link" } = {}) {
  const init = { method, headers: { ...headers }, signal };
  if (licence !== undefined) init.headers["X-ForgeDrop-License"] = licence;
  if (bearer !== undefined) init.headers.Authorization = `Bearer ${bearer}`;
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] ??= "application/json";
  }
  const response = await fetch(`${origin}${base}${path}`, init);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: response.status, body: json, headers: response.headers, text };
}

const desktopPoll = (device, body = {}, options = {}) =>
  call("/desktop/poll", { licence: device.token, body: { wait: 0, ...body }, ...options });
const phonePoll = (person, clientId, wait = 0, options = {}) =>
  call("/phone/poll", { bearer: person.bearer, body: { clientId, wait }, ...options });
const phoneSignal = (person, body, options = {}) => call("/signal", { bearer: person.bearer, body, ...options });
const desktopSignal = (device, body, options = {}) => call("/signal", { licence: device.token, body, ...options });

const newClientId = () => crypto.randomBytes(16).toString("base64url"); // 22 characters
const newSession = () => crypto.randomBytes(12).toString("base64url"); // 16 characters

const offer = (clientId, session, to, extra = {}) => ({
  to,
  from: `phone:${clientId}`,
  session,
  type: "offer",
  data: { sdp: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n", name: "iPhone", fingerprint: "1234-5678-9abc-def0" },
  ...extra,
});

async function until(check, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const pollIsWaiting = (userId, address) => until(() => store.waiting(userId, address), `a poll on ${address}`);

function countQueries() {
  const seen = [];
  const listener = (query) => seen.push(query.sql);
  db.on("query", listener);
  return {
    seen,
    stop() {
      db.off("query", listener);
      return seen.length;
    },
  };
}

// ------------------------------------------------------------ desktop auth

test("a desktop signs in with its licence, and nothing else will do", async () => {
  const { studio, old, caseys } = devices;
  const alice = people.alice;

  const ok = await desktopPoll(studio);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { messages: [] });
  assert.equal(ok.headers.get("cache-control"), "no-store");

  const refused = async (licence, status, error) => {
    const res = await call("/desktop/poll", { licence, body: { wait: 0 } });
    assert.equal(res.status, status, `${String(licence).slice(0, 24)} -> ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error });
  };

  assert.equal((await call("/desktop/poll", { body: { wait: 0 } })).status, 401, "no header at all");
  await refused("", 401, "licence_invalid");
  await refused("garbage", 401, "licence_invalid");
  await refused("FD1.e30.AAAA", 401, "licence_invalid");

  // Bad signature: Alice's token with its payload swapped for Bob's account.
  const [prefix, , sig] = studio.token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ v: 1, product: "forgedrop", uid: people.bob.id, did: studio.deviceId, kid: "fd-test" })
  ).toString("base64url");
  await refused(`${prefix}.${forged}.${sig}`, 401, "licence_invalid");

  const mint = (payload, signingKey = SEED) =>
    signLicenseToken(
      { v: 1, product: "forgedrop", uid: alice.id, did: studio.deviceId, iat: 1758326400, exp: null, lim: 5, ...payload },
      { signingKey, kid: "fd-test" }
    );
  await refused(mint({}, crypto.randomBytes(32).toString("base64")), 401, "licence_invalid");
  // Same key signs every licensed product; a Rose Colored Glasses licence is not a ForgeDrop one.
  await refused(mint({ product: "rose-colored-glasses" }), 401, "licence_invalid");
  await refused(mint({ did: "not-a-uuid" }), 401, "licence_invalid");
  await refused(mint({ exp: Math.floor(clock / 1000) - 60 }), 401, "licence_invalid");

  // Genuine licences whose machine or account no longer qualifies.
  await refused(old.token, 403, "device_inactive");
  await refused(mint({ did: randomUUID() }), 403, "device_inactive");
  await refused(caseys.token, 403, "entitlement_required");

  // On /signal the licence header alone decides that this is a desktop.
  const both = await call("/signal", { licence: "garbage", bearer: alice.bearer, body: {} });
  assert.deepEqual([both.status, both.body], [401, { error: "licence_invalid" }]);
});

test("a licence verdict is cached for 60 s, so polling does not hit the database", async () => {
  const { fresh } = devices;

  const first = countQueries();
  assert.equal((await desktopPoll(fresh)).status, 200);
  assert.ok(first.stop() >= 2, "the first poll reads the device row and the entitlement");

  const second = countQueries();
  assert.equal((await desktopPoll(fresh)).status, 200);
  assert.equal((await call("/desktop/offline", { licence: fresh.token, body: {} })).status, 204);
  second.stop();
  assert.deepEqual(second.seen, [], "a cache hit asks the database nothing");

  // A refusal is cached the same way.
  assert.equal((await desktopPoll(devices.caseys)).status, 403);
  const refusal = countQueries();
  assert.equal((await desktopPoll(devices.caseys)).status, 403);
  assert.equal(refusal.stop(), 0);

  // After a minute it is read again.
  advance(61_000);
  const later = countQueries();
  assert.equal((await desktopPoll(fresh)).status, 200);
  assert.ok(later.stop() >= 2);
});

test("freeing a slot on the account page cuts that desktop's link within a minute", async () => {
  const { spare } = devices;
  const alice = people.alice;
  const phone = newClientId();

  assert.equal((await desktopPoll(spare)).status, 200);
  await deactivateDevice(alice.id, "forgedrop", spare.deviceId);

  // Its licence check is still cached, so it can still poll...
  assert.equal((await desktopPoll(spare)).status, 200);
  // ...but a phone can no longer reach it, and the list no longer offers it.
  const sent = await phoneSignal(alice, offer(phone, newSession(), spare.address));
  assert.deepEqual([sent.status, sent.body], [404, { error: "desktop_offline" }]);
  const listed = await call("/desktops", { method: "GET", bearer: alice.bearer });
  assert.equal(listed.body.desktops.some((d) => d.deviceId === spare.deviceId), false);

  advance(61_000);
  const cut = await desktopPoll(spare);
  assert.deepEqual([cut.status, cut.body], [403, { error: "device_inactive" }]);
});

test("without a usable signing key the desktop side answers 503 link_unavailable", async () => {
  const { studio } = devices;
  for (const base of ["/nokey", "/badkey"]) {
    const res = await call("/desktop/poll", { base, licence: studio.token, body: { wait: 0 } });
    assert.deepEqual([res.status, res.body], [503, { error: "link_unavailable" }], base);
  }
  await call("/desktop/poll", { base: "/badkey", licence: studio.token, body: { wait: 0 } });
  assert.equal(
    logged.filter((entry) => entry.msg === "forgedrop_link_signing_key_invalid").length,
    1,
    "a bad key is logged once, not on every poll"
  );
  // Phones do not need the key.
  const phones = await call("/desktops", { base: "/nokey", method: "GET", bearer: people.alice.bearer });
  assert.equal(phones.status, 200);
});

// -------------------------------------------------------------- phone auth

test("a phone signs in with the customer token and must own ForgeDrop", async () => {
  const phone = newClientId();
  const target = devices.studio.address;

  const missing = await call("/desktops", { method: "GET" });
  assert.deepEqual([missing.status, missing.body], [401, { error: "missing_token" }]);
  const bad = await call("/desktops", { method: "GET", bearer: "not-a-jwt" });
  assert.deepEqual([bad.status, bad.body], [401, { error: "invalid_token" }]);
  assert.equal((await call("/phone/poll", { body: { clientId: phone, wait: 0 } })).status, 401);
  assert.equal((await call("/signal", { body: offer(phone, newSession(), target) })).status, 401);

  const casey = people.casey;
  for (const res of [
    await call("/desktops", { method: "GET", bearer: casey.bearer }),
    await phonePoll(casey, phone),
    await phoneSignal(casey, offer(phone, newSession(), target)),
  ]) {
    assert.deepEqual([res.status, res.body], [403, { error: "entitlement_required" }]);
  }

  // A phone's ownership is read per request: buying ForgeDrop works at once.
  const fran = people.fran;
  assert.equal((await phonePoll(fran, phone)).status, 403);
  await grantProductEntitlement({ userId: fran.id, productSlug: "forgedrop", source: "test" });
  const now200 = await phonePoll(fran, phone);
  assert.deepEqual([now200.status, now200.body], [200, { messages: [] }]);
});

// ------------------------------------------------------------ the desktops

test("the desktop list covers every active ForgeDrop machine, online ones first", async () => {
  const alice = people.alice;
  const { studio, laptop, basement, old, bobs } = devices;

  const polled = await desktopPoll(studio, {
    name: "Studio PC (live)",
    fingerprint: "ffff-0000-1111-2222",
    appVersion: "1.4.0",
  });
  assert.equal(polled.status, 200);

  const res = await call("/desktops", { method: "GET", bearer: alice.bearer });
  assert.equal(res.status, 200);
  const list = res.body.desktops;
  const ids = list.map((d) => d.deviceId);

  assert.deepEqual(list[0], {
    deviceId: studio.deviceId,
    name: "Studio PC (live)",
    fingerprint: "ffff-0000-1111-2222",
    // Reported by the desktop as it polls, never proven: its say-so.
    fingerprintVerified: false,
    appVersion: "1.4.0",
    platform: "windows",
    online: true,
  });
  assert.deepEqual(
    list.find((d) => d.deviceId === laptop.deviceId),
    {
      deviceId: laptop.deviceId,
      name: "alice laptop",
      fingerprint: "bbbb-bbbb-bbbb-bbbb",
      fingerprintVerified: false,
      appVersion: "1.0.1",
      platform: "windows",
      online: false,
    },
    "an activated desktop that never polled is listed offline, from its activation row"
  );
  assert.equal(ids.includes(old.deviceId), false, "a freed slot is not listed");
  assert.equal(ids.includes(bobs.deviceId), false, "another account's desktop is not listed");
  assert.deepEqual(
    list.filter((d) => !d.online).map((d) => d.name),
    ["alice laptop", "Basement PC", "Test PC"],
    "offline ones by name, ignoring case"
  );
  assert.equal(list.find((d) => d.deviceId === basement.deviceId).platform, "linux");

  // Online means polling now or within the last 40 s.
  advance(39_000);
  let again = await call("/desktops", { method: "GET", bearer: alice.bearer });
  assert.equal(again.body.desktops.find((d) => d.deviceId === studio.deviceId).online, true);
  advance(2_000);
  again = await call("/desktops", { method: "GET", bearer: alice.bearer });
  assert.deepEqual(again.body.desktops.find((d) => d.deviceId === studio.deviceId), {
    deviceId: studio.deviceId,
    name: "Studio PC",
    fingerprint: "aaaa-aaaa-aaaa-aaaa",
    fingerprintVerified: false,
    appVersion: "1.0.0",
    platform: "windows",
    online: false,
  });
});

test("presence text is trimmed to the documented lengths", async () => {
  const { studio } = devices;
  await desktopPoll(studio, { name: `  ${"N".repeat(70)}\n`, fingerprint: "f".repeat(40), appVersion: "v".repeat(40) });
  const res = await call("/desktops", { method: "GET", bearer: people.alice.bearer });
  const me = res.body.desktops.find((d) => d.deviceId === studio.deviceId);
  assert.equal(me.name, "N".repeat(64));
  assert.equal(me.fingerprint, "f".repeat(32));
  assert.equal(me.appVersion, "v".repeat(32));
  await desktopPoll(studio, { name: "Studio PC (live)", fingerprint: "ffff-0000-1111-2222", appVersion: "1.4.0" });
});

// ---------------------------------------------------------------- relaying

test("a phone's offer wakes the desktop's waiting poll at once", async () => {
  const alice = people.alice;
  const { studio } = devices;
  const phone = newClientId();
  const session = newSession();

  const waiting = desktopPoll(studio, { wait: 20 });
  await pollIsWaiting(alice.id, studio.address);

  const started = Date.now();
  // Any spelling of the uuid reaches the same desktop.
  const sent = await phoneSignal(alice, offer(phone, session, `desktop:${studio.deviceId.toUpperCase()}`));
  assert.deepEqual([sent.status, sent.body], [202, { ok: true }]);

  const got = await waiting;
  assert.ok(Date.now() - started < 2000, "woken by the message, not by the 20 s wait");
  assert.equal(got.status, 200);
  assert.equal(got.body.messages.length, 1);
  const [message] = got.body.messages;
  assert.deepEqual(Object.keys(message).sort(), ["data", "from", "sentAt", "session", "type"]);
  assert.equal(message.from, `phone:${phone}`);
  assert.equal(message.session, session);
  assert.equal(message.type, "offer");
  assert.deepEqual(message.data, offer(phone, session, "").data);
  assert.equal(new Date(message.sentAt).toISOString(), message.sentAt);
  assert.equal(store.waiting(alice.id, studio.address), false);
});

test("the desktop's answer reaches the phone, from the desktop's own address", async () => {
  const alice = people.alice;
  const { studio } = devices;
  const phone = newClientId();
  const session = newSession();

  await desktopPoll(studio);
  const waiting = phonePoll(alice, phone, 20);
  await pollIsWaiting(alice.id, `phone:${phone}`);

  const sent = await desktopSignal(studio, {
    to: `phone:${phone}`,
    // Ignored from a desktop: the server says who it is.
    from: `phone:${newClientId()}`,
    session,
    type: "answer",
    data: { sdp: "v=0 answer" },
  });
  assert.deepEqual([sent.status, sent.body], [202, { ok: true }]);

  const got = await waiting;
  assert.equal(got.status, 200);
  assert.equal(got.body.messages.length, 1);
  assert.deepEqual(
    { ...got.body.messages[0], sentAt: undefined },
    { from: studio.address, session, type: "answer", data: { sdp: "v=0 answer" }, sentAt: undefined }
  );
});

test("an answer sent before the phone's first poll waits for it", async () => {
  // A phone that has just signalled counts as present, so the desktop's
  // answer is not refused as phone_gone while the phone opens its poll.
  const alice = people.alice;
  const { studio } = devices;
  const phone = newClientId();
  const session = newSession();

  await desktopPoll(studio);
  assert.equal((await phoneSignal(alice, offer(phone, session, studio.address))).status, 202);
  const answered = await desktopSignal(studio, { to: `phone:${phone}`, session, type: "answer", data: { sdp: "a" } });
  assert.equal(answered.status, 202);

  const got = await phonePoll(alice, phone);
  assert.deepEqual(got.body.messages.map((m) => m.type), ["answer"]);
  await desktopPoll(studio); // collect the offer
});

test("a newer poll from the same address ends the older one with no messages", async () => {
  const alice = people.alice;
  const { studio } = devices;
  const phone = newClientId();
  const session = newSession();

  const older = desktopPoll(studio, { wait: 20 });
  await pollIsWaiting(alice.id, studio.address);
  const started = Date.now();
  const newer = desktopPoll(studio, { wait: 20 });
  const ended = await older;
  assert.ok(Date.now() - started < 2000, "ended by the newer poll, not by its own 20 s wait");
  assert.deepEqual([ended.status, ended.body], [200, { messages: [] }]);
  await pollIsWaiting(alice.id, studio.address);

  await phoneSignal(alice, { ...offer(phone, session, studio.address), type: "bye", data: {} });
  const got = await newer;
  assert.deepEqual(got.body.messages.map((m) => [m.type, m.from]), [["bye", `phone:${phone}`]]);

  // Phones too.
  const olderPhone = phonePoll(alice, phone, 20);
  await pollIsWaiting(alice.id, `phone:${phone}`);
  const phoneStarted = Date.now();
  const newerPhone = phonePoll(alice, phone, 20);
  assert.deepEqual((await olderPhone).body, { messages: [] });
  assert.ok(Date.now() - phoneStarted < 2000);
  await pollIsWaiting(alice.id, `phone:${phone}`);
  await desktopSignal(studio, { to: `phone:${phone}`, session, type: "bye" });
  assert.deepEqual(
    (await newerPhone).body.messages.map((m) => [m.type, m.data]),
    [["bye", {}]],
    "data defaults to {}"
  );
  assert.equal(store.stats().waiters, 0);
});

test("a poll whose client hangs up leaves nothing behind and loses nothing", async () => {
  const alice = people.alice;
  const { studio } = devices;
  const phone = newClientId();
  const session = newSession();

  const controller = new AbortController();
  const abandoned = desktopPoll(studio, { wait: 20 }, { signal: controller.signal }).catch((error) => error);
  await pollIsWaiting(alice.id, studio.address);
  controller.abort();
  assert.equal((await abandoned).name, "AbortError");
  await until(() => !store.waiting(alice.id, studio.address), "the abandoned poll to be released");
  assert.equal(store.stats().waiters, 0);

  // Still online (it polled moments ago), and the next message is kept for
  // the next poll rather than written to the closed connection.
  assert.equal((await phoneSignal(alice, offer(phone, session, studio.address))).status, 202);
  const got = await desktopPoll(studio);
  assert.deepEqual(got.body.messages.map((m) => m.session), [session]);
});

test("a desktop that goes offline is offline at once, and its queue goes with it", async () => {
  const alice = people.alice;
  const { studio } = devices;
  const phone = newClientId();

  const waiting = desktopPoll(studio, { wait: 20 });
  await pollIsWaiting(alice.id, studio.address);
  const started = Date.now();
  const off = await call("/desktop/offline", { licence: studio.token, body: {} });
  assert.equal(off.status, 204);
  assert.equal(off.text, "");
  assert.deepEqual((await waiting).body, { messages: [] }, "its pending poll ends");
  assert.ok(Date.now() - started < 2000, "at once, not after its 20 s wait");

  const refused = await phoneSignal(alice, offer(phone, newSession(), studio.address));
  assert.deepEqual([refused.status, refused.body], [404, { error: "desktop_offline" }]);
  const listed = await call("/desktops", { method: "GET", bearer: alice.bearer });
  assert.equal(listed.body.desktops.find((d) => d.deviceId === studio.deviceId).online, false);

  await desktopPoll(studio);
  assert.equal((await phoneSignal(alice, offer(phone, newSession(), studio.address))).status, 202);
  assert.equal((await call("/desktop/offline", { licence: studio.token })).status, 204, "no body needed");
  assert.deepEqual((await desktopPoll(studio)).body, { messages: [] }, "queued messages are dropped");
});

test("desktop_offline and phone_gone", async () => {
  const alice = people.alice;
  const { studio, laptop } = devices;
  const phone = newClientId();

  const neverPolled = await phoneSignal(alice, offer(phone, newSession(), laptop.address));
  assert.deepEqual([neverPolled.status, neverPolled.body], [404, { error: "desktop_offline" }]);
  const unknown = await phoneSignal(alice, offer(phone, newSession(), `desktop:${randomUUID()}`));
  assert.deepEqual([unknown.status, unknown.body], [404, { error: "desktop_offline" }]);

  await desktopPoll(studio);
  const nobody = await desktopSignal(studio, { to: `phone:${newClientId()}`, session: newSession(), type: "bye" });
  assert.deepEqual([nobody.status, nobody.body], [404, { error: "phone_gone" }]);

  // A phone is present while polling or within 60 s of its last poll.
  await phonePoll(alice, phone);
  advance(59_000);
  await desktopPoll(studio);
  assert.equal((await desktopSignal(studio, { to: `phone:${phone}`, session: newSession(), type: "bye" })).status, 202);
  advance(2_000);
  const gone = await desktopSignal(studio, { to: `phone:${phone}`, session: newSession(), type: "bye" });
  assert.deepEqual([gone.status, gone.body], [404, { error: "phone_gone" }]);
});

test("one account can never reach another's desktops or read its phones' mail", async () => {
  const { alice, bob } = people;
  const { studio, bobs } = devices;
  const phone = newClientId();
  const session = newSession();

  await desktopPoll(studio);
  await desktopPoll(bobs);

  // Bob's phone cannot signal Alice's online desktop.
  const crossDesktop = await phoneSignal(bob, offer(newClientId(), session, studio.address));
  assert.deepEqual([crossDesktop.status, crossDesktop.body], [404, { error: "desktop_offline" }]);

  // Alice's phone is present; Bob's desktop still cannot reach it.
  await phonePoll(alice, phone);
  const crossPhone = await desktopSignal(bobs, { to: `phone:${phone}`, session, type: "answer", data: { sdp: "x" } });
  assert.deepEqual([crossPhone.status, crossPhone.body], [404, { error: "phone_gone" }]);

  // Alice's desktop answers Alice's phone. Bob polls the very same clientId
  // and gets nothing; Alice's phone still gets its answer.
  assert.equal(
    (await desktopSignal(studio, { to: `phone:${phone}`, session, type: "answer", data: { sdp: "for alice" } })).status,
    202
  );
  assert.deepEqual((await phonePoll(bob, phone)).body, { messages: [] });
  const mine = await phonePoll(alice, phone);
  assert.deepEqual(mine.body.messages.map((m) => m.data.sdp), ["for alice"]);

  const bobsList = await call("/desktops", { method: "GET", bearer: bob.bearer });
  assert.deepEqual(bobsList.body.desktops.map((d) => d.deviceId), [bobs.deviceId]);
});

// --------------------------------------------------------------- the shapes

test("bad to, from, session, type and data are refused", async () => {
  const alice = people.alice;
  const { studio, laptop } = devices;
  const phone = newClientId();
  const good = offer(phone, newSession(), studio.address);
  await desktopPoll(studio);

  const expect = async (res, status, error, note) => {
    const got = await res;
    assert.deepEqual([got.status, got.body], [status, { error }], note);
  };
  const fromPhone = (patch) => phoneSignal(alice, { ...good, ...patch });

  await expect(phoneSignal(alice, {}), 400, "bad_recipient", "nothing at all");
  await expect(fromPhone({ to: undefined }), 400, "bad_recipient", "no to");
  await expect(fromPhone({ to: "desktop:not-a-uuid" }), 400, "bad_recipient");
  await expect(fromPhone({ to: `tablet:${studio.deviceId}` }), 400, "bad_recipient");
  await expect(fromPhone({ to: studio.deviceId }), 400, "bad_recipient", "no kind");
  await expect(fromPhone({ to: `phone:${newClientId()}` }), 400, "bad_recipient", "phone to phone");
  await expect(fromPhone({ to: "phone:short" }), 400, "bad_recipient");
  await expect(fromPhone({ to: ["desktop", studio.deviceId] }), 400, "bad_recipient");

  await expect(fromPhone({ from: undefined }), 400, "bad_sender", "a phone must say which phone");
  await expect(fromPhone({ from: studio.address }), 400, "bad_sender", "a phone cannot claim a desktop");
  await expect(fromPhone({ from: "phone:short" }), 400, "bad_sender");
  await expect(fromPhone({ from: `phone:${"x".repeat(65)}` }), 400, "bad_sender");

  await expect(fromPhone({ session: undefined }), 400, "bad_session");
  await expect(fromPhone({ session: "x".repeat(15) }), 400, "bad_session");
  await expect(fromPhone({ session: "x".repeat(65) }), 400, "bad_session");
  await expect(fromPhone({ session: "has spaces in it ok" }), 400, "bad_session");
  await expect(fromPhone({ session: 1234567890123456 }), 400, "bad_session");

  await expect(fromPhone({ type: "hello" }), 400, "bad_type");
  await expect(fromPhone({ type: "answer" }), 400, "bad_type", "phones offer, desktops answer");
  await expect(fromPhone({ type: undefined }), 400, "bad_type");

  await expect(fromPhone({ data: [] }), 400, "bad_data");
  await expect(fromPhone({ data: "v=0" }), 400, "bad_data");
  await expect(fromPhone({ data: null }), 400, "bad_data");

  const fromDesktop = (patch) =>
    desktopSignal(studio, { to: `phone:${phone}`, session: newSession(), type: "answer", data: {}, ...patch });
  await expect(fromDesktop({ to: laptop.address }), 400, "bad_type", "desktops only dial each other");
  await expect(fromDesktop({ to: studio.address, type: "dial" }), 400, "bad_recipient", "not to itself");
  await expect(fromDesktop({ to: undefined }), 400, "bad_recipient");
  await expect(fromDesktop({ type: "offer" }), 400, "bad_type");

  // The shape is checked before anything is delivered.
  assert.deepEqual((await desktopPoll(studio)).body, { messages: [] });

  await expect(phonePoll(alice, undefined), 400, "bad_client_id");
  await expect(phonePoll(alice, "short"), 400, "bad_client_id");
  await expect(phonePoll(alice, "has spaces and is long enough"), 400, "bad_client_id");
  await expect(phonePoll(alice, "x".repeat(65)), 400, "bad_client_id");
  await expect(phonePoll(alice, phone, "soon"), 400, "bad_wait");
  await expect(desktopPoll(studio, { wait: "25" }), 400, "bad_wait");
  await expect(desktopPoll(studio, { wait: true }), 400, "bad_wait");
});

test("wait, uuid and text helpers read clients generously but safely", () => {
  assert.equal(parseWait(undefined), 25, "wait defaults to 25");
  assert.equal(parseWait(null), 25);
  assert.equal(parseWait(0), 0);
  assert.equal(parseWait(90), 25, "clamped to 25");
  assert.equal(parseWait(-3), 0);
  assert.equal(parseWait(2.5), 2.5);
  assert.equal(parseWait("10"), null);
  assert.equal(parseWait(Number.NaN), null);

  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.equal(canonicalUuid(id.toUpperCase()), id);
  assert.equal(canonicalUuid(id.replace(/-/g, "")), id);
  assert.equal(canonicalUuid(`{${id}}`), id);
  assert.equal(canonicalUuid("0f8fad5b"), null);
  assert.equal(canonicalUuid(42), null);

  assert.equal(cleanText("  Studio\u0000PC\n ", 64), "Studio PC");
  assert.equal(cleanText("   ", 64), null);
  assert.equal(cleanText(12, 64), null);
  assert.equal(cleanText("😀".repeat(70), 64), "😀".repeat(64), "cut by character, not by UTF-16 unit");
});

test("data is capped at 32 KiB and the body at 64 KiB; bodies must be JSON", async () => {
  const alice = people.alice;
  const { studio } = devices;
  const phone = newClientId();
  await desktopPoll(studio);

  // {"sdp":""} is 10 bytes.
  const exactly = { sdp: "x".repeat(32 * 1024 - 10) };
  assert.equal(Buffer.byteLength(JSON.stringify(exactly)), 32 * 1024);
  const fits = await phoneSignal(alice, offer(phone, newSession(), studio.address, { data: exactly }));
  assert.equal(fits.status, 202, "exactly 32 KiB is allowed");

  const over = await phoneSignal(alice, offer(phone, newSession(), studio.address, { data: { sdp: `${exactly.sdp}x` } }));
  assert.deepEqual([over.status, over.body], [413, { error: "data_too_large" }]);

  const multibyte = await phoneSignal(alice, offer(phone, newSession(), studio.address, { data: { sdp: "é".repeat(16 * 1024) } }));
  assert.deepEqual([multibyte.status, multibyte.body], [413, { error: "data_too_large" }], "counted in bytes");

  const huge = await phoneSignal(alice, offer(phone, newSession(), studio.address, { data: { sdp: "x".repeat(70 * 1024) } }));
  assert.deepEqual([huge.status, huge.body], [413, { error: "payload_too_large" }]);

  const broken = await call("/signal", { bearer: alice.bearer, raw: "{not json", headers: { "Content-Type": "application/json" } });
  assert.deepEqual([broken.status, broken.body], [400, { error: "invalid_json" }]);

  const text = await call("/signal", { bearer: alice.bearer, raw: JSON.stringify(offer(phone, newSession(), studio.address)), headers: { "Content-Type": "text/plain" } });
  assert.deepEqual([text.status, text.body], [415, { error: "json_required" }]);
  const form = await call("/desktop/poll", { licence: studio.token, raw: "wait=0", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.deepEqual([form.status, form.body], [415, { error: "json_required" }]);

  const delivered = await desktopPoll(studio);
  assert.equal(delivered.body.messages.length, 1, "only the message that fitted was delivered");
});

// --------------------------------------------------------- expiry and caps

test("messages expire after 60 s and a mailbox keeps the newest 32", async () => {
  const alice = people.alice;
  const { studio } = devices;
  const phone = newClientId();

  await desktopPoll(studio);
  const sessions = Array.from({ length: 33 }, (_, i) => `session-${String(i).padStart(8, "0")}`);
  for (const session of sessions) {
    assert.equal((await phoneSignal(alice, offer(phone, session, studio.address))).status, 202);
  }
  const capped = await desktopPoll(studio);
  assert.deepEqual(capped.body.messages.map((m) => m.session), sessions.slice(1), "the oldest is dropped");

  assert.equal((await phoneSignal(alice, offer(phone, "still-fresh-0001", studio.address))).status, 202);
  advance(59_000);
  assert.deepEqual((await desktopPoll(studio)).body.messages.map((m) => m.session), ["still-fresh-0001"]);

  assert.equal((await phoneSignal(alice, offer(phone, "gone-stale-00001", studio.address))).status, 202);
  advance(61_000);
  assert.deepEqual((await desktopPoll(studio)).body, { messages: [] }, "expired after 60 s");
});

test("the store sweeps what has lapsed and bounds an account's phones", async () => {
  let t = 1_000_000;
  const local = createLinkStore({ now: () => t, phonesPerAccount: 3 });
  stores.push(local);
  const answers = [];
  const respond = (tag) => (messages) => answers.push([tag, messages.length]);

  local.poll("u1", "desktop:d1", { waitMs: 0, respond: respond("d1") });
  local.poll("u1", "phone:p1", { waitMs: 60_000, respond: respond("p1") });
  local.deliver("u1", "desktop:d1", { hello: 1 });
  assert.deepEqual(local.stats(), { accounts: 1, endpoints: 2, waiters: 1, messages: 1 });

  // A fourth phone on the account retires the one heard from longest ago,
  // ending its pending poll.
  t += 1;
  local.touch("u1", "phone:p2");
  t += 1;
  local.touch("u1", "phone:p3");
  t += 1;
  local.touch("u1", "phone:p4");
  assert.equal(local.isPresent("u1", "phone:p1"), false);
  assert.deepEqual(answers, [["d1", 0], ["p1", 0]]);
  assert.equal(local.stats().waiters, 0);

  // Presence lapses at 40 s (desktop) and 60 s (phone); a queued message
  // outlives presence until it expires, then the sweep forgets everything.
  t += 45_000;
  local.sweep();
  assert.deepEqual(local.stats(), { accounts: 1, endpoints: 4, waiters: 0, messages: 1 });
  t += 20_000;
  local.sweep();
  assert.deepEqual(local.stats(), { accounts: 0, endpoints: 0, waiters: 0, messages: 0 });

  // A released poll never answers, and an answered one never answers twice.
  const release = local.poll("u2", "phone:p9", { waitMs: 60_000, respond: respond("p9") });
  release();
  release();
  local.deliver("u2", "phone:p9", { later: true });
  assert.equal(answers.some(([tag]) => tag === "p9"), false);
  assert.equal(local.stats().messages, 1, "kept for the next poll");

  // A client that has gone, before its hang-up has been noticed: the message
  // is not written into the dead connection, it waits for the next poll.
  let alive = true;
  local.poll("u3", "desktop:d3", { waitMs: 60_000, respond: respond("d3"), isAlive: () => alive });
  alive = false;
  local.deliver("u3", "desktop:d3", { offer: 1 });
  assert.equal(answers.some(([tag]) => tag === "d3"), false);
  assert.equal(local.waiting("u3", "desktop:d3"), false, "the dead poll is released");
  local.poll("u3", "desktop:d3", { waitMs: 0, respond: respond("d3-next") });
  assert.deepEqual(answers.at(-1), ["d3-next", 1]);

  // Nor does a dead poll that is superseded get written to.
  alive = false;
  local.poll("u3", "desktop:d3", { waitMs: 60_000, respond: respond("d3-dead"), isAlive: () => alive });
  local.poll("u3", "desktop:d3", { waitMs: 0, respond: respond("d3-live") });
  assert.equal(answers.some(([tag]) => tag === "d3-dead"), false);
  assert.equal(local.stats().waiters, 0);

  const source = await src("../src/modules/forgedrop-link/store.js");
  assert.match(source, /sweeper\.unref\?\.\(\)/, "the sweep timer never holds the process open");
  assert.match(source, /waiter\.timer\.unref\?\.\(\)/);
});

// ---------------------------------------------------- the real module wiring

test("the mounted module enforces the documented rate limits, with Retry-After", async () => {
  assert.deepEqual(LINK_LIMITS.rate, { signalPerMinute: 120, pollPerMinute: 60, desktopsPerMinute: 30 });
  assert.equal(LINK_LIMITS.bodyBytes, 64 * 1024);
  assert.equal(LINK_LIMITS.dataBytes, 32 * 1024);
  assert.equal(LINK_LIMITS.mailboxMessages, 32);
  assert.equal(LINK_LIMITS.messageTtlMs, 60_000);
  assert.equal(LINK_LIMITS.desktopOnlineMs, 40_000);
  assert.equal(LINK_LIMITS.phonePresentMs, 60_000);
  assert.equal(LINK_LIMITS.licenceCacheMs, 60_000);

  const dana = people.dana;
  const { danas } = devices;
  const base = "/real";

  const hammer = async (count, send) => {
    for (let i = 0; i < count; i += 1) {
      const res = await send();
      assert.notEqual(res.status, 429, `request ${i + 1} of ${count} was limited`);
    }
    const limited = await send();
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "rate_limited");
    assert.match(limited.headers.get("retry-after"), /^[1-9]\d*$/);
    assert.equal(limited.headers.get("access-control-expose-headers"), "Retry-After");
  };

  await hammer(30, () => call("/desktops", { base, method: "GET", bearer: dana.bearer }));

  const phone = newClientId();
  await hammer(60, () => call("/phone/poll", { base, bearer: dana.bearer, body: { clientId: phone, wait: 0 } }));
  // Per address: another tab of the same phone has its own allowance.
  assert.equal((await call("/phone/poll", { base, bearer: dana.bearer, body: { clientId: newClientId(), wait: 0 } })).status, 200);

  await hammer(60, () => call("/desktop/poll", { base, licence: danas.token, body: { wait: 0 } }));

  // Per account, across its phones and desktops alike.
  await hammer(120, () =>
    call("/signal", { base, bearer: dana.bearer, body: offer(newClientId(), newSession(), `desktop:${randomUUID()}`) })
  );
  const desktopToo = await call("/signal", {
    base,
    licence: danas.token,
    body: { to: `phone:${newClientId()}`, session: newSession(), type: "bye" },
  });
  assert.equal(desktopToo.status, 429);
});

test("the mounted module is the real one, answering JSON for everything", async () => {
  const base = "/real";
  const unauthenticated = await call("/desktops", { base, method: "GET" });
  assert.deepEqual([unauthenticated.status, unauthenticated.body], [401, { error: "missing_token" }]);
  const nowhere = await call("/nowhere", { base, method: "GET" });
  assert.deepEqual([nowhere.status, nowhere.body], [404, { error: "not_found" }]);
  const polled = await call("/desktop/poll", { base, licence: devices.bobs.token, body: { wait: 0 } });
  assert.deepEqual([polled.status, polled.body], [200, { messages: [] }]);
});

test("app.js mounts the link before the shared 25 MB parser, and a broken module cannot stop the API", async () => {
  const app = await src("../src/app.js");
  // Lose this and every phone-link request 404s with nothing else looking wrong.
  assert.match(app, /import \{ forgedropLinkRouter \} from "\.\/modules\/forgedrop-link\/index\.js";/);
  assert.match(app, /app\.use\("\/v1\/forgedrop\/link", forgedropLinkRouter\);/);
  const mountAt = app.indexOf('app.use("/v1/forgedrop/link", forgedropLinkRouter)');
  assert.ok(mountAt > app.search(/app\.use\(\s*cors\(/), "after CORS, so the browser app can call it");
  assert.ok(mountAt < app.search(/app\.use\(\s*express\.json\(/), "before the shared parser, so its own 64 KiB one applies");

  // index.js holds its own code behind a dynamic import and a catch.
  const index = await src("../src/modules/forgedrop-link/index.js");
  assert.doesNotMatch(index, /from "\.\/[a-z]+\.js"/, "no static import of the module's own files");
  assert.match(index, /await import\("\.\/router\.js"\)/);

  const broken = await call("/desktop/poll", { base: "/broken", licence: devices.studio.token, body: {} });
  assert.deepEqual([broken.status, broken.body], [503, { error: "link_unavailable" }]);
  assert.ok(logged.some((entry) => entry.msg === "forgedrop_link_unavailable" && /router\.js/.test(entry.meta.message)));
  const wrongShape = await loadForgeDropLink(async () => ({ not: "a router" }), { logger: () => {} });
  assert.equal(typeof wrongShape, "function");
  assert.equal(wrongShape.stack.length, 1, "the 503 stand-in");
});

test("no poll is left waiting once its answer has gone out", () => {
  assert.equal(store.stats().waiters, 0);
});

// ------------------------------------------------ desktop to desktop (1.4)

// Their own machines: earlier tests free and rename the shared ones.
let dialers;
async function dialDesktops() {
  if (!dialers) {
    dialers = {
      spare: await activate("dial-home", people.alice, { name: "Home PC" }),
      fresh: await activate("dial-away", people.alice, { name: "Away laptop" }),
      basement: await activate("dial-phones-only", people.alice, { name: "Den PC" }),
      bobs: await activate("dial-bob", people.bob, { name: "Bob's other PC" }),
    };
  }
  return dialers;
}

const dial = (to, session, extra = {}) => ({
  to: to.address,
  session,
  type: "dial",
  data: { candidates: { tcp: ["[2001:db8::7]:47021"], udp: ["203.0.113.7:61000"] }, token: "AAAA" },
  ...extra,
});

test("one desktop dials another of the same account, and hears its answer", async () => {
  const { spare, fresh } = await dialDesktops();
  await desktopPoll(spare, { caps: ["internet"] });
  await desktopPoll(fresh, { caps: ["phone-link", "internet"] });
  const session = newSession();

  const sent = await desktopSignal(spare, dial(fresh, session));
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const heard = await desktopPoll(fresh, { caps: ["phone-link", "internet"] });
  assert.equal(heard.body.messages.length, 1);
  assert.equal(heard.body.messages[0].from, spare.address);
  assert.equal(heard.body.messages[0].type, "dial");
  assert.deepEqual(heard.body.messages[0].data.candidates.udp, ["203.0.113.7:61000"]);

  const answered = await desktopSignal(fresh, {
    to: spare.address,
    session,
    type: "dial-answer",
    data: { candidates: { udp: ["198.51.100.4:62000"] } },
  });
  assert.equal(answered.status, 202);
  const back = await desktopPoll(spare, { caps: ["internet"] });
  assert.equal(back.body.messages[0].type, "dial-answer");
  assert.equal(back.body.messages[0].from, fresh.address);
});

test("a desktop that is not taking dials is offline to its other desktops", async () => {
  const { spare, basement } = await dialDesktops();
  await desktopPoll(spare, { caps: ["internet"] });
  await desktopPoll(basement, { caps: ["phone-link"] });            // phones only
  const res = await desktopSignal(spare, dial(basement, newSession()));
  assert.deepEqual([res.status, res.body], [404, { error: "desktop_offline" }]);
  // An app from before 1.4 says nothing about capabilities: phones only.
  await desktopPoll(basement);
  const again = await desktopSignal(spare, dial(basement, newSession()));
  assert.equal(again.status, 404);
});

test("a desktop polling only for dials is offline to phones", async () => {
  const alice = people.alice;
  const { spare } = await dialDesktops();
  await desktopPoll(spare, { caps: ["internet"] });
  const listed = await call("/desktops", { method: "GET", bearer: alice.bearer });
  assert.equal(listed.body.desktops.find((d) => d.deviceId === spare.deviceId).online, false);
  const phone = newClientId();
  const res = await phoneSignal(alice, offer(phone, newSession(), spare.address));
  assert.deepEqual([res.status, res.body], [404, { error: "desktop_offline" }]);
});

test("a desktop lists its account's other desktops, online ones taking dials", async () => {
  const { spare, fresh, basement, bobs } = await dialDesktops();
  await desktopPoll(spare, { caps: ["internet"] });
  await desktopPoll(fresh, { caps: ["internet"], name: "Fresh (live)" });
  await desktopPoll(basement, { caps: ["phone-link"] });
  const res = await call("/desktop/peers", { method: "GET", licence: spare.token });
  assert.equal(res.status, 200);
  const ids = res.body.desktops.map((d) => d.deviceId);
  assert.equal(ids.includes(spare.deviceId), false, "not itself");
  assert.equal(ids.includes(bobs.deviceId), false, "not another account's");
  const byId = Object.fromEntries(res.body.desktops.map((d) => [d.deviceId, d]));
  assert.equal(byId[fresh.deviceId].online, true);
  assert.equal(byId[fresh.deviceId].name, "Fresh (live)");
  assert.equal(byId[fresh.deviceId].address, fresh.address);
  assert.equal(byId[basement.deviceId].online, false, "phones only is not taking dials");
  assert.equal(typeof byId[fresh.deviceId].fingerprintVerified, "boolean");
  // Phones have no business here.
  assert.equal((await call("/desktop/peers", { method: "GET", bearer: people.alice.bearer })).status, 401);
});

test("the peer list prefers a proven fingerprint over what the desktop says", async () => {
  const { fresh, spare } = await dialDesktops();
  await db("device_activations")
    .where({ device_id: fresh.deviceId })
    .update({ identity_fingerprint: "1234-abcd-1234-abcd", identity_verified_at: db.fn.now() });
  await desktopPoll(fresh, { caps: ["internet"], fingerprint: "ffff-ffff-ffff-ffff" });
  const res = await call("/desktop/peers", { method: "GET", licence: spare.token });
  const listed = res.body.desktops.find((d) => d.deviceId === fresh.deviceId);
  assert.equal(listed.fingerprint, "1234-abcd-1234-abcd");
  assert.equal(listed.fingerprintVerified, true);
  await db("device_activations")
    .where({ device_id: fresh.deviceId })
    .update({ identity_verified_at: null });
});

test("dials never cross accounts, and phones cannot dial", async () => {
  const { spare, bobs } = await dialDesktops();
  await desktopPoll(bobs, { caps: ["internet"] });
  await desktopPoll(spare, { caps: ["internet"] });
  // Bob's desktop is online and taking dials, but not in Alice's account.
  const res = await desktopSignal(spare, dial(bobs, newSession()));
  assert.deepEqual([res.status, res.body], [404, { error: "desktop_offline" }]);
  const phone = newClientId();
  const fromPhone = await phoneSignal(people.alice, {
    to: spare.address,
    from: `phone:${phone}`,
    session: newSession(),
    type: "dial",
    data: {},
  });
  assert.deepEqual([fromPhone.status, fromPhone.body], [400, { error: "bad_type" }]);
});

test("capabilities are read generously but only known ones count", () => {
  assert.deepEqual(parseCaps(["internet", "internet", "phone-link", "teleport", 7]), ["internet", "phone-link"]);
  assert.equal(parseCaps("internet"), null);
  assert.equal(parseCaps(undefined), null);
});
