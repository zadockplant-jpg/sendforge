// The ForgeDrop installer for licensed desktops (src/modules/forgedrop-release):
// installed copies keep updating once ForgeDrop's public release files close
// to anyone who has not bought it (2026-09-27). Runs the real router, the real
// licence sign-in and device slots on PGlite; GitHub is a stand-in fetch.

import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import express from "express";

import { attachPglite } from "./helpers/pglite-db.js";

process.env.LICENSE_SIGNING_KEY = crypto.randomBytes(32).toString("base64");
process.env.LICENSE_SIGNING_KID = "fd-release-test";

const { db } = await import("../src/config/db.js");
const { env } = await import("../src/config/env.js");
const { grantProductEntitlement, hasProductEntitlement } = await import(
  "../src/services/entitlement.service.js"
);
const { activateDevice, deactivateDevice } = await import("../src/services/deviceActivation.service.js");
const { forgedropFingerprint } = await import("../src/services/identityProof.service.js");
const { createForgeDropReleaseRouter, releaseSource } = await import(
  "../src/modules/forgedrop-release/router.js"
);
const { loadForgeDropRelease } = await import("../src/modules/forgedrop-release/index.js");

const INSTALLER = crypto.randomBytes(300_000);
let detach;
let server;
let origin;
const asked = [];
const people = {};

/** GitHub as far as the route can tell: one release, and anything else missing. */
async function fakeGitHub(url) {
  asked.push(url);
  if (url === releaseSource("1.6.3")) {
    return new Response(INSTALLER, { status: 200, headers: { "content-length": String(INSTALLER.length) } });
  }
  if (url === releaseSource("5.0.0")) return new Response("busy", { status: 503 });
  if (url === releaseSource("6.0.0")) throw new Error("network down");
  return new Response("Not Found", { status: 404 });
}

async function person(name, { owns = true } = {}) {
  const id = randomUUID();
  await db("users").insert({ id, email: `${name}@example.com`, email_verified: true });
  if (owns) await grantProductEntitlement({ userId: id, productSlug: "forgedrop", source: "test" });
  const { publicKey } = crypto.generateKeyPairSync("x25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const device = await activateDevice({
    userId: id,
    productSlug: "forgedrop",
    deviceId: randomUUID(),
    deviceName: `${name} PC`,
    platform: "windows",
    appVersion: "1.6.3",
    identityFingerprint: forgedropFingerprint(raw),
    identityPublicKey: raw.toString("hex"),
    deviceLimit: 20,
  });
  people[name] = { id, token: device.token, deviceId: device.deviceId };
  return people[name];
}

before(async () => {
  detach = await attachPglite(db);
  await person("owner");
  await person("stranger", { owns: false });
  const freed = await person("freed");
  await deactivateDevice(freed.id, "forgedrop", freed.deviceId);

  const app = express();
  app.use(
    "/v1/downloads/forgedrop-release",
    createForgeDropReleaseRouter({
      db,
      hasProductEntitlement,
      signingKey: () => env.licenseSigningKey,
      fetchAsset: fakeGitHub,
    })
  );
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await detach?.();
});

async function get(version, token) {
  const headers = token ? { "X-ForgeDrop-License": token } : {};
  const res = await fetch(`${origin}/v1/downloads/forgedrop-release/${version}`, { headers });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

test("a licensed ForgeDrop gets the release it asks for, byte for byte", async () => {
  asked.length = 0;
  const res = await get("1.6.3", people.owner.token);
  assert.equal(res.status, 200);
  assert.ok(res.body.equals(INSTALLER));
  assert.equal(res.headers.get("content-length"), String(INSTALLER.length));
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(asked, [
    "https://github.com/zadockplant-jpg/sendforge-downloads/releases/download/forgedrop-v1.6.3/Install.ForgeDrop.exe",
  ]);
});

test("only a licensed ForgeDrop: no licence, a freed slot, or no ForgeDrop is refused", async () => {
  asked.length = 0;
  assert.equal((await get("1.6.3")).status, 401);
  assert.equal((await get("1.6.3", "FD1.junk.junk")).status, 401);
  assert.equal((await get("1.6.3", people.freed.token)).status, 403);
  assert.equal((await get("1.6.3", people.stranger.token)).status, 403);
  assert.deepEqual(asked, [], "GitHub is never asked for anyone refused");
});

test("versions are plain numbers; a missing release is 404, GitHub in trouble 502", async () => {
  asked.length = 0;
  for (const bad of ["..%2F..%2Fsecret", "1.6", "1.6.3.4", "latest", "1.6.3-beta"]) {
    assert.equal((await get(bad, people.owner.token)).status, 404, bad);
  }
  assert.deepEqual(asked, [], "nothing odd ever reaches GitHub");
  assert.equal((await get("9.9.9", people.owner.token)).status, 404);
  assert.equal((await get("5.0.0", people.owner.token)).status, 502);
  assert.equal((await get("6.0.0", people.owner.token)).status, 502);
});

test("a module that will not load stands a 503 in, and app.js mounts it ahead of the downloads", async () => {
  const broken = await loadForgeDropRelease(
    async () => {
      throw new SyntaxError("Unexpected token in router.js");
    },
    { logger: () => {} }
  );
  assert.equal(typeof broken, "function");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const mine = app.indexOf('app.use("/v1/downloads/forgedrop-release", forgedropReleaseRouter)');
  const theirs = app.indexOf('app.use("/v1/downloads", downloadsRouter)');
  assert.ok(mine > 0 && theirs > mine, "ahead of the downloads router, which would take the name");
  const index = await readFile(new URL("../src/modules/forgedrop-release/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(index, /from "\.\/[a-z0-9-]+\.js"/, "no static import of the module's own files");
});
