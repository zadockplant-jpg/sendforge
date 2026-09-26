// The real admin router on PGlite, with what paying a reward touches beyond
// the shared test schema (helpers/pglite-db.js): the admin's session version,
// the payout columns and their unique reference, Cash App tag ownership, the
// audit log, and the subscriptions table. For the recurring payout tests.
//
// The recurring payouts migration is not run here: a test runs it when it
// wants to, so shares can also be recorded before it exists.

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";

import { attachPglite } from "./pglite-db.js";

export const ADMIN_EMAIL = "zadockplant@gmail.com";
export const DAY = 24 * 60 * 60 * 1000;

/**
 * Makes accounts: `owns` products, a Cash App tag (claimed unless told not
 * to be), the account that referred them, and `affiliate` for a code on
 * affiliate terms, which is the ForgeDrop affiliate level.
 */
export function makePeople({ db, grantProductEntitlement, ensureAffiliateReferralCode, cashAppTagKey }) {
  let count = 0;
  return async function person(name, { owns = [], cashApp = null, claimed = true, referredBy = null, affiliate = false } = {}) {
    count += 1;
    const id = randomUUID();
    const email = `${name}-${count}@example.com`;
    await db("users").insert({ id, email, cash_app_tag: cashApp, referred_by_user_id: referredBy?.id || null });
    for (const slug of owns) await grantProductEntitlement({ userId: id, productSlug: slug, source: "test" });
    if (cashApp && claimed) {
      await db("cash_app_tag_claims").insert({
        id: randomUUID(),
        user_id: id,
        normalized_tag: cashAppTagKey(cashApp),
        display_tag: cashApp,
        status: "active",
      });
    }
    const code = affiliate ? await ensureAffiliateReferralCode({ id, email, cash_app_tag: cashApp }) : null;
    return { id, email, code };
  };
}

/** The tables and columns paying a reward needs beyond helpers/pglite-db.js. */
export async function addPayoutTables(db) {
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
  // As in production (20260614_cashapp_payout_integrity_1_6): one reward per reference.
  await db.raw(
    "CREATE UNIQUE INDEX reward_queue_unique_payout_reference ON reward_queue (payout_reference) WHERE payout_reference IS NOT NULL AND btrim(payout_reference) <> ''"
  );
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
  // As 004_billing makes it.
  await db.schema.createTable("subscriptions", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable();
    t.text("provider").notNullable().defaultTo("stripe");
    t.text("provider_customer_id").notNullable().defaultTo("");
    t.text("provider_subscription_id").notNullable().defaultTo("");
    t.text("plan").notNullable();
    t.text("status").notNullable();
    t.timestamp("current_period_start", { useTz: true });
    t.timestamp("current_period_end", { useTz: true });
    t.jsonb("raw").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
  });
}

export async function startAdminPayoutsApp({ db, adminRouter, issueAdminAccessToken }) {
  const detach = await attachPglite(db);
  await addPayoutTables(db);

  const adminId = randomUUID();
  await db("users").insert({ id: adminId, email: ADMIN_EMAIL });
  const adminToken = issueAdminAccessToken({ id: adminId, email: ADMIN_EMAIL });

  const app = express();
  app.use(express.json());
  app.use("/v1/admin", adminRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function api(method, path, body, token = adminToken) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${origin}/v1/admin${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { code: response.status, body: json };
  }

  return {
    adminId,
    adminToken,
    api,
    async stop() {
      server.close();
      await detach();
    },
  };
}
