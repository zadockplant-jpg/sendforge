// DropForge share links: a signed-in owner's phone page sends files to
// anyone, who needs no account (ForgeDrop/docs/share.md). The phone page
// makes a room and sends its link from its own email or number; the page the
// link opens (the website's /g/) reaches the sending page through the room,
// as a guest of the sender's account. The sender learns whether the address
// is a paid account, and one that is not gets one free transfer, kept in the
// database by a keyed hash of the address.
//
// As in forgedrop-link-requests.test.js, the HTTP tests run the real router,
// the real customer sign-in, and real users, entitlements, referral codes and
// licences against an in-process Postgres (PGlite). Every test gets a relay
// of its own (fresh stores, its own path, its own rate-limit names). The free
// transfers live in the database, so a new relay is what a deploy looks like
// to them. The stores' clock is a dial the tests turn; long-polls and the
// rate limiter use real time. The app trusts one proxy hop, as app.js does,
// so a test can call from several client addresses. A file of its own,
// because rate limiters are per process.

import assert from "node:assert/strict";
import crypto, { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import cors from "cors";
import express from "express";

import { attachPglite } from "./helpers/pglite-db.js";

const SEED = crypto.randomBytes(32).toString("base64");
process.env.LICENSE_SIGNING_KEY = SEED;
process.env.LICENSE_SIGNING_KID = "fd-test";
process.env.JWT_SECRET ||= "forgedrop-shares-test-secret-at-least-32-bytes";

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
const { forgedropFingerprint } = await import("../src/services/identityProof.service.js");
const { createForgeDropLinkRouter, SHARE_LIMITS } = await import("../src/modules/forgedrop-link/router.js");
const { createLinkStore } = await import("../src/modules/forgedrop-link/store.js");
const { createShareStore } = await import("../src/modules/forgedrop-link/shares.js");
const { createFreeTransfers, FREE_TRANSFERS_TABLE, personOf } = await import(
  "../src/modules/forgedrop-link/freeTransfers.js"
);
const { GUEST_TYPES, isShareId, PHONE_TO_GUEST_TYPES } = await import("../src/modules/forgedrop-link/shapes.js");

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
const desktops = {};
// Every room any test made, and every address one was made for: none of
// them may ever reach the log.
const made = [];
const addresses = [];
let detach;
let server;
let origin;

const app = express();
// As app.js: behind one proxy, whose X-Forwarded-For says who called.
app.set("trust proxy", 1);
// app.js runs the app-wide form parser ahead of every router; so does this.
app.use(express.urlencoded({ extended: false }));

async function signUp(name, { email = `${name}@example.com`, verified = true, owns = true } = {}) {
  const id = randomUUID();
  await db("users").insert({ id, email, email_verified: verified });
  if (owns) await grantProductEntitlement({ userId: id, productSlug: "forgedrop", source: "test" });
  accounts[name] = { id, email, bearer: issueCustomerAccessToken({ id, email }) };
  addresses.push(email);
  return accounts[name];
}

before(async () => {
  detach = await attachPglite(db);
  // requireAuth reads auth_version; the shared helper's users table predates it.
  await db.schema.alterTable("users", (t) => t.integer("auth_version").defaultTo(0));

  // Alice and Dana send: Alice already has a referral code, Dana has never
  // asked for hers. Bob owns DropForge, and so does Legacy, whose email was
  // stored before emails were lower case: both are paid accounts. Erin owns
  // it but never verified her email; Carol, Fran and Later never bought it.
  const alice = await signUp("alice");
  await signUp("dana");
  await signUp("bob");
  await signUp("legacy", { email: "Legacy.User@Example.com" });
  await signUp("erin", { verified: false });
  await signUp("carol", { owns: false });
  await signUp("fran", { owns: false });
  await signUp("later", { owns: false });
  await db("referral_codes").insert({
    id: randomUUID(),
    user_id: alice.id,
    email: alice.email,
    code: "ALICESHARE",
    status: "active",
  });

  // Alice's desktop, with a proven key: it asks for files, and the page of
  // that request is a guest no phone may reach.
  const raw = crypto.randomBytes(32);
  const activated = await activateDevice({
    userId: alice.id,
    productSlug: "forgedrop",
    deviceId: randomUUID(),
    deviceName: "Studio PC",
    platform: "windows",
    appVersion: "2.0.2",
    identityFingerprint: forgedropFingerprint(raw),
    identityPublicKey: raw.toString("hex"),
    deviceLimit: 20,
  });
  desktops.studio = { token: activated.token, address: `desktop:${activated.deviceId}` };

  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const running of stoppable) running.stop();
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

/** A response as [status, body], to compare in one go. */
const answer = async (response) => {
  const res = await response;
  return [res.status, res.body];
};

// Limits off, except in the tests about them.
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
  requestPerMinute: 1e6,
  requestPagePerMinute: 1e6,
  shareCreatePerHour: 1e6,
  shareEndPerMinute: 1e6,
  sharePagePerMinute: 1e6,
};

const newClientId = () => crypto.randomBytes(16).toString("base64url"); // 22 characters
const newSession = () => crypto.randomBytes(12).toString("base64url"); // 16 characters
const newShareId = () => crypto.randomBytes(16).toString("base64url"); // 22 characters, nobody's

/** An address nobody has sent to yet: not an account at all. */
function newcomer() {
  const address = `newcomer-${crypto.randomBytes(5).toString("hex")}@example.net`;
  addresses.push(address);
  return address;
}

/**
 * What the database keeps an address as: HMAC-SHA256 of it, trimmed and in
 * lower case, under a key derived from JWT_SECRET the way the install
 * tokens' key is.
 */
function keptAs(address) {
  const key = createHmac("sha256", env.jwtSecret).update("sendforge-forgedrop-free-transfer/v1").digest();
  return createHmac("sha256", key).update(address.trim().toLowerCase()).digest("hex");
}
const keptRows = (address) => db(FREE_TRANSFERS_TABLE).where({ address_hash: keptAs(address) }).select("*");

let relays = 0;

/**
 * A relay of its own: a fresh router and stores, at a path of its own.
 * `withCors` puts app.js's CORS in front, as the real API has it; `store`
 * gives it a link store made for the test; `secret` is what free transfers
 * are keyed from, and `freeTransfers` stands in for the database's record.
 */
function relay({
  rate = UNLIMITED,
  withCors = false,
  store: givenStore = null,
  secret = () => env.jwtSecret,
  freeTransfers = null,
} = {}) {
  relays += 1;
  const base = `/relay-${relays}`;
  const store = givenStore || createLinkStore({ now });
  const shares = createShareStore({ now });
  stoppable.push(store, shares);
  const emails = [];
  const router = createForgeDropLinkRouter({
    db,
    requireAuth,
    hasProductEntitlement,
    signingKey: () => env.licenseSigningKey,
    now,
    log,
    store,
    shares,
    freeTransferSecret: secret,
    freeTransfers,
    sendRequestEmail: async (message) => {
      emails.push(message);
    },
    requestLink: (token) => `https://sendforge.test/s/#${token}`,
    rate,
    rateLimitPrefix: `fd-shares-${relays}`,
  });
  if (withCors) app.use(base, cors({ origin: true, credentials: true }), router);
  else app.use(base, router);

  const at = (path, options = {}) => call(path, { base, ...options });

  /** Messages as a poll gave them, each without the time it was sent. */
  const unstamped = (messages) =>
    messages.map(({ sentAt, ...message }) => {
      assert.equal(new Date(sentAt).toISOString(), sentAt, "sentAt is ISO-8601");
      return message;
    });

  /** A phone page of `account`, as /drop/ runs it: a clientId of its own. */
  function phone(account, { clientId = newClientId(), name = "Alice's iPhone" } = {}) {
    const poll = (wait = 0, options = {}) =>
      at("/phone/poll", { bearer: account.bearer, body: { clientId, wait }, ...options });
    return {
      clientId,
      address: `phone:${clientId}`,
      poll,
      async mail() {
        const res = await poll(0);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return unstamped(res.body.messages);
      },
      async create(body = {}) {
        const res = await at("/share/create", { bearer: account.bearer, body: { clientId, name, ...body } });
        if (res.status === 201) made.push(res.body.share);
        return res;
      },
      end: (share, extra = {}) => at("/share/end", { bearer: account.bearer, body: { share, ...extra } }),
      /** /signal as the page sends it, naming itself; `from` may be overridden. */
      signal: (body) => at("/signal", { bearer: account.bearer, body: { from: `phone:${clientId}`, ...body } }),
    };
  }

  /** A share's page, as its link opens it: the room's id and a clientId of its own. */
  function page(share, { clientId = newClientId(), from } = {}) {
    const headers = from ? { "X-Forwarded-For": from } : {};
    const post = (path, body = {}) => at(path, { body: { share, ...body }, headers });
    const poll = (wait = 0, options = {}) =>
      at("/share/poll", { body: { share, clientId, wait }, headers, ...options });
    return {
      clientId,
      address: `guest:${clientId}`,
      open: () => post("/share/open"),
      poll,
      signal: (body) => post("/share/signal", { clientId, ...body }),
      offer: (session = newSession(), data = { sdp: "v=0 offer" }) =>
        post("/share/signal", { clientId, session, type: "offer", data }),
      received: () => post("/share/received"),
      async mail() {
        const res = await poll(0);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return unstamped(res.body.messages);
      },
    };
  }

  return {
    store,
    shares,
    emails,
    call: at,
    phone,
    page,

    /** `account`'s phone page, polling, makes a room: for Bob's paid address unless told otherwise. */
    async start(account = accounts.alice, body = {}) {
      const sender = phone(account);
      assert.equal((await sender.poll()).status, 200);
      const res = await sender.create({ to: "bob@example.com", ...body });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return { sender, share: res.body.share, body: res.body };
    },

    /**
     * A page takes the room with its offer and the sending page answers: a
     * connection, as far as this server ever sees one.
     */
    async connect({ sender, share }) {
      const guest = page(share);
      const session = newSession();
      assert.equal((await guest.offer(session)).status, 202);
      const answered = await sender.signal({ to: guest.address, session, type: "answer", data: { sdp: "v=0 answer" } });
      assert.equal(answered.status, 202, JSON.stringify(answered.body));
      return guest;
    },
  };
}

// ------------------------------------------------------------- making rooms

test("a phone page makes a room for an email: its id, whether the address is a paid account, and the sender's referral code", async () => {
  const r = relay();
  const sender = r.phone(accounts.alice);
  const ids = [];
  const create = async (to) => {
    const res = await sender.create({ to });
    assert.equal(res.status, 201, `${to}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(Object.keys(res.body).sort(), ["paid", "referral", "share"], to);
    assert.ok(isShareId(res.body.share), res.body.share);
    assert.equal(res.headers.get("cache-control"), "no-store");
    ids.push(res.body.share);
    return res.body;
  };

  // A verified account that owns DropForge, however the address is written,
  // and one whose email was stored before emails were lower case.
  for (const to of ["bob@example.com", "  BOB@Example.COM ", "legacy.user@example.com"]) {
    const body = await create(to);
    assert.deepEqual([body.paid, body.referral], [true, "ALICESHARE"], to);
  }

  // Nobody, an owner who never verified their email and an account that does
  // not own DropForge are all not paid, alike: the database is asked the same
  // questions for each, so not even the time says which has an account. The
  // first makes the free transfers' table, which is not there before.
  assert.equal(await db.schema.hasTable(FREE_TRANSFERS_TABLE), false);
  assert.equal((await create(newcomer())).paid, false);
  assert.equal(await db.schema.hasTable(FREE_TRANSFERS_TABLE), true, "made the first time it is needed");
  const asked = [];
  for (const to of [newcomer(), "erin@example.com", "carol@example.com"]) {
    const counting = countQueries();
    const body = await create(to);
    asked.push(counting.stop().length);
    assert.deepEqual([body.paid, body.referral], [false, "ALICESHARE"], to);
  }
  assert.equal(new Set(asked).size, 1, `questions per room: ${asked}`);
  assert.equal(new Set(ids).size, ids.length, "an id each");
  assert.deepEqual(r.shares.stats(), { shares: 7 });

  // A sender who never had a referral code gets theirs, made as their account
  // page would make it, and the same one every time.
  const dana = r.phone(accounts.dana, { name: "Dana's Pixel" });
  const first = await dana.create({ to: "bob@example.com" });
  const codes = await db("referral_codes").where({ user_id: accounts.dana.id, status: "active" });
  assert.equal(codes.length, 1);
  assert.match(codes[0].code, /^DANA\d{4}$/);
  assert.equal(first.body.referral, codes[0].code);
  assert.equal((await dana.create({ to: newcomer() })).body.referral, codes[0].code);
});

test("making a room is refused for a bad clientId, name or email, in that order, and its name is cleaned as a device name is", async () => {
  const r = relay();
  const clientId = newClientId();
  const create = (patch) =>
    r.call("/share/create", {
      bearer: accounts.alice.bearer,
      body: { clientId, name: "Alice's iPhone", to: "bob@example.com", ...patch },
    });
  const refused = async (patch, error, note) =>
    assert.deepEqual(await answer(create(patch)), [400, { error }], note);

  for (const bad of [undefined, "short", `${"x".repeat(21)}!`, "x".repeat(65), 7]) {
    await refused({ clientId: bad }, "bad_client_id", JSON.stringify(bad));
  }
  for (const name of [undefined, null, "", "   ", "\u0000\n\t", 7, ["Alice"]]) {
    await refused({ name }, "bad_name", JSON.stringify(name));
  }
  for (const to of [undefined, "", "bob", "bob@", "bob@example", 7, ["bob@example.com"]]) {
    await refused({ to }, "bad_email", JSON.stringify(to));
  }
  await refused({ clientId: "short", name: "", to: "bob" }, "bad_client_id", "the clientId first");
  await refused({ name: "", to: "bob" }, "bad_name", "then the name");
  assert.deepEqual(r.shares.stats(), { shares: 0 });

  // Control characters become spaces, the ends are trimmed, and it is cut at
  // 64 characters, however many UTF-16 units they take.
  const res = await create({ name: `  Alice's\u0000iPhone ${"\u{1F600}".repeat(70)}\n` });
  assert.equal(res.status, 201);
  made.push(res.body.share);
  assert.equal((await r.page(res.body.share).open()).body.name, `Alice's iPhone ${"\u{1F600}".repeat(49)}`);
});

test("making and ending rooms take a phone's sign-in, for an account that owns DropForge", async () => {
  const r = relay();
  const body = { clientId: newClientId(), name: "Phone", to: "bob@example.com", share: newShareId() };
  for (const path of ["/share/create", "/share/end"]) {
    assert.deepEqual(await answer(r.call(path, { body })), [401, { error: "missing_token" }], path);
    assert.deepEqual(await answer(r.call(path, { bearer: "not-a-jwt", body })), [401, { error: "invalid_token" }], path);
    // A desktop's licence is not a phone's sign-in.
    assert.deepEqual(
      await answer(r.call(path, { licence: desktops.studio.token, body })),
      [401, { error: "missing_token" }],
      path
    );
    assert.deepEqual(
      await answer(r.call(path, { bearer: accounts.carol.bearer, body })),
      [403, { error: "entitlement_required" }],
      path
    );
  }
  assert.deepEqual(r.shares.stats(), { shares: 0 });

  // Ownership is read on every request: buying DropForge works at once.
  const fran = r.phone(accounts.fran);
  assert.equal((await fran.create({ to: "bob@example.com" })).status, 403);
  await grantProductEntitlement({ userId: accounts.fran.id, productSlug: "forgedrop", source: "test" });
  assert.equal((await fran.create({ to: "bob@example.com" })).status, 201);
});

// ----------------------------------------------------------------- the page

test("the page opens a room: its page's name, whether that page is there now, whether the address is paid, and the referral", async () => {
  const r = relay();
  const sender = r.phone(accounts.alice, { name: "Alice's iPhone" });
  const res = await sender.create({ to: newcomer() }); // before the phone page has polled
  assert.equal(res.status, 201);
  const guest = r.page(res.body.share);

  const closed = await guest.open();
  assert.deepEqual(
    [closed.status, closed.body],
    [200, { name: "Alice's iPhone", online: false, paid: false, referral: "ALICESHARE" }],
    "no sign-in, and its page not polling"
  );
  assert.equal(closed.headers.get("cache-control"), "no-store");

  // Online while the page that made it polls, and for a minute after, as a
  // phone is present.
  await sender.poll();
  assert.equal((await guest.open()).body.online, true);
  advance(59_000);
  assert.equal((await guest.open()).body.online, true);
  advance(2_000);
  assert.equal((await guest.open()).body.online, false, "a minute without a word");
  // Another page of the same account is not the one that made it.
  await r.phone(accounts.alice).poll();
  assert.equal((await guest.open()).body.online, false);

  // A room for a paid account says so.
  const paid = await sender.create({ to: "bob@example.com" });
  assert.deepEqual((await r.page(paid.body.share).open()).body, {
    name: "Alice's iPhone",
    online: false,
    paid: true,
    referral: "ALICESHARE",
  });
});

test("the first offer claims the room and reaches the sending page, with data.share set by this server, and its answer comes back", async () => {
  const r = relay();
  const alice = accounts.alice;
  const { sender, share } = await r.start();
  const other = r.phone(alice);
  await other.poll();
  const guest = r.page(share);
  const session = newSession();

  const waiting = guest.poll(20);
  await until(() => r.store.waiting(alice.id, guest.address), "the page's poll");
  const offered = await guest.signal({
    session,
    type: "offer",
    // What the page says about the room is not what the sending page is told,
    // and whomever it names, only that page is told anything.
    data: { sdp: "v=0 offer", share: { id: newShareId(), name: "someone else" }, to: "phone:elsewhere" },
    to: other.address,
  });
  assert.deepEqual([offered.status, offered.body], [202, { ok: true }]);
  assert.deepEqual(await sender.mail(), [
    {
      from: guest.address,
      session,
      type: "offer",
      data: { sdp: "v=0 offer", to: "phone:elsewhere", share: { id: share } },
    },
  ]);

  // The phone answers through /signal, and the page's poll wakes.
  const started = Date.now();
  const answered = await sender.signal({ to: guest.address, session, type: "answer", data: { sdp: "v=0 answer" } });
  assert.deepEqual([answered.status, answered.body], [202, { ok: true }]);
  const woken = await waiting;
  assert.ok(Date.now() - started < 2000, "woken by the answer, not by the 20 s wait");
  assert.deepEqual(
    woken.body.messages.map(({ sentAt, ...message }) => message),
    [{ from: sender.address, session, type: "answer", data: { sdp: "v=0 answer" } }]
  );

  // Either side may say bye; data defaults to {}, and the room is still said.
  assert.equal((await guest.signal({ session, type: "bye" })).status, 202);
  assert.deepEqual((await sender.mail()).map((m) => [m.type, m.data]), [["bye", { share: { id: share } }]]);
  assert.equal((await sender.signal({ to: guest.address, session, type: "bye" })).status, 202);
  assert.deepEqual((await guest.mail()).map((m) => [m.from, m.type]), [[sender.address, "bye"]]);

  // Its claimant may try again on a new session, after failing to connect.
  const again = newSession();
  assert.equal((await guest.offer(again)).status, 202);
  assert.deepEqual((await sender.mail()).map((m) => [m.session, m.type]), [[again, "offer"]]);
  assert.deepEqual(await other.mail(), [], "another page of the account heard nothing");

  // A page that just spoke is there before it has polled at all: the
  // answer waits for its first poll.
  const second = await r.start();
  const quick = r.page(second.share);
  assert.equal((await quick.offer(session)).status, 202);
  assert.equal((await second.sender.signal({ to: quick.address, session, type: "answer", data: {} })).status, 202);
  assert.deepEqual((await quick.mail()).map((m) => m.type), ["answer"]);
});

test("the first page to offer takes the room: any other gets share_taken, and the sending page never hears it", async () => {
  const r = relay();
  const { sender, share } = await r.start();
  const first = r.page(share);
  const second = r.page(share);
  const taken = async (response, note) => assert.deepEqual(await answer(response), [409, { error: "share_taken" }], note);

  // A bye before any offer has nothing to end: it claims nothing and reaches nobody.
  assert.deepEqual(await answer(second.signal({ session: newSession(), type: "bye" })), [202, { ok: true }]);
  assert.deepEqual(await sender.mail(), []);

  assert.equal((await first.offer()).status, 202);
  await taken(second.offer(), "another page's offer");
  await taken(second.signal({ session: newSession(), type: "bye" }), "and its bye");
  assert.deepEqual((await sender.mail()).map((m) => [m.from, m.type]), [[first.address, "offer"]]);

  // The page that took it keeps it.
  assert.equal((await first.signal({ session: newSession(), type: "bye" })).status, 202);
  assert.equal((await first.offer()).status, 202);
  assert.deepEqual((await sender.mail()).map((m) => [m.from, m.type]), [
    [first.address, "bye"],
    [first.address, "offer"],
  ]);

  // Taken is taken while the sender is away too: there is nothing to wait for.
  advance(61_000);
  await taken(second.offer(), "while the sender is away");
  assert.deepEqual(await answer(first.offer()), [404, { error: "sender_offline" }]);

  // A page that did not take it may still look, and polls only its own
  // mailbox, as a request's page does.
  assert.equal((await second.open()).status, 200);
  assert.deepEqual(await second.mail(), []);
});

test("an offer while the sending page is away is sender_offline, and claims nothing", async () => {
  const r = relay();
  const sender = r.phone(accounts.alice);
  const res = await sender.create({ to: "bob@example.com" }); // it has not polled yet
  const early = r.page(res.body.share);
  const offline = async (guest, note) =>
    assert.deepEqual(await answer(guest.offer()), [404, { error: "sender_offline" }], note);

  await offline(early, "never polled");
  // Another page of the same account being there is not the sending page being there.
  await r.phone(accounts.alice).poll();
  await offline(early, "another page polls");

  await sender.poll();
  const other = r.page(res.body.share);
  assert.equal((await other.offer()).status, 202, "the early offers claimed nothing");
  assert.deepEqual(await answer(early.offer()), [409, { error: "share_taken" }]);
  assert.deepEqual((await sender.mail()).map((m) => m.from), [other.address], "nothing refused reached it");

  // A minute without a poll, and it is away again.
  advance(61_000);
  await offline(other, "a minute without a word");
  await sender.poll();
  assert.equal((await other.offer()).status, 202);
  assert.deepEqual((await sender.mail()).map((m) => m.from), [other.address]);
});

test("a phone answers only the guest that claimed one of its own rooms, and still reaches no other guest", async () => {
  const r = relay();
  const { alice, dana } = accounts;
  const { sender, share } = await r.start();
  const guest = r.page(share);
  const session = newSession();
  const expect = async (response, status, error, note) =>
    assert.deepEqual(await answer(response), [status, { error }], note);
  const answerFrom = (from, to) => from.signal({ to: to.address, session, type: "answer", data: { sdp: "a" } });

  // There, but not yet its guest: it has claimed nothing.
  assert.equal((await guest.poll()).status, 200);
  await expect(answerFrom(sender, guest), 400, "bad_recipient", "before it claims the room");
  assert.equal((await guest.offer(session)).status, 202);
  assert.equal((await answerFrom(sender, guest)).status, 202);
  assert.deepEqual((await guest.mail()).map((m) => [m.from, m.type]), [[sender.address, "answer"]]);

  // Its own guest takes an answer or a bye, and nothing else...
  assert.equal((await sender.signal({ to: guest.address, session, type: "bye" })).status, 202);
  for (const type of ["offer", "dial", "here", undefined]) {
    await expect(sender.signal({ to: guest.address, session, type }), 400, "bad_type", String(type));
  }
  // ...and only from the page that made the room, naming itself as a phone.
  for (const from of [undefined, "phone:short", `desktop:${randomUUID()}`, guest.address]) {
    await expect(sender.signal({ to: guest.address, from, session, type: "answer" }), 400, "bad_recipient", String(from));
  }

  // A page on the same room that polls but never claimed it.
  const onlooker = r.page(share);
  assert.equal((await onlooker.poll()).status, 200);
  await expect(answerFrom(sender, onlooker), 400, "bad_recipient", "a page that claimed nothing");

  // Another page of the same account: the guest claimed the first page's room.
  const other = r.phone(alice);
  await other.poll();
  await expect(answerFrom(other, guest), 400, "bad_recipient", "another page of the account");
  // Its own room's guest is its own, and not the first page's.
  const second = await other.create({ to: "bob@example.com" });
  const theirs = r.page(second.body.share);
  assert.equal((await theirs.offer(session)).status, 202);
  assert.equal((await answerFrom(other, theirs)).status, 202);
  await expect(answerFrom(sender, theirs), 400, "bad_recipient", "another page's room's guest");

  // Another account's phone, even using the sending page's own clientId:
  // rooms are filed under their account.
  const impostor = r.phone(dana, { clientId: sender.clientId });
  await impostor.poll();
  await expect(answerFrom(impostor, guest), 400, "bad_recipient", "another account");

  // A request page's guest (1.9) is its asking desktop's to answer, never a phone's.
  const { studio } = desktops;
  assert.equal((await r.call("/desktop/poll", { licence: studio.token, body: { wait: 0, caps: ["phone-link"] } })).status, 200);
  assert.equal((await r.call("/person/request", { licence: studio.token, body: { to: "bob@example.com" } })).status, 202);
  const requestUrl = r.emails.at(-1).requestUrl;
  const token = requestUrl.slice(requestUrl.indexOf("#") + 1);
  const asked = { clientId: newClientId() };
  asked.address = `guest:${asked.clientId}`;
  assert.equal((await r.call("/request/poll", { body: { token, clientId: asked.clientId, wait: 0 } })).status, 200);
  await expect(answerFrom(sender, asked), 400, "bad_recipient", "a request page's guest");
  assert.equal(
    (await r.call("/signal", { licence: studio.token, body: { to: asked.address, session, type: "answer" } })).status,
    202,
    "its desktop still answers it"
  );

  // Nobody that was refused was told anything.
  assert.deepEqual(await onlooker.mail(), []);
  assert.deepEqual((await r.call("/request/poll", { body: { token, clientId: asked.clientId, wait: 0 } })).body.messages.map((m) => m.from), [studio.address]);

  // A guest quiet for a minute is gone, as any guest is.
  advance(61_000);
  await sender.poll();
  await expect(sender.signal({ to: guest.address, session, type: "bye" }), 404, "phone_gone", "quiet for a minute");
  // And once its room has ended, the guest is no longer the phone's, there or not.
  assert.equal((await guest.poll()).status, 200);
  assert.equal((await sender.end(share)).status, 200);
  await expect(sender.signal({ to: guest.address, session, type: "bye" }), 400, "bad_recipient", "after its room ended");
});

test("the page's signals and polls are checked as a request page's are, and a room's id is its only key", async () => {
  const r = relay();
  const { sender, share } = await r.start();
  const guest = r.page(share);
  const expect = async (response, status, error, note) =>
    assert.deepEqual(await answer(response), [status, { error }], note);
  const send = (patch) =>
    r.call("/share/signal", {
      body: { share, clientId: guest.clientId, session: newSession(), type: "offer", data: {}, ...patch },
    });

  for (const clientId of [undefined, "short", `${"x".repeat(21)}!`, "x".repeat(65), 7]) {
    await expect(send({ clientId }), 400, "bad_client_id", JSON.stringify(clientId));
    await expect(r.call("/share/poll", { body: { share, clientId, wait: 0 } }), 400, "bad_client_id");
  }
  for (const session of [undefined, "x".repeat(15), "x".repeat(65), "has spaces in it ok"]) {
    await expect(send({ session }), 400, "bad_session", JSON.stringify(session));
  }
  for (const type of ["answer", "dial", "here", "OFFER", undefined, 7]) {
    await expect(send({ type }), 400, "bad_type", String(type));
  }
  for (const data of [[], "sdp", null, 7]) await expect(send({ data }), 400, "bad_data", JSON.stringify(data));
  // {"sdp":""} is 10 bytes.
  const exactly = { sdp: "x".repeat(32 * 1024 - 10) };
  assert.equal((await send({ data: exactly })).status, 202, "exactly 32 KiB is allowed");
  await expect(send({ data: { sdp: `${exactly.sdp}x` } }), 413, "data_too_large");
  await expect(guest.poll("soon"), 400, "bad_wait");
  assert.deepEqual(
    (await sender.mail()).map((m) => [m.type, m.data.sdp.length, m.data.share.id]),
    [["offer", exactly.sdp.length, share]]
  );

  // A malformed id is as gone as an unknown one, on every one of its routes.
  const gone = async (id, note) => {
    const lost = r.page(id);
    for (const res of [await lost.open(), await lost.poll(), await lost.offer(), await lost.received()]) {
      assert.deepEqual([res.status, res.body], [404, { error: "share_gone" }], note);
    }
  };
  await gone(newShareId(), "well formed, but nobody's");
  for (const id of [undefined, null, "", "short", share.slice(1), `${share}A`, 7, [share], { id: share }]) {
    await gone(id, JSON.stringify(id));
  }
  assert.deepEqual(await answer(r.call("/share/open", {})), [404, { error: "share_gone" }], "no body at all");
});

// ------------------------------------------------------- ending and expiry

test("the sender ends a room: its link then says share_gone, and only its own account can end it", async () => {
  const r = relay();
  const { sender, share } = await r.start();
  const guest = r.page(share);
  const session = newSession();
  assert.equal((await guest.offer(session)).status, 202);
  const waiting = guest.poll(20);
  await until(() => r.store.waiting(accounts.alice.id, guest.address), "the page's poll");

  // Another account is answered the same, and ends nothing.
  assert.deepEqual(await answer(r.phone(accounts.dana).end(share)), [200, { ok: true }]);
  assert.equal((await guest.open()).status, 200);

  // The phone says bye to its guest, then ends the room: the bye still
  // reaches the page's waiting poll.
  assert.equal((await sender.signal({ to: guest.address, session, type: "bye" })).status, 202);
  assert.deepEqual(await answer(sender.end(share)), [200, { ok: true }]);
  assert.deepEqual((await waiting).body.messages.map((m) => [m.from, m.type]), [[sender.address, "bye"]]);
  for (const res of [await guest.open(), await guest.poll(), await guest.offer(), await guest.received()]) {
    assert.deepEqual([res.status, res.body], [404, { error: "share_gone" }]);
  }

  // Ending it again, or a room that never was, is answered the same.
  for (const id of [share, newShareId()]) assert.deepEqual(await answer(sender.end(id)), [200, { ok: true }]);
  // A malformed id or "sent" is refused.
  for (const id of [undefined, null, "", "short", `${share}A`, 7]) {
    assert.deepEqual(await answer(sender.end(id)), [400, { error: "bad_share" }], JSON.stringify(id));
  }
  for (const sent of ["yes", 1, 0, {}, []]) {
    assert.deepEqual(await answer(sender.end(share, { sent })), [400, { error: "bad_sent" }], JSON.stringify(sent));
  }
  assert.deepEqual(r.shares.stats(), { shares: 0 });
});

test("a room is gone a day after it was made, and with it the phone's way to its guest", async () => {
  const r = relay();
  const { sender, share } = await r.start();
  const guest = r.page(share);
  const session = newSession();
  assert.equal((await guest.offer(session)).status, 202);

  advance(24 * 60 * 60_000 - 1);
  assert.equal((await guest.open()).status, 200);
  await sender.poll();
  await guest.poll();
  assert.equal((await sender.signal({ to: guest.address, session, type: "answer", data: {} })).status, 202);

  advance(1);
  for (const res of [await guest.open(), await guest.poll(), await guest.offer(session), await guest.received()]) {
    assert.deepEqual([res.status, res.body], [404, { error: "share_gone" }]);
  }
  assert.deepEqual(
    await answer(sender.signal({ to: guest.address, session, type: "bye" })),
    [400, { error: "bad_recipient" }],
    "its guest is still there, but no longer the phone's"
  );
  assert.deepEqual(r.shares.stats(), { shares: 0 });
});

test("an account keeps ten rooms open, the oldest ended first, apart from other accounts", async () => {
  const r = relay();
  const alice = r.phone(accounts.alice);
  const dana = r.phone(accounts.dana);
  const make = async (phone) => {
    const res = await phone.create({ to: "bob@example.com" });
    assert.equal(res.status, 201);
    return res.body.share;
  };
  const opens = async (id) => (await r.page(id).open()).status;

  const mine = [];
  for (let i = 0; i < 10; i += 1) mine.push(await make(alice));
  const theirs = [];
  for (let i = 0; i < 10; i += 1) theirs.push(await make(dana));
  for (const id of [...mine, ...theirs]) assert.equal(await opens(id), 200);

  mine.push(await make(alice));
  assert.equal(await opens(mine[0]), 404, "the oldest made room");
  for (const id of [...mine.slice(1), ...theirs]) assert.equal(await opens(id), 200);

  // A room its sender ended no longer counts.
  assert.equal((await alice.end(mine[5])).status, 200);
  mine.push(await make(alice));
  assert.equal(await opens(mine[1]), 200, "no other room had to end");
  assert.deepEqual(r.shares.stats(), { shares: 20 });
});

// ------------------------------------------------------------------ limits

test("making rooms is limited to 20 an hour per account, whatever the answer", async () => {
  const r = relay({ rate: {} }); // the documented limits
  const one = r.phone(accounts.alice);
  const two = r.phone(accounts.alice);
  let last = null;
  for (let i = 1; i <= 20; i += 1) {
    const res = await (i % 2 ? one : two).create({ to: i === 20 ? "not an email" : "bob@example.com" });
    assert.equal(res.status, i === 20 ? 400 : 201, `room ${i}`);
    if (res.status === 201 && i % 2) last = res.body.share;
  }
  const limited = await one.create({ to: "bob@example.com" });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 59 * 60, "an hour's allowance, not a minute's");
  assert.equal((await two.create({ to: "bob@example.com" })).status, 429, "per account, whichever of its pages");
  assert.equal((await r.phone(accounts.dana).create({ to: "bob@example.com" })).status, 201, "another account has its own");
  // Ending is not held up by it.
  assert.deepEqual(await answer(one.end(last)), [200, { ok: true }]);
});

test("a share page's routes take no sign-in, are limited per address together and per guest's polls, and answer the website across origins", async () => {
  const r = relay({ rate: { ...UNLIMITED, sharePagePerMinute: 60 }, withCors: true });
  const { share } = await r.start();

  // The website asks first, as a browser does before a JSON POST to another origin.
  const site = "https://sendforge.app";
  for (const path of ["/share/open", "/share/poll", "/share/signal", "/share/received"]) {
    const preflight = await r.call(path, {
      method: "OPTIONS",
      headers: { Origin: site, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(preflight.status, 204, path);
    assert.equal(preflight.headers.get("access-control-allow-origin"), site, path);
    assert.match(preflight.headers.get("access-control-allow-methods"), /POST/, path);
    assert.match(preflight.headers.get("access-control-allow-headers"), /content-type/i, path);
  }
  const looked = await r.call("/share/open", { body: { share }, headers: { Origin: site } });
  assert.equal(looked.status, 200, "with no licence and no sign-in");
  assert.equal(looked.headers.get("access-control-allow-origin"), site);

  // Sixty a minute from one address, the four routes together; another
  // address has its own allowance, and a request page's is apart from it.
  const one = r.page(share, { from: "203.0.113.7" });
  const calls = [one.open, () => one.poll(), () => one.signal({ session: newSession(), type: "bye" }), one.received];
  for (let i = 1; i <= 60; i += 1) {
    const res = await calls[i % 4]();
    assert.notEqual(res.status, 429, `call ${i}`);
  }
  const limited = await one.open();
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.match(limited.headers.get("retry-after"), /^[1-9]\d*$/);
  assert.equal((await one.received()).status, 429);
  assert.equal((await r.page(share, { from: "203.0.113.8" }).open()).status, 200);
  const request = await r.call("/request/open", {
    body: { token: "A".repeat(43) },
    headers: { "X-Forwarded-For": "203.0.113.7" },
  });
  assert.deepEqual([request.status, request.body], [404, { error: "request_gone" }]);

  // And sixty polls a minute from one guest, from however many addresses.
  const clientId = newClientId();
  for (let i = 1; i <= 60; i += 1) {
    const res = await r.page(share, { clientId, from: `198.51.100.${i}` }).poll();
    assert.equal(res.status, 200, `poll ${i}`);
  }
  assert.equal((await r.page(share, { clientId, from: "198.51.100.200" }).poll()).status, 429);
  assert.equal((await r.page(share, { from: "198.51.100.201" }).poll()).status, 200, "another guest has its own");
});

test("a share's guests are counted with request pages' guests, never against the account's phones", async () => {
  const store = createLinkStore({ now, phonesPerAccount: 2, guestsPerAccount: 2 });
  const r = relay({ store });
  const alice = accounts.alice;
  const { sender, share } = await r.start();
  const other = r.phone(alice);
  await other.poll();

  const guests = [r.page(share), r.page(share), r.page(share)];
  for (const guest of guests) {
    advance(1);
    assert.equal((await guest.poll()).status, 200);
  }
  assert.equal(store.isPresent(alice.id, guests[0].address), false, "the stalest guest made room");
  assert.equal(store.isPresent(alice.id, guests[2].address), true);
  for (const page of [sender, other]) assert.equal(store.isPresent(alice.id, page.address), true, "and no phone did");
  assert.equal((await r.page(share).open()).body.online, true);
});

// ------------------------------------------------------ the free transfer

test("an address that is not a paid account gets one free transfer, used once a transfer to it has finished, by either page's word", async () => {
  const r = relay();
  const to = newcomer();
  const kept = async () => (await keptRows(to)).length;

  // Claimed, then cancelled: nothing went, so nothing is used.
  const cancelled = await r.start(accounts.alice, { to });
  assert.equal(cancelled.body.paid, false);
  await r.connect(cancelled);
  assert.deepEqual(await answer(cancelled.sender.end(cancelled.share, { sent: false })), [200, { ok: true }]);
  assert.equal(await kept(), 0);
  const plain = await r.start(accounts.alice, { to });
  await r.connect(plain);
  assert.equal((await plain.sender.end(plain.share)).status, 200);
  assert.equal(await kept(), 0);

  // Before a page has claimed a room nothing can have gone through it, so
  // neither word counts yet.
  const unclaimed = await r.start(accounts.alice, { to });
  assert.deepEqual(await answer(r.page(unclaimed.share).received()), [200, { ok: true }]);
  assert.deepEqual(await answer(unclaimed.sender.end(unclaimed.share, { sent: true })), [200, { ok: true }]);
  assert.equal(await kept(), 0);

  // The page's word, after a transfer.
  const room = await r.start(accounts.alice, { to });
  const guest = await r.connect(room);
  assert.deepEqual(await answer(guest.received()), [200, { ok: true }]);
  assert.equal(await kept(), 1);
  const [row] = await keptRows(to);
  // Said again, and by the sender too: the same as once.
  assert.deepEqual(await answer(guest.received()), [200, { ok: true }]);
  assert.deepEqual(await answer(room.sender.end(room.share, { sent: true })), [200, { ok: true }]);
  assert.deepEqual(await keptRows(to), [row]);

  // From now on any account's new room for it is refused, however the address is written.
  for (const [account, written] of [
    [accounts.alice, to],
    [accounts.dana, `  ${to.toUpperCase()} `],
  ]) {
    assert.deepEqual(
      await answer(r.phone(account).create({ to: written })),
      [409, { error: "free_transfer_used" }],
      written
    );
  }

  // The sender's word counts as the page's does.
  const other = newcomer();
  const theirs = await r.start(accounts.dana, { to: other });
  await r.connect(theirs);
  assert.deepEqual(await answer(theirs.sender.end(theirs.share, { sent: true })), [200, { ok: true }]);
  assert.equal((await keptRows(other)).length, 1);
  assert.deepEqual(await answer(r.phone(accounts.alice).create({ to: other })), [409, { error: "free_transfer_used" }]);
  assert.equal((await r.page(theirs.share).open()).status, 404, "and the room it ended is over");
});

test("a used free transfer stays used after a deploy, kept only as a keyed hash of the address", async () => {
  const to = newcomer();
  const first = relay();
  const room = await first.start(accounts.alice, { to });
  assert.equal((await (await first.connect(room)).received()).status, 200);

  // A new relay is what a deploy leaves: no rooms, nothing in memory. The
  // database still knows.
  const redeployed = relay();
  assert.deepEqual(
    await answer(redeployed.phone(accounts.dana).create({ to })),
    [409, { error: "free_transfer_used" }]
  );

  // HMAC-SHA256 of the address under a key derived from JWT_SECRET, as the
  // install tokens' is; never the address, nor a plain hash of it that anyone
  // could make from a guessed one.
  const rows = await db(FREE_TRANSFERS_TABLE).select("*");
  assert.deepEqual(Object.keys(rows[0]).sort(), ["address_hash", "used_at"]);
  assert.ok(rows.some((row) => row.address_hash === keptAs(to)));
  const guessable = crypto.createHash("sha256").update(to).digest("hex");
  for (const row of rows) {
    assert.match(row.address_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(row.address_hash, guessable);
  }
  assert.equal(JSON.stringify(rows).includes("@"), false, "no address in it");
  const here = createFreeTransfers({ db, secret: () => env.jwtSecret });
  assert.equal(await here.used(here.keyOf(`  ${to.toUpperCase()}`)), true, "trimmed and in lower case");
  const elsewhere = createFreeTransfers({ db, secret: () => "another server's secret, at least 32 bytes" });
  assert.equal(await elsewhere.used(elsewhere.keyOf(to)), false, "another key finds nothing");

  // Without the secret nothing can be looked up: a room for someone who is
  // not a paid account is refused rather than left uncounted, and one for a
  // paid account is still made.
  const unkeyed = relay({ secret: () => "" });
  assert.deepEqual(
    await answer(unkeyed.phone(accounts.alice).create({ to: newcomer() })),
    [503, { error: "link_unavailable" }]
  );
  const at = logged.findIndex((entry) => entry.msg === "forgedrop_link_share_check_failed");
  assert.deepEqual(logged[at], {
    level: "error",
    msg: "forgedrop_link_share_check_failed",
    meta: { message: "JWT_SECRET is required for free transfers" },
  });
  logged.splice(at, 1); // expected, so not left for "nothing went wrong unnoticed"
  assert.equal((await unkeyed.phone(accounts.alice).create({ to: "bob@example.com" })).status, 201);
});

test("a paid address is never counted, and one that buys DropForge after its free transfer is a paid account", async () => {
  const r = relay();
  // Bob and Legacy own DropForge: their rooms end sent and received, and
  // nothing is kept about them.
  for (const to of ["bob@example.com", "bob@example.com", "legacy.user@example.com"]) {
    const room = await r.start(accounts.alice, { to });
    assert.equal(room.body.paid, true);
    assert.deepEqual(await answer((await r.connect(room)).received()), [200, { ok: true }]);
    assert.deepEqual(await answer(room.sender.end(room.share, { sent: true })), [200, { ok: true }]);
    assert.equal((await r.phone(accounts.dana).create({ to })).body.paid, true, to);
  }
  for (const address of ["bob@example.com", "legacy.user@example.com"]) {
    assert.equal((await keptRows(address)).length, 0, address);
  }

  // Later has no DropForge: one free transfer, then no more...
  const later = accounts.later;
  const room = await r.start(accounts.alice, { to: later.email });
  assert.equal(room.body.paid, false);
  await (await r.connect(room)).received();
  assert.deepEqual(
    await answer(r.phone(accounts.alice).create({ to: later.email })),
    [409, { error: "free_transfer_used" }]
  );
  // ...until they buy it: a paid account, and the count no longer matters.
  await grantProductEntitlement({ userId: later.id, productSlug: "forgedrop", source: "test" });
  const bought = await r.phone(accounts.alice).create({ to: later.email });
  assert.deepEqual([bought.status, bought.body.paid], [201, true]);
  assert.equal((await r.page(bought.body.share).open()).body.paid, true);
});

test("a free transfer used under one way of writing an address is used under every other, while paid is asked of the address as typed", async () => {
  const r = relay();
  const tag = crypto.randomBytes(4).toString("hex");
  const typed = `Jo.Ann.${tag}+photos@GoogleMail.com`;
  const person = `joann${tag}@gmail.com`;
  addresses.push(typed, person, `joann${tag}@example.com`, `jo.ann.${tag}@example.com`);

  const room = await r.start(accounts.alice, { to: typed });
  assert.equal(room.body.paid, false);
  assert.equal((await (await r.connect(room)).received()).status, 200);
  // Kept once, as the person, never as the address was typed.
  assert.equal((await keptRows(person)).length, 1);
  assert.equal((await keptRows(typed)).length, 0);

  for (const alias of [person, `j.o.a.n.n.${tag}@gmail.com`, `JOANN${tag}+work@googlemail.com`, `joann${tag}+@gmail.com`]) {
    assert.deepEqual(
      await answer(r.phone(accounts.dana).create({ to: alias })),
      [409, { error: "free_transfer_used" }],
      alias
    );
  }
  // The same name at another domain is another person, and its dots count there.
  assert.equal((await r.phone(accounts.dana).create({ to: `joann${tag}@example.com` })).status, 201);
  assert.equal((await r.phone(accounts.dana).create({ to: `jo.ann.${tag}@example.com` })).status, 201);

  // Whether an address is a paid account is asked of it as typed: Bob's own
  // address is one, and a +tag of it is no account at all.
  assert.equal((await r.phone(accounts.alice).create({ to: "bob+work@example.com" })).body.paid, false);
  assert.equal((await r.phone(accounts.alice).create({ to: "Bob@Example.com" })).body.paid, true);
});

test("while a page holds one room for someone who is not a paid account, no page can claim another room for them", async () => {
  const r = relay();
  const tag = crypto.randomBytes(4).toString("hex");
  const person = `pat${tag}@example.net`;
  addresses.push(person);
  const refused = async (response, note) =>
    assert.deepEqual(await answer(response), [409, { error: "free_transfer_used" }], note);

  // Two senders, each with a room for the same person written two ways, and
  // a third room whose sender is not there.
  const first = await r.start(accounts.alice, { to: `Pat${tag}+one@Example.net` });
  const second = await r.start(accounts.dana, { to: person });
  const away = await r.phone(accounts.alice).create({ to: `pat${tag}+two@example.net` });
  assert.equal(away.status, 201);

  const holder = await r.connect(first);
  const other = r.page(second.share);
  await refused(other.offer(), "another sender's room for the same person");
  await refused(r.page(away.body.share).offer(), "ahead of sender_offline: there is nothing to wait for");
  assert.deepEqual(await second.sender.mail(), [], "and its sender hears nothing");
  // A bye before any offer is still nothing at all.
  assert.deepEqual(await answer(other.signal({ session: newSession(), type: "bye" })), [202, { ok: true }]);

  // The page holding its room is never refused, as after a reload with its clientId.
  assert.equal((await r.page(first.share, { clientId: holder.clientId }).offer()).status, 202);

  // Once the room it held ends unsent, another can be claimed, and nothing was used.
  assert.equal((await first.sender.end(first.share)).status, 200);
  assert.equal((await other.offer()).status, 202);
  assert.equal((await keptRows(person)).length, 0);
  const third = await r.start(accounts.alice, { to: person });
  await refused(r.page(third.share).offer(), "the room held now is the second");

  // A paid account's rooms are never held against each other.
  await r.connect(await r.start(accounts.alice));
  await r.connect(await r.start(accounts.dana));
});

test("once someone's free transfer is used, the first offer on any room made for them before is free_transfer_used, and claims nothing", async () => {
  const r = relay();
  const person = newcomer();
  const refused = async (guest, note) =>
    assert.deepEqual(await answer(guest.offer()), [409, { error: "free_transfer_used" }], note);

  const first = await r.start(accounts.alice, { to: person });
  const earlier = await r.start(accounts.dana, { to: person }); // made while nothing was used
  const holder = await r.connect(first);
  assert.equal((await holder.received()).status, 200);
  // The page that had the transfer may still offer on its own room.
  assert.equal((await r.page(first.share, { clientId: holder.clientId }).offer()).status, 202);
  assert.equal((await first.sender.end(first.share, { sent: true })).status, 200);

  // The room made before is refused on the database's word, whichever page
  // offers, and the refusal took no claim.
  const page = r.page(earlier.share);
  await refused(page, "its sender is there");
  await refused(r.page(earlier.share), "another page: the refusal claimed nothing");
  assert.deepEqual(await earlier.sender.mail(), []);
  // Ahead of sender_offline: the page is not told to wait for nothing.
  advance(61_000);
  await refused(page, "its sender is away");
});

/**
 * The database's record of free transfers, with its answers to "used?" held
 * until the test lets them go, or failing, as the test says.
 */
function heldFreeTransfers() {
  const real = createFreeTransfers({ db, secret: () => env.jwtSecret });
  const held = { hold: false, fail: false, waiting: [] };
  held.keyOf = (address) => real.keyOf(address);
  held.use = (key) => real.use(key);
  held.used = (key) => {
    if (held.fail) return Promise.reject(new Error("the database is not answering"));
    if (!held.hold) return real.used(key);
    return new Promise((resolve, reject) => held.waiting.push(() => real.used(key).then(resolve, reject)));
  };
  return held;
}

test("two pages offering together on two rooms for the same person: one claims its room, the other is refused", async () => {
  const freeTransfers = heldFreeTransfers();
  const r = relay({ freeTransfers });
  const person = newcomer();
  const a = await r.start(accounts.alice, { to: person });
  const b = await r.start(accounts.dana, { to: person });

  // Both offers get past every check made before the claim, and wait on the
  // database together; then both go on.
  freeTransfers.hold = true;
  const offers = [r.page(a.share).offer(), r.page(b.share).offer()];
  await until(() => freeTransfers.waiting.length === 2, "both offers asking the database");
  freeTransfers.hold = false;
  for (const go of freeTransfers.waiting.splice(0)) go();
  const results = await Promise.all(offers);
  assert.deepEqual(results.map((res) => res.status).sort(), [202, 409]);
  assert.deepEqual(results.find((res) => res.status === 409).body, { error: "free_transfer_used" });
  const mail = [...(await a.sender.mail()), ...(await b.sender.mail())];
  assert.deepEqual(mail.map((m) => m.type), ["offer"], "one offer reached one sender");
});

test("when the database cannot say whether a free transfer is used, the offer is 503 and claims nothing", async () => {
  const freeTransfers = heldFreeTransfers();
  const r = relay({ freeTransfers });
  const room = await r.start(accounts.alice, { to: newcomer() });

  freeTransfers.fail = true;
  assert.deepEqual(await answer(r.page(room.share).offer()), [503, { error: "link_unavailable" }]);
  const at = logged.findIndex((entry) => entry.msg === "forgedrop_link_free_transfer_failed");
  assert.deepEqual(logged[at], {
    level: "error",
    msg: "forgedrop_link_free_transfer_failed",
    meta: { message: "the database is not answering" },
  });
  logged.splice(at, 1); // expected, so not left for "nothing went wrong unnoticed"
  assert.deepEqual(await room.sender.mail(), []);

  freeTransfers.fail = false;
  assert.equal((await r.page(room.share).offer()).status, 202, "another page can claim it");
});

// ---------------------------------------------------------------- the pieces

test("free transfers count the person an address stands for: lower case, no +tag, and at Gmail no dots, googlemail.com being gmail.com", () => {
  for (const [address, person] of [
    ["  Jo.Ann+Photos@Example.COM ", "jo.ann@example.com"],
    ["jo.ann+a+b@example.com", "jo.ann@example.com"],
    ["jo.ann+@example.com", "jo.ann@example.com"],
    ["Jo.Ann+photos@GoogleMail.com", "joann@gmail.com"],
    ["j.o.a.n.n@gmail.com", "joann@gmail.com"],
    ["joann@googlemail.com", "joann@gmail.com"],
    ["jo.ann@mail.gmail.com", "jo.ann@mail.gmail.com"],
    ["jo.ann@gmail.co", "jo.ann@gmail.co"],
    ["plain@example.org", "plain@example.org"],
  ]) {
    assert.equal(personOf(address), person, address);
  }
  const record = createFreeTransfers({ db, secret: () => env.jwtSecret });
  assert.equal(record.keyOf("Jo.Ann+x@googlemail.com"), record.keyOf("joann@gmail.com"));
  assert.equal(record.keyOf("joann@gmail.com"), keptAs("joann@gmail.com"));
  assert.notEqual(record.keyOf("jo.ann@example.com"), record.keyOf("joann@example.com"));
});

test("the share store holds one room at a time for someone who is not a paid account, and none for a paid one", () => {
  let t = 1_000_000;
  const shares = createShareStore({ now: () => t });
  stoppable.push(shares);
  const person = "cd".repeat(32);
  const make = (userId, extra) =>
    shares.create({ userId, address: `phone:${userId}` }, { name: userId, paid: false, recipient: person, ...extra }).share;

  const x = make("u1");
  const y = make("u2");
  const z = make("u3");
  assert.equal(shares.contested(y), false);
  assert.deepEqual(shares.claim(x, "g1"), { ok: true });
  assert.equal(shares.contested(y), true);
  assert.equal(shares.contested(x), false, "not by itself");
  assert.deepEqual(shares.claim(y, "g2"), { ok: false, error: "free_transfer_used" });
  assert.deepEqual(shares.claim(y, "g1"), { ok: false, error: "free_transfer_used" }, "whichever page asks");
  assert.deepEqual(shares.claim(x, "g1"), { ok: true }, "its holder is never refused");
  assert.equal(shares.byId(y).guest, null, "a refusal claims nothing");

  // Ended, or run out, the held room holds nothing.
  assert.equal(shares.end("u1", x), true);
  assert.deepEqual(shares.claim(y, "g2"), { ok: true });
  assert.equal(shares.contested(z), true);
  t += 24 * 60 * 60_000;
  const w = make("u4");
  assert.equal(shares.contested(w), false, "the room that held them is over");

  // Paid accounts' rooms keep no person, and are never held against each other.
  const p = shares.create({ userId: "u5", address: "phone:u5" }, { name: "P", paid: true, recipient: person }).share;
  const q = shares.create({ userId: "u6", address: "phone:u6" }, { name: "Q", paid: true, recipient: person }).share;
  assert.deepEqual(shares.claim(p, "g5"), { ok: true });
  assert.deepEqual(shares.claim(q, "g6"), { ok: true });
  assert.equal(shares.contested(w), false, "a paid room holds no one");
});

test("the share store: an id each, one claimant, whose guest is whose, ending, so many an account, a day, and a timer that never holds the process open", async () => {
  let t = 1_000_000;
  const shares = createShareStore({ now: () => t, sharesPerAccount: 2 });
  stoppable.push(shares);
  const page = { userId: "u1", address: "phone:p1", kind: "phone" };
  const hash = "ab".repeat(32);

  const { share: a } = shares.create(page, { name: "A", paid: false, referral: "CODE1", recipient: hash });
  assert.ok(isShareId(a));
  assert.deepEqual(
    { ...shares.byId(a), expiresAt: undefined },
    {
      id: a,
      owner: { userId: "u1", address: "phone:p1" },
      name: "A",
      paid: false,
      referral: "CODE1",
      recipient: hash,
      guest: null,
      expiresAt: undefined,
    }
  );
  // A paid account's room keeps no hash.
  const { share: b } = shares.create(page, { name: "B", paid: true, recipient: hash });
  assert.deepEqual([shares.byId(b).recipient, shares.byId(b).referral], [null, null]);

  assert.deepEqual(shares.claim(a, "g1"), { ok: true });
  assert.deepEqual(shares.claim(a, "g1"), { ok: true }, "again is the same as once");
  assert.deepEqual(shares.claim(a, "g2"), { ok: false, error: "share_taken" });
  assert.equal(shares.answers(page, "g1"), true);
  assert.equal(shares.answers(page, "g2"), false);
  assert.equal(shares.answers({ userId: "u1", address: "phone:p2" }, "g1"), false, "another page");
  assert.equal(shares.answers({ userId: "u2", address: "phone:p1" }, "g1"), false, "another account");

  // Only its own account ends it.
  assert.equal(shares.end("u2", a), false);
  assert.equal(shares.end("u1", a), true);
  assert.equal(shares.byId(a), null);
  assert.equal(shares.answers(page, "g1"), false, "an ended room's guest is nobody's");
  assert.deepEqual(shares.claim(a, "g1"), { ok: false, error: "share_gone" });
  for (const id of [undefined, null, 7, "A".repeat(22)]) assert.equal(shares.byId(id), null, String(id));

  // Two an account here: a third ends the oldest, and another account keeps its own.
  shares.create(page, { name: "C", paid: true });
  shares.create(page, { name: "D", paid: true });
  assert.equal(shares.byId(b), null, "the oldest made room");
  shares.create({ userId: "u2", address: "phone:q1" }, { name: "E", paid: true });
  assert.deepEqual(shares.stats(), { shares: 3 });

  t += 24 * 60 * 60_000 - 1;
  shares.sweep();
  assert.deepEqual(shares.stats(), { shares: 3 });
  t += 1;
  shares.sweep();
  assert.deepEqual(shares.stats(), { shares: 0 });

  const source = await src("../src/modules/forgedrop-link/shares.js");
  assert.match(source, /sweeper\.unref\?\.\(\)/);
});

test("a share's shapes and the documented limits", () => {
  assert.equal(isShareId(newShareId()), true);
  for (const id of ["A".repeat(21), "A".repeat(23), `${"A".repeat(21)}=`, `${"A".repeat(21)}/`, 7, null, undefined]) {
    assert.equal(isShareId(id), false, String(id));
  }
  assert.deepEqual([...PHONE_TO_GUEST_TYPES].sort(), ["answer", "bye"]);
  assert.deepEqual([...GUEST_TYPES].sort(), ["bye", "offer"]);
  assert.equal(SHARE_LIMITS.shareMs, 24 * 60 * 60_000);
  assert.equal(SHARE_LIMITS.sharesPerAccount, 10);
  assert.equal(SHARE_LIMITS.nameChars, 64);
  assert.deepEqual(SHARE_LIMITS.rate, { shareCreatePerHour: 20, shareEndPerMinute: 30, sharePagePerMinute: 60 });
});

test("the mounted module keys free transfers from JWT_SECRET, needing nothing new configured", async () => {
  const index = await src("../src/modules/forgedrop-link/index.js");
  assert.match(index, /freeTransferSecret: \(\) => env\.jwtSecret,/);
});

test("no room's id, and no address a room was made for, ever reaches the log", () => {
  // Enough rooms to mean something, even when another test stopped early.
  assert.ok(made.length > 40, `rooms made: ${made.length}`);
  const written = JSON.stringify(logged);
  for (const id of made) assert.equal(written.includes(id), false, "a room's id was logged");
  for (const address of addresses) {
    assert.equal(written.toLowerCase().includes(address.toLowerCase()), false, "an address was logged");
  }
});

test("nothing went wrong unnoticed", () => {
  assert.deepEqual(logged.filter((entry) => entry.level === "error"), []);
});
