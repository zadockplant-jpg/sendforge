// ForgeDrop Cloud pickup: files a desktop sealed and left in R2 for another
// computer, deleted once picked up or after 7 days (ForgeDrop/docs/pickup.md).
//
// The HTTP tests run the real router, real licences minted by the activation
// service, real device_activations and product_entitlements rows and the
// real migration, against an in-process Postgres (PGlite). R2 is an
// in-process stand-in (helpers/fake-r2.js) that checks every signature
// against the request that actually arrived; the signer itself is checked
// against AWS's published examples. The clock is a dial the tests turn.

import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import express from "express";

import { startFakeR2 } from "./helpers/fake-r2.js";
import { attachPglite } from "./helpers/pglite-db.js";

const SEED = crypto.randomBytes(32).toString("base64");
process.env.LICENSE_SIGNING_KEY = SEED;
process.env.LICENSE_SIGNING_KID = "fd-test";

// env.js reads the environment when it is first imported, so everything that
// touches it is imported after the key is set.
const { db } = await import("../src/config/db.js");
const { env } = await import("../src/config/env.js");
const { grantProductEntitlement, hasProductEntitlement, listProductEntitlements, revokeProductEntitlement } =
  await import("../src/services/entitlement.service.js");
const { activateDevice, deactivateDevice } = await import("../src/services/deviceActivation.service.js");
const { forgedropFingerprint } = await import("../src/services/identityProof.service.js");
const { sendForgeDropPickupWaitingEmail } = await import("../src/services/email.service.js");
const { up: pickupsUp } = await import("../src/db/migrations/20260928_create_forgedrop_pickups.js");
const { createForgeDropPickupRouter, PICKUP_LIMITS } = await import("../src/modules/forgedrop-pickup/router.js");
const { createR2Client, EMPTY_SHA256, r2ConfigProblems, readR2Config, signV4 } = await import(
  "../src/modules/forgedrop-pickup/r2.js"
);
const { bytesSentThisMonth, CLOUD_PICKUP_TIERS, GB, monthWindow, TB, tierForStripePrice, tierFromEntitlements } =
  await import("../src/modules/forgedrop-pickup/plans.js");
const { partPlan } = await import("../src/modules/forgedrop-pickup/shapes.js");
const { forgedropPickupRouter, loadForgeDropPickup } = await import("../src/modules/forgedrop-pickup/index.js");

const src = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

// ------------------------------------------------------------------ fixtures

const MiB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
// The part size here; the real one, 64 MiB, is checked on its own below.
const PART = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let clock = Date.UTC(2026, 8, 10, 12, 0, 0);
const now = () => clock;
const advance = (ms) => {
  clock += ms;
};

const logged = [];
const log = (level, msg, meta) => logged.push({ level, msg, meta });
const mail = [];
const mailer = { fails: false };
const sendWaitingEmail = async (message) => {
  if (mailer.fails) throw new Error("SendGrid said no");
  mail.push(message);
};

const R2 = { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key", bucket: "forgedrop-pickups" };
// What the desktop's pickup.seal_key makes; here only relayed.
const SEALED_KEY = { v: 1, eph: "ZXBoZW1lcmFs", key: "c2VhbGVkIGZpbGUga2V5", from: "0123-4567-89ab-cdef", tag: "dGFn" };

let fake;
let server;
let origin;
let detach;
let main;
const routers = [];
const people = {};
const devices = {};

function mount(overrides = {}) {
  const router = createForgeDropPickupRouter({
    db,
    hasProductEntitlement,
    listProductEntitlements,
    signingKey: () => env.licenseSigningKey,
    r2Config: { ...R2, endpoint: fake.origin, region: "auto" },
    sendWaitingEmail,
    now,
    log,
    // The tests run the sweep themselves.
    sweepEveryMs: 0,
    limits: { partBytes: PART },
    // The limits are tested on their own mount below.
    rate: { createPerMinute: 1e6, requestsPerMinute: 1e6 },
    ...overrides,
  });
  routers.push(router);
  return router;
}

async function signUp(name, { owns = true, tier = null, verified = true } = {}) {
  const id = randomUUID();
  const email = `${name}@example.com`;
  await db("users").insert({ id, email, email_verified: verified });
  if (owns) await grantProductEntitlement({ userId: id, productSlug: "forgedrop", source: "test" });
  if (tier) await grantProductEntitlement({ userId: id, productSlug: tier, source: "test" });
  people[name] = { id, email };
  return people[name];
}

function newIdentity() {
  const { publicKey } = crypto.generateKeyPairSync("x25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { identity: raw.toString("hex"), fingerprint: forgedropFingerprint(raw) };
}

/** A desktop; `proven` means it showed it holds its identity key. */
async function activate(key, person, name, { proven = true } = {}) {
  const { identity, fingerprint } = newIdentity();
  const result = await activateDevice({
    userId: person.id,
    productSlug: "forgedrop",
    deviceId: randomUUID(),
    deviceName: name,
    platform: "windows",
    appVersion: "1.6.0",
    identityFingerprint: fingerprint,
    identityPublicKey: proven ? identity : null,
    deviceLimit: 20,
  });
  devices[key] = { deviceId: result.deviceId, token: result.token, owner: person, name, identity, fingerprint };
  return devices[key];
}

before(async () => {
  detach = await attachPglite(db);
  await pickupsUp(db);
  fake = await startFakeR2(R2);

  const tier100 = "forgedrop-cloud-pickup-100gb";
  const alice = await signUp("alice", { tier: tier100 });
  const bob = await signUp("bob");
  const carol = await signUp("carol");
  const dave = await signUp("dave");
  const erin = await signUp("erin", { owns: false });
  const frank = await signUp("frank", { verified: false });
  const gina = await signUp("gina");
  const hank = await signUp("hank", { tier: tier100 });

  await activate("studio", alice, "Studio PC");
  await activate("aliceLaptop", alice, "Alice Laptop", { proven: false });
  await activate("bobDesktop", bob, "Bob Desktop");
  await activate("bobSpare", bob, "Bob Spare");
  await activate("carolPc", carol, "Carol PC");
  await activate("davePc", dave, "Dave PC");
  await activate("erinPc", erin, "Erin PC");
  await activate("frankPc", frank, "Frank PC");
  await activate("ginaPc", gina, "Gina PC");
  await deactivateDevice(gina.id, "forgedrop", devices.ginaPc.deviceId);
  await activate("hankPc", hank, "Hank PC");

  main = mount();
  const app = express();
  // app.js runs the app-wide form parser ahead of every router; so does this.
  app.use(express.urlencoded({ extended: false }));
  app.use("/v1/forgedrop/pickup", main);
  // The real sizes: 64 MiB parts.
  app.use("/big", mount({ limits: {} }));
  app.use("/unconfigured", mount({ r2Config: null }));
  app.use("/nokey", mount({ signingKey: () => "", rateLimitPrefix: "fdp-nokey" }));
  app.use("/strict", mount({ rate: { createPerMinute: 2, requestsPerMinute: 1e6 }, rateLimitPrefix: "fdp-strict" }));
  app.use("/real", forgedropPickupRouter);
  app.use(
    "/broken",
    await loadForgeDropPickup(
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
  for (const router of routers) router.stop();
  server?.closeAllConnections?.();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await fake?.close();
  await detach?.();
});

// ------------------------------------------------------------------- helpers

async function call(path, { method = "POST", body, raw, licence, headers = {}, base = "/v1/forgedrop/pickup" } = {}) {
  const init = { method, headers: { ...headers } };
  if (licence !== undefined) init.headers["X-ForgeDrop-License"] = licence;
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
  return { status: response.status, body: json, headers: response.headers };
}

/** The pickup API as one desktop calls it (forgedrop/core/pickup_transfer.py). */
const as = (device, base) => ({
  create: (body) => call("", { licence: device.token, body, base }),
  done: (id, parts = {}) => call(`/${id}/done`, { licence: device.token, body: { parts }, base }),
  waiting: () => call("/waiting", { method: "GET", licence: device.token, base }),
  get: (id) => call(`/${id}`, { method: "GET", licence: device.token, base }),
  pickedUp: (id) => call(`/${id}/picked-up`, { licence: device.token, body: {}, base }),
  cancel: (id) => call(`/${id}/cancel`, { licence: device.token, body: {}, base }),
});

async function putTo(url, bytes) {
  const res = await fetch(url, { method: "PUT", body: bytes });
  assert.equal(res.status, 200, await res.text());
  return res.headers.get("etag");
}

async function getFrom(url) {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Leave `files` (already sealed, as far as anyone here can tell) for
 * `recipient`, and upload them as the desktop does, except the objects in
 * `skip`. Returns the id, the create answer and the ETags for done.
 */
async function leave(device, recipient, files, { manifest = crypto.randomBytes(64), skip = [], base } = {}) {
  const body = { recipient, objects: files.map((file) => file.length), manifestSize: manifest.length };
  if (recipient.fingerprint) body.sealedKey = SEALED_KEY;
  const created = await as(device, base).create(body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const parts = {};
  for (const [n, target] of created.body.uploads.entries()) {
    if (skip.includes(n)) continue;
    if (target.url) {
      parts[n] = [await putTo(target.url, files[n])];
      continue;
    }
    parts[n] = [];
    for (const [index, url] of target.urls.entries()) {
      parts[n].push(await putTo(url, files[n].subarray(index * target.partSize, (index + 1) * target.partSize)));
    }
  }
  await putTo(created.body.manifest.url, manifest);
  return { id: created.body.id, created: created.body, parts, manifest };
}

const pickupRow = (id) => db("forgedrop_pickups").where({ id }).first();
const pickupCount = async () => Number((await db("forgedrop_pickups").count({ n: "*" }).first()).n);
const objectRows = async (id) =>
  Number((await db("forgedrop_pickup_objects").where({ pickup_id: id }).count({ n: "*" }).first()).n);

const ROUTES = (id) => [
  ["POST", ""],
  ["GET", "/waiting"],
  ["GET", `/${id}`],
  ["POST", `/${id}/done`],
  ["POST", `/${id}/picked-up`],
  ["POST", `/${id}/cancel`],
];

// ---------------------------------------------------------------- the signer

test("the signer reproduces AWS's published Signature Version 4 examples", () => {
  const AWS = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
  };

  // S3, "Authenticating Requests: Using Query Parameters": a presigned GET.
  const client = createR2Client({
    ...AWS,
    bucket: "examplebucket",
    endpoint: "https://s3.amazonaws.com",
    hostStyle: "virtual",
    now: () => Date.UTC(2013, 4, 24),
  });
  assert.equal(
    client.presignGet("test.txt", 86400),
    "https://examplebucket.s3.amazonaws.com/test.txt" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
  );

  // S3, "Signature Calculations for the Authorization Header": a GET with a
  // Range header, and a PUT whose key has to be escaped ($ is %24).
  const host = "examplebucket.s3.amazonaws.com";
  const amzDate = "20130524T000000Z";
  const get = signV4({
    ...AWS,
    amzDate,
    method: "GET",
    path: "/test.txt",
    headers: { host, range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": amzDate },
    payloadHash: EMPTY_SHA256,
  });
  assert.equal(get.signedHeaders, "host;range;x-amz-content-sha256;x-amz-date");
  assert.equal(get.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");

  const payloadHash = crypto.createHash("sha256").update("Welcome to Amazon S3.").digest("hex");
  const put = signV4({
    ...AWS,
    amzDate,
    method: "PUT",
    path: "/test$file.text",
    headers: {
      date: "Fri, 24 May 2013 00:00:00 GMT",
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
    },
    payloadHash,
  });
  assert.match(put.canonicalRequest, /^PUT\n\/test%24file\.text\n/);
  assert.equal(put.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
});

test("R2 is addressed path-style under its account, region auto; a presigned PUT pins its length", () => {
  const client = createR2Client({
    accessKeyId: "id",
    secretAccessKey: "secret",
    bucket: "drops",
    endpoint: "https://0123abcd.r2.cloudflarestorage.com",
    now: () => Date.UTC(2026, 8, 26, 9, 30),
  });
  const put = new URL(client.presignPut("pickups/abc/0", 1234, 86400));
  assert.equal(put.host, "0123abcd.r2.cloudflarestorage.com");
  assert.equal(put.pathname, "/drops/pickups/abc/0");
  assert.equal(put.searchParams.get("X-Amz-Credential"), "id/20260926/auto/s3/aws4_request");
  assert.equal(put.searchParams.get("X-Amz-SignedHeaders"), "content-length;host");
  const part = new URL(client.presignUploadPart("pickups/abc/1", "up+load/id=", 3, 99, 60));
  assert.equal(part.searchParams.get("partNumber"), "3");
  assert.equal(part.searchParams.get("uploadId"), "up+load/id=", "escaped in the link, whole when read");
  assert.equal(new URL(client.presignGet("pickups/abc/0", 3600)).searchParams.get("X-Amz-SignedHeaders"), "host");
  // Upload links are timed from when the pickup was made, not from now.
  const timed = new URL(client.presignPut("pickups/abc/0", 1, 86400, Date.UTC(2026, 8, 25, 23, 0)));
  assert.equal(timed.searchParams.get("X-Amz-Date"), "20260925T230000Z");
  assert.equal(put.searchParams.get("X-Amz-Date"), "20260926T093000Z");
});

test("R2's settings come from R2_*; with any of them missing there are none", () => {
  const full = {
    R2_ACCOUNT_ID: " 0123abcd ",
    R2_ACCESS_KEY_ID: "key-id",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "forgedrop-pickups",
  };
  assert.deepEqual(readR2Config(full), {
    accountId: "0123abcd",
    accessKeyId: "key-id",
    secretAccessKey: "secret",
    bucket: "forgedrop-pickups",
    endpoint: "https://0123abcd.r2.cloudflarestorage.com",
    region: "auto",
  });
  assert.deepEqual(r2ConfigProblems(full), []);
  for (const name of Object.keys(full)) {
    assert.equal(readR2Config({ ...full, [name]: "" }), null, name);
    assert.deepEqual(r2ConfigProblems({ ...full, [name]: undefined }), [`${name} missing`]);
  }
  assert.deepEqual(r2ConfigProblems({ ...full, R2_BUCKET: "Not_A_Bucket" }), ["R2_BUCKET invalid"]);
  assert.deepEqual(r2ConfigProblems({ ...full, R2_ACCOUNT_ID: "a.b/c" }), ["R2_ACCOUNT_ID invalid"]);
  assert.equal(readR2Config({}), null);
});

// ------------------------------------------------------- no R2, no module

test("without R2's settings every pickup route answers 503 pickup_unavailable, and a broken module cannot stop the API", async () => {
  const id = randomUUID();
  // The mounted module, built from this process's environment: no R2 here.
  for (const base of ["/unconfigured", "/real", "/broken"]) {
    for (const [method, path] of ROUTES(id)) {
      for (const licence of [undefined, devices.studio.token]) {
        const res = await call(path, { method, base, licence, body: method === "POST" ? {} : undefined });
        assert.deepEqual([res.status, res.body], [503, { error: "pickup_unavailable" }], `${base} ${method} ${path}`);
        assert.equal(res.headers.get("cache-control"), "no-store");
      }
    }
  }
  assert.ok(
    logged.some(
      (entry) =>
        entry.msg === "forgedrop_pickup_unavailable" &&
        entry.meta.reason === "r2_not_configured" &&
        entry.meta.problems.includes("R2_BUCKET missing")
    )
  );
  assert.ok(logged.some((entry) => entry.msg === "forgedrop_pickup_unavailable" && /router\.js/.test(entry.meta.message)));
  const wrongShape = await loadForgeDropPickup(async () => ({ not: "a router" }), { logger: () => {} });
  assert.equal(typeof wrongShape, "function");

  const app = await src("../src/app.js");
  // Lose this and every pickup request 404s with nothing else looking wrong.
  assert.match(app, /import \{ forgedropPickupRouter \} from "\.\/modules\/forgedrop-pickup\/index\.js";/);
  assert.match(app, /app\.use\("\/v1\/forgedrop\/pickup", forgedropPickupRouter\);/);
  const mountAt = app.indexOf('app.use("/v1/forgedrop/pickup", forgedropPickupRouter)');
  assert.ok(mountAt > app.search(/app\.use\(\s*cors\(/));
  assert.ok(mountAt < app.search(/app\.use\(\s*express\.json\(/), "before the shared parser, so its own applies");

  // index.js holds the module's own code behind a dynamic import and a catch.
  const index = await src("../src/modules/forgedrop-pickup/index.js");
  assert.doesNotMatch(index, /from "\.\/[a-z0-9-]+\.js"/, "no static import of the module's own files");
  assert.match(index, /await import\("\.\/router\.js"\)/);
});

// ------------------------------------------------------------------- sign-in

test("every route is for a desktop signed in with its ForgeDrop licence", async () => {
  const id = randomUUID();
  for (const [method, path] of ROUTES(id)) {
    const body = method === "POST" ? {} : undefined;
    const none = await call(path, { method, body });
    assert.deepEqual([none.status, none.body], [401, { error: "licence_invalid" }], `${method} ${path}`);
    const junk = await call(path, { method, body, licence: "FD1.e30.AAAA" });
    assert.deepEqual([junk.status, junk.body], [401, { error: "licence_invalid" }]);
    const freed = await call(path, { method, body, licence: devices.ginaPc.token });
    assert.deepEqual([freed.status, freed.body], [403, { error: "device_inactive" }]);
    const unowned = await call(path, { method, body, licence: devices.erinPc.token });
    assert.deepEqual([unowned.status, unowned.body], [403, { error: "entitlement_required" }]);
    // Without the licence key nothing can be checked: the pickup's own 503.
    const nokey = await call(path, { method, body, licence: devices.studio.token, base: "/nokey" });
    assert.deepEqual([nokey.status, nokey.body], [503, { error: "pickup_unavailable" }]);
  }
});

// ----------------------------------------------------- a computer's pickup

test("a computer's pickup: left, uploaded, finished, listed, downloaded, picked up, and then gone", async () => {
  const { studio, bobDesktop } = devices;
  const files = [crypto.randomBytes(1000), crypto.randomBytes(2345)];
  const manifest = crypto.randomBytes(300);

  const created = await as(studio).create({
    recipient: { fingerprint: bobDesktop.fingerprint.toUpperCase() },
    objects: files.map((file) => file.length),
    manifestSize: manifest.length,
    sealedKey: SEALED_KEY,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, expiresAt, uploads } = created.body;
  assert.match(id, UUID);
  assert.deepEqual(Object.keys(created.body).sort(), ["expiresAt", "id", "manifest", "uploads"]);
  assert.equal(expiresAt, new Date(clock + 7 * DAY).toISOString());
  assert.equal(uploads.length, 2);
  for (const upload of uploads) assert.deepEqual(Object.keys(upload), ["url"]);
  const link = new URL(uploads[1].url);
  assert.equal(link.origin, fake.origin);
  assert.equal(link.pathname, `/${R2.bucket}/pickups/${id}/1`);
  assert.equal(link.searchParams.get("X-Amz-SignedHeaders"), "content-length;host");
  assert.equal(link.searchParams.get("X-Amz-Expires"), "86400");
  assert.equal(new URL(created.body.manifest.url).pathname, `/${R2.bucket}/pickups/${id}/manifest`);
  const row = await pickupRow(id);
  assert.equal(row.status, "uploading");
  assert.equal(row.recipient_kind, "device");
  assert.equal(row.recipient_user_id, people.bob.id, "the recipient computer's account");
  assert.equal(row.recipient_fingerprint, bobDesktop.fingerprint);
  assert.equal(Number(row.total_bytes), 1000 + 2345 + 300);

  // Until the upload is finished, the recipient sees nothing.
  assert.deepEqual((await as(bobDesktop).waiting()).body, { pickups: [] });
  assert.equal((await as(bobDesktop).get(id)).status, 404);

  const parts = { 0: [await putTo(uploads[0].url, files[0])], 1: [await putTo(uploads[1].url, files[1])] };
  await putTo(created.body.manifest.url, manifest);
  const mailed = mail.length;
  const done = await as(studio).done(id, parts);
  assert.deepEqual([done.status, done.body], [200, { id, status: "waiting", expiresAt }]);
  assert.equal(mail.length, mailed + 1);
  assert.deepEqual(mail.at(-1), {
    to: "bob@example.com",
    fromName: "Studio PC",
    expiresAt: new Date(expiresAt),
    pickupId: id,
  });
  // Said twice (a reply lost on the way back): the same answer, one email.
  assert.deepEqual((await as(studio).done(id, parts)).body, { id, status: "waiting", expiresAt });
  assert.equal(mail.length, mailed + 1);

  const waiting = await as(bobDesktop).waiting();
  assert.deepEqual(waiting.body, {
    pickups: [
      {
        id,
        fromName: "Studio PC",
        fromFingerprint: studio.fingerprint,
        fromIdentity: studio.identity,
        sealedKey: SEALED_KEY,
        objects: 2,
        totalBytes: 1000 + 2345 + 300,
        expiresAt,
      },
    ],
  });

  const links = await as(bobDesktop).get(id);
  assert.equal(links.status, 200);
  assert.deepEqual(Object.keys(links.body).sort(), ["expiresAt", "id", "manifest", "objects"]);
  assert.equal(new URL(links.body.manifest).searchParams.get("X-Amz-Expires"), "3600");
  assert.deepEqual(await getFrom(links.body.manifest), manifest);
  assert.equal(links.body.objects.length, 2);
  for (const [n, url] of links.body.objects.entries()) assert.deepEqual(await getFrom(url), files[n]);

  // The desktop's requests went on presigned links; this server's own,
  // signed in their headers, checked every object and the manifest.
  const traffic = fake.requests.filter((entry) => entry.key.startsWith(`pickups/${id}/`));
  for (const entry of traffic) {
    const presigned = ["PutObject", "UploadPart", "GetObject"].includes(entry.operation);
    assert.equal(entry.auth, presigned ? "presigned" : "header", entry.operation);
  }
  assert.deepEqual(
    [...new Set(traffic.filter((entry) => entry.operation === "HeadObject").map((entry) => entry.key))].sort(),
    [`pickups/${id}/0`, `pickups/${id}/1`, `pickups/${id}/manifest`]
  );

  assert.equal((await as(bobDesktop).pickedUp(id)).status, 204);
  assert.deepEqual(fake.keysOf(id), [], "deleted as soon as it is picked up");
  const kept = await pickupRow(id);
  assert.equal(kept.status, "picked_up");
  assert.ok(kept.uploaded_at && kept.picked_up_at && kept.deleted_at);
  // All that is left: the sender's account, bytes and times.
  for (const column of [
    "sender_device_id",
    "sender_name",
    "sender_fingerprint",
    "sender_identity_key",
    "recipient_user_id",
    "recipient_fingerprint",
    "sealed_key",
  ]) {
    assert.equal(kept[column], null, column);
  }
  assert.equal(kept.sender_user_id, people.alice.id);
  assert.equal(Number(kept.total_bytes), 3645);
  assert.equal(await objectRows(id), 0);

  assert.equal((await as(bobDesktop).pickedUp(id)).status, 204, "said twice: already done");
  assert.deepEqual((await as(bobDesktop).waiting()).body, { pickups: [] });
  assert.equal((await as(bobDesktop).get(id)).status, 404);
  const late = await as(studio).done(id, parts);
  assert.deepEqual([late.status, late.body], [409, { error: "pickup_closed", status: "picked_up" }]);
  const cancelled = await as(studio).cancel(id);
  assert.deepEqual([cancelled.status, cancelled.body], [409, { error: "pickup_closed", status: "picked_up" }]);
});

test("the recipient must be an active computer that proved its key; anything else is recipient_unknown", async () => {
  const { studio, aliceLaptop, ginaPc } = devices;
  const leaveFor = (fingerprint) =>
    as(studio).create({ recipient: { fingerprint }, objects: [100], manifestSize: 50, sealedKey: SEALED_KEY });
  const before = await pickupCount();

  // Nobody's key; a computer that never proved its key; a freed slot.
  for (const fingerprint of ["0123-4567-89ab-cdef", aliceLaptop.fingerprint, ginaPc.fingerprint]) {
    const res = await leaveFor(fingerprint);
    assert.deepEqual([res.status, res.body], [404, { error: "recipient_unknown" }], fingerprint);
  }
  for (const fingerprint of ["", "not-a-fingerprint", "0123456789abcdef", 42, null]) {
    assert.deepEqual((await leaveFor(fingerprint)).body, { error: "bad_recipient" }, String(fingerprint));
  }
  assert.equal(await pickupCount(), before, "nothing was left, so nothing was counted");

  // Once it proves its key, it can be sent to.
  await db("device_activations")
    .where({ device_id: aliceLaptop.deviceId })
    .update({ identity_public_key: aliceLaptop.identity, identity_verified_at: new Date(clock) });
  try {
    const res = await leaveFor(aliceLaptop.fingerprint);
    assert.equal(res.status, 201);
    assert.equal((await as(studio).cancel(res.body.id)).status, 204);
  } finally {
    await db("device_activations")
      .where({ device_id: aliceLaptop.deviceId })
      .update({ identity_public_key: null, identity_verified_at: null });
  }
});

test("leaving files for a computer takes a sender that proved its own key; a link does not", async () => {
  const { aliceLaptop, bobDesktop } = devices;
  const refused = await as(aliceLaptop).create({
    recipient: { fingerprint: bobDesktop.fingerprint },
    objects: [100],
    manifestSize: 50,
    sealedKey: SEALED_KEY,
  });
  assert.deepEqual([refused.status, refused.body], [403, { error: "sender_unproven" }]);

  const link = await as(aliceLaptop).create({ recipient: { link: true }, objects: [100], manifestSize: 50 });
  assert.equal(link.status, 201);
  const row = await pickupRow(link.body.id);
  assert.equal(row.recipient_kind, "link");
  assert.equal(row.sender_fingerprint, null);
  assert.equal(row.sealed_key, null, "a link's key rides in the link");
  assert.equal((await as(aliceLaptop).cancel(link.body.id)).status, 204);

  // A computer that has not proved its key has nothing sealed to it.
  assert.deepEqual((await as(aliceLaptop).waiting()).body, { pickups: [] });
});

// ------------------------------------------------------------- the allowance

test("without a plan it is plan_required; past the month's allowance, allowance_used", async () => {
  const { davePc, hankPc, bobDesktop } = devices;
  for (const recipient of [{ link: true }, { fingerprint: bobDesktop.fingerprint }]) {
    const res = await as(davePc).create({
      recipient,
      objects: [100],
      manifestSize: 50,
      ...(recipient.fingerprint ? { sealedKey: SEALED_KEY } : {}),
    });
    assert.deepEqual([res.status, res.body], [402, { error: "plan_required" }]);
  }

  // Hank's plan: 100 GB a month. Leaving files reserves their bytes at once.
  const hank = as(hankPc, "/big");
  const big = (bytes, manifestSize = 1000) => hank.create({ recipient: { link: true }, objects: [bytes], manifestSize });
  const first = await big(60 * GB);
  assert.equal(first.status, 201);
  assert.equal(first.body.uploads[0].partSize, 64 * MiB);
  assert.equal(first.body.uploads[0].urls.length, 960);

  const refused = await big(40 * GB);
  assert.deepEqual(
    [refused.status, refused.body],
    [403, { error: "allowance_used", allowance: { bytes: 100 * GB, used: 60 * GB + 1000 } }]
  );

  // Cancelled before its upload was finished: it does not count.
  assert.equal((await hank.cancel(first.body.id)).status, 204);
  const second = await big(40 * GB);
  assert.equal(second.status, 201);

  // Finished and then cancelled: it counts.
  const small = await leave(hankPc, { link: true }, [crypto.randomBytes(10)], { manifest: crypto.randomBytes(20), base: "/big" });
  assert.equal((await hank.done(small.id, small.parts)).status, 200);
  assert.equal((await hank.cancel(small.id)).status, 204);
  const used = 40 * GB + 1000 + 30;
  assert.equal(await bytesSentThisMonth(db, people.hank.id, clock), used);

  // What is left fits exactly; a byte more does not.
  const over = await big(100 * GB - used - 1000 + 1);
  assert.deepEqual(over.body, { error: "allowance_used", allowance: { bytes: 100 * GB, used } });
  const exact = await big(100 * GB - used - 1000);
  assert.equal(exact.status, 201);

  // A bigger plan held alongside: the bigger one counts.
  await grantProductEntitlement({ userId: people.hank.id, productSlug: "forgedrop-cloud-pickup-1tb", source: "test" });
  const upgraded = await big(GB);
  assert.equal(upgraded.status, 201);
  await revokeProductEntitlement(people.hank.id, "forgedrop-cloud-pickup-1tb");
  assert.equal((await big(GB)).status, 403);

  // A new month (UTC) starts from nothing.
  const { to } = monthWindow(clock);
  assert.equal(await bytesSentThisMonth(db, people.hank.id, to.getTime()), 0);
  assert.equal(await bytesSentThisMonth(db, people.hank.id, to.getTime() - 1), 100 * GB + GB + 1000);

  for (const res of [second, exact, upgraded]) assert.equal((await hank.cancel(res.body.id)).status, 204);
  assert.equal(await bytesSentThisMonth(db, people.hank.id, clock), 30);
});

test("plans: four tiers in one table, the biggest held wins, and Stripe prices map only once set", () => {
  assert.deepEqual(
    CLOUD_PICKUP_TIERS.map((tier) => [tier.slug, tier.monthlyCents, tier.bytes]),
    [
      ["forgedrop-cloud-pickup-100gb", 500, 100 * GB],
      ["forgedrop-cloud-pickup-250gb", 1000, 250 * GB],
      ["forgedrop-cloud-pickup-500gb", 1500, 500 * GB],
      ["forgedrop-cloud-pickup-1tb", 2500, TB],
    ]
  );
  assert.equal(tierFromEntitlements([]), null);
  assert.equal(tierFromEntitlements([{ product_slug: "forgedrop" }, { product_slug: "tabforge" }]), null);
  assert.equal(
    tierFromEntitlements([
      { product_slug: "forgedrop-cloud-pickup-250gb" },
      { product_slug: "forgedrop" },
      { product_slug: "forgedrop-cloud-pickup-100gb" },
    ]).slug,
    "forgedrop-cloud-pickup-250gb"
  );

  // Nothing is set yet, so no price is a tier.
  assert.equal(tierForStripePrice("price_123", {}), null);
  assert.equal(tierForStripePrice("", { STRIPE_PRICE_FORGEDROP_PICKUP_500GB: "" }), null);
  assert.equal(
    tierForStripePrice("price_500", { STRIPE_PRICE_FORGEDROP_PICKUP_500GB: " price_500 " }).slug,
    "forgedrop-cloud-pickup-500gb"
  );

  assert.deepEqual(monthWindow(Date.UTC(2026, 11, 31, 23, 59)), {
    from: new Date(Date.UTC(2026, 11, 1)),
    to: new Date(Date.UTC(2027, 0, 1)),
  });
});

// ----------------------------------------------------------------- uploads

test("64 MiB goes up in one PUT; more in 64 MiB parts; past 10,000 parts, bigger ones", () => {
  assert.equal(PICKUP_LIMITS.partBytes, 64 * MiB);
  assert.equal(partPlan(1), null);
  assert.equal(partPlan(64 * MiB), null);
  assert.deepEqual(partPlan(64 * MiB + 1), { partSize: 64 * MiB, count: 2 });
  assert.deepEqual(partPlan(200 * MiB), { partSize: 64 * MiB, count: 4 });
  assert.deepEqual(partPlan(10_000 * 64 * MiB), { partSize: 64 * MiB, count: 10_000 });
  const whole = partPlan(TB);
  assert.equal(whole.partSize % MiB, 0);
  assert.ok(whole.partSize > 64 * MiB && whole.count <= 10_000 && whole.partSize * whole.count >= TB);

  assert.equal(PICKUP_LIMITS.maxObjects, 10_000);
  assert.equal(PICKUP_LIMITS.maxTotalBytes, TB);
  assert.equal(PICKUP_LIMITS.keepMs, 7 * DAY);
  assert.equal(PICKUP_LIMITS.downloadUrlSeconds, 3600);
  assert.equal(PICKUP_LIMITS.staleUploadMs, DAY);
  assert.equal(PICKUP_LIMITS.sweepEveryMs, 10 * 60 * 1000);
});

test("an object over the part size goes up in parts, and done puts them together", async () => {
  const { studio, bobDesktop } = devices;
  const big = crypto.randomBytes(2 * PART + 1234);
  const small = crypto.randomBytes(10);
  const created = await as(studio).create({
    recipient: { fingerprint: bobDesktop.fingerprint },
    objects: [big.length, small.length],
    manifestSize: 40,
    sealedKey: SEALED_KEY,
  });
  assert.equal(created.status, 201);
  const { id } = created.body;
  const [multi, single] = created.body.uploads;
  assert.deepEqual(Object.keys(multi).sort(), ["partSize", "urls"]);
  assert.equal(multi.partSize, PART);
  assert.equal(multi.urls.length, 3);
  const uploadId = new URL(multi.urls[0]).searchParams.get("uploadId");
  assert.ok(fake.uploads.has(uploadId));
  assert.deepEqual(
    multi.urls.map((url) => new URL(url).searchParams.get("partNumber")),
    ["1", "2", "3"],
    "in part order"
  );
  assert.deepEqual(Object.keys(single), ["url"]);

  const etags = [];
  for (const [index, url] of multi.urls.entries()) etags.push(await putTo(url, big.subarray(index * PART, (index + 1) * PART)));
  const parts = { 0: etags, 1: [await putTo(single.url, small)] };
  await putTo(created.body.manifest.url, crypto.randomBytes(40));

  // Every part, in order: two of three is refused, and nothing is put together.
  const short = await as(studio).done(id, { ...parts, 0: etags.slice(0, 2) });
  assert.deepEqual([short.status, short.body], [400, { error: "bad_parts", object: 0 }]);
  const none = await as(studio).done(id, { 1: parts[1] });
  assert.deepEqual([none.status, none.body], [400, { error: "bad_parts", object: 0 }]);
  assert.ok(fake.uploads.has(uploadId));

  const finished = await as(studio).done(id, parts);
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.deepEqual(fake.objects.get(`pickups/${id}/0`), big);
  assert.equal(fake.uploads.has(uploadId), false);

  const links = await as(bobDesktop).get(id);
  assert.deepEqual(await getFrom(links.body.objects[0]), big);
  assert.deepEqual(await getFrom(links.body.objects[1]), small);
  assert.equal((await as(bobDesktop).pickedUp(id)).status, 204);
  assert.deepEqual(fake.keysOf(id), []);
});

test("an upload that is not what was declared is refused at done, and deleted", async () => {
  const { studio, bobDesktop } = devices;

  // R2 itself turns away a body of another length: the length is signed.
  const files = [crypto.randomBytes(500), crypto.randomBytes(600)];
  const { id, created, parts } = await leave(studio, { fingerprint: bobDesktop.fingerprint }, files);
  const longer = await fetch(created.uploads[1].url, { method: "PUT", body: crypto.randomBytes(601) });
  assert.equal(longer.status, 403);

  // Suppose one got through anyway.
  fake.objects.set(`pickups/${id}/1`, crypto.randomBytes(601));
  const mailed = mail.length;
  const res = await as(studio).done(id, parts);
  assert.deepEqual([res.status, res.body], [422, { error: "upload_mismatch", object: 1, expected: 600, found: 601 }]);
  assert.deepEqual(fake.keysOf(id), [], "none of it kept");
  const row = await pickupRow(id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.uploaded_at, null, "so not counted");
  assert.ok(row.deleted_at);
  assert.equal(mail.length, mailed, "nobody is told about it");
  assert.equal((await as(bobDesktop).get(id)).status, 404);
  // The desktop cancels after any failure; that is fine.
  assert.equal((await as(studio).cancel(id)).status, 204);

  // A file that never arrived.
  const missing = await leave(studio, { link: true }, [crypto.randomBytes(10), crypto.randomBytes(20)], { skip: [0] });
  const gone = await as(studio).done(missing.id, missing.parts);
  assert.deepEqual([gone.status, gone.body], [422, { error: "upload_mismatch", object: 0, expected: 10, found: null }]);
  assert.deepEqual(fake.keysOf(missing.id), []);

  // A manifest of another size.
  const manifest = await leave(studio, { link: true }, [crypto.randomBytes(10)]);
  fake.objects.set(`pickups/${manifest.id}/manifest`, crypto.randomBytes(3));
  const wrong = await as(studio).done(manifest.id, manifest.parts);
  assert.deepEqual(wrong.body, { error: "upload_mismatch", object: "manifest", expected: 64, found: 3 });

  // A part R2 does not have under that ETag: the multipart upload is let go.
  const multi = await leave(studio, { link: true }, [crypto.randomBytes(PART + 1)]);
  const uploadId = new URL(multi.created.uploads[0].urls[0]).searchParams.get("uploadId");
  const bad = await as(studio).done(multi.id, { 0: [multi.parts[0][0], '"0123456789abcdef0123456789abcdef"'] });
  assert.deepEqual([bad.status, bad.body], [422, { error: "upload_mismatch", object: 0 }]);
  assert.equal(fake.uploads.has(uploadId), false);
  assert.deepEqual(fake.keysOf(multi.id), []);
  assert.equal((await pickupRow(multi.id)).status, "cancelled");
});

test("done, after R2 had trouble, can be said again; what was put together is not asked twice", async () => {
  const { studio, bobDesktop } = devices;
  const big = crypto.randomBytes(PART + 100);
  const { id, parts } = await leave(studio, { fingerprint: bobDesktop.fingerprint }, [big, crypto.randomBytes(5)]);
  const completes = () =>
    fake.requests.filter((entry) => entry.operation === "CompleteMultipartUpload" && entry.key === `pickups/${id}/0`).length;

  fake.fail("HeadObject", { status: 500, code: "InternalError", times: 1 });
  const troubled = await as(studio).done(id, parts);
  assert.deepEqual([troubled.status, troubled.body], [503, { error: "pickup_unavailable" }]);
  assert.equal((await pickupRow(id)).status, "uploading", "nothing lost");
  assert.equal(completes(), 1);
  assert.ok(logged.some((entry) => entry.msg === "forgedrop_pickup_failed" && /HeadObject/.test(entry.meta.message)));

  const again = await as(studio).done(id, parts);
  assert.equal(again.status, 200);
  assert.equal(completes(), 1);
  assert.deepEqual(await getFrom((await as(bobDesktop).get(id)).body.objects[0]), big);
  assert.equal((await as(bobDesktop).pickedUp(id)).status, 204);
});

test("an object R2 already put together is taken as finished, not as missing", async () => {
  const { studio, bobDesktop } = devices;
  const big = crypto.randomBytes(PART + 7);
  const { id, created, parts } = await leave(studio, { fingerprint: bobDesktop.fingerprint }, [big]);
  // As if an earlier done had completed it and its note of that was lost.
  const uploadId = new URL(created.uploads[0].urls[0]).searchParams.get("uploadId");
  const client = createR2Client({ ...R2, endpoint: fake.origin, now });
  await client.completeMultipartUpload(`pickups/${id}/0`, uploadId, parts[0]);
  assert.equal(fake.uploads.has(uploadId), false);

  const done = await as(studio).done(id, parts);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(await getFrom((await as(bobDesktop).get(id)).body.objects[0]), big);
  assert.equal((await as(bobDesktop).pickedUp(id)).status, 204);
});

test("if R2 cannot start an upload, the pickup is dropped and nothing is counted", async () => {
  const { studio } = devices;
  const used = await bytesSentThisMonth(db, people.alice.id, clock);
  const before = await pickupCount();
  fake.fail("CreateMultipartUpload", { status: 500, code: "InternalError", times: 1 });
  const res = await as(studio).create({ recipient: { link: true }, objects: [PART + 1, PART + 2], manifestSize: 10 });
  assert.deepEqual([res.status, res.body], [503, { error: "pickup_unavailable" }]);

  assert.equal(await pickupCount(), before + 1);
  const row = await db("forgedrop_pickups").where({ total_bytes: 2 * PART + 13, object_count: 2 }).first();
  assert.equal(row.status, "cancelled");
  assert.ok(row.deleted_at);
  assert.equal(await objectRows(row.id), 0);
  assert.equal(await bytesSentThisMonth(db, people.alice.id, clock), used);
  // The other multipart upload, which R2 did start, is let go.
  assert.equal([...fake.uploads.values()].some((upload) => upload.key.startsWith(`pickups/${row.id}/`)), false);
});

// ------------------------------------------------------------- who sees it

test("a computer's pickup is only ever its recipient's: every other desktop gets 404, never 403", async () => {
  const { studio, bobDesktop, bobSpare, carolPc } = devices;
  const { id, parts } = await leave(studio, { fingerprint: bobDesktop.fingerprint }, [crypto.randomBytes(64)]);
  assert.equal((await as(studio).done(id, parts)).status, 200);

  // Another account's desktop, the recipient's own other desktop, the sender.
  for (const device of [carolPc, bobSpare, studio]) {
    const get = await as(device).get(id);
    assert.deepEqual([get.status, get.body], [404, { error: "not_found" }], device.name);
    assert.equal((await as(device).pickedUp(id)).status, 404);
    assert.equal((await as(device).waiting()).body.pickups.some((pickup) => pickup.id === id), false);
  }
  // Only the sending desktop finishes or cancels it.
  for (const device of [carolPc, bobDesktop, bobSpare]) {
    assert.deepEqual((await as(device).done(id, parts)).body, { error: "not_found" });
    assert.deepEqual((await as(device).cancel(id)).body, { error: "not_found" });
  }
  for (const other of ["nope", "123", randomUUID(), id.toUpperCase().replace(/-/g, "x")]) {
    assert.equal((await as(bobDesktop).get(other)).status, 404, other);
  }

  // Still there for its recipient, whatever the others tried.
  assert.equal((await as(bobDesktop).get(id)).status, 200);
  assert.equal((await as(bobDesktop).pickedUp(id)).status, 204);
});

test("a link's pickup is for any licensed desktop that knows its id", async () => {
  const { studio, carolPc, erinPc } = devices;
  const files = [crypto.randomBytes(77)];
  const { id, parts } = await leave(studio, { link: true }, files);
  const mailed = mail.length;
  assert.equal((await as(studio).done(id, parts)).status, 200);
  assert.equal(mail.length, mailed, "nobody to email: the link goes by hand");
  assert.deepEqual((await as(carolPc).waiting()).body, { pickups: [] }, "a link's pickup is never listed");

  const links = await as(carolPc).get(id);
  assert.equal(links.status, 200);
  assert.deepEqual(await getFrom(links.body.objects[0]), files[0]);
  // Without ForgeDrop, turned away before the id is even looked at.
  const erin = await as(erinPc).get(id);
  assert.deepEqual([erin.status, erin.body], [403, { error: "entitlement_required" }]);

  assert.equal((await as(carolPc).pickedUp(id)).status, 204);
  assert.deepEqual(fake.keysOf(id), []);
  assert.equal((await as(carolPc).get(id)).status, 404);
});

test("the sender can take a pickup back while it uploads or waits; nobody else can", async () => {
  const { studio, bobDesktop, carolPc } = devices;

  // Uploading, a multipart upload under way.
  const uploading = await leave(
    studio,
    { fingerprint: bobDesktop.fingerprint },
    [crypto.randomBytes(PART + 5), crypto.randomBytes(9)],
    { skip: [0] }
  );
  const uploadId = new URL(uploading.created.uploads[0].urls[0]).searchParams.get("uploadId");
  assert.ok(fake.uploads.has(uploadId));
  assert.equal((await as(carolPc).cancel(uploading.id)).status, 404);
  assert.equal((await as(bobDesktop).cancel(uploading.id)).status, 404);
  assert.equal((await as(studio).cancel(uploading.id)).status, 204);
  assert.equal(fake.uploads.has(uploadId), false, "the multipart upload is let go");
  assert.deepEqual(fake.keysOf(uploading.id), []);
  const row = await pickupRow(uploading.id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.sealed_key, null);
  assert.equal((await as(studio).cancel(uploading.id)).status, 204, "said twice");
  const late = await as(studio).done(uploading.id, uploading.parts);
  assert.deepEqual([late.status, late.body], [409, { error: "pickup_closed", status: "cancelled" }]);

  // Waiting: gone from the recipient's list, and no longer collected.
  const waiting = await leave(studio, { fingerprint: bobDesktop.fingerprint }, [crypto.randomBytes(9)]);
  assert.equal((await as(studio).done(waiting.id, waiting.parts)).status, 200);
  assert.equal((await as(bobDesktop).waiting()).body.pickups.some((pickup) => pickup.id === waiting.id), true);
  assert.equal((await as(studio).cancel(waiting.id)).status, 204);
  assert.equal((await as(bobDesktop).waiting()).body.pickups.some((pickup) => pickup.id === waiting.id), false);
  assert.equal((await as(bobDesktop).get(waiting.id)).status, 404);
  assert.equal((await as(bobDesktop).pickedUp(waiting.id)).status, 404);
  assert.deepEqual(fake.keysOf(waiting.id), []);
  assert.ok((await pickupRow(waiting.id)).uploaded_at, "finished before it was cancelled, so it counts");
});

// ------------------------------------------------------------------ email

test("the recipient is emailed only at a verified address, and a failed email does not fail done", async () => {
  const { studio, frankPc, bobDesktop } = devices;
  const unverified = await leave(studio, { fingerprint: frankPc.fingerprint }, [crypto.randomBytes(5)]);
  const mailed = mail.length;
  assert.equal((await as(studio).done(unverified.id, unverified.parts)).status, 200);
  assert.equal(mail.length, mailed);
  assert.ok(
    logged.some(
      (entry) =>
        entry.msg === "forgedrop_pickup_email_skipped" &&
        entry.meta.pickupId === unverified.id &&
        entry.meta.reason === "email_not_verified"
    )
  );
  // Frank's ForgeDrop lists it all the same.
  assert.deepEqual(
    (await as(frankPc).waiting()).body.pickups.map((pickup) => pickup.id),
    [unverified.id]
  );
  assert.equal((await as(frankPc).pickedUp(unverified.id)).status, 204);

  mailer.fails = true;
  try {
    const failing = await leave(studio, { fingerprint: bobDesktop.fingerprint }, [crypto.randomBytes(5)]);
    assert.equal((await as(studio).done(failing.id, failing.parts)).status, 200);
    assert.ok(logged.some((entry) => entry.msg === "forgedrop_pickup_email_failed" && entry.meta.pickupId === failing.id));
    assert.equal((await as(bobDesktop).pickedUp(failing.id)).status, 204);
  } finally {
    mailer.fails = false;
  }
});

test("the email names the sending computer and when the files go, and nothing else", async () => {
  const keys = ["NODE_ENV", "SENDGRID_API_KEY", "ACCOUNT_FROM_EMAIL", "SUPPORT_EMAIL"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const sent = [];
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
  try {
    const expiresAt = new Date(Date.UTC(2026, 9, 3, 14, 5));
    const named = await sendForgeDropPickupWaitingEmail({
      to: "bob@example.com",
      fromName: "Studio <b>PC</b>\r\nBcc: someone",
      expiresAt,
      pickupId: "pickup-1",
    });
    assert.equal(named.status, "accepted");
    await sendForgeDropPickupWaitingEmail({ to: "bob@example.com", fromName: null, expiresAt, pickupId: "pickup-2" });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }

  assert.equal(sent[0].url, "https://api.sendgrid.com/v3/mail/send");
  const { body } = sent[0];
  assert.equal(body.subject, "Files are waiting for you in ForgeDrop");
  assert.deepEqual(body.from, { email: "referrals@sendforge.app", name: "ForgeDrop" });
  assert.deepEqual(body.personalizations[0].to, [{ email: "bob@example.com" }]);
  assert.equal(body.personalizations[0].custom_args.sf_message_kind, "forgedrop-pickup-waiting");
  assert.equal(body.personalizations[0].custom_args.sf_message_ref, "pickup-1");
  const [text, html] = body.content.map((part) => part.value);
  assert.match(text, /^Files are waiting for you in ForgeDrop\.\n\nFrom: Studio <b>PC<\/b> Bcc: someone\n/);
  assert.match(text, /on October 3, 2026 at 2:05 PM UTC if they aren't\./);
  assert.match(html, /<strong>From:<\/strong> Studio &lt;b&gt;PC&lt;\/b&gt; Bcc: someone<\/p>/);
  assert.match(html, /October 3, 2026 at 2:05 PM UTC/);
  assert.doesNotMatch(text + html, /https?:\/\//, "no links to follow");

  const unnamed = sent[1].body.content[0].value;
  assert.match(unnamed, /From: another ForgeDrop computer\n/);
});

// ------------------------------------------------------------------- sweep

test("the sweep: a pickup waiting 7 days expires, an upload left for a day is abandoned; both are deleted", async () => {
  const { studio, bobDesktop } = devices;
  const waiting = await leave(studio, { fingerprint: bobDesktop.fingerprint }, [crypto.randomBytes(30)]);
  assert.equal((await as(studio).done(waiting.id, waiting.parts)).status, 200);
  const stuck = await leave(studio, { link: true }, [crypto.randomBytes(2 * PART)], { skip: [0] });
  const uploadId = new URL(stuck.created.uploads[0].urls[0]).searchParams.get("uploadId");

  advance(DAY - 60_000);
  await main.service.sweep();
  assert.equal((await pickupRow(stuck.id)).status, "uploading", "not a day yet");

  advance(2 * 60_000);
  const swept = await main.service.sweep();
  assert.ok(swept.abandoned >= 1);
  const abandoned = await pickupRow(stuck.id);
  assert.equal(abandoned.status, "cancelled", "never finished, so not counted");
  assert.equal(abandoned.uploaded_at, null);
  assert.ok(abandoned.deleted_at);
  assert.equal(fake.uploads.has(uploadId), false);
  assert.deepEqual(fake.keysOf(stuck.id), []);
  assert.equal((await pickupRow(waiting.id)).status, "waiting");

  // Seven days after it was left: no longer offered, even before the sweep.
  advance(6 * DAY);
  assert.equal((await as(bobDesktop).get(waiting.id)).status, 404);
  assert.equal((await as(bobDesktop).waiting()).body.pickups.some((pickup) => pickup.id === waiting.id), false);
  const later = await main.service.sweep();
  assert.ok(later.expired >= 1);
  const expired = await pickupRow(waiting.id);
  assert.equal(expired.status, "expired");
  assert.ok(expired.deleted_at);
  assert.equal(expired.recipient_fingerprint, null);
  assert.equal(expired.sealed_key, null);
  assert.deepEqual(fake.keysOf(waiting.id), []);
});

test("a deletion R2 turns down is tried again by the sweep", async () => {
  const { studio, bobDesktop } = devices;
  const { id, parts } = await leave(studio, { fingerprint: bobDesktop.fingerprint }, [crypto.randomBytes(12)]);
  assert.equal((await as(studio).done(id, parts)).status, 200);

  fake.fail("DeleteObject", { status: 503, code: "ServiceUnavailable", times: 1 });
  assert.equal((await as(bobDesktop).pickedUp(id)).status, 204, "collected is collected");
  let row = await pickupRow(id);
  assert.equal(row.status, "picked_up");
  assert.equal(row.deleted_at, null);
  assert.equal(row.sealed_key, null);
  assert.ok(fake.keysOf(id).length > 0);
  assert.ok(logged.some((entry) => entry.msg === "forgedrop_pickup_delete_failed" && entry.meta.pickupId === id));

  const swept = await main.service.sweep();
  assert.ok(swept.deleted >= 1);
  row = await pickupRow(id);
  assert.ok(row.deleted_at);
  assert.deepEqual(fake.keysOf(id), []);
});

test("an object put back while the upload links still worked is deleted once they have run out", async () => {
  const { studio, bobDesktop } = devices;
  const files = [crypto.randomBytes(40)];
  const { id, created, parts } = await leave(studio, { fingerprint: bobDesktop.fingerprint }, files);
  assert.equal((await as(studio).done(id, parts)).status, 200);
  assert.equal((await as(bobDesktop).pickedUp(id)).status, 204);
  assert.deepEqual(fake.keysOf(id), []);

  // The sender's link still works for the rest of the day.
  await putTo(created.uploads[0].url, files[0]);
  assert.deepEqual(fake.keysOf(id), [`pickups/${id}/0`]);
  await main.service.sweep();
  assert.deepEqual(fake.keysOf(id), [`pickups/${id}/0`], "not yet: the link could put it back again");

  advance(DAY + 60_000);
  const swept = await main.service.sweep();
  assert.ok(swept.redeleted >= 1);
  assert.deepEqual(fake.keysOf(id), []);
  const row = await pickupRow(id);
  assert.ok(new Date(row.deleted_at).getTime() >= new Date(row.created_at).getTime() + DAY);

  // And only the once.
  const seen = fake.requests.length;
  await main.service.sweep();
  assert.equal(fake.requests.slice(seen).filter((entry) => entry.key.startsWith(`pickups/${id}/`)).length, 0);
});

// ------------------------------------------------------------ the requests

test("bodies are checked: shapes, sizes and caps, and a refusal leaves nothing behind", async () => {
  const { studio, bobDesktop } = devices;
  const before = await pickupCount();
  const base = { recipient: { link: true }, objects: [10], manifestSize: 10 };
  const device = { recipient: { fingerprint: bobDesktop.fingerprint } };
  const refusals = [
    [{ ...base, recipient: undefined }, 400, "bad_recipient"],
    [{ ...base, recipient: { link: false } }, 400, "bad_recipient"],
    [{ ...base, recipient: "link" }, 400, "bad_recipient"],
    [{ ...base, recipient: { link: true, fingerprint: bobDesktop.fingerprint } }, 400, "bad_recipient"],
    [{ ...base, objects: [] }, 400, "bad_objects"],
    [{ ...base, objects: "10" }, 400, "bad_objects"],
    [{ ...base, objects: [10, 0] }, 400, "bad_objects"],
    [{ ...base, objects: [1.5] }, 400, "bad_objects"],
    [{ ...base, objects: [-1] }, 400, "bad_objects"],
    [{ ...base, objects: ["10"] }, 400, "bad_objects"],
    [{ ...base, objects: Array(10_001).fill(1) }, 413, "too_many_objects"],
    [{ ...base, manifestSize: 0 }, 400, "bad_manifest_size"],
    [{ ...base, manifestSize: undefined }, 400, "bad_manifest_size"],
    [{ ...base, manifestSize: 64 * MiB + 1 }, 413, "manifest_too_large"],
    [{ ...base, objects: [TB - 10, 1] }, 413, "pickup_too_large"],
    [{ ...base, sealedKey: SEALED_KEY }, 400, "bad_sealed_key"],
    [{ ...base, ...device }, 400, "bad_sealed_key"],
    [{ ...base, ...device, sealedKey: "sealed" }, 400, "bad_sealed_key"],
    [{ ...base, ...device, sealedKey: { pad: "x".repeat(5000) } }, 400, "bad_sealed_key"],
  ];
  for (const [body, status, error] of refusals) {
    const res = await as(studio).create(body);
    assert.deepEqual([res.status, res.body], [status, { error }], JSON.stringify(body).slice(0, 100));
  }
  assert.equal(await pickupCount(), before);

  const form = await call("", {
    licence: studio.token,
    raw: "objects=1",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  assert.deepEqual([form.status, form.body], [415, { error: "json_required" }]);
  const broken = await call("", { licence: studio.token, raw: "{", headers: { "Content-Type": "application/json" } });
  assert.deepEqual([broken.status, broken.body], [400, { error: "invalid_json" }]);
  const parts = await call(`/${randomUUID()}/done`, { licence: studio.token, body: { parts: ["etag"] } });
  assert.deepEqual([parts.status, parts.body], [400, { error: "bad_parts" }]);
  const nowhere = await call("/some/where/else", { method: "GET", licence: studio.token });
  assert.deepEqual([nowhere.status, nowhere.body], [404, { error: "not_found" }]);

  // Exactly at the cap is fine: 10,000 files, one link each.
  const most = await as(studio).create({ ...base, objects: Array(10_000).fill(48) });
  assert.equal(most.status, 201);
  assert.equal(most.body.uploads.length, 10_000);
  assert.equal(await objectRows(most.body.id), 10_000);
  assert.equal((await as(studio).cancel(most.body.id)).status, 204);
  assert.equal(await objectRows(most.body.id), 0);
});

test("leaving files is limited per account, with Retry-After", async () => {
  assert.deepEqual(PICKUP_LIMITS.rate, { createPerMinute: 20, requestsPerMinute: 240 });
  const strict = as(devices.studio, "/strict");
  const made = [];
  for (let i = 0; i < 2; i += 1) {
    const res = await strict.create({ recipient: { link: true }, objects: [1], manifestSize: 1 });
    assert.equal(res.status, 201);
    made.push(res.body.id);
  }
  const limited = await strict.create({ recipient: { link: true }, objects: [1], manifestSize: 1 });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.match(limited.headers.get("retry-after"), /^[1-9]\d*$/);
  // Only leaving files is limited that hard.
  assert.equal((await strict.waiting()).status, 200);
  for (const id of made) assert.equal((await strict.cancel(id)).status, 204);
});

test("the migration can run twice, and holds statuses and recipients to the known ones", async () => {
  await pickupsUp(db);
  const row = (patch) => ({
    id: randomUUID(),
    sender_user_id: randomUUID(),
    recipient_kind: "link",
    status: "uploading",
    object_count: 1,
    manifest_bytes: 1,
    total_bytes: 2,
    expires_at: new Date(clock),
    ...patch,
  });
  await assert.rejects(db("forgedrop_pickups").insert(row({ status: "lost" })));
  await assert.rejects(db("forgedrop_pickups").insert(row({ recipient_kind: "phone" })));
  const ok = row({});
  await db("forgedrop_pickups").insert(ok);
  await db("forgedrop_pickups").where({ id: ok.id }).del();
});
