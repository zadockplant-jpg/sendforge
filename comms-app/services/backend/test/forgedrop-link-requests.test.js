// ForgeDrop requests for files: a desktop asks someone for files by the email
// of their SendForge account, the request is emailed to them as a link, and
// the page it opens on their phone reaches the asking desktop the way the
// phone link does, as a guest of the asking account
// (ForgeDrop/docs/people.md, "Requesting files (1.9)").
//
// As in forgedrop-link-people.test.js, the HTTP tests run the real router,
// real licence tokens minted by the activation service, and real users and
// device_activations rows against an in-process Postgres (PGlite). Every test
// gets a relay of its own (fresh stores, its own path, its own rate-limit
// names), whose email senders only write down what they were asked to send.
// The stores' clock is a dial the tests turn; long-polls and the rate limiter
// use real time. The app trusts one proxy hop, as app.js does, so a test can
// call from several client addresses. A file of its own, because rate
// limiters are per process.

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
process.env.JWT_SECRET ||= "forgedrop-requests-test-secret-at-least-32-bytes";

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
const { sendForgeDropFileRequestEmail } = await import("../src/services/email.service.js");
const { createForgeDropLinkRouter, LINK_LIMITS, PERSON_LIMITS } = await import(
  "../src/modules/forgedrop-link/router.js"
);
const { createLinkStore } = await import("../src/modules/forgedrop-link/store.js");
const { createCodeStore } = await import("../src/modules/forgedrop-link/codes.js");
const { createPeopleStore } = await import("../src/modules/forgedrop-link/people.js");
const { createRequestStore } = await import("../src/modules/forgedrop-link/requests.js");
const { GUEST_TYPES, isRequestToken, parseAddress, parseMessage, takesGuests } = await import(
  "../src/modules/forgedrop-link/shapes.js"
);

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
// As app.js: behind one proxy, whose X-Forwarded-For says who called.
app.set("trust proxy", 1);
// app.js runs the app-wide form parser ahead of every router; so does this.
app.use(express.urlencoded({ extended: false }));

async function signUp(name, { email = `${name}@example.com`, verified = true, owns = true } = {}) {
  const id = randomUUID();
  await db("users").insert({ id, email, email_verified: verified });
  if (owns) await grantProductEntitlement({ userId: id, productSlug: "forgedrop", source: "test" });
  accounts[name] = {
    id,
    email,
    address: email.trim().toLowerCase(),
    bearer: issueCustomerAccessToken({ id, email }),
  };
  return accounts[name];
}

/** An activated desktop with an identity key of its own, proven unless told otherwise. */
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
    appVersion: "1.9.0",
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

  // Alice asks; Bob is asked. Erin's email is not verified, Carol does not
  // own ForgeDrop, and Legacy's email was stored before emails were lower case.
  const alice = await signUp("alice");
  const bob = await signUp("bob");
  const erin = await signUp("erin", { verified: false });
  await signUp("carol", { owns: false });
  const legacy = await signUp("legacy", { email: "Legacy.User@Example.com" });

  await activate("studio", alice, "Studio PC");
  await activate("laptop", alice, "Alice's laptop");
  await activate("attic", alice, "Attic PC", { proven: false });
  await activate("bobs", bob, "Bob's desktop");
  await activate("erins", erin, "Erin PC");
  await activate("legacys", legacy, "Legacy PC");

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
};

const newClientId = () => crypto.randomBytes(16).toString("base64url"); // 22 characters
const newSession = () => crypto.randomBytes(12).toString("base64url"); // 16 characters

let relays = 0;

/**
 * A relay of its own: a fresh router and stores, at a path of its own. Its
 * request emails are written down in `emails`, its transfer emails in
 * `transfers`; `withCors` puts app.js's CORS in front, as the real API has it.
 */
function relay({ rate = UNLIMITED, sendRequestEmail = null, withCors = false } = {}) {
  relays += 1;
  const base = `/relay-${relays}`;
  const store = createLinkStore({ now });
  const deliver = (userId, address, message) => store.deliver(userId, address, message);
  const codes = createCodeStore({ now, deliver });
  const people = createPeopleStore({ now, deliver, present: (userId, address) => store.isPresent(userId, address) });
  const requests = createRequestStore({ now });
  stoppable.push(store, codes, people, requests);
  const emails = [];
  const transfers = [];
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
    requests,
    sendTransferEmail: async (message) => {
      transfers.push(message);
    },
    approvalLink: (token) => `https://sendforge.test/r/#${token}`,
    sendRequestEmail:
      sendRequestEmail ??
      (async (message) => {
        emails.push(message);
      }),
    requestLink: (token) => `https://sendforge.test/s/#${token}`,
    rate,
    rateLimitPrefix: `fd-requests-${relays}`,
  });
  if (withCors) app.use(base, cors({ origin: true, credentials: true }), router);
  else app.use(base, router);

  const at = (path, options = {}) => call(path, { base, ...options });
  const poll = (device, body = {}, options = {}) =>
    at("/desktop/poll", { licence: device.token, body: { wait: 0, ...body }, ...options });

  /** What is waiting for a desktop, each without the time it was sent. */
  async function mail(device, body = {}) {
    const res = await poll(device, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.messages.map(({ sentAt, ...message }) => {
      assert.equal(new Date(sentAt).toISOString(), sentAt, "sentAt is ISO-8601");
      return message;
    });
  }

  /** A request page, as the phone that opened the link runs it: its token and a clientId of its own. */
  function page(token, { clientId = newClientId(), from } = {}) {
    const headers = from ? { "X-Forwarded-For": from } : {};
    return {
      clientId,
      address: `guest:${clientId}`,
      open: () => at("/request/open", { body: { token }, headers }),
      poll: (wait = 0, options = {}) => at("/request/poll", { body: { token, clientId, wait }, headers, ...options }),
      signal: (body) => at("/request/signal", { body: { token, clientId, ...body }, headers }),
      /** What is waiting for the page, each without the time it was sent. */
      async mail() {
        const res = await at("/request/poll", { body: { token, clientId, wait: 0 }, headers });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.messages.map(({ sentAt, ...message }) => message);
      },
    };
  }

  return {
    store,
    people,
    requests,
    emails,
    transfers,
    call: at,
    poll,
    mail,
    page,
    ask: (device, body) => at("/person/request", { licence: device.token, body }),
    signal: (device, body) => at("/signal", { licence: device.token, body }),

    /** `asker` asks Bob's address for files, and the token its email carries. */
    async start(asker = devices.studio, body = {}) {
      const res = await at("/person/request", {
        licence: asker.token,
        body: { to: "bob@example.com", message: "Could you send the photos?", ...body },
      });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      const email = emails.at(-1);
      assert.equal(email?.fileRequestId, res.body.request, "the request was emailed");
      return { request: res.body.request, token: tokenOf(email) };
    },
  };
}

/** The token an email's link carries after its "#". */
const tokenOf = (email) => email.requestUrl.slice(email.requestUrl.indexOf("#") + 1);

// ---------------------------------------------------------------- asking

test("asking for files answers the same whoever the address is; only a verified owner's is kept and emailed", async () => {
  const r = relay();
  const { studio } = devices;
  await r.poll(studio, { caps: ["phone-link", "people"] });

  const asked = [];
  const ids = [];
  for (const to of ["nobody@example.com", "erin@example.com", "carol@example.com", "bob@example.com"]) {
    const counting = countQueries();
    const res = await r.ask(studio, { to, message: "Hi" });
    asked.push(counting.stop().length);
    assert.equal(res.status, 202, `${to}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(Object.keys(res.body), ["request"], to);
    assert.match(res.body.request, /^[A-Za-z0-9_-]{22}$/, to);
    ids.push(res.body.request);
  }
  assert.equal(new Set(asked).size, 1, `questions per request: ${asked}`);
  assert.equal(new Set(ids).size, ids.length, "an id each");
  // Nobody, an unverified email and a non-owner: nothing kept, nothing sent.
  assert.deepEqual(r.requests.stats(), { requests: 1 });
  assert.deepEqual(
    r.emails.map((email) => [email.to, email.fileRequestId]),
    [["bob@example.com", ids[3]]]
  );
  // Asking is not knocking: nothing reached anyone's mailbox.
  assert.deepEqual(await r.mail(devices.bobs), []);
});

test("a request is refused for a bad address or message first, then for the asker's own email or key", async () => {
  const r = relay();
  const { studio, erins, attic } = devices;
  for (const to of [undefined, "", "bob", "bob@", 42, ["bob@example.com"]]) {
    const res = await r.ask(studio, { to });
    assert.deepEqual([res.status, res.body], [400, { error: "bad_email" }], JSON.stringify(to));
  }
  for (const message of [7, true, ["hi"], { text: "hi" }, "x".repeat(1001), `  ${"é".repeat(1001)}  `]) {
    const res = await r.ask(studio, { to: "bob@example.com", message });
    assert.deepEqual([res.status, res.body], [400, { error: "bad_message" }], JSON.stringify(message).slice(0, 40));
  }
  // A message is optional, and up to 1000 characters however they are written.
  for (const message of [undefined, null, "", "   ", "x".repeat(1000), `  ${"😀".repeat(1000)}\n`]) {
    const res = await r.ask(studio, { to: "nobody@example.com", message });
    assert.equal(res.status, 202, JSON.stringify(message)?.slice(0, 40));
  }
  // What is wrong with the request is said before what is wrong with the asker.
  assert.deepEqual((await r.ask(erins, { to: "bob", message: 7 })).body, { error: "bad_email" });
  assert.deepEqual((await r.ask(erins, { to: "bob@example.com", message: 7 })).body, { error: "bad_message" });
  const unverified = await r.ask(erins, { to: "bob@example.com" });
  assert.deepEqual([unverified.status, unverified.body], [409, { error: "email_unverified" }]);
  const unproven = await r.ask(attic, { to: "bob@example.com" });
  assert.deepEqual([unproven.status, unproven.body], [409, { error: "identity_unproven" }]);
  assert.deepEqual(r.emails, []);
  assert.deepEqual(r.requests.stats(), { requests: 0 });

  // Desktops only.
  const phone = await r.call("/person/request", { bearer: accounts.alice.bearer, body: { to: "bob@example.com" } });
  assert.deepEqual([phone.status, phone.body], [401, { error: "licence_invalid" }]);
});

test("the email goes once per request: who is asking, their message as they wrote it, and the link to its page", async () => {
  const r = relay();
  const { studio } = devices;
  await r.poll(studio, { name: "Studio PC (live)", caps: ["phone-link", "people"] });
  const RLO = String.fromCharCode(0x202e);
  const NUL = String.fromCharCode(0);
  const res = await r.ask(studio, {
    to: "  BOB@example.com ",
    message: `  Hi Bob,\r\nthe <b>photos</b> from Saturday${RLO}gpj.exe${NUL}, please.\n  `,
  });
  assert.equal(res.status, 202);
  assert.equal(r.emails.length, 1);
  const [email] = r.emails;
  const token = tokenOf(email);
  assert.ok(isRequestToken(token), token);
  assert.deepEqual(email, {
    to: "bob@example.com",
    askerEmail: "alice@example.com",
    askerComputer: "Studio PC (live)",
    // Line breaks kept, tags left as the text they are (the email escapes
    // them), and what could turn text around or hide in it taken out.
    message: "Hi Bob,\nthe <b>photos</b> from Saturdaygpj.exe, please.",
    requestUrl: `https://sendforge.test/s/#${token}`,
    fileRequestId: res.body.request,
  });

  // To the address the account has, as it was stored; no message, none said.
  await r.ask(studio, { to: "legacy.user@example.com" });
  assert.equal(r.emails[1].to, "Legacy.User@Example.com");
  assert.equal(r.emails[1].message, null);
  assert.notEqual(tokenOf(r.emails[1]), token, "a token each");

  // Nothing written to the log carries a token.
  assert.equal(JSON.stringify(logged).includes(token), false);
});

test("request emails are limited as a waiting send's are, and counted apart from them", async () => {
  const r = relay();
  const { studio, legacys, bobs } = devices;
  await r.poll(bobs, { caps: ["people"] });
  const ask = async (from) => assert.equal((await r.ask(from, { to: "bob@example.com" })).status, 202);

  await ask(studio);
  await ask(studio);
  assert.equal(r.emails.length, 1, "one per asker and asked account every 2 minutes");
  assert.deepEqual(r.requests.stats(), { requests: 2 }, "both requests are kept all the same");
  // A send to Bob in the same minute still emails: its allowance is its own.
  const knocked = await r.call("/person/knock", {
    licence: studio.token,
    body: { to: "bob@example.com", purpose: "send", files: 1, bytes: 1 },
  });
  assert.equal(knocked.status, 202);
  assert.equal(r.transfers.length, 1);
  await ask(legacys);
  assert.equal(r.emails.length, 2, "another asker is another pair");
  advance(2 * 60_000);
  await ask(studio);
  assert.equal(r.emails.length, 3);

  // Ten an hour to one account, from anyone.
  for (let i = 4; i <= 10; i += 1) {
    advance(2 * 60_000);
    await ask(studio);
    assert.equal(r.emails.length, i);
  }
  advance(2 * 60_000);
  await ask(studio);
  await ask(legacys);
  assert.equal(r.emails.length, 10, "the eleventh in the hour sends none");
  advance(60 * 60_000);
  await ask(studio);
  assert.equal(r.emails.length, 11, "an hour on, there is room again");
});

test("an email that fails is logged, without its link, and the request is kept", async () => {
  const r = relay({
    sendRequestEmail: async () => {
      throw Object.assign(new Error("Email send failed"), { code: "sendgrid_non_2xx" });
    },
  });
  const res = await r.ask(devices.studio, { to: "bob@example.com" });
  assert.equal(res.status, 202);
  assert.deepEqual(r.requests.stats(), { requests: 1 });
  await until(() => logged.some((entry) => entry.msg === "forgedrop_link_request_email_failed"), "the failure's log");
  const at = logged.findIndex((entry) => entry.msg === "forgedrop_link_request_email_failed");
  assert.deepEqual(logged[at], {
    level: "error",
    msg: "forgedrop_link_request_email_failed",
    meta: { code: "sendgrid_non_2xx", message: "Email send failed" },
  });
  logged.splice(at, 1); // expected, so not left for "nothing went wrong unnoticed"
});

// ---------------------------------------------------------------- the page

test("the page opens a request: who is asking, their message and key, and whether their computer can be reached now", async () => {
  const r = relay();
  const { studio } = devices;
  const { token } = await r.start(studio);
  const guest = r.page(token);

  const body = {
    from: "alice@example.com",
    name: "Studio PC",
    message: "Could you send the photos?",
    identity: studio.identity,
  };
  const closed = await guest.open();
  assert.deepEqual([closed.status, closed.body], [200, { ...body, online: false }], "no licence, and not polling");
  assert.equal(closed.headers.get("cache-control"), "no-store");

  await r.poll(studio, { caps: ["people"] });
  assert.equal((await guest.open()).body.online, false, "polling, but not taking phones");
  await r.poll(studio, { caps: ["phone-link", "people"] });
  assert.deepEqual((await guest.open()).body, { ...body, online: true });
  assert.equal((await r.call("/desktop/offline", { licence: studio.token })).status, 204);
  assert.equal((await guest.open()).body.online, false);

  // A request without a message says none.
  const quiet = await r.start(studio, { message: undefined, to: "legacy.user@example.com" });
  assert.equal((await r.page(quiet.token).open()).body.message, null);
});

test("a guest's offer reaches the desktop that asked, with the request as this server knows it, and its answer comes back", async () => {
  const r = relay();
  const { studio } = devices;
  const alice = accounts.alice;
  await r.poll(studio, { caps: ["phone-link", "people"] });
  const { request, token } = await r.start(studio);
  const guest = r.page(token);
  const session = newSession();

  // The page opens its poll, and the desktop is offered a connection.
  const waiting = guest.poll(20);
  await until(() => r.store.waiting(alice.id, guest.address), "the page's poll");
  const offered = await guest.signal({
    session,
    type: "offer",
    // What the page says about the request is not what the desktop is told.
    data: { sdp: "v=0 offer", request: { id: "A".repeat(22), email: "mallory@example.com" } },
  });
  assert.deepEqual([offered.status, offered.body], [202, { ok: true }]);
  assert.deepEqual(await r.mail(studio), [
    {
      from: guest.address,
      session,
      type: "offer",
      data: { sdp: "v=0 offer", request: { id: request, email: "bob@example.com" } },
    },
  ]);

  // The desktop answers as it answers a phone, and the page's poll wakes.
  const started = Date.now();
  const answered = await r.signal(studio, { to: guest.address, session, type: "answer", data: { sdp: "v=0 answer" } });
  assert.deepEqual([answered.status, answered.body], [202, { ok: true }]);
  const woken = await waiting;
  assert.ok(Date.now() - started < 2000, "woken by the answer, not by the 20 s wait");
  assert.deepEqual(
    woken.body.messages.map(({ sentAt, ...message }) => message),
    [{ from: studio.address, session, type: "answer", data: { sdp: "v=0 answer" } }]
  );

  // Either side may say bye; data defaults to {}.
  assert.equal((await guest.signal({ session, type: "bye" })).status, 202);
  assert.deepEqual((await r.mail(studio)).map((m) => [m.type, m.data]), [
    ["bye", { request: { id: request, email: "bob@example.com" } }],
  ]);
  assert.equal((await r.signal(studio, { to: guest.address, session, type: "bye" })).status, 202);
  assert.deepEqual((await guest.mail()).map((m) => m.type), ["bye"]);

  // Its token works for any number of sends.
  const second = newSession();
  assert.equal((await guest.signal({ session: second, type: "offer", data: { sdp: "again" } })).status, 202);
  assert.deepEqual((await r.mail(studio)).map((m) => [m.session, m.type]), [[second, "offer"]]);
});

test("an answer before the page's first poll waits for it, and a desktop answers only a guest that is there", async () => {
  const r = relay();
  const { studio } = devices;
  await r.poll(studio, { caps: ["phone-link"] });
  const { token } = await r.start(studio);
  const guest = r.page(token);
  const session = newSession();

  // A guest that just spoke is there, before it has polled at all.
  assert.equal((await guest.signal({ session, type: "offer", data: {} })).status, 202);
  assert.equal((await r.signal(studio, { to: guest.address, session, type: "answer", data: { sdp: "a" } })).status, 202);
  assert.deepEqual((await guest.mail()).map((m) => m.type), ["answer"]);

  // One that never was, or has gone quiet for a minute, is not.
  const nobody = await r.signal(studio, { to: `guest:${newClientId()}`, session, type: "answer" });
  assert.deepEqual([nobody.status, nobody.body], [404, { error: "phone_gone" }]);
  advance(59_000);
  await r.poll(studio);
  assert.equal((await r.signal(studio, { to: guest.address, session, type: "bye" })).status, 202);
  advance(2_000);
  await r.poll(studio);
  const gone = await r.signal(studio, { to: guest.address, session, type: "bye" });
  assert.deepEqual([gone.status, gone.body], [404, { error: "phone_gone" }]);

  // A desktop only answers or says bye to a guest.
  const wrong = await r.signal(studio, { to: guest.address, session, type: "offer" });
  assert.deepEqual([wrong.status, wrong.body], [400, { error: "bad_type" }]);
});

test("the page reaches the desktop that asked while it polls taking phones and holds its slot, and nothing else", async () => {
  const r = relay();
  const { studio, laptop, bobs } = devices;
  const alice = accounts.alice;
  const { token } = await r.start(studio);
  const guest = r.page(token);
  const offer = (data = {}) => guest.signal({ session: newSession(), type: "offer", data: { sdp: "o", ...data } });

  const offline = async (note) => {
    const res = await offer();
    assert.deepEqual([res.status, res.body], [404, { error: "desktop_offline" }], note);
  };
  await offline("not polling");
  await r.poll(studio, { caps: ["people", "internet"] });
  await offline("polling, but not taking phones");
  await r.poll(studio, { caps: ["phone-link"] });
  assert.equal((await offer()).status, 202);
  await r.mail(studio);

  // Only ever to it: whatever the page names, and whoever else is there.
  await r.poll(laptop, { caps: ["phone-link"] });
  await r.poll(bobs, { caps: ["phone-link"] });
  assert.equal((await guest.signal({ session: newSession(), type: "offer", to: bobs.address, data: {} })).status, 202);
  assert.deepEqual((await r.mail(studio)).map((m) => m.type), ["offer"]);
  assert.deepEqual(await r.mail(laptop), []);
  assert.deepEqual(await r.mail(bobs), []);

  // Another account's desktop cannot answer the guest: it is not there to find.
  await guest.poll();
  const across = await r.signal(bobs, { to: guest.address, session: newSession(), type: "answer" });
  assert.deepEqual([across.status, across.body], [404, { error: "phone_gone" }]);

  // A phone can neither address a guest nor claim to be one, and polling as
  // a phone with a guest's clientId reads the phone's mail, not the guest's.
  const phoneClient = newClientId();
  const fromPhone = (body) => r.call("/signal", { bearer: alice.bearer, body });
  const toGuest = await fromPhone({ to: guest.address, from: `phone:${phoneClient}`, session: newSession(), type: "offer" });
  assert.deepEqual([toGuest.status, toGuest.body], [400, { error: "bad_recipient" }]);
  const asGuest = await fromPhone({ to: studio.address, from: guest.address, session: newSession(), type: "offer" });
  assert.deepEqual([asGuest.status, asGuest.body], [400, { error: "bad_sender" }]);
  assert.equal((await r.signal(studio, { to: guest.address, session: newSession(), type: "answer" })).status, 202);
  const phonePoll = await r.call("/phone/poll", { bearer: alice.bearer, body: { clientId: guest.clientId, wait: 0 } });
  assert.deepEqual([phonePoll.status, phonePoll.body], [200, { messages: [] }]);
  assert.deepEqual((await guest.mail()).map((m) => m.type), ["answer"]);

  // Its slot freed on the account page (its licence taken on trust for a
  // minute more), the desktop that asked is offline to the page.
  const spare = await activate("spare", alice, "Spare PC");
  await r.poll(spare, { caps: ["phone-link"] });
  // Another address: Alice's account emailed Bob's under 2 minutes ago.
  const late = await r.start(spare, { to: "legacy.user@example.com" });
  await deactivateDevice(alice.id, "forgedrop", spare.deviceId);
  const freed = await r.page(late.token).signal({ session: newSession(), type: "offer", data: {} });
  assert.deepEqual([freed.status, freed.body], [404, { error: "desktop_offline" }]);
});

test("the page's signals and polls are checked like a phone's", async () => {
  const r = relay();
  const { studio } = devices;
  await r.poll(studio, { caps: ["phone-link"] });
  const { token } = await r.start(studio);
  const guest = r.page(token);
  const expect = async (res, status, error, note) => {
    const got = await res;
    assert.deepEqual([got.status, got.body], [status, { error }], note);
  };
  const send = (patch) => r.call("/request/signal", {
    body: { token, clientId: guest.clientId, session: newSession(), type: "offer", data: {}, ...patch },
  });

  for (const clientId of [undefined, "short", `${"x".repeat(21)}!`, "x".repeat(65), 7]) {
    await expect(send({ clientId }), 400, "bad_client_id", JSON.stringify(clientId));
    await expect(r.call("/request/poll", { body: { token, clientId, wait: 0 } }), 400, "bad_client_id");
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
  assert.deepEqual((await r.mail(studio)).map((m) => [m.type, m.data.sdp.length]), [["offer", exactly.sdp.length]]);
});

test("a request's token is its only key: an unknown or malformed one is gone, and a request is gone after a day", async () => {
  const r = relay();
  const { studio } = devices;
  const gone = async (token, note) => {
    const guest = r.page(token);
    for (const res of [
      await guest.open(),
      await guest.poll(),
      await guest.signal({ session: newSession(), type: "offer", data: {} }),
    ]) {
      assert.deepEqual([res.status, res.body], [404, { error: "request_gone" }], note);
    }
  };
  await gone(crypto.randomBytes(32).toString("base64url"), "well formed, but nobody's");
  for (const token of [undefined, null, "", "short", "A".repeat(42), "A".repeat(44), 7, ["A".repeat(43)]]) {
    await gone(token, JSON.stringify(token));
  }
  const empty = await r.call("/request/open", {});
  assert.deepEqual([empty.status, empty.body], [404, { error: "request_gone" }], "no body at all");

  // A day from the asking, whether or not anyone polls.
  const { token } = await r.start(studio);
  advance(24 * 60 * 60_000 - 1);
  assert.equal((await r.page(token).open()).status, 200);
  advance(1);
  await gone(token, "a day on");
  assert.deepEqual(r.requests.stats(), { requests: 0 });
});

test("the page's routes take no licence, are limited per address and per guest, and answer the website across origins", async () => {
  const r = relay({ rate: { ...UNLIMITED, requestPagePerMinute: 60 }, withCors: true });
  const { studio } = devices;
  await r.poll(studio, { caps: ["phone-link"] });
  const { token } = await r.start(studio);

  // The website asks first, as a browser does before a JSON POST to another origin.
  const site = "https://sendforge.app";
  for (const path of ["/request/open", "/request/poll", "/request/signal"]) {
    const preflight = await r.call(path, {
      method: "OPTIONS",
      headers: { Origin: site, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(preflight.status, 204, path);
    assert.equal(preflight.headers.get("access-control-allow-origin"), site, path);
    assert.match(preflight.headers.get("access-control-allow-methods"), /POST/, path);
    assert.match(preflight.headers.get("access-control-allow-headers"), /content-type/i, path);
  }
  const looked = await r.call("/request/open", { body: { token }, headers: { Origin: site } });
  assert.equal(looked.status, 200, "with no licence and no sign-in");
  assert.equal(looked.headers.get("access-control-allow-origin"), site);

  // Sixty a minute from one address, the three routes together; another
  // address has its own allowance.
  const one = r.page(token, { from: "203.0.113.7" });
  for (let i = 1; i <= 60; i += 1) {
    const res = await [one.open, () => one.poll(), () => one.signal({ session: newSession(), type: "bye" })][i % 3]();
    assert.notEqual(res.status, 429, `call ${i}`);
  }
  const limited = await one.open();
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.match(limited.headers.get("retry-after"), /^[1-9]\d*$/);
  assert.equal((await r.page(token, { from: "203.0.113.8" }).open()).status, 200);

  // And sixty polls a minute from one guest, from however many addresses.
  const clientId = newClientId();
  for (let i = 1; i <= 60; i += 1) {
    const res = await r.page(token, { clientId, from: `198.51.100.${i}` }).poll();
    assert.equal(res.status, 200, `poll ${i}`);
  }
  const polled = await r.page(token, { clientId, from: "198.51.100.200" }).poll();
  assert.equal(polled.status, 429);
  assert.equal((await r.poll(studio)).status, 200, "desktops are not held up by it");

  // app.js runs its CORS ahead of the link, so the real site reaches these the same way.
  const source = await src("../src/app.js");
  const corsAt = source.search(/app\.use\(\s*cors\(\{\s*origin: true/);
  assert.ok(corsAt > 0);
  assert.ok(corsAt < source.indexOf('app.use("/v1/forgedrop/link", forgedropLinkRouter)'));
});

test("asking is limited to 10 a minute per account", async () => {
  const r = relay({ rate: {} }); // the documented limits
  const { studio, laptop, bobs } = devices;
  for (let i = 1; i <= 10; i += 1) {
    const res = await r.ask(i % 2 ? studio : laptop, { to: "nobody@example.com" });
    assert.equal(res.status, 202, `request ${i}`);
  }
  const limited = await r.ask(studio, { to: "nobody@example.com" });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.equal((await r.ask(laptop, { to: "nobody@example.com" })).status, 429, "per account");
  assert.equal((await r.ask(bobs, { to: "nobody@example.com" })).status, 202, "another account has its own");
  // Counted apart from knocks.
  const knocked = await r.call("/person/knock", { licence: studio.token, body: { to: "nobody@example.com", purpose: "hello" } });
  assert.equal(knocked.status, 202);
});

// ---------------------------------------------------------------- the email

test("the request email says who is asking and their message as plain text, and links to the page, never to the log", async () => {
  const keys = ["NODE_ENV", "SENDGRID_API_KEY", "ACCOUNT_FROM_EMAIL", "SUPPORT_EMAIL"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const sent = [];
  const printed = [];
  const token = crypto.randomBytes(32).toString("base64url");
  const requestUrl = `https://sendforge.app/s/#${token}`;
  const email = (extra) =>
    sendForgeDropFileRequestEmail({
      to: "bob@example.com",
      askerEmail: "michael@example.com",
      askerComputer: "LETSGOSLOWER",
      message: "Could you send the photos from Saturday?\nThe big ones, please.",
      requestUrl,
      fileRequestId: "R".repeat(22),
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
    await email({
      askerComputer: "Studio <b>PC</b>\r\nBcc: someone",
      message: '<a href="https://evil.example">Verify</a> & <script>alert(1)</script>\nsecond line',
    });
    await email({ askerComputer: null, message: null });
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

  const { body } = sent[0];
  assert.equal(body.subject, "michael@example.com is asking you for files");
  assert.deepEqual(body.from, { email: "referrals@sendforge.app", name: "ForgeDrop" });
  assert.deepEqual(body.personalizations[0].to, [{ email: "bob@example.com" }]);
  assert.equal(body.personalizations[0].custom_args.sf_message_kind, "forgedrop-file-request");
  assert.equal(body.personalizations[0].custom_args.sf_message_ref, "R".repeat(22), "the request, never the token");
  assert.equal(body.tracking_settings.click_tracking.enable, false, "the link is not rewritten through a tracker");
  const [text, html] = body.content.map((part) => part.value);
  assert.equal(
    text,
    `michael@example.com is asking you for files

From: michael@example.com (LETSGOSLOWER)

Their message:
Could you send the photos from Saturday?
The big ones, please.

Send files:
${requestUrl}

On a phone, the link opens a page ready to choose files; on a computer, it opens ForgeDrop. The files go straight to their computer.

You're getting this because someone used ForgeDrop to ask for files at this email address. Need help? Contact support@sendforge.app.`
  );
  assert.match(html, /<h1 [^>]*>michael@example\.com is asking you for files<\/h1>/);
  assert.match(html, /<strong>From:<\/strong> michael@example\.com \(LETSGOSLOWER\)<\/p>/);
  assert.match(html, />Could you send the photos from Saturday\?<br>The big ones, please\.<\/div>/);
  assert.ok(html.includes(`<a href="${requestUrl}" `), "the button links to the page");
  assert.match(html, />Send files<\/a>/);

  // Their message is text, never HTML: nothing in it becomes a tag or a link.
  const [hostileText, hostileHtml] = sent[1].body.content.map((part) => part.value);
  assert.match(hostileText, /\nFrom: michael@example\.com \(Studio <b>PC<\/b> Bcc: someone\)\n/);
  assert.match(
    hostileHtml,
    />&lt;a href=&quot;https:\/\/evil\.example&quot;&gt;Verify&lt;\/a&gt; &amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;<br>second line<\/div>/
  );
  assert.doesNotMatch(hostileHtml, /<script|href="https:\/\/evil/);
  assert.match(hostileHtml, /michael@example\.com \(Studio &lt;b&gt;PC&lt;\/b&gt; Bcc: someone\)<\/p>/);
  // No message, no message block.
  const [quietText, quietHtml] = sent[2].body.content.map((part) => part.value);
  assert.match(quietText, /\nFrom: michael@example\.com\n\nSend files:\n/);
  assert.doesNotMatch(quietHtml, /Their message/);

  // The log-only send wrote no link, and nothing printed carries the token.
  assert.ok(printed.some((line) => line.includes('"email_log_mode"')));
  assert.equal(printed.some((line) => line.includes(token)), false);
});

// ---------------------------------------------------------------- the pieces

test("guests are counted apart from an account's phones, and present as long as a phone is", () => {
  let t = 1_000_000;
  const store = createLinkStore({ now: () => t, phonesPerAccount: 2, guestsPerAccount: 2 });
  stoppable.push(store);
  store.touch("u1", "phone:p1");
  t += 1;
  store.touch("u1", "phone:p2");
  for (const guest of ["guest:g1", "guest:g2", "guest:g3"]) {
    t += 1;
    store.touch("u1", guest);
  }
  assert.equal(store.isPresent("u1", "guest:g1"), false, "the stalest guest made room");
  for (const address of ["phone:p1", "phone:p2", "guest:g2", "guest:g3"]) assert.equal(store.isPresent("u1", address), true, address);
  t += 1;
  store.touch("u1", "phone:p3");
  assert.equal(store.isPresent("u1", "phone:p1"), false, "the stalest phone made room");
  assert.equal(store.isPresent("u1", "guest:g2"), true, "and no guest");

  t += 59_000;
  assert.equal(store.isPresent("u1", "guest:g3"), true);
  t += 2_000;
  assert.equal(store.isPresent("u1", "guest:g3"), false, "a minute without a word");
  assert.equal(LINK_LIMITS.guestPresentMs, 60_000);
  assert.equal(LINK_LIMITS.guestsPerAccount, 32);
});

test("the request store keeps a day, a token each, so many per desktop, and its timer never holds the process open", async () => {
  let t = 1_000_000;
  const requests = createRequestStore({ now: () => t, requestsPerDesktop: 2 });
  stoppable.push(requests);
  const asker = { userId: "u1", address: "desktop:a", kind: "desktop" };
  const card = { email: "a@example.com", name: "A", identity: "ab".repeat(32), fingerprint: "abcd-abcd-abcd-abcd" };

  const unkept = requests.ask(asker, { card, address: "b@example.com", message: null, keep: false });
  assert.match(unkept.request, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(unkept.token, null);
  assert.deepEqual(requests.stats(), { requests: 0 });

  const first = requests.ask(asker, { card, address: "b@example.com", message: "hi", keep: true });
  assert.ok(isRequestToken(first.token));
  assert.deepEqual(
    { ...requests.byToken(first.token), expiresAt: undefined },
    {
      id: first.request,
      token: first.token,
      asker: { userId: "u1", address: "desktop:a" },
      card,
      address: "b@example.com",
      message: "hi",
      expiresAt: undefined,
    }
  );
  const second = requests.ask(asker, { card, address: "c@example.com", keep: true });
  const third = requests.ask(asker, { card, address: "d@example.com", keep: true });
  assert.equal(requests.byToken(first.token), null, "the oldest made room");
  assert.equal(requests.byToken(second.token).address, "c@example.com");
  assert.equal(requests.byToken(third.token).message, null);
  assert.equal(requests.byToken("A".repeat(43)), null);
  assert.equal(requests.byToken(undefined), null);
  // Another desktop keeps its own.
  requests.ask({ userId: "u1", address: "desktop:b" }, { card, address: "e@example.com", keep: true });
  assert.deepEqual(requests.stats(), { requests: 3 });

  t += 24 * 60 * 60_000 - 1;
  requests.sweep();
  assert.deepEqual(requests.stats(), { requests: 3 });
  t += 1;
  requests.sweep();
  assert.deepEqual(requests.stats(), { requests: 0 });

  // Its email allowance is its own.
  assert.equal(requests.mayEmail("u1", "u2"), true);
  assert.equal(requests.mayEmail("u1", "u2"), false);

  const source = await src("../src/modules/forgedrop-link/requests.js");
  assert.match(source, /sweeper\.unref\?\.\(\)/);
});

test("a request's shapes: messages, tokens, guests' addresses and types, and the documented limits", () => {
  assert.equal(parseMessage(undefined), null);
  assert.equal(parseMessage("  \n "), null);
  assert.equal(parseMessage("  Hi\r\nthere\r\tyou  "), "Hi\nthere\n\tyou");
  assert.equal(parseMessage(`a${String.fromCharCode(0)}b${String.fromCharCode(0x202e)}c${String.fromCharCode(0x2066)}d`), "abcd");
  const zwj = `\u{1F469}${String.fromCharCode(0x200d)}\u{1F4BB}`;
  assert.equal(parseMessage(zwj), zwj, "emoji keep their joiners");
  assert.equal(parseMessage("x".repeat(1000)).length, 1000);
  assert.equal(parseMessage("x".repeat(1001)), undefined);
  assert.equal(parseMessage("\u{1F600}".repeat(1000)).length, 2000, "a thousand characters, however long in UTF-16");
  assert.equal(parseMessage("\u{1F600}".repeat(1001)), undefined);
  for (const value of [7, true, [], {}]) assert.equal(parseMessage(value), undefined, JSON.stringify(value));

  assert.equal(isRequestToken(crypto.randomBytes(32).toString("base64url")), true);
  for (const token of ["A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, 7, null]) {
    assert.equal(isRequestToken(token), false, JSON.stringify(token));
  }

  const id = newClientId();
  assert.deepEqual(parseAddress(`guest:${id}`), { kind: "guest", id, address: `guest:${id}` });
  for (const bad of ["guest:short", `guest:${id}!`, `guest:${"x".repeat(65)}`, "guest:"]) assert.equal(parseAddress(bad), null, bad);
  assert.deepEqual([...GUEST_TYPES].sort(), ["bye", "offer"]);
  assert.equal(takesGuests({ caps: ["phone-link"] }), true);
  assert.equal(takesGuests({ caps: ["people", "internet"] }), false);
  assert.equal(takesGuests({ caps: null }), false, "only an app that says so");
  assert.equal(takesGuests(null), false);

  assert.equal(PERSON_LIMITS.requestMs, 24 * 60 * 60_000);
  assert.equal(PERSON_LIMITS.requestsPerDesktop, 64);
  assert.equal(PERSON_LIMITS.messageChars, 1000);
  assert.equal(PERSON_LIMITS.rate.requestPerMinute, 10);
  assert.equal(PERSON_LIMITS.rate.requestPagePerMinute, 60);
});

test("the mounted module emails requests for real, linking to the website's /s/ page", async () => {
  const index = await src("../src/modules/forgedrop-link/index.js");
  assert.match(index, /import \{[^}]*\bsendForgeDropFileRequestEmail\b[^}]*\} from "\.\.\/\.\.\/services\/email\.service\.js";/);
  assert.match(index, /sendRequestEmail: sendForgeDropFileRequestEmail,/);
  assert.match(index, /requestLink: \(token\) => `\$\{siteUrl\("\/s\/"\)\}#\$\{token\}`,/);
});

test("nothing went wrong unnoticed", () => {
  assert.deepEqual(logged.filter((entry) => entry.level === "error"), []);
});
