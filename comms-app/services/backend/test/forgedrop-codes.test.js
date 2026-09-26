// ForgeDrop codes: the relay that introduces two desktops through a short
// code, for sending to someone who is not one of your own computers
// (ForgeDrop/docs/codes.md, "Backend: the code relay").
//
// As in forgedrop-link.test.js, the HTTP tests run the real router, real
// licence tokens minted by the activation service and real device_activations
// rows against an in-process Postgres (PGlite). Every test gets a relay of its
// own (fresh stores, its own path, its own rate-limit names), so the
// nameplates one test opens never shift another's numbers. The stores' clock
// is a dial the tests turn; long-polls and the rate limiter use real time.

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
process.env.JWT_SECRET ||= "forgedrop-codes-test-secret-at-least-32-bytes";

// env.js reads the environment when it is first imported, so everything that
// touches it is imported after the key is set.
const { db } = await import("../src/config/db.js");
const { env } = await import("../src/config/env.js");
const { requireAuth } = await import("../src/middleware/auth.js");
const { issueCustomerAccessToken } = await import("../src/services/auth.service.js");
const { grantProductEntitlement, hasProductEntitlement } = await import(
  "../src/services/entitlement.service.js"
);
const { activateDevice } = await import("../src/services/deviceActivation.service.js");
const { createForgeDropLinkRouter, CODE_LIMITS } = await import("../src/modules/forgedrop-link/router.js");
const { createLinkStore } = await import("../src/modules/forgedrop-link/store.js");
const { createCodeStore } = await import("../src/modules/forgedrop-link/codes.js");
const { isCodeSession, parseMinutes, parseNameplate } = await import("../src/modules/forgedrop-link/shapes.js");

const src = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

// ------------------------------------------------------------------ fixtures

let clock = Date.now();
const now = () => clock;
const advance = (ms) => {
  clock += ms;
};

const logged = [];
const log = (level, msg, meta) => logged.push({ level, msg, meta });
const stoppable = [];
const people = {};
const devices = {};
let detach;
let server;
let origin;

const app = express();
// app.js runs the app-wide form parser ahead of every router; so does this.
app.use(express.urlencoded({ extended: false }));

async function signUp(name) {
  const id = randomUUID();
  const email = `${name}@example.com`;
  await db("users").insert({ id, email });
  await grantProductEntitlement({ userId: id, productSlug: "forgedrop", source: "test" });
  people[name] = { id, email, bearer: issueCustomerAccessToken({ id, email }) };
  return people[name];
}

async function activate(key, person, name) {
  const result = await activateDevice({
    userId: person.id,
    productSlug: "forgedrop",
    deviceId: randomUUID(),
    deviceName: name,
    platform: "windows",
    appVersion: "1.5.0",
    deviceLimit: 20,
  });
  devices[key] = { deviceId: result.deviceId, token: result.token, owner: person, address: `desktop:${result.deviceId}` };
  return devices[key];
}

before(async () => {
  detach = await attachPglite(db);
  // requireAuth reads auth_version; the shared helper's users table predates it.
  await db.schema.alterTable("users", (t) => t.integer("auth_version").defaultTo(0));

  // Three accounts. Alice has two desktops; Bob and Dana are strangers to her.
  const alice = await signUp("alice");
  const bob = await signUp("bob");
  const dana = await signUp("dana");
  await activate("studio", alice, "Studio PC");
  await activate("laptop", alice, "Alice's laptop");
  await activate("bobs", bob, "Bob's desktop");
  await activate("danas", dana, "Dana PC");

  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const made of stoppable) made.stop();
  server?.closeAllConnections?.();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await detach?.();
});

// ------------------------------------------------------------------- helpers

async function call(path, { method = "POST", body, raw, licence, bearer, headers = {}, signal, base } = {}) {
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

async function until(check, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function countQueries() {
  const seen = [];
  const listener = (query) => seen.push(query.sql);
  db.on("query", listener);
  return {
    stop() {
      db.off("query", listener);
      return seen;
    },
  };
}

// Limits off, except in the tests about them: a long run should not depend on
// which minute of the clock it lands in.
const UNLIMITED = {
  signalPerMinute: 1e6,
  pollPerMinute: 1e6,
  desktopsPerMinute: 1e6,
  codeOpenPerMinute: 1e6,
  codeClaimPerMinute: 1e6,
  codeSignalPerMinute: 1e6,
};

let relays = 0;

/** A relay of its own: a fresh router and stores, at a path of its own. */
function relay({ rate = UNLIMITED } = {}) {
  relays += 1;
  const base = `/relay-${relays}`;
  const store = createLinkStore({ now });
  const codes = createCodeStore({ now, deliver: (userId, address, message) => store.deliver(userId, address, message) });
  stoppable.push(store, codes);
  app.use(
    base,
    createForgeDropLinkRouter({
      db,
      requireAuth,
      hasProductEntitlement,
      signingKey: () => env.licenseSigningKey,
      now,
      log,
      store,
      codes,
      rate,
      rateLimitPrefix: `fd-codes-${relays}`,
    })
  );

  const at = (path, options = {}) => call(path, { base, ...options });
  const open = (device, body = {}) => at("/code/open", { licence: device.token, body });
  const claim = (device, nameplate) => at("/code/claim", { licence: device.token, body: { nameplate } });
  return {
    store,
    codes,
    call: at,
    open,
    claim,
    signal: (device, body) => at("/code/signal", { licence: device.token, body }),
    close: (device, body) => at("/code/close", { licence: device.token, body }),
    poll: (device, body = {}, options = {}) =>
      at("/desktop/poll", { licence: device.token, body: { wait: 0, ...body }, ...options }),

    /** What is waiting for a desktop, each without the time it was sent. */
    async mail(device) {
      const res = await at("/desktop/poll", { licence: device.token, body: { wait: 0 } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.messages.map(({ sentAt, ...message }) => {
        assert.equal(new Date(sentAt).toISOString(), sentAt, "sentAt is ISO-8601");
        return message;
      });
    },

    /** Open a code on `creator` and claim it from `claimer`. */
    async start(creator, claimer) {
      const opened = await open(creator);
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      const claimed = await claim(claimer, opened.body.nameplate);
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      return { nameplate: opened.body.nameplate, sid: claimed.body.session };
    },
  };
}

const said = (sid, type, data) => ({ from: `code:${sid}`, session: sid, type, data });

// ----------------------------------------------------------------- opening

test("open hands out the smallest free nameplate: 1, then 2, and closing 1 frees it", async () => {
  const r = relay();
  const { studio, laptop, bobs, danas } = devices;

  const one = await r.open(studio);
  assert.deepEqual([one.status, one.body], [200, { nameplate: "1", expiresAt: new Date(clock + 60 * 60_000).toISOString() }]);
  assert.equal(one.headers.get("cache-control"), "no-store");

  // One count for everybody: the next code is 2, whoever opens it.
  assert.equal((await r.open(bobs)).body.nameplate, "2");

  const closed = await r.close(studio, { nameplate: "1" });
  assert.deepEqual([closed.status, closed.text], [204, ""]);
  assert.equal((await r.open(danas)).body.nameplate, "1", "the smallest free one again");
  assert.equal((await r.open(studio)).body.nameplate, "3");

  // A claimed nameplate is closed, and its number is free for the next code.
  assert.equal((await r.claim(laptop, "2")).status, 200);
  assert.equal((await r.open(laptop)).body.nameplate, "2");
});

test("a desktop can have 4 codes open at once; the 5th is refused", async () => {
  const r = relay();
  const { studio, laptop, bobs } = devices;

  const numbers = [];
  for (let i = 0; i < 4; i += 1) numbers.push((await r.open(studio, { minutes: 5 })).body.nameplate);
  assert.deepEqual(numbers, ["1", "2", "3", "4"]);
  const fifth = await r.open(studio);
  assert.deepEqual([fifth.status, fifth.body], [409, { error: "too_many_codes" }]);

  // Per desktop: the same account's other desktop still can.
  assert.equal((await r.open(laptop)).body.nameplate, "5");

  // A code withdrawn, claimed or run out makes room again.
  assert.equal((await r.close(studio, { nameplate: "1" })).status, 204);
  assert.equal((await r.open(studio)).body.nameplate, "1");
  assert.equal((await r.open(studio)).status, 409);
  assert.equal((await r.claim(bobs, "2")).status, 200);
  assert.equal((await r.open(studio)).body.nameplate, "2");
  assert.equal((await r.open(studio)).status, 409);
  advance(5 * 60_000); // 3 and 4 were open for 5 minutes
  assert.equal((await r.open(studio)).body.nameplate, "3");
  assert.equal((await r.open(studio)).body.nameplate, "4");
  assert.equal((await r.open(studio)).status, 409);
});

test("a code is open for its minutes: an hour by default, a minute at least, a day at most", async () => {
  const r = relay();
  const { studio } = devices;
  const lasts = async (body) => {
    const res = await r.open(studio, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await r.close(studio, { nameplate: res.body.nameplate })).status, 204);
    return (Date.parse(res.body.expiresAt) - clock) / 60_000;
  };
  assert.equal(await lasts({}), 60);
  assert.equal(await lasts({ minutes: null }), 60);
  assert.equal(await lasts({ minutes: 1440 }), 1440);
  assert.equal(await lasts({ minutes: 5000 }), 1440, "clamped to a day");
  assert.equal(await lasts({ minutes: 0 }), 1, "clamped to a minute");
  assert.equal(await lasts({ minutes: -5 }), 1);
  assert.equal(await lasts({ minutes: 2.5 }), 2.5);

  for (const minutes of ["60", true, [60], { m: 1 }]) {
    const res = await r.open(studio, { minutes });
    assert.deepEqual([res.status, res.body], [400, { error: "bad_minutes" }], JSON.stringify(minutes));
  }
});

// ---------------------------------------------------------------- claiming

test("a claim tells the creator through its poll, and the session carries messages both ways across two accounts", async () => {
  const r = relay();
  const { alice } = people;
  const { studio, bobs } = devices;

  await r.poll(studio, { name: "Studio PC (live)" });
  const { nameplate } = (await r.open(studio)).body;

  const waiting = r.poll(studio, { wait: 20 });
  await until(() => r.store.waiting(alice.id, studio.address), "the creator's poll");
  const started = Date.now();
  const claimed = await r.claim(bobs, nameplate);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const sid = claimed.body.session;
  assert.ok(isCodeSession(sid), `a 22-character base64url session id, not ${sid}`);
  assert.deepEqual(claimed.body, { session: sid, peer: { name: "Studio PC (live)" } });

  const woken = await waiting;
  assert.ok(Date.now() - started < 2000, "woken by the claim, not by the 20 s wait");
  assert.deepEqual(woken.body.messages, [
    { ...said(sid, "code-claimed", { nameplate }), sentAt: new Date(clock).toISOString() },
  ]);

  // Bob speaks first (the claimer starts the PAKE), then Alice answers.
  const pake = { Y: "b".repeat(43), AD: { name: "Bob's desktop", identity: "ab".repeat(32), app: "1.5.0" } };
  const fromBob = await r.signal(bobs, { session: sid, type: "pake", data: pake });
  assert.deepEqual([fromBob.status, fromBob.body], [202, { ok: true }]);
  assert.deepEqual(await r.mail(studio), [said(sid, "pake", pake)]);

  assert.equal((await r.signal(studio, { session: sid, type: "pake", data: { Y: "s" } })).status, 202);
  assert.equal((await r.signal(studio, { session: sid, type: "proof", data: { mac: "5a" } })).status, 202);
  assert.deepEqual(await r.mail(bobs), [said(sid, "pake", { Y: "s" }), said(sid, "proof", { mac: "5a" })]);

  // Each message went to its reader's own mailbox, under its own account:
  // two accounts with one desktop each, and nothing filed under the wrong one.
  assert.deepEqual(r.store.stats(), { accounts: 2, endpoints: 2, waiters: 0, messages: 0 });
  // Alice's other desktop, in the same account, hears none of it.
  assert.deepEqual(await r.mail(devices.laptop), []);
  // Nor does a successful session leave anything else behind.
  assert.deepEqual(r.codes.stats(), { nameplates: 0, sessions: 1 });
});

test("another desktop of the same account can claim a code too", async () => {
  const r = relay();
  const { studio, laptop } = devices;
  const { sid, nameplate } = await r.start(studio, laptop);

  assert.equal((await r.signal(laptop, { session: sid, type: "pake", data: { Y: "l" } })).status, 202);
  assert.equal((await r.signal(studio, { session: sid, type: "pake", data: { Y: "s" } })).status, 202);
  assert.deepEqual(await r.mail(studio), [said(sid, "code-claimed", { nameplate }), said(sid, "pake", { Y: "l" })]);
  assert.deepEqual(await r.mail(laptop), [said(sid, "pake", { Y: "s" })]);
});

test("a desktop cannot claim its own code, and trying does not spend it", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  const { nameplate } = (await r.open(studio)).body;

  const own = await r.claim(studio, nameplate);
  assert.deepEqual([own.status, own.body], [404, { error: "code_unknown" }]);
  assert.deepEqual(await r.mail(studio), [], "and nobody was told of a claim");
  assert.equal((await r.claim(bobs, nameplate)).status, 200, "still open for someone else");
});

test("the first claim consumes a code: a second claim gets 404", async () => {
  const r = relay();
  const { studio, laptop, bobs, danas } = devices;
  const { nameplate } = (await r.open(studio)).body;

  assert.equal((await r.claim(bobs, nameplate)).status, 200);
  for (const device of [danas, bobs, laptop]) {
    const again = await r.claim(device, nameplate);
    assert.deepEqual([again.status, again.body], [404, { error: "code_unknown" }]);
  }
  assert.deepEqual((await r.mail(studio)).map((m) => m.type), ["code-claimed"], "one claim, told once");
});

test("an unknown or expired nameplate gets 404, a malformed one 400", async () => {
  const r = relay();
  const { studio, bobs } = devices;

  const unknown = await r.claim(bobs, "7");
  assert.deepEqual([unknown.status, unknown.body], [404, { error: "code_unknown" }]);

  // A one-minute code can be claimed at 59 s, and not at 60.
  const early = (await r.open(studio, { minutes: 1 })).body.nameplate;
  advance(59_000);
  assert.equal((await r.claim(bobs, early)).status, 200);
  const late = (await r.open(studio, { minutes: 1 })).body.nameplate;
  advance(60_000);
  const expired = await r.claim(bobs, late);
  assert.deepEqual([expired.status, expired.body], [404, { error: "code_unknown" }]);
  assert.equal((await r.open(studio)).body.nameplate, late, "and its number is free again");

  // The same number in any spelling a person might type.
  assert.equal((await r.claim(bobs, ` 00${late} `)).status, 200);
  const numeric = (await r.open(studio)).body.nameplate;
  assert.equal((await r.claim(bobs, Number(numeric))).status, 200);

  const malformed = [undefined, null, "", "abc", "0", 0, "-1", "1.5", 1.5, "1e3", "1234567890", ["1"], { n: 1 }, "7-orbit-maple"];
  for (const bad of malformed) {
    const res = await r.claim(bobs, bad);
    assert.deepEqual([res.status, res.body], [400, { error: "bad_nameplate" }], JSON.stringify(bad));
  }
});

test("the claimer is told the creator's name: the one given with the code, else its poll's, else none", async () => {
  const r = relay();
  const { studio, laptop, bobs } = devices;
  const peerOf = async (creator, body) => {
    const { nameplate } = (await r.open(creator, body)).body;
    const claimed = await r.claim(bobs, nameplate);
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    return claimed.body.peer;
  };

  assert.deepEqual(await peerOf(laptop, {}), { name: null }, "never polled and gave no name");
  await r.poll(studio, { name: "Studio PC (live)" });
  assert.deepEqual(await peerOf(studio, {}), { name: "Studio PC (live)" });
  assert.deepEqual(await peerOf(studio, { name: "  Alice's\nstudio " }), { name: "Alice's studio" });
  assert.deepEqual(await peerOf(studio, { name: "N".repeat(80) }), { name: "N".repeat(64) });
  assert.deepEqual(await peerOf(studio, { name: 42 }), { name: "Studio PC (live)" }, "a name that is not text is ignored");
});

// --------------------------------------------------------------- signaling

test("bad sessions, types and data are refused, and data is capped at 32 KiB", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  const { sid } = await r.start(studio, bobs);
  await r.mail(studio);

  const expect = async (res, status, error, note) => {
    const got = await res;
    assert.deepEqual([got.status, got.body], [status, { error }], note);
  };
  const send = (patch) => r.signal(bobs, { session: sid, type: "pake", data: {}, ...patch });

  await expect(send({ session: undefined }), 400, "bad_session");
  await expect(send({ session: "x".repeat(21) }), 400, "bad_session");
  await expect(send({ session: "x".repeat(23) }), 400, "bad_session");
  await expect(send({ session: `${sid.slice(0, 21)}!` }), 400, "bad_session");
  await expect(send({ session: "A".repeat(22) }), 404, "code_gone", "well formed, but no such session");

  for (const type of ["offer", "answer", "code-claimed", "PAKE", "hello", undefined, 7]) {
    await expect(send({ type }), 400, "bad_type", String(type));
  }
  for (const data of [[], "Y", null, 7, true]) {
    await expect(send({ data }), 400, "bad_data", JSON.stringify(data));
  }

  // {"pad":""} is 10 bytes.
  const exactly = { pad: "x".repeat(32 * 1024 - 10) };
  assert.equal(Buffer.byteLength(JSON.stringify(exactly)), 32 * 1024);
  assert.equal((await send({ data: exactly })).status, 202, "exactly 32 KiB is allowed");
  await expect(send({ data: { pad: `${exactly.pad}x` } }), 413, "data_too_large");
  await expect(send({ data: { pad: "é".repeat(16 * 1024) } }), 413, "data_too_large", "counted in bytes");

  // Only the message that fitted was delivered.
  const mail = await r.mail(studio);
  assert.deepEqual(mail.map((m) => [m.type, m.data.pad.length]), [["pake", exactly.pad.length]]);

  // Every type goes either way, and data defaults to {}.
  const types = ["pake", "proof", "dial", "dial-answer"];
  for (const type of types) {
    assert.equal((await r.signal(studio, { session: sid, type })).status, 202, type);
    assert.equal((await r.signal(bobs, { session: sid, type })).status, 202, type);
  }
  assert.deepEqual(await r.mail(bobs), types.map((type) => said(sid, type, {})));
  assert.deepEqual(await r.mail(studio), types.map((type) => said(sid, type, {})));
});

test("a session carries at most 64 messages", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  const { sid } = await r.start(studio, bobs);

  for (let i = 0; i < 64; i += 1) {
    const res = await r.signal(i % 2 ? studio : bobs, { session: sid, type: "dial", data: { i } });
    assert.equal(res.status, 202, `message ${i + 1}: ${JSON.stringify(res.body)}`);
  }
  for (const device of [bobs, studio]) {
    const over = await r.signal(device, { session: sid, type: "bye" });
    assert.deepEqual([over.status, over.body], [409, { error: "too_many_messages" }]);
    assert.equal(over.headers.get("retry-after"), null, "waiting will not help");
  }

  // It can still be closed, and the other side still hears the bye.
  await r.mail(bobs);
  assert.equal((await r.close(studio, { session: sid })).status, 204);
  assert.deepEqual(await r.mail(bobs), [said(sid, "bye", {})]);
});

// ----------------------------------------------------------------- closing

test("close ends a session with a bye to the other side, and after it signals get 404 code_gone", async () => {
  const r = relay();
  const { studio, bobs, danas } = devices;

  // The claimer closes.
  const first = await r.start(studio, bobs);
  const closed = await r.close(bobs, { session: first.sid });
  assert.deepEqual([closed.status, closed.text], [204, ""]);
  assert.deepEqual(await r.mail(studio), [
    said(first.sid, "code-claimed", { nameplate: first.nameplate }),
    said(first.sid, "bye", {}),
  ]);
  for (const device of [studio, bobs]) {
    const late = await r.signal(device, { session: first.sid, type: "pake", data: {} });
    assert.deepEqual([late.status, late.body], [404, { error: "code_gone" }]);
  }
  const twice = await r.close(studio, { session: first.sid });
  assert.deepEqual([twice.status, twice.body], [404, { error: "code_gone" }], "already over");
  assert.deepEqual(await r.mail(bobs), [], "whoever closed hears nothing back");

  // The creator closes.
  const second = await r.start(studio, bobs);
  assert.equal((await r.close(studio, { session: second.sid })).status, 204);
  assert.deepEqual(await r.mail(bobs), [said(second.sid, "bye", {})]);

  // A bye through /code/signal ends it as well, carrying what it says.
  const third = await r.start(studio, bobs);
  const bye = await r.signal(studio, { session: third.sid, type: "bye", data: { reason: "declined" } });
  assert.equal(bye.status, 202);
  assert.deepEqual(await r.mail(bobs), [said(third.sid, "bye", { reason: "declined" })]);
  const answered = await r.signal(bobs, { session: third.sid, type: "proof", data: {} });
  assert.deepEqual([answered.status, answered.body], [404, { error: "code_gone" }]);

  // To anyone but its two sides, a session is not there.
  const fourth = await r.start(studio, bobs);
  for (const res of [
    await r.close(danas, { session: fourth.sid }),
    await r.signal(danas, { session: fourth.sid, type: "bye" }),
    await r.close(devices.laptop, { session: fourth.sid }),
  ]) {
    assert.deepEqual([res.status, res.body], [404, { error: "code_gone" }]);
  }
  assert.equal((await r.signal(bobs, { session: fourth.sid, type: "pake" })).status, 202, "and it goes on");
});

test("only the creator can withdraw a code, and a withdrawn code cannot be claimed", async () => {
  const r = relay();
  const { studio, laptop, bobs } = devices;
  const { nameplate } = (await r.open(studio)).body;

  // Not a stranger, nor the creator's own account's other desktop.
  for (const device of [bobs, laptop]) {
    const res = await r.close(device, { nameplate });
    assert.deepEqual([res.status, res.body], [404, { error: "code_unknown" }]);
  }
  const withdrawn = await r.close(studio, { nameplate: Number(nameplate), session: null });
  assert.equal(withdrawn.status, 204, "a null session counts as not given");
  assert.deepEqual((await r.claim(bobs, nameplate)).body, { error: "code_unknown" });
  assert.deepEqual((await r.close(studio, { nameplate })).body, { error: "code_unknown" }, "already withdrawn");

  // Once claimed it is too late to withdraw the code, and the 404 says so;
  // the session is closed by its id instead.
  const claimed = await r.start(studio, bobs);
  assert.deepEqual((await r.close(studio, { nameplate: claimed.nameplate })).body, { error: "code_unknown" });
  assert.equal((await r.close(studio, { session: claimed.sid })).status, 204);

  // A close names one thing, and names it properly.
  const bad = async (body, error) => {
    const res = await r.close(studio, body);
    assert.deepEqual([res.status, res.body], [400, { error }], JSON.stringify(body));
  };
  await bad({}, "bad_request");
  await bad({ nameplate: null, session: null }, "bad_request");
  await bad({ nameplate: "1", session: claimed.sid }, "bad_request");
  await bad({ session: "short" }, "bad_session");
  await bad({ nameplate: "one" }, "bad_nameplate");
});

// ------------------------------------------------------------------ expiry

test("a session lasts an hour from its claim; then it is gone for both sides", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  const { sid } = await r.start(studio, bobs);

  advance(59 * 60_000);
  assert.equal((await r.signal(bobs, { session: sid, type: "pake" })).status, 202);
  advance(60_000);
  for (const res of [
    await r.signal(bobs, { session: sid, type: "pake" }),
    await r.signal(studio, { session: sid, type: "dial" }),
    await r.close(studio, { session: sid }),
  ]) {
    assert.deepEqual([res.status, res.body], [404, { error: "code_gone" }]);
  }
  assert.deepEqual(r.codes.stats(), { nameplates: 0, sessions: 0 });
});

test("the code store sweeps what has run out, and its timer never holds the process open", async () => {
  let t = 1_000_000;
  const delivered = [];
  const codes = createCodeStore({
    now: () => t,
    deliver: (userId, address, message) => delivered.push([userId, address, message.type]),
  });
  stoppable.push(codes);
  const creator = { userId: "u1", address: "desktop:a", kind: "desktop" };
  const claimer = { userId: "u2", address: "desktop:b", kind: "desktop" };

  assert.equal(codes.open(creator, { minutes: 1 }).nameplate, "1");
  assert.equal(codes.open(creator, { minutes: 60 }).nameplate, "2");
  assert.equal(codes.claim(claimer, 2).ok, true);
  assert.deepEqual(delivered, [["u1", "desktop:a", "code-claimed"]], "into the creator's own account");
  assert.deepEqual(codes.stats(), { nameplates: 1, sessions: 1 });

  t += 60_000;
  codes.sweep();
  assert.deepEqual(codes.stats(), { nameplates: 0, sessions: 1 }, "the one-minute code has run out");
  t += 58 * 60_000;
  codes.sweep();
  assert.deepEqual(codes.stats(), { nameplates: 0, sessions: 1 });
  t += 60_000;
  codes.sweep();
  assert.deepEqual(codes.stats(), { nameplates: 0, sessions: 0 }, "and the session, an hour after its claim");

  const source = await src("../src/modules/forgedrop-link/codes.js");
  assert.match(source, /sweeper\.unref\?\.\(\)/);
});

// ----------------------------------------------------------- limits, auth

test("claims are limited to 5 a minute per account: the 6th is refused", async () => {
  const r = relay({ rate: {} }); // the documented limits
  const { studio, laptop, bobs } = devices;

  for (let i = 1; i <= 5; i += 1) {
    const res = await r.claim(studio, String(100 + i));
    assert.deepEqual([res.status, res.body], [404, { error: "code_unknown" }], `claim ${i}`);
  }
  const sixth = await r.claim(studio, "106");
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error, "rate_limited");
  assert.match(sixth.headers.get("retry-after"), /^[1-9]\d*$/);
  assert.equal(sixth.headers.get("access-control-expose-headers"), "Retry-After");

  // Per account: its other desktop has no allowance of its own, and a
  // refused claim spends nothing. Another account has its own allowance.
  const { nameplate } = (await r.open(studio)).body;
  assert.equal((await r.claim(laptop, nameplate)).status, 429);
  assert.equal((await r.claim(bobs, nameplate)).status, 200, "the code was still open");
});

test("opens are limited to 20 a minute per desktop, and code signals to 120 per account", async () => {
  const r = relay({ rate: {} }); // the documented limits
  const { studio, laptop, bobs } = devices;

  for (let i = 1; i <= 20; i += 1) {
    const opened = await r.open(studio);
    assert.equal(opened.status, 200, `open ${i}`);
    assert.equal((await r.close(studio, { nameplate: opened.body.nameplate })).status, 204);
  }
  const limited = await r.open(studio);
  assert.deepEqual([limited.status, limited.body.error], [429, "rate_limited"]);
  assert.equal((await r.open(laptop)).status, 200, "per desktop");

  const nowhere = "A".repeat(22);
  for (let i = 1; i <= 120; i += 1) {
    const res = await r.signal(i % 2 ? studio : laptop, { session: nowhere, type: "pake" });
    assert.deepEqual([res.status, res.body], [404, { error: "code_gone" }], `signal ${i}`);
  }
  assert.equal((await r.signal(laptop, { session: nowhere, type: "pake" })).status, 429);
  assert.equal((await r.signal(bobs, { session: nowhere, type: "pake" })).status, 404, "another account has its own");
});

test("a phone cannot use any /code route", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  const { nameplate } = (await r.open(studio)).body;

  const routes = [
    ["/code/open", {}],
    ["/code/claim", { nameplate }],
    ["/code/signal", { session: "A".repeat(22), type: "pake", data: {} }],
    ["/code/close", { nameplate }],
  ];
  for (const [path, body] of routes) {
    // A phone signs in with its owner's customer token: not a licence.
    const phone = await r.call(path, { bearer: people.alice.bearer, body });
    assert.deepEqual([phone.status, phone.body], [401, { error: "licence_invalid" }], path);
    const nobody = await r.call(path, { body });
    assert.deepEqual([nobody.status, nobody.body], [401, { error: "licence_invalid" }], path);
  }
  assert.equal((await r.claim(bobs, nameplate)).status, 200, "the code was left open");
});

test("the code relay asks the database nothing once a licence is cached", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  await r.poll(studio);
  await r.poll(bobs);

  const counting = countQueries();
  const { sid } = await r.start(studio, bobs);
  assert.equal((await r.signal(bobs, { session: sid, type: "pake", data: {} })).status, 202);
  assert.equal((await r.close(studio, { session: sid })).status, 204);
  const { nameplate } = (await r.open(studio)).body;
  assert.equal((await r.close(studio, { nameplate })).status, 204);
  assert.deepEqual(counting.stop(), []);
});

test("nameplates, minutes and session ids are read generously but safely, to the documented limits", () => {
  assert.equal(parseNameplate("7"), 7);
  assert.equal(parseNameplate(" 12 "), 12);
  assert.equal(parseNameplate("007"), 7);
  assert.equal(parseNameplate(7), 7);
  assert.equal(parseNameplate("999999999"), 999999999);
  for (const bad of ["0", 0, "-1", -1, "1.5", 1.5, "", " ", "x", "1e3", "1234567890", 2 ** 53, null, undefined, [7], {}]) {
    assert.equal(parseNameplate(bad), null, JSON.stringify(bad));
  }

  assert.equal(parseMinutes(undefined), 60);
  assert.equal(parseMinutes(null), 60);
  assert.equal(parseMinutes(30), 30);
  assert.equal(parseMinutes(0.5), 1);
  assert.equal(parseMinutes(1e9), 1440);
  assert.equal(parseMinutes("30"), null);
  assert.equal(parseMinutes(Number.NaN), null);
  assert.equal(parseMinutes(Number.POSITIVE_INFINITY), null);

  assert.equal(isCodeSession(crypto.randomBytes(16).toString("base64url")), true);
  assert.equal(isCodeSession("A".repeat(21)), false);
  assert.equal(isCodeSession("A".repeat(23)), false);
  assert.equal(isCodeSession(`${"A".repeat(21)}=`), false);

  assert.equal(CODE_LIMITS.defaultMinutes, 60);
  assert.equal(CODE_LIMITS.maxMinutes, 1440);
  assert.equal(CODE_LIMITS.nameplatesPerDesktop, 4);
  assert.equal(CODE_LIMITS.sessionMs, 60 * 60_000);
  assert.equal(CODE_LIMITS.sessionMessages, 64);
  assert.deepEqual(CODE_LIMITS.rate, { codeOpenPerMinute: 20, codeClaimPerMinute: 5, codeSignalPerMinute: 120 });
});

test("nothing went wrong unnoticed", () => {
  assert.deepEqual(logged.filter((entry) => entry.level === "error"), []);
});
