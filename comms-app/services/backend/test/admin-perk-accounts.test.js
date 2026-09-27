// Perk Accounts lists everyone who owns TabForge without paying: accounts
// authorised in the dashboard, and accounts that redeemed a comp code or a
// personal invite. The owner (2026-09-27) found a comp-code Pro account the
// list left out. Revoking takes back either kind, and keeps the record of how
// it was granted. The real admin router against PGlite.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after, before } from "node:test";
import express from "express";

import { attachPglite } from "./helpers/pglite-db.js";

process.env.JWT_SECRET ||= "admin-perk-accounts-test-secret-at-least-32-bytes";

const { db } = await import("../src/config/db.js");
const { issueAdminAccessToken } = await import("../src/services/auth.service.js");
const { adminRouter } = await import("../src/routes/admin.routes.js");

const ADMIN = "zadockplant@gmail.com";
let detach;
let server;
let origin;
let adminToken;

before(async () => {
  detach = await attachPglite(db);
  await db.schema.alterTable("users", (t) => {
    t.integer("auth_version").defaultTo(0);
  });
  await db.schema.createTable("admin_audit_log", (t) => {
    t.uuid("id").primary();
    t.uuid("admin_user_id");
    t.text("admin_email");
    t.text("action");
    t.text("resource_type");
    t.text("resource_id");
    t.jsonb("before_value");
    t.jsonb("after_value");
    t.text("ip_hash");
    t.text("user_agent");
    t.jsonb("metadata");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
  });
  const adminId = randomUUID();
  await db("users").insert({ id: adminId, email: ADMIN });
  adminToken = issueAdminAccessToken({ id: adminId, email: ADMIN });
  const app = express();
  app.use(express.json());
  app.use("/v1/admin", adminRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await detach?.();
});

async function owner(email, source, metadata, slugs = ["tabforge", "tabforge-subscription"]) {
  const id = randomUUID();
  await db("users").insert({ id, email });
  for (const slug of slugs) {
    await db("product_entitlements").insert({ id: randomUUID(), user_id: id, product_slug: slug, source, status: "active", granted_at: new Date(), metadata });
  }
  return id;
}

const call = async (method, path, body) => {
  const res = await fetch(`${origin}/v1/admin${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { code: res.status, body: await res.json() };
};

test("a comp-code account is listed with the code it redeemed, beside the perks and not the payers", async () => {
  await owner("jeff@example.com", "comp_code", { comp_code: "SENDIT2026" });
  await owner("perk@example.com", "admin_perk", { perk: true, granted_by: ADMIN, note: "creator" });
  await owner("paid@example.com", "stripe", {});
  const { code, body } = await call("GET", "/perks");
  assert.equal(code, 200);
  const byEmail = Object.fromEntries(body.items.map((item) => [item.email, item]));
  assert.deepEqual(Object.keys(byEmail).sort(), ["jeff@example.com", "perk@example.com"]);
  assert.deepEqual([byEmail["jeff@example.com"].sources, byEmail["jeff@example.com"].compCode, byEmail["jeff@example.com"].active], [["comp_code"], "SENDIT2026", true]);
  assert.deepEqual(byEmail["perk@example.com"].sources, ["perk"]);
});

test("revoking a comp-code account takes back Pro and Private Sync and keeps the code on record", async () => {
  const { code, body } = await call("POST", "/perks/revoke", { email: "jeff@example.com", note: "code shared publicly" });
  assert.equal(code, 200, JSON.stringify(body));
  assert.deepEqual(body.account.products.sort(), ["tabforge", "tabforge-subscription"]);
  const rows = await db("product_entitlements as e").join("users as u", "u.id", "e.user_id").where("u.email", "jeff@example.com").select("e.*");
  for (const row of rows) {
    assert.equal(row.status, "revoked");
    assert.equal(row.metadata.comp_code, "SENDIT2026", "how it was granted stays on the row");
    assert.equal(row.metadata.revoked_by, ADMIN);
    assert.equal(row.metadata.revoked_note, "code shared publicly");
    assert.equal(row.metadata.perk, undefined, "a comp code's row is not relabelled a perk");
  }
  const listed = (await call("GET", "/perks")).body.items.find((item) => item.email === "jeff@example.com");
  assert.deepEqual([listed.active, listed.sources, listed.compCode], [false, ["comp_code"], "SENDIT2026"], "still listed, as revoked, with its code");
});

test("revoking a perk keeps its grant note, and a paying customer is never touched", async () => {
  await call("POST", "/perks/revoke", { email: "perk@example.com" });
  const perk = await db("product_entitlements as e").join("users as u", "u.id", "e.user_id").where("u.email", "perk@example.com").select("e.*");
  assert.ok(perk.every((row) => row.status === "revoked" && row.metadata.note === "creator" && row.metadata.perk === true));
  const { body } = await call("POST", "/perks/revoke", { email: "paid@example.com" });
  assert.deepEqual(body.account.products, [], "nothing to take back from a purchase");
  const paid = await db("product_entitlements as e").join("users as u", "u.id", "e.user_id").where("u.email", "paid@example.com").select("e.status");
  assert.ok(paid.every((row) => row.status === "active"));
});
