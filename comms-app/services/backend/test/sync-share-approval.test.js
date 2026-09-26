// The owner approves Private Sync shares. One paid Private Sync invoice earns
// the referrer 5%, so approving it must not ask for a count of referred
// customers the way a milestone reward does; that count refused every sync
// share. The referrer's TabForge Pro gate, the Cash App checks and the
// waiting period still apply. Real services and the real admin router,
// against PGlite.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after, before } from "node:test";
import express from "express";

import { attachPglite } from "./helpers/pglite-db.js";

// env.js reads the environment when it is first imported.
process.env.JWT_SECRET ||= "sync-share-approval-test-secret-at-least-32-bytes";

const { db } = await import("../src/config/db.js");
const { issueAdminAccessToken } = await import("../src/services/auth.service.js");
const { grantProductEntitlement, revokeProductEntitlement } = await import("../src/services/entitlement.service.js");
const { cashAppTagKey, isCloudPickupShareReward, isSyncShareReward, recordSyncSubscriptionShare } = await import(
  "../src/services/referrals/referral.service.js"
);
const { adminRouter } = await import("../src/routes/admin.routes.js");

const ADMIN = "zadockplant@gmail.com";
const DAY = 24 * 60 * 60 * 1000;
let detach;
let server;
let origin;
let adminToken;

before(async () => {
  detach = await attachPglite(db);
  // What approval touches beyond the shared test schema: the admin's session
  // version, Cash App tag ownership, the payout columns and the audit log.
  await db.schema.alterTable("users", (t) => {
    t.integer("auth_version").defaultTo(0);
  });
  await db.schema.alterTable("reward_queue", (t) => {
    t.uuid("approved_by");
    t.timestamp("approved_at", { useTz: true });
    t.uuid("paid_by");
    t.timestamp("paid_at", { useTz: true });
    t.text("payout_reference");
  });
  await db.schema.createTable("cash_app_tag_claims", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable();
    t.text("normalized_tag").notNullable().unique();
    t.text("display_tag").notNullable();
    t.text("status").notNullable().defaultTo("active");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
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

let people = 0;
async function person(name, { owns = [], cashApp = null, referredBy = null } = {}) {
  people += 1;
  const id = randomUUID();
  const email = `${name}-${people}@example.com`;
  await db("users").insert({ id, email, cash_app_tag: cashApp, referred_by_user_id: referredBy?.id || null });
  for (const slug of owns) await grantProductEntitlement({ userId: id, productSlug: slug, source: "test" });
  if (cashApp) {
    await db("cash_app_tag_claims").insert({ id: randomUUID(), user_id: id, normalized_tag: cashAppTagKey(cashApp), display_tag: cashApp, status: "active" });
  }
  return { id, email };
}

// A Private Sync share, queued the way the Stripe webhook queues it.
async function syncShare(subscriber, invoice, { waited = true } = {}) {
  const result = await recordSyncSubscriptionShare({ subscriberUserId: subscriber.id, invoiceRef: invoice, netPaidCents: 500 });
  assert.equal(result.recorded, true, result.reason);
  if (waited) {
    // The 10-day waiting period is over.
    await db("reward_queue").where({ id: result.reward.id }).update({ created_at: new Date(Date.now() - 11 * DAY) });
  }
  return result.reward;
}

async function setStatus(rewardId, status) {
  const response = await fetch(`${origin}/v1/admin/rewards/${rewardId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ status }),
  });
  return { code: response.status, body: await response.json() };
}

test("the owner can approve and pay a Private Sync share", async () => {
  const ada = await person("ada", { owns: ["tabforge"], cashApp: "$ada" });
  const sam = await person("sam", { owns: ["tabforge", "tabforge-subscription"], referredBy: ada });
  const share = await syncShare(sam, "in_sam_sync_1");
  assert.equal(share.reward_amount_cents, 25, "5% of $5");
  assert.equal(isSyncShareReward(share), true);
  assert.equal(isCloudPickupShareReward(share), false);

  const approved = await setStatus(share.id, "approved");
  assert.equal(approved.code, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.item.status, "approved");
  const paid = await setStatus(share.id, "paid");
  assert.equal(paid.code, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.item.status, "paid");
  assert.equal(paid.body.item.payout_reference, `manual:${share.id}`);
});

test("a referrer who no longer owns TabForge Pro cannot be paid a sync share", async () => {
  const bo = await person("bo", { owns: ["tabforge"], cashApp: "$bo" });
  const kim = await person("kim", { owns: ["tabforge", "tabforge-subscription"], referredBy: bo });
  const share = await syncShare(kim, "in_kim_sync_1");
  await revokeProductEntitlement(bo.id, "tabforge");
  const refused = await setStatus(share.id, "approved");
  assert.equal(refused.code, 409);
  assert.equal(refused.body.error, "referrer_tabforge_pro_required");
});

// A share has no programme row of its own, and the review period used to come
// out as 0 days for it, so a share could be approved the day it was earned.
test("a sync share still waits out the review period", async () => {
  const cy = await person("cy", { owns: ["tabforge"], cashApp: "$cy" });
  const lou = await person("lou", { owns: ["tabforge", "tabforge-subscription"], referredBy: cy });
  const share = await syncShare(lou, "in_lou_sync_1", { waited: false });
  const refused = await setStatus(share.id, "approved");
  assert.equal(refused.code, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "payout_hold_not_complete");
});

test("a milestone reward still needs the customers it was earned on", async () => {
  const dee = await person("dee", { owns: ["tabforge"], cashApp: "$dee" });
  const [milestone] = await db("reward_queue")
    .insert({
      id: randomUUID(),
      user_id: dee.id,
      email: dee.email,
      product_slug: "tabforge",
      reward_key: "tabforge:5",
      reward_amount_cents: 1700,
      reward_type: "cashapp_manual",
      cashapp_handle: "$dee",
      status: "pending",
      metadata: { tier_required_purchases: 5 },
      created_at: new Date(Date.now() - 11 * DAY),
    })
    .returning("*");
  assert.equal(isSyncShareReward(milestone), false);
  const refused = await setStatus(milestone.id, "approved");
  assert.equal(refused.code, 409);
  assert.equal(refused.body.error, "referral_qualification_no_longer_met");
  assert.deepEqual([refused.body.verifiedCount, refused.body.requiredPurchases], [0, 5]);
});
