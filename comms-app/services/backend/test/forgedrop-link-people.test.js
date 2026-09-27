// ForgeDrop people: the relay that introduces two desktops by the email of a
// SendForge account, for sending to someone by their address
// (ForgeDrop/docs/people.md, "Backend: the person relay"), and from 1.8 the
// knock that waits for them, the email it sends and the page that approves it
// ("Waiting, and the email").
//
// As in forgedrop-codes.test.js, the HTTP tests run the real router, real
// licence tokens minted by the activation service, and real users and
// device_activations rows against an in-process Postgres (PGlite). Every test
// gets a relay of its own (fresh stores, its own path, its own rate-limit
// names), whose email sender only writes down what it was asked to send. The
// stores' clock is a dial the tests turn; long-polls and the rate limiter use
// real time. A file of its own, because rate limiters are per process.

import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import cors from "cors";
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
const { sendForgeDropTransferEmail } = await import("../src/services/email.service.js");
const { createForgeDropLinkRouter, PERSON_LIMITS } = await import("../src/modules/forgedrop-link/router.js");
const { createLinkStore } = await import("../src/modules/forgedrop-link/store.js");
const { createCodeStore } = await import("../src/modules/forgedrop-link/codes.js");
const { createPeopleStore } = await import("../src/modules/forgedrop-link/people.js");
const { isProven } = await import("../src/modules/forgedrop-link/devices.js");
const {
  answersPhones,
  isApprovalToken,
  isPersonSession,
  KNOCK_OUTCOMES,
  KNOCK_PURPOSES,
  parseCaps,
  parseEmail,
  parseSummary,
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
    appVersion: "1.8.0",
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
  invitePerMinute: 1e6,
};

let relays = 0;

/**
 * A relay of its own: a fresh router and stores, at a path of its own. Its
 * emails are written down in `emails` unless `sendTransferEmail` says
 * otherwise; `withCors` puts app.js's CORS in front, as the real API has it.
 */
function relay({ rate = UNLIMITED, sendTransferEmail = null, withCors = false } = {}) {
  relays += 1;
  const base = `/relay-${relays}`;
  const store = createLinkStore({ now });
  const deliver = (userId, address, message) => store.deliver(userId, address, message);
  const codes = createCodeStore({ now, deliver });
  const people = createPeopleStore({ now, deliver, present: (userId, address) => store.isPresent(userId, address) });
  stoppable.push(store, codes, people);
  const emails = [];
  const router = createForgeDropLinkRouter({
    db,
    requireAuth,
    hasProductEntitlement,
    signingKey: () => env.licenseSigningKey,
    now,
    log,
    store,
    codes,
    people,
    sendTransferEmail:
      sendTransferEmail ??
      (async (message) => {
        emails.push(message);
        return { ok: true };
      }),
    approvalLink: (token) => `https://sendforge.test/r/#${token}`,
    rate,
    rateLimitPrefix: `fd-people-${relays}`,
  });
  if (withCors) app.use(base, cors({ origin: true, credentials: true }), router);
  else app.use(base, router);

  const at = (path, options = {}) => call(path, { base, ...options });
  const poll = (device, body = {}, options = {}) =>
    at("/desktop/poll", { licence: device.token, body: { wait: 0, ...body }, ...options });
  const knock = (device, body) => at("/person/knock", { licence: device.token, body });

  /** What is waiting for a desktop, each without the time it was sent; `body` adds to its poll. */
  async function mail(device, body = {}) {
    const res = await poll(device, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.messages.map(({ sentAt, ...message }) => {
      assert.equal(new Date(sentAt).toISOString(), sentAt, "sentAt is ISO-8601");
      return message;
    });
  }

  return {
    store,
    people,
    emails,
    call: at,
    poll,
    knock,
    mail,
    me: (device) => at("/person/me", { method: "GET", licence: device.token }),
    signal: (device, body) => at("/person/signal", { licence: device.token, body }),
    close: (device, body) => at("/person/close", { licence: device.token, body }),
    end: (device, body) => at("/person/end", { licence: device.token, body }),
    // The approval page: no licence, only the token.
    invite: (body) => at("/person/invite", { body }),
    approve: (body) => at("/person/approve", { body }),

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

/** Let `ms` pass on the clock, with `polling` polling every 30 s as a running ForgeDrop does. */
async function elapse(r, ms, ...polling) {
  for (let left = ms; left > 0; left -= 30_000) {
    advance(Math.min(30_000, left));
    for (const device of polling) assert.equal((await r.poll(device)).status, 200);
  }
}

/** What sendforge.app vouches for about a desktop: its account's address, its name and its proven key. */
const cardOf = (device, name = device.name) => ({
  email: device.owner.address,
  name,
  identity: device.identity,
  fingerprint: device.fingerprint,
});

/** A send's knock as the desktop knocked on reads it: who from, what it sends, and whether it is approved. */
const sendKnock = (device, { name = device.name, files = null, bytes = null, approved = false } = {}) => ({
  purpose: "send",
  ...cardOf(device, name),
  files,
  bytes,
  approved,
});

const said = (sid, type, data) => ({ from: `person:${sid}`, session: sid, type, data });

/** The token an email's link carries after its "#". */
const tokenOf = (email) => email.approveUrl.slice(email.approveUrl.indexOf("#") + 1);

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
  for (const path of ["/person/me", "/person/knock", "/person/signal", "/person/close", "/person/end"]) {
    const method = path === "/person/me" ? "GET" : "POST";
    const body =
      method === "POST"
        ? { to: "bob@example.com", purpose: "send", session: "A".repeat(22), type: "dial", knock: "A".repeat(22), outcome: "sent" }
        : undefined;
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
    approved: true,
    data: { email: "mallory@example.com" },
  });
  assert.equal(knocked.status, 202, JSON.stringify(knocked.body));
  assert.deepEqual(Object.keys(knocked.body), ["knock"]);
  assert.ok(isPersonSession(knocked.body.knock), `a 22-character base64url knock id, not ${knocked.body.knock}`);

  const card = sendKnock(studio, { name: "Studio PC (live)" });
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
  assert.deepEqual(r.people.stats(), { sessions: 2, knocks: 1, waiting: 1 });
  assert.deepEqual(
    r.emails.map((email) => email.to),
    ["bob@example.com"],
    "and Bob's address is emailed"
  );

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
  // Only a verified owner's address has a send wait for it, and an email:
  // none for no account, an unverified one, or one that does not own ForgeDrop.
  assert.deepEqual(r.people.stats(), { sessions: 0, knocks: 3, waiting: 3 });
  assert.deepEqual(
    r.emails.map((email) => email.to),
    ["dana@example.com", "fran@example.com", "bob@example.com"]
  );

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
  assert.deepEqual(r.emails, [], "or emailed");

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
  assert.deepEqual(mail, [said(mail[0]?.session, "knock", sendKnock(studio))]);
  assert.deepEqual(await r.mail(studio), []);
  assert.deepEqual(await r.mail(attic), []);
  assert.deepEqual(r.people.stats(), { sessions: 1, knocks: 1, waiting: 1 });

  // From there it goes as with anyone else.
  const sid = mail[0].session;
  assert.equal((await r.signal(laptop, { session: sid, type: "here" })).status, 202);
  assert.deepEqual(await r.mail(studio), [said(sid, "here", { knock: knocked.body.knock, ...cardOf(laptop) })]);

  // With no other desktop of its own taking people, nobody is knocked on
  // now; the send waits, and the laptop has both when it comes back.
  assert.equal((await r.call("/desktop/offline", { licence: laptop.token })).status, 204);
  assert.equal((await r.knock(studio, { to: "alice@example.com", purpose: "send" })).status, 202);
  assert.deepEqual(r.people.stats(), { sessions: 1, knocks: 2, waiting: 2 });
  const back = await r.mail(laptop, { caps: ["people"] });
  assert.deepEqual(back.map((m) => [m.type, m.data.email]), [
    ["knock", "alice@example.com"],
    ["knock", "alice@example.com"],
  ]);
  assert.deepEqual(await r.mail(studio), [], "and still never the desktop that knocked");
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
  // It neither waits nor emails.
  assert.deepEqual(r.people.stats(), { sessions: 0, knocks: 0, waiting: 0 });
  assert.deepEqual(r.emails, []);

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
  // The sessions are over; the three sends still wait, as sends do.
  assert.deepEqual(r.people.stats(), { sessions: 0, knocks: 3, waiting: 3 });
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

  // "approved", like the knock, is only ever this server's to send.
  for (const type of ["knock", "approved", "offer", "answer", "pake", "proof", "HERE", "hello", "send", undefined, 7]) {
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
  // Nor does the send wait on: the desktop that knocked never polled.
  r.people.sweep();
  assert.deepEqual(r.people.stats(), { sessions: 0, knocks: 0, waiting: 0 });
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
  assert.deepEqual(r.people.stats(), { sessions: 3, knocks: 1, waiting: 1 });

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
  assert.deepEqual(r.people.stats(), { sessions: 0, knocks: 1, waiting: 1 });
});

// ------------------------------------------------ waiting, the email, the page (1.8)

test("a send waits: a desktop that comes online later is knocked on, and again after it goes and comes back", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  await r.poll(studio, { caps: ["people"] });
  const knocked = await r.knock(studio, { to: "bob@example.com", purpose: "send", files: 3, bytes: 6_710_886 });
  assert.equal(knocked.status, 202);
  const { knock } = knocked.body;
  assert.deepEqual(r.people.stats(), { sessions: 0, knocks: 1, waiting: 1 });

  // Bob opens ForgeDrop ten minutes later, the sender's polling all the while.
  await elapse(r, 10 * 60_000, studio);
  const card = sendKnock(studio, { files: 3, bytes: 6_710_886 });
  const first = await r.mail(bobs, { caps: ["people"] });
  assert.deepEqual(first, [said(first[0]?.session, "knock", card)]);
  assert.deepEqual(await r.mail(bobs, { caps: ["people"] }), [], "once, while it stays online");

  // Its session is like any other: the here reaches the sender with the knock id.
  assert.equal((await r.signal(bobs, { session: first[0].session, type: "here" })).status, 202);
  assert.deepEqual(await r.mail(studio), [said(first[0].session, "here", { knock, ...cardOf(bobs) })]);

  // It goes offline and comes back: knocked on again, on a new session.
  assert.equal((await r.call("/desktop/offline", { licence: bobs.token })).status, 204);
  const again = await r.mail(bobs, { caps: ["people"] });
  assert.deepEqual(again, [said(again[0]?.session, "knock", card)]);
  assert.notEqual(again[0].session, first[0].session);

  // As after its polls lapse, without a word, while the sender's go on.
  await elapse(r, 60_000, studio);
  const lapsed = await r.mail(bobs, { caps: ["people"] });
  assert.deepEqual(lapsed, [said(lapsed[0]?.session, "knock", card)]);
  assert.deepEqual(r.people.stats(), { sessions: 3, knocks: 1, waiting: 1 });
  assert.equal(r.emails.length, 1, "one email, however often it knocks");
});

test("a waiting send goes only to a desktop taking people with a slot and a proven key, never to the one that knocked", async () => {
  const r = relay();
  const { studio, laptop } = devices;
  const den = await activate("aliceDen", accounts.alice, "Den PC", { proven: false });
  const spare = await activate("aliceSpare", accounts.alice, "Spare PC");
  await r.poll(studio, { caps: ["people"] });
  await r.poll(spare);

  // On its own address the send waits for its account's other desktops.
  assert.equal((await r.knock(studio, { to: "alice@example.com", purpose: "send", files: 1, bytes: 10 })).status, 202);
  const card = sendKnock(studio, { files: 1, bytes: 10 });
  assert.deepEqual(await r.mail(studio, { caps: ["people"] }), [], "never the desktop that knocked");
  assert.deepEqual(await r.mail(den, { caps: ["people"] }), [], "never one that has not proved its key");

  // Polling without people: nothing. With it: the knock.
  assert.deepEqual(await r.mail(laptop, { caps: ["phone-link", "internet"] }), []);
  const got = await r.mail(laptop, { caps: ["people", "internet"] });
  assert.deepEqual(got, [said(got[0]?.session, "knock", card)]);

  // The den proves its key: its next poll takes the send that waited for it.
  await db("device_activations")
    .where({ device_id: den.deviceId })
    .update({ identity_public_key: den.identity, identity_verified_at: db.fn.now() });
  const proved = await r.mail(den, { caps: ["people"] });
  assert.deepEqual(proved, [said(proved[0]?.session, "knock", card)]);

  // A desktop whose slot was freed (its licence taken on trust for a minute more) is not.
  await deactivateDevice(accounts.alice.id, "forgedrop", spare.deviceId);
  assert.deepEqual(await r.mail(spare, { caps: ["people"] }), []);
});

test("a waiting send is over once the desktop that knocked stops polling", async () => {
  const r = relay();
  const { studio, bobs } = devices;

  // Knocked just before its first poll, it is not given up on at once.
  assert.equal((await r.knock(studio, { to: "bob@example.com", purpose: "send", files: 1, bytes: 1 })).status, 202);
  const token = tokenOf(r.emails.at(-1));
  assert.deepEqual((await r.mail(bobs, { caps: ["people"] })).map((m) => m.type), ["knock"]);
  await r.poll(studio, { caps: ["people"] });
  assert.equal((await r.invite({ token })).body.status, "waiting");

  // Then it stops polling.
  advance(41_000);
  assert.equal((await r.call("/desktop/offline", { licence: bobs.token })).status, 204);
  assert.deepEqual(await r.mail(bobs, { caps: ["people"] }), [], "back online, but the send is gone");
  for (const route of [r.invite, r.approve]) {
    const res = await route({ token });
    assert.deepEqual([res.status, res.body], [404, { error: "invite_gone" }]);
  }
  assert.deepEqual(r.people.stats(), { sessions: 1, knocks: 0, waiting: 0 });
});

test("ending a send stops it waiting, says bye on its open sessions, and its page says how it ended; only the knocker can", async () => {
  const r = relay();
  const { studio, laptop, bobs, bobsLaptop } = devices;
  await r.poll(studio, { caps: ["people"] });
  await r.poll(bobs, { caps: ["people"] });
  const { knock } = (await r.knock(studio, { to: "bob@example.com", purpose: "send", files: 2, bytes: 2048 })).body;
  const token = tokenOf(r.emails.at(-1));
  const [atDesk] = await r.mail(bobs);

  // Neither the sender's other desktop nor the recipient can end it.
  for (const device of [laptop, bobs]) {
    const res = await r.end(device, { knock, outcome: "cancelled" });
    assert.deepEqual([res.status, res.text], [204, ""]);
  }
  assert.equal((await r.invite({ token })).body.status, "waiting");

  const ended = await r.end(studio, { knock, outcome: "sent" });
  assert.deepEqual([ended.status, ended.text], [204, ""]);
  assert.deepEqual(await r.mail(bobs), [said(atDesk.session, "bye", {})]);
  const late = await r.signal(bobs, { session: atDesk.session, type: "here" });
  assert.deepEqual([late.status, late.body], [404, { error: "person_gone" }]);
  // It waits no more: a desktop coming online now is not knocked on.
  assert.deepEqual(await r.mail(bobsLaptop, { caps: ["people"] }), []);
  assert.deepEqual(r.people.stats(), { sessions: 0, knocks: 1, waiting: 0 });

  // Its page says so from then on, and cannot approve it; a second end changes nothing.
  const page = { status: "sent", from: "alice@example.com", name: "Studio PC", files: 2, bytes: 2048 };
  assert.deepEqual((await r.invite({ token })).body, page);
  const over = await r.approve({ token });
  assert.deepEqual([over.status, over.body], [409, { error: "invite_over" }]);
  assert.equal((await r.end(studio, { knock, outcome: "cancelled" })).status, 204);
  assert.deepEqual((await r.invite({ token })).body, page);

  // Nor does the sender going quiet change it, until its day is up.
  advance(23 * 60 * 60_000);
  assert.deepEqual((await r.invite({ token })).body, page);
  advance(60 * 60_000);
  const expired = await r.invite({ token });
  assert.deepEqual([expired.status, expired.body], [404, { error: "invite_gone" }]);

  // A knock nobody waited on, or none at all, ends the same way; a malformed end is refused.
  const nobody = await r.knock(studio, { to: "nobody@example.com", purpose: "send" });
  assert.equal((await r.end(studio, { knock: nobody.body.knock, outcome: "cancelled" })).status, 204);
  assert.equal((await r.end(studio, { knock: "A".repeat(22), outcome: "sent" })).status, 204);
  for (const [body, error] of [
    [{ outcome: "sent" }, "bad_knock"],
    [{ knock: "short", outcome: "sent" }, "bad_knock"],
    [{ knock, outcome: "done" }, "bad_outcome"],
    [{ knock, outcome: "SENT" }, "bad_outcome"],
    [{ knock }, "bad_outcome"],
  ]) {
    const res = await r.end(studio, body);
    assert.deepEqual([res.status, res.body], [400, { error }], JSON.stringify(body));
  }
});

test("a knock says what it sends in whole numbers, or not at all; a hello neither waits nor emails", async () => {
  const r = relay();
  const { studio, bobs } = devices;
  const bad = [
    [-1, 0],
    [1.5, 0],
    ["3", 0],
    [true, 0],
    [1_000_001, 0],
    [[1], 0],
    [{}, 0],
    [0, -1],
    [0, 2.5],
    [0, "10"],
    [0, 2 ** 53],
  ];
  for (const [files, bytes] of bad) {
    const res = await r.knock(studio, { to: "bob@example.com", purpose: "send", files, bytes });
    assert.deepEqual([res.status, res.body], [400, { error: "bad_summary" }], JSON.stringify({ files, bytes }));
  }
  const good = [{}, { files: null, bytes: null }, { files: 0, bytes: 0 }, { files: 1_000_000, bytes: Number.MAX_SAFE_INTEGER }, { files: 3 }, { bytes: 3 }];
  for (const body of good) {
    assert.equal((await r.knock(studio, { to: "nobody@example.com", purpose: "send", ...body })).status, 202, JSON.stringify(body));
  }

  await r.poll(bobs, { caps: ["people"] });
  assert.equal((await r.knock(studio, { to: "bob@example.com", purpose: "hello", files: 3, bytes: 3 })).status, 202);
  assert.deepEqual((await r.mail(bobs)).map((m) => m.data), [{ purpose: "hello", ...cardOf(studio) }]);
  assert.deepEqual(r.people.stats(), { sessions: 0, knocks: 0, waiting: 0 });
  assert.deepEqual(r.emails, []);
});

test("each waiting send emails the recipient's address once: who from, what, and the link to its page", async () => {
  const r = relay();
  const { studio, legacys } = devices;
  await r.poll(studio, { name: "Studio PC (live)", caps: ["people"] });
  const knocked = await r.knock(studio, { to: "  BOB@example.com ", purpose: "send", files: 3, bytes: 6_710_886 });
  assert.equal(r.emails.length, 1);
  const [email] = r.emails;
  const token = tokenOf(email);
  assert.ok(isApprovalToken(token), token);
  assert.deepEqual(email, {
    to: "bob@example.com",
    senderEmail: "alice@example.com",
    senderComputer: "Studio PC (live)",
    files: 3,
    bytes: 6_710_886,
    approveUrl: `https://sendforge.test/r/#${token}`,
    knockId: knocked.body.knock,
  });
  // The page shows the same.
  assert.deepEqual((await r.invite({ token })).body, {
    status: "waiting",
    from: "alice@example.com",
    name: "Studio PC (live)",
    files: 3,
    bytes: 6_710_886,
  });

  // To the address the account has, as it was stored; and a knock that did
  // not say what it sends says nothing about it.
  await r.knock(studio, { to: "legacy.user@example.com", purpose: "send" });
  assert.equal(r.emails[1].to, "Legacy.User@Example.com");
  assert.deepEqual([r.emails[1].files, r.emails[1].bytes], [null, null]);
  assert.notEqual(tokenOf(r.emails[1]), token, "a token each");
  assert.equal(legacys.owner.address, "legacy.user@example.com");

  // Nothing written to the log carries a token.
  assert.equal(JSON.stringify(logged).includes(token), false);
});

test("emails are limited, one per sender and recipient every 2 minutes and 10 an hour per recipient, and the send knocks regardless", async () => {
  const r = relay();
  const { studio, bobs, legacys } = devices;
  await r.poll(bobs, { caps: ["people"] });
  const send = async (from) => {
    const res = await r.knock(from, { to: "bob@example.com", purpose: "send", files: 1, bytes: 1 });
    assert.equal(res.status, 202);
  };
  const emailed = () => r.emails.map((email) => email.senderEmail);

  await send(studio);
  await send(studio);
  assert.deepEqual(emailed(), ["alice@example.com"], "the second within 2 minutes sends none");
  assert.deepEqual((await r.mail(bobs)).map((m) => m.type), ["knock", "knock"], "but knocks all the same");
  await send(legacys);
  assert.deepEqual(emailed(), ["alice@example.com", "legacy.user@example.com"], "another sender is another pair");
  advance(2 * 60_000 - 1);
  await send(studio);
  assert.equal(r.emails.length, 2);
  advance(1);
  await send(studio);
  assert.equal(r.emails.length, 3, "2 minutes on, the pair may again");

  // Ten an hour to one recipient, from anyone.
  for (let i = 4; i <= 10; i += 1) {
    advance(2 * 60_000);
    await send(studio);
    assert.equal(r.emails.length, i);
  }
  advance(2 * 60_000);
  await send(studio);
  await send(legacys);
  assert.equal(r.emails.length, 10, "the eleventh in the hour sends none");
  // An hour after the first two went, there is room for two more.
  advance(60 * 60_000 - 18 * 60_000);
  await send(studio);
  await send(legacys);
  await send(studio);
  assert.deepEqual(emailed().slice(10), ["alice@example.com", "legacy.user@example.com"]);
});

test("an email that fails is logged, without its link, and the send goes on", async () => {
  const r = relay({
    sendTransferEmail: async () => {
      throw Object.assign(new Error("Email send failed"), { code: "sendgrid_non_2xx" });
    },
  });
  const { studio, bobs } = devices;
  await r.poll(bobs, { caps: ["people"] });
  const knocked = await r.knock(studio, { to: "bob@example.com", purpose: "send", files: 1, bytes: 1 });
  assert.equal(knocked.status, 202);
  assert.deepEqual((await r.mail(bobs)).map((m) => m.type), ["knock"]);

  await until(() => logged.some((entry) => entry.msg === "forgedrop_link_transfer_email_failed"), "the failure's log");
  const at = logged.findIndex((entry) => entry.msg === "forgedrop_link_transfer_email_failed");
  assert.deepEqual(logged[at], {
    level: "error",
    msg: "forgedrop_link_transfer_email_failed",
    meta: { code: "sendgrid_non_2xx", message: "Email send failed" },
  });
  logged.splice(at, 1); // expected, so not left for "nothing went wrong unnoticed"
});

test("the approval page looks, then approves: each open session hears approved, and later knocks say so", async () => {
  const r = relay();
  const { studio, bobs, bobsLaptop } = devices;
  await r.poll(studio, { caps: ["people"] });
  await r.poll(bobs, { caps: ["people"] });
  await r.poll(bobsLaptop, { caps: ["people"] });
  const { knock } = (await r.knock(studio, { to: "bob@example.com", purpose: "send", files: 3, bytes: 6_710_886 })).body;
  const token = tokenOf(r.emails.at(-1));
  const [atDesk] = await r.mail(bobs);
  const [atLaptop] = await r.mail(bobsLaptop);
  // The laptop has already declined its session.
  assert.equal((await r.close(bobsLaptop, { session: atLaptop.session })).status, 204);
  assert.deepEqual(await r.mail(studio), [said(atLaptop.session, "bye", {})]);

  const page = { status: "waiting", from: "alice@example.com", name: "Studio PC", files: 3, bytes: 6_710_886 };
  const looked = await r.invite({ token });
  assert.deepEqual([looked.status, looked.body], [200, page]);
  assert.deepEqual(await r.mail(bobs), [], "looking approves nothing");

  const approved = await r.approve({ token });
  assert.deepEqual([approved.status, approved.body], [200, { ...page, status: "approved" }]);
  assert.deepEqual(await r.mail(bobs), [said(atDesk.session, "approved", {})], "on the session still open");
  assert.deepEqual(await r.mail(bobsLaptop), [], "not on one that has ended");
  assert.deepEqual(await r.mail(studio), [], "and the sender is not told");

  // Twice is the same as once.
  const twice = await r.approve({ token });
  assert.deepEqual([twice.status, twice.body], [200, { ...page, status: "approved" }]);
  assert.deepEqual(await r.mail(bobs), []);
  assert.equal((await r.invite({ token })).body.status, "approved");

  // A desktop knocked on from now on is told so in the knock.
  assert.equal((await r.call("/desktop/offline", { licence: bobsLaptop.token })).status, 204);
  const later = await r.mail(bobsLaptop, { caps: ["people"] });
  assert.deepEqual(later, [said(later[0]?.session, "knock", sendKnock(studio, { files: 3, bytes: 6_710_886, approved: true }))]);

  // Once it is over, the page says how, and approving is refused.
  assert.equal((await r.end(studio, { knock, outcome: "cancelled" })).status, 204);
  assert.deepEqual((await r.invite({ token })).body, { ...page, status: "cancelled" });
  const over = await r.approve({ token });
  assert.deepEqual([over.status, over.body], [409, { error: "invite_over" }]);
});

test("a token is the only key: an unknown or malformed one is gone", async () => {
  const r = relay();
  const gone = async (body, note) => {
    for (const route of [r.invite, r.approve]) {
      const res = await route(body);
      assert.deepEqual([res.status, res.body], [404, { error: "invite_gone" }], note);
    }
  };
  await gone({ token: crypto.randomBytes(32).toString("base64url") }, "well formed, but nobody's");
  for (const token of [undefined, null, "", "short", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, 7, ["A".repeat(43)]]) {
    await gone({ token }, JSON.stringify(token));
  }
  await gone(undefined, "no body at all");
});

test("the approval page's routes take no licence, are limited per address, and answer the website across origins", async () => {
  const r = relay({ rate: { ...UNLIMITED, invitePerMinute: 30 }, withCors: true });
  const { studio } = devices;
  await r.poll(studio);
  await r.knock(studio, { to: "bob@example.com", purpose: "send", files: 1, bytes: 1 });
  const token = tokenOf(r.emails.at(-1));

  // The website asks first, as a browser does before a JSON POST to another origin.
  const site = "https://sendforge.app";
  const preflight = await r.call("/person/approve", {
    method: "OPTIONS",
    headers: { Origin: site, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), site);
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
  assert.match(preflight.headers.get("access-control-allow-headers"), /content-type/i);
  const looked = await r.call("/person/invite", { body: { token }, headers: { Origin: site } });
  assert.equal(looked.status, 200, "with no licence and no sign-in");
  assert.equal(looked.headers.get("access-control-allow-origin"), site);

  // Thirty a minute from one address, the two routes together.
  for (let i = 2; i <= 30; i += 1) {
    const res = await (i % 2 ? r.invite({ token }) : r.approve({ token }));
    assert.equal(res.status, 200, `call ${i}: ${JSON.stringify(res.body)}`);
  }
  for (const route of [r.invite, r.approve]) {
    const limited = await route({ token });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "rate_limited");
    assert.match(limited.headers.get("retry-after"), /^[1-9]\d*$/);
  }
  assert.equal((await r.poll(studio)).status, 200, "desktops are not held up by it");

  // app.js runs its CORS ahead of the link, so the real site reaches these the same way.
  const source = await src("../src/app.js");
  const corsAt = source.search(/app\.use\(\s*cors\(\{\s*origin: true/);
  assert.ok(corsAt > 0);
  assert.ok(corsAt < source.indexOf('app.use("/v1/forgedrop/link", forgedropLinkRouter)'));
});

test("a poll asks the database nothing unless a send waits for that desktop", async () => {
  const r = relay();
  const { studio, laptop, bobs, bobsLaptop } = devices;
  for (const device of [studio, laptop, bobs, bobsLaptop]) await r.poll(device); // their licences checked
  await r.poll(studio, { caps: ["people"] });
  await r.poll(laptop, { caps: ["people"] });
  await r.poll(bobs, { caps: ["people"] });
  assert.equal((await r.knock(studio, { to: "bob@example.com", purpose: "send", files: 1, bytes: 1 })).status, 202);

  // A send waiting for Bob's account costs Alice's desktops nothing, and
  // Bob's desktop nothing once it has it.
  const quiet = countQueries();
  await r.poll(laptop);
  await r.poll(studio);
  assert.deepEqual((await r.mail(bobs)).map((m) => m.type), ["knock"]);
  assert.deepEqual(await r.mail(bobs), []);
  assert.deepEqual(quiet.stop(), []);

  // Bob's laptop, taking people with the send due, costs one question: does
  // it hold a slot and a proven key.
  const due = countQueries();
  assert.deepEqual((await r.mail(bobsLaptop, { caps: ["people"] })).map((m) => m.type), ["knock"]);
  assert.equal(due.stop().length, 1);
});

test("the email says the owner's words, who from, what, and the link, and never writes the link to the log", async () => {
  const keys = ["NODE_ENV", "SENDGRID_API_KEY", "ACCOUNT_FROM_EMAIL", "SUPPORT_EMAIL"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const sent = [];
  const printed = [];
  const token = crypto.randomBytes(32).toString("base64url");
  const approveUrl = `https://sendforge.app/r/#${token}`;
  const email = (extra) =>
    sendForgeDropTransferEmail({
      to: "bob@example.com",
      senderEmail: "michael@example.com",
      senderComputer: "LETSGOSLOWER",
      files: 3,
      bytes: 6_710_886,
      approveUrl,
      knockId: "K".repeat(22),
      ...extra,
    });
  Object.assign(process.env, {
    NODE_ENV: "test",
    SENDGRID_API_KEY: "SG.test-only",
    ACCOUNT_FROM_EMAIL: "referrals@sendforge.app",
    SUPPORT_EMAIL: "support@sendforge.app",
  });
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return {
      status: 202,
      headers: { get: (name) => (String(name).toLowerCase() === "x-message-id" ? "sg-1" : null) },
      text: async () => "",
    };
  };
  console.log = (line) => printed.push(String(line));
  try {
    assert.equal((await email()).status, "accepted");
    await email({ senderComputer: "Studio <b>PC</b>\r\nBcc: someone", files: 1, bytes: 512 });
    await email({ senderComputer: null, files: null, bytes: null });
    for (const [files, bytes] of [
      [2, 1023],
      [2, 1024],
      [2, 5 * 1024 ** 4],
      [1234, 2048 * 1024 ** 4],
      [0, 0],
    ]) {
      await email({ files, bytes });
    }
    // Without a provider it only logs that it would have sent, and never the link.
    delete process.env.SENDGRID_API_KEY;
    assert.equal((await email()).mode, "log");
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }

  assert.equal(sent[0].url, "https://api.sendgrid.com/v3/mail/send");
  const { body } = sent[0];
  // The owner's words, exactly.
  assert.equal(body.subject, "A ForgeDrop file transfer was initiated");
  assert.deepEqual(body.from, { email: "referrals@sendforge.app", name: "ForgeDrop" });
  assert.deepEqual(body.personalizations[0].to, [{ email: "bob@example.com" }]);
  assert.equal(body.personalizations[0].custom_args.sf_message_kind, "forgedrop-transfer");
  assert.equal(body.personalizations[0].custom_args.sf_message_ref, "K".repeat(22), "the knock, never the token");
  assert.equal(body.tracking_settings.click_tracking.enable, false, "the link is not rewritten through a tracker");
  const [text, html] = body.content.map((part) => part.value);
  assert.equal(
    text,
    `A ForgeDrop file transfer was initiated

From: michael@example.com (LETSGOSLOWER)
3 files, 6.4 MB

Click here to approve:
${approveUrl}

The files go straight between the two computers. Once you approve, they arrive while ForgeDrop is open on your computer; you can also accept them in ForgeDrop itself. Nothing arrives without your approval.

You're getting this because someone used ForgeDrop to send files to this email address. Need help? Contact support@sendforge.app.`
  );
  assert.match(html, /<h1 [^>]*>A ForgeDrop file transfer was initiated<\/h1>/);
  assert.ok(html.includes(`<a href="${approveUrl}" `), "the button links to the page");
  assert.match(html, />Click here to approve<\/a>/);
  assert.match(html, /<strong>From:<\/strong> michael@example\.com \(LETSGOSLOWER\)<\/p>/);
  assert.match(html, />3 files, 6\.4 MB<\/p>/);
  assert.ok(html.includes("Nothing arrives without your approval."));

  // A name is shown as text, on one line; what is not known is not said.
  const [hostile, htmlHostile] = sent[1].body.content.map((part) => part.value);
  assert.match(hostile, /\nFrom: michael@example\.com \(Studio <b>PC<\/b> Bcc: someone\)\n1 file, 512 B\n/);
  assert.match(htmlHostile, /michael@example\.com \(Studio &lt;b&gt;PC&lt;\/b&gt; Bcc: someone\)<\/p>/);
  const unknown = sent[2].body.content[0].value;
  assert.match(unknown, /\nFrom: michael@example\.com\n\nClick here to approve:\n/);

  // Sizes as ForgeDrop's window writes them, counting in 1024s.
  const lines = sent.slice(3).map((message) => message.body.content[0].value.split("\n")[3]);
  assert.deepEqual(lines, ["2 files, 1,023 B", "2 files, 1.0 KB", "2 files, 5.0 TB", "1,234 files, 2,048.0 TB", "0 files, 0 B"]);

  // The log-only send wrote no link, and nothing printed carries the token.
  assert.ok(printed.some((line) => line.includes('"email_log_mode"')));
  assert.equal(printed.some((line) => line.includes(token)), false);
});

test("the mounted module sends the real email, linking to the website's /r/ page", async () => {
  const index = await src("../src/modules/forgedrop-link/index.js");
  assert.match(index, /import \{ sendForgeDropTransferEmail \} from "\.\.\/\.\.\/services\/email\.service\.js";/);
  assert.match(index, /sendTransferEmail: sendForgeDropTransferEmail,/);
  assert.match(index, /approvalLink: \(token\) => `\$\{siteUrl\("\/r\/"\)\}#\$\{token\}`,/);

  const { studio } = devices;
  const me = await call("/person/me", { base: "/real", method: "GET", licence: studio.token });
  assert.deepEqual([me.status, me.body], [200, { email: "alice@example.com", verified: true }]);
  const gone = await call("/person/invite", { base: "/real", body: { token: "A".repeat(43) } });
  assert.deepEqual([gone.status, gone.body], [404, { error: "invite_gone" }]);
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
  assert.equal((await r.end(studio, { knock: second.knock, outcome: "sent" })).status, 204);
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

test("addresses, session ids, tokens and summaries are read generously but safely, and only known caps count", () => {
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

  assert.equal(isApprovalToken(crypto.randomBytes(32).toString("base64url")), true);
  for (const token of ["A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)}+`, 7, null]) {
    assert.equal(isApprovalToken(token), false, JSON.stringify(token));
  }

  assert.deepEqual(parseSummary({}), { files: null, bytes: null });
  assert.deepEqual(parseSummary({ files: 3, bytes: 6_710_886 }), { files: 3, bytes: 6_710_886 });
  assert.deepEqual(parseSummary({ files: null, bytes: 0 }), { files: null, bytes: 0 });
  assert.deepEqual(parseSummary({ files: 1_000_000 }), { files: 1_000_000, bytes: null });
  for (const body of [
    { files: -1 },
    { files: 1.5 },
    { files: 1_000_001 },
    { files: "3" },
    { files: Number.NaN },
    { bytes: Number.POSITIVE_INFINITY },
    { bytes: 2 ** 53 },
    { bytes: -0.5 },
    { bytes: true },
  ]) {
    assert.equal(parseSummary(body), null, JSON.stringify(body));
  }

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
  assert.equal(PERSON_LIMITS.knockMs, 24 * 60 * 60_000);
  assert.equal(PERSON_LIMITS.emailEveryMs, 2 * 60_000);
  assert.equal(PERSON_LIMITS.emailsPerHour, 10);
  assert.equal(PERSON_LIMITS.maxFiles, 1_000_000);
  assert.equal(PERSON_LIMITS.knocksPerDesktop, 64);
  assert.equal(PERSON_LIMITS.knocksPerPoll, 8);
  assert.deepEqual(PERSON_LIMITS.rate, { knockPerMinute: 10, personSignalPerMinute: 120, invitePerMinute: 30 });
  // What an app may send; "approved", like the knock, only ever comes from here.
  assert.deepEqual([...PERSON_TYPES].sort(), ["bye", "dial", "dial-answer", "here"]);
  assert.deepEqual([...KNOCK_PURPOSES].sort(), ["hello", "send"]);
  assert.deepEqual([...KNOCK_OUTCOMES].sort(), ["cancelled", "sent"]);
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

  // A send with nobody to wait for knocks only on who is there.
  const { knock, token } = people.knock(sender, { purpose: "send", card, recipients });
  assert.ok(isPersonSession(knock));
  assert.equal(token, null);
  assert.deepEqual(
    delivered.map(({ userId, address, message }) => [userId, address, message.type, message.data]),
    [
      ["u2", "desktop:b", "knock", { purpose: "send", ...card }],
      ["u2", "desktop:c", "knock", { purpose: "send", ...card }],
    ],
    "into the recipients' own account"
  );
  assert.deepEqual(people.stats(), { sessions: 2, knocks: 0, waiting: 0 });
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
  assert.deepEqual(people.stats(), { sessions: 1, knocks: 0, waiting: 0 });

  people.knock(sender, { purpose: "hello", card, recipients });
  assert.deepEqual(people.stats(), { sessions: 1, knocks: 0, waiting: 0 }, "a hello keeps nothing");
  assert.ok(isPersonSession(people.knock(sender, { purpose: "send", card, recipients: [] }).knock), "a knock id for nobody too");

  t += 59 * 60_000;
  people.sweep();
  assert.deepEqual(people.stats(), { sessions: 1, knocks: 0, waiting: 0 });
  t += 60_000;
  people.sweep();
  assert.deepEqual(people.stats(), { sessions: 0, knocks: 0, waiting: 0 }, "an hour after the knock");

  const source = await src("../src/modules/forgedrop-link/people.js");
  assert.match(source, /sweeper\.unref\?\.\(\)/);
});

test("a waiting knock lasts its day while its sender polls, goes a few a poll, and a desktop keeps so many", () => {
  let t = 1_000_000;
  const delivered = [];
  const polling = new Set(["u1 desktop:a"]);
  const people = createPeopleStore({
    now: () => t,
    deliver: (userId, address, message) => delivered.push({ userId, address, message }),
    present: (userId, address) => polling.has(`${userId} ${address}`),
    knocksPerDesktop: 3,
    knocksPerPoll: 2,
  });
  stoppable.push(people);
  const sender = { userId: "u1", address: "desktop:a" };
  const desk = { userId: "u2", address: "desktop:b" };
  const card = { email: "a@example.com", name: "A", identity: "ab".repeat(32), fingerprint: "abcd-abcd-abcd-abcd" };
  const send = (waitFor = { userId: "u2", files: 2, bytes: 20 }, recipients = []) =>
    people.knock(sender, { purpose: "send", card, recipients, waitFor });

  const first = send();
  assert.ok(isPersonSession(first.knock));
  assert.ok(isApprovalToken(first.token));
  assert.equal(people.waitsFor("u2"), true);
  assert.equal(people.waitsFor("u9"), false);
  // Three more from the one desktop, which keeps three: the oldest goes.
  const [second, third, fourth] = [send(), send(), send()];
  assert.deepEqual(people.invite(first.token), { ok: false, error: "invite_gone" });
  assert.equal(people.invite(second.token).invite.status, "waiting");
  assert.deepEqual(people.stats(), { sessions: 0, knocks: 3, waiting: 3 });

  // Two a poll, oldest first, none twice; one given back comes again.
  const due = people.claimWaiting(desk);
  assert.deepEqual(due, [second.knock, third.knock]);
  people.deliverWaiting(desk, due);
  assert.deepEqual(
    delivered.map(({ userId, address, message }) => [userId, address, message.type, message.data.files, message.data.approved]),
    [
      ["u2", "desktop:b", "knock", 2, false],
      ["u2", "desktop:b", "knock", 2, false],
    ]
  );
  assert.deepEqual(people.claimWaiting(desk), [fourth.knock]);
  people.releaseWaiting(desk, [fourth.knock]);
  assert.deepEqual(people.claimWaiting(desk), [fourth.knock]);
  people.deliverWaiting(desk, [fourth.knock]);
  assert.deepEqual(people.claimWaiting(desk), []);
  // Coming online again, all of them are due again.
  people.cameOnline("u2", "desktop:b");
  assert.deepEqual(people.claimWaiting(desk), [second.knock, third.knock]);

  // Approving tells the sessions still open, once.
  delivered.length = 0;
  assert.equal(people.approve(second.token).invite.status, "approved");
  assert.equal(people.approve(second.token).invite.status, "approved");
  assert.deepEqual(delivered.map(({ message }) => [message.type, message.data]), [["approved", {}]]);

  // A fourth send makes room again: the oldest, whose open session is told bye.
  delivered.length = 0;
  const own = send({ userId: "u1", files: null, bytes: null });
  assert.deepEqual(
    delivered.map(({ address, message }) => [address, message.type]),
    [["desktop:b", "bye"]]
  );
  assert.deepEqual(people.invite(second.token), { ok: false, error: "invite_gone" });
  // Its own account's send waits for its other desktops, never for itself.
  assert.deepEqual(people.claimWaiting(sender), []);
  assert.deepEqual(people.claimWaiting({ userId: "u1", address: "desktop:z" }), [own.knock]);

  // The sender stops polling: once the moment after a knock has passed, its sends are gone.
  polling.delete("u1 desktop:a");
  assert.equal(people.invite(own.token).ok, true, "knocked just now");
  t += 41_000;
  people.sweep();
  assert.deepEqual(people.stats(), { sessions: 2, knocks: 0, waiting: 0 });

  // A day at most, however long its sender polls; an ended one keeps its day too.
  polling.add("u1 desktop:a");
  const day = send();
  const ended = send();
  people.end(sender, ended.knock, "sent");
  people.end({ userId: "u2", address: "desktop:b" }, day.knock, "cancelled"); // not the knocker: nothing
  polling.delete("u1 desktop:a");
  t += 30_000;
  assert.equal(people.invite(day.token).ok, true);
  polling.add("u1 desktop:a");
  t += 24 * 60 * 60_000 - 30_001;
  assert.equal(people.invite(day.token).invite.status, "waiting");
  assert.equal(people.invite(ended.token).invite.status, "sent");
  t += 1;
  assert.deepEqual(people.invite(day.token), { ok: false, error: "invite_gone" });
  assert.deepEqual(people.invite(ended.token), { ok: false, error: "invite_gone" });
  assert.deepEqual(people.approve(null), { ok: false, error: "invite_gone" });
});

test("an email may go once per sender and recipient every 2 minutes, and 10 an hour per recipient", () => {
  let t = 0;
  const people = createPeopleStore({ now: () => t, deliver: () => {} });
  stoppable.push(people);
  assert.equal(people.mayEmail("s1", "r1"), true);
  assert.equal(people.mayEmail("s1", "r1"), false);
  assert.equal(people.mayEmail("s1", "r2"), true, "another recipient is another pair");
  t += 2 * 60_000 - 1;
  assert.equal(people.mayEmail("s1", "r1"), false);
  t += 1;
  assert.equal(people.mayEmail("s1", "r1"), true);
  for (let i = 2; i <= 9; i += 1) assert.equal(people.mayEmail(`s${i}`, "r1"), true, `sender ${i}`);
  assert.equal(people.mayEmail("s10", "r1"), false, "the eleventh within the hour, from anyone");
  assert.equal(people.mayEmail("s10", "r2"), true);
  t = 60 * 60_000;
  assert.equal(people.mayEmail("s11", "r1"), true, "the first is an hour old");
  assert.equal(people.mayEmail("s12", "r1"), false);
  people.sweep();
  t += 3 * 60 * 60_000;
  people.sweep();
  assert.equal(people.mayEmail("s1", "r1"), true, "swept, and room again");
});

test("nothing went wrong unnoticed", () => {
  assert.deepEqual(logged.filter((entry) => entry.level === "error"), []);
});
