// ForgeDrop people: the relay that introduces two desktops by the email of a
// SendForge account, for sending to someone by their address
// (ForgeDrop/docs/people.md, "Backend: the person relay").
//
// As in forgedrop-codes.test.js, the HTTP tests run the real router, real
// licence tokens minted by the activation service, and real users and
// device_activations rows against an in-process Postgres (PGlite). Every test
// gets a relay of its own (fresh stores, its own path, its own rate-limit
// names). The stores' clock is a dial the tests turn; long-polls and the rate
// limiter use real time. A file of its own, because rate limiters are per
// process.

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
process.env.JWT_SECRET ||= "forgedrop-people-test-secret-at-least-32-bytes";

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
const { forgedropFingerprint } = await import("../src/services/identityProof.service.js");
const { createForgeDropLinkRouter, PERSON_LIMITS } = await import("../src/modules/forgedrop-link/router.js");
const { createLinkStore } = await import("../src/modules/forgedrop-link/store.js");
const { createCodeStore } = await import("../src/modules/forgedrop-link/codes.js");
const { createPeopleStore } = await import("../src/modules/forgedrop-link/people.js");
const { isProven } = await import("../src/modules/forgedrop-link/devices.js");
const {
  answersPhones,
  isPersonSession,
  KNOCK_PURPOSES,
  parseCaps,
  parseEmail,
  PERSON_TYPES,
  takesDials,
  takesPeople,
} = await import("../src/modules/forgedrop-link/shapes.js");
const { forgedropLinkRouter } = await import("../src/modules/forgedrop-link/index.js");

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
const accounts = {};
const devices = {};
let detach;
let server;
let origin;

const app = express();
// app.js runs the app-wide form parser ahead of every router; so does this.
app.use(express.urlencoded({ extended: false }));

async function signUp(name, { email = `${name}@example.com`, verified = true, owns = true } = {}) {
  const id = randomUUID();
  await db("users").insert({ id, email, email_verified: verified });
  if (owns) await grantProductEntitlement({ userId: id, productSlug: "forgedrop", source: "test" });
  accounts[name] = {
    id,
    email,
    // The address sendforge.app vouches for: the email trimmed, in lower case.
    address: email.trim().toLowerCase(),
    bearer: issueCustomerAccessToken({ id, email }),
  };
  return accounts[name];
}

/**
 * An activated desktop with an identity key of its own. `proven` records the
 * key as one the desktop proved it holds, as activation does after a proof
 * (identityProof.service.js); otherwise only its fingerprint is on file.
 */
async function activate(key, owner, name, { proven = true } = {}) {
  const raw = crypto.randomBytes(32);
  const identity = raw.toString("hex");
  const fingerprint = forgedropFingerprint(raw);
  const result = await activateDevice({
    userId: owner.id,
    productSlug: "forgedrop",
    deviceId: randomUUID(),
    deviceName: name,
    platform: "windows",
    appVersion: "1.7.0",
    identityFingerprint: fingerprint,
    identityPublicKey: proven ? identity : null,
    deviceLimit: 20,
  });
  devices[key] = {
    deviceId: result.deviceId,
    token: result.token,
    owner,
    name,
    identity,
    fingerprint,
    address: `desktop:${result.deviceId}`,
  };
  return devices[key];
}

before(async () => {
  detach = await attachPglite(db);
  // requireAuth reads auth_version; the shared helper's users table predates it.
  await db.schema.alterTable("users", (t) => t.integer("auth_version").defaultTo(0));

  // Alice and Bob own ForgeDrop, have verified emails, and their desktops have
  // proved their keys (all but Alice's attic PC). Everyone else lacks one thing.
  const alice = await signUp("alice");
  const bob = await signUp("bob");
  const dana = await signUp("dana");
  const erin = await signUp("erin", { verified: false });
  const fran = await signUp("fran");
  // An account from before emails were stored in lower case.
  const legacy = await signUp("legacy", { email: "Legacy.User@Example.com" });

  await activate("studio", alice, "Studio PC");
  await activate("laptop", alice, "Alice's laptop");
  await activate("attic", alice, "Attic PC", { proven: false });
  await activate("bobs", bob, "Bob's desktop");
  await activate("bobsLaptop", bob, "Bob's laptop");
  await activate("danas", dana, "Dana PC", { proven: false });
  await activate("erins", erin, "Erin PC");
  await activate("frans", fran, "Fran PC");
  await activate("legacys", legacy, "Legacy PC");

  // The module as app.js mounts it, with its own stores and the real limits.
  app.use("/real", forgedropLinkRouter);
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
  knockPerMinute: 1e6,
  personSignalPerMinute: 1e6,
};

let relays = 0;

/** A relay of its own: a fresh router and stores, at a path of its own. */
function relay({ rate = UNLIMITED } = {}) {
  relays += 1;
  const base = `/relay-${relays}`;
  const store = createLinkStore({ now });
  const deliver = (userId, address, message) => store.deliver(userId, address, message);
  const codes = createCodeStore({ now, deliver });
  const people = createPeopleStore({ now, deliver });
  stoppable.push(store, codes, people);
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
      people,
      rate,
      rateLimitPrefix: `fd-people-${relays}`,
    })
  );

  const at = (path, options = {}) => call(path, { base, ...options });
  const poll = (device, body = {}, options = {}) =>
    at("/desktop/poll", { licence: device.token, body: { wait: 0, ...body }, ...options });
  const knock = (device, body) => at("/person/knock", { licence: device.token, body });

  /** What is waiting for a desktop, each without the time it was sent. */
  async function mail(device) {
    const res = await poll(device);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.messages.map(({ sentAt, ...message }) => {
      assert.equal(new Date(sentAt).toISOString(), sentAt, "sentAt is ISO-8601");
      return message;
    });
  }

  return {
    store,
    people,
    call: at,
    poll,
    knock,
    mail,
    me: (device) => at("/person/me", { method: "GET", licence: device.token }),
    signal: (device, body) => at("/person/signal", { licence: device.token, body }),
    close: (device, body) => at("/person/close", { licence: device.token, body }),

    /**
     * `recipient` polls taking people and `sender` knocks on its owner's
     * address to send: the knock id, and the session `recipient` was given.
     */
    async start(sender, recipient) {
      await poll(recipient, { caps: ["people"] });
      const knocked = await knock(sender, { to: recipient.owner.address, purpose: "send" });
      assert.equal(knocked.status, 202, JSON.stringify(knocked.body));
      const [message, ...more] = await mail(recipient);
      assert.equal(message?.type, "knock", JSON.stringify(message));
      assert.deepEqual(more, []);
      return { knock: knocked.body.knock, sid: message.session };
    },
  };
}

/** What sendforge.app vouches for about a desktop: its account's address, its name and its proven key. */
const cardOf = (device, name = device.name) => ({
  email: device.owner.address,
  name,
  identity: device.identity,
  fingerprint: device.fingerprint,
});

const said = (sid, type, data) => ({ from: `person:${sid}`, session: sid, type, data });

// ---------------------------------------------------------------- the address

test("a desktop asks for its own address: its account's email, trimmed and in lower case, and whether it is verified", async () => {
  const r = relay();
  const { studio, attic, erins, legacys } = devices;

  const me = await r.me(studio);
  assert.deepEqual([me.status, me.body], [200, { email: "alice@example.com", verified: true }]);
  assert.equal(me.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    (await r.me(attic)).body,
    { email: "alice@example.com", verified: true },
    "whether its own key is proven has nothing to do with it"
  );
  assert.deepEqual((await r.me(legacys)).body, { email: "legacy.user@example.com", verified: true });
  assert.deepEqual((await r.me(erins)).body, { email: "erin@example.com", verified: false });

  // Desktops only: a phone signs in with its owner's customer token, not a licence.
  for (const path of ["/person/me", "/person/knock", "/person/signal", "/person/close"]) {
    const method = path === "/person/me" ? "GET" : "POST";
    const body =
      method === "POST" ? { to: "bob@example.com", purpose: "send", session: "A".repeat(22), type: "dial" } : undefined;
    const phone = await r.call(path, { method, bearer: accounts.alice.bearer, body });
    assert.deepEqual([phone.status, phone.body], [401, { error: "licence_invalid" }], path);
    const nobody = await r.call(path, { method, body });
    assert.deepEqual([nobody.status, nobody.body], [401, { error: "licence_invalid" }], path);
  }
});

// ------------------------------------------------------------------ knocking

test("a knock lands on each of the address's desktops that take people, vouching for the sender from the database", async () => {
  const r = relay();
  const bob = accounts.bob;
  const { studio, bobs, bobsLaptop } = devices;
  await r.poll(studio, { name: "Studio PC (live)", caps: ["people"] });
  await r.poll(bobsLaptop, { caps: ["people"] });
  const waiting = r.poll(bobs, { wait: 20, caps: ["phone-link", "internet", "people"] });
  await until(() => r.store.waiting(bob.id, bobs.address), "Bob's desktop to poll");

  const started = Date.now();
  const knocked = await r.knock(studio, {
    to: "  Bob@Example.COM ",
    purpose: "send",
    // What an app says about itself is never what the other side is told.
    email: "mallory@example.com",
    name: "Not Alice",
    identity: "00".repeat(32),
    fingerprint: "0000-0000-0000-0000",
    data: { email: "mallory@example.com" },
  });
  assert.equal(knocked.status, 202, JSON.stringify(knocked.body));
  assert.deepEqual(Object.keys(knocked.body), ["knock"]);
  assert.ok(isPersonSession(knocked.body.knock), `a 22-character base64url knock id, not ${knocked.body.knock}`);

  const card = { purpose: "send", ...cardOf(studio, "Studio PC (live)") };
  assert.match(card.identity, /^[0-9a-f]{64}$/);

  const woken = await waiting;
  assert.ok(Date.now() - started < 2000, "woken by the knock, not by the 20 s wait");
  assert.equal(woken.body.messages.length, 1);
  const { sentAt, ...atDesk } = woken.body.messages[0];
  assert.equal(sentAt, new Date(clock).toISOString());
  assert.ok(isPersonSession(atDesk.session), atDesk.session);
  assert.deepEqual(atDesk, said(atDesk.session, "knock", card));

  const atLaptop = await r.mail(bobsLaptop);
  assert.deepEqual(atLaptop, [said(atLaptop[0]?.session, "knock", card)]);
  assert.notEqual(atLaptop[0].session, atDesk.session, "a session each");
  assert.notEqual(atDesk.session, knocked.body.knock, "the knock id is not a session");
  assert.deepEqual(r.people.stats(), { sessions: 2 });

  // Into Bob's own mailboxes, and nowhere else.
  assert.deepEqual(await r.mail(studio), []);
  assert.equal(r.store.stats().messages, 0);
});

test("the sender's name is its poll's, else its device row's; an address is found whatever its case", async () => {
  const r = relay();
  const { laptop, bobs, legacys } = devices;
  await r.poll(bobs, { caps: ["people"] });
  await r.poll(legacys, { caps: ["people"] });

  // Alice's laptop is not polling: its name comes from its device row.
  assert.equal((await r.knock(laptop, { to: "bob@example.com", purpose: "hello" })).status, 202);
  assert.deepEqual((await r.mail(bobs)).map((m) => m.data), [{ purpose: "hello", ...cardOf(laptop) }]);

  // An account stored before emails were lower case is found by its address
  // in any case, and vouched for in lower case.
  assert.equal((await r.knock(bobs, { to: "LEGACY.User@example.com", purpose: "hello" })).status, 202);
  assert.deepEqual((await r.mail(legacys)).map((m) => m.data), [{ purpose: "hello", ...cardOf(bobs) }]);
  assert.equal((await r.knock(legacys, { to: "bob@example.com", purpose: "hello" })).status, 202);
  const fromLegacy = (await r.mail(bobs)).map((m) => m.data);
  assert.deepEqual(fromLegacy, [{ purpose: "hello", ...cardOf(legacys) }]);
  assert.equal(fromLegacy[0].email, "legacy.user@example.com");
});

test("were two accounts ever to hold one address in different cases, the one stored exactly as it is knocked on, else neither", async () => {
  const r = relay();
  const { studio } = devices;
  const exact = await activate("twinExact", await signUp("twin"), "Twin PC");
  const cased = await activate("twinCased", await signUp("Twin", { email: "Twin@Example.com" }), "Other Twin PC");
  const pairA = await activate("pairA", await signUp("pairA", { email: "Pair@Example.com" }), "Pair A PC");
  const pairB = await activate("pairB", await signUp("pairB", { email: "PAIR@example.com" }), "Pair B PC");
  for (const device of [exact, cased, pairA, pairB]) await r.poll(device, { caps: ["people"] });

  assert.equal((await r.knock(studio, { to: "Twin@example.com", purpose: "hello" })).status, 202);
  assert.equal((await r.mail(exact)).length, 1);
  assert.deepEqual(await r.mail(cased), []);

  assert.equal((await r.knock(studio, { to: "pair@example.com", purpose: "hello" })).status, 202);
  assert.deepEqual(await r.mail(pairA), []);
  assert.deepEqual(await r.mail(pairB), []);
});

test("a knock answers the same whether the address has nobody, or nobody who can be knocked on", async () => {
  const r = relay();
  const { studio, bobs, bobsLaptop, danas, erins, frans } = devices;
  // Casey owned ForgeDrop when her desktop signed in (its licence is taken on
  // trust for a minute), and has since stopped owning it.
  const casey = await signUp("casey");
  const caseys = await activate("caseys", casey, "Casey PC");
  await r.poll(caseys, { caps: ["people"] });
  await db("product_entitlements").where({ user_id: casey.id }).update({ status: "revoked" });

  await r.poll(studio, { caps: ["people"] });
  await r.poll(danas, { caps: ["people"] }); // has never proved its key
  await r.poll(erins, { caps: ["people"] }); // its account's email is not verified
  await r.poll(frans, { caps: ["phone-link", "internet"] }); // does not take people
  await r.poll(bobs); // an app from before people; Bob's laptop is not polling at all

  const nobody = [
    "nobody@example.com",
    "casey@example.com",
    "dana@example.com",
    "erin@example.com",
    "fran@example.com",
    "bob@example.com",
  ];
  const asked = [];
  for (const to of nobody) {
    const counting = countQueries();
    const res = await r.knock(studio, { to, purpose: "send" });
    asked.push(counting.stop().length);
    assert.equal(res.status, 202, `${to}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(Object.keys(res.body), ["knock"], to);
    assert.ok(isPersonSession(res.body.knock), to);
  }
  for (const device of [caseys, danas, erins, frans, bobs, bobsLaptop]) {
    assert.deepEqual(await r.mail(device), [], device.name);
  }
  assert.deepEqual(r.people.stats(), { sessions: 0 });

  // Someone found is looked for with the very same questions to the
  // database, so how long a knock takes says nothing either.
  await r.poll(bobs, { caps: ["people"] });
  const counting = countQueries();
  assert.equal((await r.knock(studio, { to: "bob@example.com", purpose: "send" })).status, 202);
  asked.push(counting.stop().length);
  assert.equal((await r.mail(bobs)).length, 1);
  assert.equal(new Set(asked).size, 1, `questions per knock: ${asked}`);
});

test("the sender needs a verified email and a proven key, and a malformed knock is refused first", async () => {
  const r = relay();
  const { erins, attic, bobs } = devices;
  await r.poll(bobs, { caps: ["people"] });

  for (const purpose of ["send", "hello"]) {
    const unverified = await r.knock(erins, { to: "bob@example.com", purpose });
    assert.deepEqual([unverified.status, unverified.body], [409, { error: "email_unverified" }], purpose);
    const unproven = await r.knock(attic, { to: "bob@example.com", purpose });
    assert.deepEqual([unproven.status, unproven.body], [409, { error: "identity_unproven" }], purpose);
  }
  assert.deepEqual(await r.mail(bobs), [], "and nobody was knocked on");

  const badEmails = [
    undefined,
    null,
    "",
    "bob",
    "bob@",
    "@example.com",
    "bob@example",
    "bob@@example.com",
    "bo b@example.com",
    42,
    ["bob@example.com"],
    { email: "bob@example.com" },
    `${"b".repeat(243)}@example.com`, // 255 characters
  ];
  for (const to of badEmails) {
    const res = await r.knock(bobs, { to, purpose: "send" });
    assert.deepEqual([res.status, res.body], [400, { error: "bad_email" }], JSON.stringify(to));
  }
  for (const purpose of [undefined, null, "", "SEND", " send", "here", 1, ["send"], { send: true }]) {
    const res = await r.knock(bobs, { to: "alice@example.com", purpose });
    assert.deepEqual([res.status, res.body], [400, { error: "bad_purpose" }], JSON.stringify(purpose));
  }
  // What is wrong with the knock is said before what is wrong with the sender.
  const both = await r.knock(erins, { to: "bob", purpose: "send" });
  assert.deepEqual([both.status, both.body], [400, { error: "bad_email" }]);
  const empty = await r.call("/person/knock", { licence: erins.token });
  assert.deepEqual([empty.status, empty.body], [400, { error: "bad_email" }], "no body at all");
});

test("the desktop knocking is never knocked on; its account's other desktops are, when it knocks on its own address", async () => {
  const r = relay();
  const { studio, laptop, attic } = devices;
  await r.poll(studio, { caps: ["people"] });
  await r.poll(laptop, { caps: ["people"] });
  await r.poll(attic, { caps: ["people"] }); // has never proved its key

  const knocked = await r.knock(studio, { to: "alice@example.com", purpose: "send" });
  assert.equal(knocked.status, 202);
  const mail = await r.mail(laptop);
  assert.deepEqual(mail, [said(mail[0]?.session, "knock", { purpose: "send", ...cardOf(studio) })]);
  assert.deepEqual(await r.mail(studio), []);
  assert.deepEqual(await r.mail(attic), []);
  assert.deepEqual(r.people.stats(), { sessions: 1 });

  // From there it goes as with anyone else.
  const sid = mail[0].session;
  assert.equal((await r.signal(laptop, { session: sid, type: "here" })).status, 202);
  assert.deepEqual(await r.mail(studio), [said(sid, "here", { knock: knocked.body.knock, ...cardOf(laptop) })]);

  // With no other desktop of its own taking people, nobody is knocked on.
  assert.equal((await r.call("/desktop/offline", { licence: laptop.token })).status, 204);
  assert.equal((await r.knock(studio, { to: "alice@example.com", purpose: "send" })).status, 202);
  assert.deepEqual(r.people.stats(), { sessions: 1 });
});

test("a hello knock tells the desktops who said hello, and keeps no session to talk on", async () => {
  const r = relay();
  const { studio, bobs, bobsLaptop } = devices;
  await r.poll(bobs, { caps: ["people"] });
  await r.poll(bobsLaptop, { caps: ["people"] });

  const knocked = await r.knock(studio, { to: "bob@example.com", purpose: "hello" });
  assert.equal(knocked.status, 202, JSON.stringify(knocked.body));
  assert.deepEqual(Object.keys(knocked.body), ["knock"]);
  assert.ok(isPersonSession(knocked.body.knock));

  const card = { purpose: "hello", ...cardOf(studio) };
  const atDesk = await r.mail(bobs);
  const atLaptop = await r.mail(bobsLaptop);
  assert.deepEqual(atDesk, [said(atDesk[0]?.session, "knock", card)]);
  assert.deepEqual(atLaptop, [said(atLaptop[0]?.session, "knock", card)]);
  assert.ok(isPersonSession(atDesk[0].session));
  assert.notEqual(atDesk[0].session, atLaptop[0].session);
  assert.deepEqual(r.people.stats(), { sessions: 0 });

  for (const type of ["here", "dial", "bye"]) {
    const res = await r.signal(bobs, { session: atDesk[0].session, type });
    assert.deepEqual([res.status, res.body], [404, { error: "person_gone" }], type);
  }
  const closed = await r.close(bobs, { session: atDesk[0].session });
  assert.deepEqual([closed.status, closed.body], [404, { error: "person_gone" }]);
  assert.deepEqual(await r.mail(studio), [], "nothing is answered");
});

// ------------------------------------------------------------------- the session

test("here reaches the sender as sendforge.app vouches for the desktop, with the knock id; whatever the app said is dropped", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  await r.poll(bobs, { name: "Bob's desktop (live)", caps: ["people"] });
  const { knock, sid } = await r.start(studio, bobs);

  const here = await r.signal(bobs, {
    session: sid,
    type: "here",
    data: {
      knock: "A".repeat(22),
      email: "mallory@example.com",
      name: "Mallory",
      identity: "11".repeat(32),
      fingerprint: "1111-1111-1111-1111",
      extra: true,
    },
  });
  assert.deepEqual([here.status, here.body], [202, { ok: true }]);
  const heard = await r.mail(studio);
  assert.deepEqual(heard, [said(sid, "here", { knock, ...cardOf(bobs, "Bob's desktop (live)") })]);
  assert.deepEqual(Object.keys(heard[0].data), ["knock", "email", "name", "identity", "fingerprint"]);
  assert.deepEqual(await r.mail(bobs), [], "nothing came back to Bob");
});

test("the sender cannot say here; dial, dial-answer and bye are relayed as sent, either way", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  const { sid } = await r.start(studio, bobs);

  const wrongWay = await r.signal(studio, { session: sid, type: "here", data: {} });
  assert.deepEqual([wrongWay.status, wrongWay.body], [400, { error: "bad_type" }]);
  assert.deepEqual(await r.mail(bobs), []);

  const dial = {
    candidates: { tcp: ["[2001:db8::7]:47021"], udp: ["203.0.113.7:61000"] },
    token: "AAAA",
    mac: "5a".repeat(32),
  };
  assert.equal((await r.signal(studio, { session: sid, type: "dial", data: dial })).status, 202);
  assert.deepEqual(await r.mail(bobs), [said(sid, "dial", dial)]);
  const answer = { candidates: { udp: ["198.51.100.4:62000"] }, mac: "a5".repeat(32) };
  assert.equal((await r.signal(bobs, { session: sid, type: "dial-answer", data: answer })).status, 202);
  assert.deepEqual(await r.mail(studio), [said(sid, "dial-answer", answer)]);

  // Either side may dial, and data defaults to {}.
  assert.equal((await r.signal(bobs, { session: sid, type: "dial" })).status, 202);
  assert.equal((await r.signal(studio, { session: sid, type: "dial-answer" })).status, 202);
  assert.deepEqual(await r.mail(studio), [said(sid, "dial", {})]);
  assert.deepEqual(await r.mail(bobs), [said(sid, "dial-answer", {})]);
});

test("to anyone but its two desktops a session is not there", async () => {
  const r = relay();
  const { studio, laptop, bobs, bobsLaptop, danas } = devices;
  await r.poll(bobsLaptop, { caps: ["people"] });
  await r.poll(danas);
  const { sid } = await r.start(studio, bobs);
  // Bob's laptop was knocked on too, with a session of its own.
  const [sibling] = await r.mail(bobsLaptop);
  assert.notEqual(sibling.session, sid);

  // Not a stranger, not the sender's other desktop, not the recipient's other desktop.
  for (const device of [danas, laptop, bobsLaptop]) {
    for (const type of ["here", "dial", "dial-answer", "bye"]) {
      const res = await r.signal(device, { session: sid, type });
      assert.deepEqual([res.status, res.body], [404, { error: "person_gone" }], `${device.name} ${type}`);
    }
    const closed = await r.close(device, { session: sid });
    assert.deepEqual([closed.status, closed.body], [404, { error: "person_gone" }], device.name);
  }
  const nowhere = await r.signal(bobs, { session: "A".repeat(22), type: "here" });
  assert.deepEqual([nowhere.status, nowhere.body], [404, { error: "person_gone" }], "a made-up session");

  // Nothing reached anyone, and the session goes on.
  for (const device of [studio, bobs, danas, laptop, bobsLaptop]) assert.deepEqual(await r.mail(device), [], device.name);
  assert.equal((await r.signal(bobs, { session: sid, type: "here" })).status, 202);
});

test("a bye or a close ends a session, and the other side hears bye", async () => {
  const r = relay();
  const { studio, bobs } = devices;

  // A bye through /person/signal, carrying what it says.
  const first = await r.start(studio, bobs);
  const bye = await r.signal(bobs, { session: first.sid, type: "bye", data: { reason: "declined" } });
  assert.deepEqual([bye.status, bye.body], [202, { ok: true }]);
  assert.deepEqual(await r.mail(studio), [said(first.sid, "bye", { reason: "declined" })]);
  for (const device of [studio, bobs]) {
    const late = await r.signal(device, { session: first.sid, type: "dial" });
    assert.deepEqual([late.status, late.body], [404, { error: "person_gone" }]);
  }

  // A close from the sender.
  const second = await r.start(studio, bobs);
  const closed = await r.close(studio, { session: second.sid });
  assert.deepEqual([closed.status, closed.text], [204, ""]);
  assert.deepEqual(await r.mail(bobs), [said(second.sid, "bye", {})]);
  const twice = await r.close(bobs, { session: second.sid });
  assert.deepEqual([twice.status, twice.body], [404, { error: "person_gone" }], "already over");
  assert.deepEqual(await r.mail(studio), [], "whoever closed hears nothing back");

  // A close from the one knocked on.
  const third = await r.start(studio, bobs);
  assert.equal((await r.close(bobs, { session: third.sid })).status, 204);
  assert.deepEqual(await r.mail(studio), [said(third.sid, "bye", {})]);
  const answered = await r.signal(bobs, { session: third.sid, type: "here" });
  assert.deepEqual([answered.status, answered.body], [404, { error: "person_gone" }]);

  // A close names a session properly.
  for (const body of [{}, { session: "short" }, { session: 7 }, { session: null }]) {
    const res = await r.close(studio, body);
    assert.deepEqual([res.status, res.body], [400, { error: "bad_session" }], JSON.stringify(body));
  }
  assert.deepEqual(r.people.stats(), { sessions: 0 });
});

test("bad sessions, types and data are refused, and data is capped at 32 KiB", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  const { sid } = await r.start(studio, bobs);

  const expect = async (res, status, error, note) => {
    const got = await res;
    assert.deepEqual([got.status, got.body], [status, { error }], note);
  };
  const send = (patch) => r.signal(studio, { session: sid, type: "dial", data: {}, ...patch });

  await expect(send({ session: undefined }), 400, "bad_session");
  await expect(send({ session: "x".repeat(21) }), 400, "bad_session");
  await expect(send({ session: "x".repeat(23) }), 400, "bad_session");
  await expect(send({ session: `${sid.slice(0, 21)}!` }), 400, "bad_session");
  await expect(send({ session: 1234 }), 400, "bad_session");
  await expect(send({ session: "A".repeat(22) }), 404, "person_gone", "well formed, but no such session");

  for (const type of ["knock", "offer", "answer", "pake", "proof", "HERE", "hello", "send", undefined, 7]) {
    await expect(send({ type }), 400, "bad_type", String(type));
  }
  for (const data of [[], "x", null, 7, true]) {
    await expect(send({ data }), 400, "bad_data", JSON.stringify(data));
  }

  // {"pad":""} is 10 bytes.
  const exactly = { pad: "x".repeat(32 * 1024 - 10) };
  assert.equal(Buffer.byteLength(JSON.stringify(exactly)), 32 * 1024);
  assert.equal((await send({ data: exactly })).status, 202, "exactly 32 KiB is allowed");
  await expect(send({ data: { pad: `${exactly.pad}x` } }), 413, "data_too_large");
  await expect(send({ data: { pad: "é".repeat(16 * 1024) } }), 413, "data_too_large", "counted in bytes");
  // A here's data is checked the same way, though it is dropped.
  await expect(r.signal(bobs, { session: sid, type: "here", data: [] }), 400, "bad_data");

  // Only the message that fitted was delivered.
  const mail = await r.mail(bobs);
  assert.deepEqual(mail.map((m) => [m.type, m.data.pad.length]), [["dial", exactly.pad.length]]);
});

test("a session carries at most 64 messages, and can still be closed", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  const { sid } = await r.start(studio, bobs);

  assert.equal((await r.signal(bobs, { session: sid, type: "here" })).status, 202);
  for (let i = 1; i < 64; i += 1) {
    const res = await r.signal(i % 2 ? studio : bobs, { session: sid, type: "dial", data: { i } });
    assert.equal(res.status, 202, `message ${i + 1}: ${JSON.stringify(res.body)}`);
  }
  for (const [device, type] of [
    [bobs, "here"],
    [studio, "bye"],
    [bobs, "dial-answer"],
  ]) {
    const over = await r.signal(device, { session: sid, type });
    assert.deepEqual([over.status, over.body], [409, { error: "too_many_messages" }], type);
    assert.equal(over.headers.get("retry-after"), null, "waiting will not help");
  }

  // It can still be closed, and the other side still hears the bye.
  await r.mail(bobs);
  assert.equal((await r.close(studio, { session: sid })).status, 204);
  assert.deepEqual(await r.mail(bobs), [said(sid, "bye", {})]);
});

test("a session lasts an hour from its knock; then it is gone for both sides", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  const { sid } = await r.start(studio, bobs);

  advance(59 * 60_000);
  assert.equal((await r.signal(studio, { session: sid, type: "dial" })).status, 202);
  advance(60_000);
  for (const res of [
    await r.signal(bobs, { session: sid, type: "here" }),
    await r.signal(studio, { session: sid, type: "dial" }),
    await r.close(bobs, { session: sid }),
  ]) {
    assert.deepEqual([res.status, res.body], [404, { error: "person_gone" }]);
  }
  assert.deepEqual(r.people.stats(), { sessions: 0 });
});

test("a desktop knocked on that can no longer be vouched for cannot say here, and its session ends unheard", async () => {
  const r = relay();
  const { studio } = devices;
  const gina = await signUp("gina");
  const desk = await activate("ginasDesk", gina, "Gina's desk");
  const laptop = await activate("ginasLaptop", gina, "Gina's laptop");
  const tablet = await activate("ginasTablet", gina, "Gina's tablet");
  for (const device of [desk, laptop, tablet]) await r.poll(device, { caps: ["people"] });

  assert.equal((await r.knock(studio, { to: "gina@example.com", purpose: "send" })).status, 202);
  const sessionOf = async (device) => {
    const [knock, ...more] = await r.mail(device);
    assert.deepEqual(more, []);
    return knock.session;
  };
  const sids = new Map([
    [desk, await sessionOf(desk)],
    [laptop, await sessionOf(laptop)],
    [tablet, await sessionOf(tablet)],
  ]);
  assert.deepEqual(r.people.stats(), { sessions: 3 });

  // Her desk's slot is freed on the account page (its licence is taken on
  // trust for a minute more), and her laptop reports a new key it has not
  // proved...
  await deactivateDevice(gina.id, "forgedrop", desk.deviceId);
  await db("device_activations")
    .where({ device_id: laptop.deviceId })
    .update({ identity_public_key: null, identity_verified_at: null });
  for (const device of [desk, laptop]) {
    const res = await r.signal(device, { session: sids.get(device), type: "here" });
    assert.deepEqual([res.status, res.body], [404, { error: "person_gone" }], device.name);
  }
  // ...and her email stops being verified before her tablet answers.
  await db("users").where({ id: gina.id }).update({ email_verified: false });
  const unverified = await r.signal(tablet, { session: sids.get(tablet), type: "here" });
  assert.deepEqual([unverified.status, unverified.body], [404, { error: "person_gone" }]);

  // Those sessions are over for both sides, and the desktop that knocked
  // never heard of any of them.
  for (const [device, sid] of sids) {
    assert.deepEqual((await r.signal(device, { session: sid, type: "dial" })).body, { error: "person_gone" });
    assert.deepEqual((await r.signal(studio, { session: sid, type: "dial" })).body, { error: "person_gone" });
  }
  assert.deepEqual(await r.mail(studio), []);
  assert.deepEqual(r.people.stats(), { sessions: 0 });
});

// ------------------------------------------------------------ caps and costs

test("a desktop polling with people alone is offline to phones and to its own computers' dials", async () => {
  const r = relay();
  const alice = accounts.alice;
  const { studio, laptop } = devices;
  await r.poll(laptop, { caps: ["internet"] });
  await r.poll(studio, { caps: ["people"] });

  const offer = () =>
    r.call("/signal", {
      bearer: alice.bearer,
      body: {
        to: studio.address,
        from: `phone:${crypto.randomBytes(16).toString("base64url")}`,
        session: crypto.randomBytes(12).toString("base64url"),
        type: "offer",
        data: { sdp: "v=0" },
      },
    });
  const dial = () =>
    r.call("/signal", {
      licence: laptop.token,
      body: { to: studio.address, session: crypto.randomBytes(12).toString("base64url"), type: "dial", data: {} },
    });
  const listedOnline = async () => {
    const phones = await r.call("/desktops", { method: "GET", bearer: alice.bearer });
    const peers = await r.call("/desktop/peers", { method: "GET", licence: laptop.token });
    assert.equal(phones.status, 200, JSON.stringify(phones.body));
    assert.equal(peers.status, 200, JSON.stringify(peers.body));
    return [
      phones.body.desktops.find((d) => d.deviceId === studio.deviceId).online,
      peers.body.desktops.find((d) => d.deviceId === studio.deviceId).online,
    ];
  };

  assert.deepEqual(await listedOnline(), [false, false]);
  const offered = await offer();
  assert.deepEqual([offered.status, offered.body], [404, { error: "desktop_offline" }]);
  const dialled = await dial();
  assert.deepEqual([dialled.status, dialled.body], [404, { error: "desktop_offline" }]);

  // Taking people as well as the others changes nothing about them.
  await r.poll(studio, { caps: ["people", "phone-link", "internet"] });
  assert.deepEqual(await listedOnline(), [true, true]);
  assert.equal((await offer()).status, 202);
  assert.equal((await dial()).status, 202);
});

test("relaying a dial or a bye and closing ask the database nothing; a here from anyone else is refused before any lookup", async () => {
  const r = relay();
  const { studio, bobs, danas } = devices;
  await r.poll(danas);
  const first = await r.start(studio, bobs);
  const second = await r.start(studio, bobs);

  const counting = countQueries();
  assert.equal((await r.signal(studio, { session: first.sid, type: "dial", data: {} })).status, 202);
  assert.equal((await r.signal(bobs, { session: first.sid, type: "dial-answer", data: {} })).status, 202);
  assert.equal((await r.signal(danas, { session: first.sid, type: "here" })).status, 404);
  assert.equal((await r.signal(studio, { session: first.sid, type: "here" })).status, 400);
  assert.equal((await r.signal(bobs, { session: first.sid, type: "bye" })).status, 202);
  assert.equal((await r.close(studio, { session: second.sid })).status, 204);
  assert.deepEqual(counting.stop(), []);
});

test("knocks are limited to 10 a minute per account, person signals to 120, and asking for one's address to 30", async () => {
  const r = relay({ rate: {} }); // the documented limits
  const { studio, laptop, bobs } = devices;

  for (let i = 1; i <= 10; i += 1) {
    const res = await r.knock(i % 2 ? studio : laptop, { to: "nobody@example.com", purpose: "send" });
    assert.equal(res.status, 202, `knock ${i}: ${JSON.stringify(res.body)}`);
  }
  const limited = await r.knock(studio, { to: "nobody@example.com", purpose: "hello" });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.match(limited.headers.get("retry-after"), /^[1-9]\d*$/);
  assert.equal(limited.headers.get("access-control-expose-headers"), "Retry-After");
  // Per account: its other desktop has no allowance of its own; another account has.
  assert.equal((await r.knock(laptop, { to: "nobody@example.com", purpose: "send" })).status, 429);
  assert.equal((await r.knock(bobs, { to: "nobody@example.com", purpose: "send" })).status, 202);

  const nowhere = "A".repeat(22);
  for (let i = 1; i <= 120; i += 1) {
    const res = await r.signal(i % 2 ? studio : laptop, { session: nowhere, type: "dial" });
    assert.deepEqual([res.status, res.body], [404, { error: "person_gone" }], `signal ${i}`);
  }
  assert.equal((await r.signal(laptop, { session: nowhere, type: "dial" })).status, 429);
  assert.equal((await r.signal(bobs, { session: nowhere, type: "dial" })).status, 404, "another account has its own");
  // Counted apart from a code session's signals.
  const code = await r.call("/code/signal", { licence: studio.token, body: { session: nowhere, type: "pake" } });
  assert.deepEqual([code.status, code.body], [404, { error: "code_gone" }]);

  for (let i = 1; i <= 30; i += 1) assert.equal((await r.me(i % 2 ? studio : laptop)).status, 200, `me ${i}`);
  assert.equal((await r.me(studio)).status, 429);
  assert.equal((await r.me(bobs)).status, 200, "another account has its own");
});

// ------------------------------------------------------------ the pieces

test("addresses and session ids are read generously but safely, and only known caps count", () => {
  for (const [given, address] of [
    ["michael@example.com", "michael@example.com"],
    ["  Michael@Example.COM \n", "michael@example.com"],
    ["a.b+tag@sub.example.co.uk", "a.b+tag@sub.example.co.uk"],
    ["o'brien@example.ie", "o'brien@example.ie"],
    ["x@example.xn--p1ai", "x@example.xn--p1ai"],
  ]) {
    assert.equal(parseEmail(given), address, JSON.stringify(given));
  }
  const bad = [
    "",
    " ",
    "michael",
    "@example.com",
    "michael@",
    "michael@example",
    "michael@@example.com",
    "mi chael@example.com",
    ".michael@example.com",
    "michael.@example.com",
    "mi..chael@example.com",
    "michael@example..com",
    "michael@-example.com",
    "michael@example.c",
    "michael@example.123",
    "mich\u0000ael@example.com",
    "mïchael@example.com",
    42,
    null,
    undefined,
    ["michael@example.com"],
    {},
  ];
  for (const value of bad) assert.equal(parseEmail(value), null, JSON.stringify(value));
  const longest = `${"b".repeat(254 - "@example.com".length)}@example.com`;
  assert.equal(parseEmail(longest), longest, "254 characters");
  assert.equal(parseEmail(`b${longest}`), null, "255 are too many");

  assert.equal(isPersonSession(crypto.randomBytes(16).toString("base64url")), true);
  assert.equal(isPersonSession("A".repeat(21)), false);
  assert.equal(isPersonSession("A".repeat(23)), false);
  assert.equal(isPersonSession(`${"A".repeat(21)}=`), false);
  assert.equal(isPersonSession(7), false);

  assert.deepEqual(parseCaps(["people", "internet", "people", "teleport", 7]), ["internet", "people"]);
  assert.equal(takesPeople({ caps: ["people"] }), true);
  assert.equal(takesPeople({ caps: ["phone-link", "internet"] }), false);
  assert.equal(takesPeople({ caps: null }), false, "an app from before caps");
  assert.equal(takesPeople(null), false);
  // A desktop that takes people alone answers neither phones nor dials.
  assert.equal(answersPhones({ caps: ["people"] }), false);
  assert.equal(takesDials({ caps: ["people"] }), false);

  // Proven means proven: a time, a fingerprint and a key of the right shape.
  const row = {
    identity_verified_at: new Date(),
    identity_fingerprint: "abcd-abcd-abcd-abcd",
    identity_public_key: "ab".repeat(32),
  };
  assert.equal(isProven(row), true);
  assert.equal(isProven({ ...row, identity_verified_at: null }), false);
  assert.equal(isProven({ ...row, identity_fingerprint: null }), false);
  assert.equal(isProven({ ...row, identity_public_key: null }), false);
  assert.equal(isProven({ ...row, identity_public_key: "ab".repeat(31) }), false);
  assert.equal(isProven(undefined), false);

  assert.equal(PERSON_LIMITS.sessionMs, 60 * 60_000);
  assert.equal(PERSON_LIMITS.sessionMessages, 64);
  assert.equal(PERSON_LIMITS.emailChars, 254);
  assert.deepEqual(PERSON_LIMITS.rate, { knockPerMinute: 10, personSignalPerMinute: 120 });
  assert.deepEqual([...PERSON_TYPES].sort(), ["bye", "dial", "dial-answer", "here"]);
  assert.deepEqual([...KNOCK_PURPOSES].sort(), ["hello", "send"]);
});

test("the person store keeps each side to its part, sweeps what has run out, and its timer never holds the process open", async () => {
  let t = 1_000_000;
  const delivered = [];
  const people = createPeopleStore({
    now: () => t,
    deliver: (userId, address, message) => delivered.push({ userId, address, message }),
  });
  stoppable.push(people);
  const sender = { userId: "u1", address: "desktop:a", kind: "desktop" };
  const recipients = [
    { userId: "u2", address: "desktop:b" },
    { userId: "u2", address: "desktop:c" },
  ];
  const stranger = { userId: "u3", address: "desktop:d" };
  const card = { email: "a@example.com", name: "A", identity: "ab".repeat(32), fingerprint: "abcd-abcd-abcd-abcd" };

  const knock = people.knock(sender, { purpose: "send", card, recipients });
  assert.ok(isPersonSession(knock));
  assert.deepEqual(
    delivered.map(({ userId, address, message }) => [userId, address, message.type, message.data]),
    [
      ["u2", "desktop:b", "knock", { purpose: "send", ...card }],
      ["u2", "desktop:c", "knock", { purpose: "send", ...card }],
    ],
    "into the recipients' own account"
  );
  assert.deepEqual(people.stats(), { sessions: 2 });
  const [sid, other] = delivered.map(({ message }) => message.session);
  delivered.length = 0;

  // Each side knows its part; to anyone else the session is not there.
  assert.deepEqual(people.role(sender, sid), { role: "sender", knock });
  assert.deepEqual(people.role(recipients[0], sid), { role: "recipient", knock });
  assert.equal(people.role(recipients[1], sid), null, "the other desktop knocked on has a session of its own");
  assert.equal(people.role(stranger, sid), null);

  // Only the desktop knocked on says here, and it goes to the sender's own account.
  assert.deepEqual(people.signal(sender, sid, "here", {}), { ok: false, error: "bad_type" });
  assert.deepEqual(people.signal(stranger, sid, "here", {}), { ok: false, error: "person_gone" });
  assert.deepEqual(people.signal(recipients[0], sid, "here", { knock }), { ok: true });
  assert.deepEqual(
    delivered.map(({ userId, address, message }) => [userId, address, message.from, message.type]),
    [["u1", "desktop:a", `person:${sid}`, "here"]]
  );
  delivered.length = 0;

  // Forgetting a session tells nobody, and only its two sides can.
  assert.deepEqual(people.forget(stranger, other), { ok: false, error: "person_gone" });
  assert.deepEqual(people.forget(recipients[1], other), { ok: true });
  assert.equal(people.role(sender, other), null);
  assert.deepEqual(delivered, []);
  assert.deepEqual(people.stats(), { sessions: 1 });

  people.knock(sender, { purpose: "hello", card, recipients });
  assert.deepEqual(people.stats(), { sessions: 1 }, "a hello keeps nothing");
  assert.ok(isPersonSession(people.knock(sender, { purpose: "send", card, recipients: [] })), "a knock id for nobody too");

  t += 59 * 60_000;
  people.sweep();
  assert.deepEqual(people.stats(), { sessions: 1 });
  t += 60_000;
  people.sweep();
  assert.deepEqual(people.stats(), { sessions: 0 }, "an hour after the knock");

  const source = await src("../src/modules/forgedrop-link/people.js");
  assert.match(source, /sweeper\.unref\?\.\(\)/);
});

test("the mounted module has the person routes", async () => {
  const { studio } = devices;
  const me = await call("/person/me", { base: "/real", method: "GET", licence: studio.token });
  assert.deepEqual([me.status, me.body], [200, { email: "alice@example.com", verified: true }]);
  const gone = await call("/person/close", { base: "/real", licence: studio.token, body: { session: "A".repeat(22) } });
  assert.deepEqual([gone.status, gone.body], [404, { error: "person_gone" }]);
});

test("nothing went wrong unnoticed", () => {
  assert.deepEqual(logged.filter((entry) => entry.level === "error"), []);
});
