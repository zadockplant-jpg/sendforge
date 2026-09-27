// The owner's customer list: every account that owns a SendForge product,
// and how each one uses it, from records the backend already keeps for
// licensing and for Cloud pickup's monthly allowance (the owner, 2026-09-27:
// no cost or privacy issue, just enough to improve the products and catch
// accounts getting around data caps). Real services against PGlite.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after, before } from "node:test";
import express from "express";

import { attachPglite } from "./helpers/pglite-db.js";

const { db } = await import("../src/config/db.js");
const { listProductOwners, lookupAccount } = await import("../src/services/adminAccounts.service.js");
const { adminAccountsRouter } = await import("../src/routes/admin.accounts.routes.js");
const { CLOUD_PICKUP_TIERS } = await import("../src/modules/forgedrop-pickup/plans.js");

const NOW = new Date("2026-09-27T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(NOW.getTime() - days * DAY);
const PLAN = CLOUD_PICKUP_TIERS.find((tier) => tier.key === "100gb");
let detach;
let server;
let origin;

before(async () => {
  detach = await attachPglite(db);
  const { up: pickupsUp } = await import("../src/db/migrations/20260928_create_forgedrop_pickups.js");
  await pickupsUp(db);
  const app = express();
  app.use("/v1/admin/accounts", adminAccountsRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await detach?.();
});

async function person(email, owns = [], { boughtDaysAgo = 1, status = "active", expiresAt = null } = {}) {
  const id = randomUUID();
  await db("users").insert({ id, email, created_at: ago(boughtDaysAgo + 30) });
  for (const slug of owns) {
    await db("product_entitlements").insert({
      id: randomUUID(), user_id: id, product_slug: slug, source: "stripe", status, granted_at: ago(boughtDaysAgo), expires_at: expiresAt,
    });
  }
  return id;
}

async function device(userId, { deviceId = randomUUID(), name = "Studio PC", version = "1.6.3", seen = ago(1), freed = null } = {}) {
  await db("device_activations").insert({
    id: randomUUID(), user_id: userId, product_slug: "forgedrop", device_id: deviceId, device_name: name,
    platform: "Windows 11", app_version: version, last_seen_at: seen,
    status: freed === null ? "active" : "deactivated", deactivated_at: freed === null ? null : ago(freed),
  });
  return deviceId;
}

async function pickup(userId, bytes, { daysAgo = 1, status = "picked_up", uploaded = true } = {}) {
  const created = ago(daysAgo);
  await db("forgedrop_pickups").insert({
    id: randomUUID(), sender_user_id: userId, recipient_kind: "device", status, object_count: 1,
    manifest_bytes: 100, total_bytes: bytes, created_at: created, uploaded_at: uploaded ? created : null,
    expires_at: new Date(created.getTime() + 8 * DAY),
  });
}

let ada, dee, frank, hal;

test("only accounts that own a product are listed, newest purchase first, and the list narrows by email", async () => {
  ada = await person("ada@example.com", ["forgedrop"], { boughtDaysAgo: 1 });
  await person("bo@example.com", ["tabforge"], { boughtDaysAgo: 5 });
  dee = await person("dee@example.com", ["forgedrop", PLAN.slug], { boughtDaysAgo: 2 });
  await person("eve@example.com", []);
  await person("gus@example.com", ["forgedrop"], { status: "revoked" });
  await person("fay@example.com", ["tuneforge"], { expiresAt: ago(3) });

  const all = await listProductOwners({ now: NOW });
  assert.deepEqual(all.items.map((item) => item.email), ["ada@example.com", "dee@example.com", "bo@example.com"]);
  assert.equal(all.total, 3, "no products, a revoked one or an expired one: not a customer");
  assert.deepEqual((await listProductOwners({ q: " DE ", now: NOW })).items.map((item) => item.email), ["dee@example.com"]);
  const page = await listProductOwners({ limit: 2, offset: 2, now: NOW });
  assert.deepEqual([page.items.map((item) => item.email), page.total], [["bo@example.com"], 3]);
  assert.deepEqual(all.items.find((item) => item.email === "dee@example.com").products, ["forgedrop", PLAN.slug]);
});

test("each line shows devices against the limit and this month's Cloud pickup against the plan, with flags", async () => {
  for (let i = 0; i < 5; i += 1) await device(ada, { name: `PC ${i + 1}`, seen: ago(i + 1) });
  await pickup(dee, Math.round(PLAN.bytes * 0.6), { daysAgo: 20 });
  await pickup(dee, Math.round(PLAN.bytes * 0.35), { daysAgo: 2, status: "waiting" });
  await pickup(dee, Math.round(PLAN.bytes * 0.5), { daysAgo: 1, status: "cancelled", uploaded: false });
  await pickup(dee, 10 * 2 ** 30, { daysAgo: 40 });

  const items = (await listProductOwners({ now: NOW })).items;
  const line = (email) => items.find((item) => item.email === email);
  assert.deepEqual(line("ada@example.com").devices, { forgedrop: { active: 5, limit: 5 } });
  assert.deepEqual(line("ada@example.com").flags, ["device_limit"]);
  assert.equal(new Date(line("ada@example.com").lastSeenAt).getTime(), ago(1).getTime());
  assert.deepEqual(line("dee@example.com").cloudPickup, {
    plan: { slug: PLAN.slug, label: "100 GB", bytes: PLAN.bytes },
    sentBytes: Math.round(PLAN.bytes * 0.6) + Math.round(PLAN.bytes * 0.35),
    pickups: 2,
  }, "a pickup cancelled before its upload finished and last month's do not count, as for the allowance");
  assert.deepEqual(line("dee@example.com").flags, ["pickup_cap"]);
  assert.equal(line("bo@example.com").cloudPickup, null);
  assert.deepEqual(line("bo@example.com").flags, []);
});

test("an account's usage: devices and versions, freed slots, an install on another account, three months of Cloud pickup", async () => {
  frank = await person("frank@example.com", ["forgedrop"]);
  const shared = await device(ada, { name: "Shared laptop", version: "1.6.2" });
  await device(frank, { deviceId: shared, name: "Shared laptop", version: "1.6.2" });
  await device(ada, { name: "Old PC", freed: 10 });
  await device(ada, { name: "Older PC", freed: 60 });

  const view = await lookupAccount("ada@example.com", db, { now: NOW });
  assert.deepEqual(view.usage.devices.forgedrop, {
    active: 6,
    limit: 5,
    freedTotal: 2,
    freedLast30Days: 1,
    lastSeenAt: view.usage.devices.forgedrop.lastSeenAt,
    platforms: { "Windows 11": 6 },
    appVersions: { "1.6.3": 5, "1.6.2": 1 },
  });
  assert.deepEqual(view.usage.sharedDevices, [{ productSlug: "forgedrop", deviceName: "Shared laptop", otherAccounts: 1 }]);
  assert.deepEqual(view.usage.flags, ["device_limit", "shared_device"]);
  const listed = view.products.find((p) => p.slug === "forgedrop").devices[0];
  assert.equal(listed.platform, "Windows 11");
  assert.ok(listed.lastSeenAt, "the device list says when each was last seen");

  const pickups = (await lookupAccount("dee@example.com", db, { now: NOW })).usage.cloudPickup;
  assert.deepEqual(pickups.plan, { slug: PLAN.slug, label: "100 GB", bytes: PLAN.bytes });
  assert.equal(pickups.percentOfPlan, 95);
  assert.equal(pickups.pickupsThisMonth, 2);
  assert.deepEqual(pickups.months.map((m) => [m.month, m.pickups]), [["2026-07", 0], ["2026-08", 1], ["2026-09", 2]]);
  assert.equal(pickups.months[1].bytes, 10 * 2 ** 30);
  assert.equal(pickups.waitingNow, 1);
  assert.equal(pickups.monthStartsAt, "2026-09-01T00:00:00.000Z");
});

test("many slots freed in a month are flagged, and nothing names a file, a recipient or a key", async () => {
  hal = await person("hal@example.com", ["forgedrop"]);
  for (const days of [3, 9, 20]) await device(hal, { name: `Swap ${days}`, freed: days });
  await pickup(hal, 1024, { daysAgo: 30, status: "expired" });
  const view = await lookupAccount("hal@example.com", db, { now: NOW });
  assert.deepEqual(view.usage.flags, ["slot_swaps"]);
  assert.equal(view.usage.cloudPickup.expiredUnpickedLast90Days, 1);
  assert.equal(view.usage.cloudPickup.plan, null);
  assert.doesNotMatch(JSON.stringify(view.usage), /recipient|fingerprint|sealed|identity|file_?name/i);
});

test("the route serves the list to the owner, and refuses a bad page size", async () => {
  const res = await fetch(`${origin}/v1/admin/accounts?q=hal`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.items.map((item) => item.email), ["hal@example.com"]);
  assert.equal(body.total, 1);
  assert.equal((await fetch(`${origin}/v1/admin/accounts?limit=0`)).status, 400);
  assert.equal((await fetch(`${origin}/v1/admin/accounts?limit=500`)).status, 400);
});
