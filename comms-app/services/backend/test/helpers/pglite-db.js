// Point the app's shared knex instance at an in-process Postgres (PGlite)
// with the tables the account, referral and licensing code reads.
//
// One connection only: PGlite is a single session, so several pooled
// "connections" would share it and interleave transactions. With one, a query
// issued outside the transaction that holds it waits forever, so a missing
// `trx` in the code under test shows up as a hang instead of passing.

import { PGlite } from "@electric-sql/pglite";

export async function attachPglite(db) {
  const pg = new PGlite();
  await pg.waitReady;
  if (db.client.pool) await db.client.destroy();
  db.client.initializeDriver();
  db.client.initializePool({ ...db.client.config, pool: { min: 0, max: 1 } });
  db.client.acquireRawConnection = async () => ({
    query(config, callback) {
      pg.query(config.text, config.values).then(
        (result) =>
          callback(null, {
            rows: result.rows,
            rowCount: result.affectedRows,
            command: config.text.trim().split(/\s/)[0].toUpperCase(),
          }),
        callback
      );
    },
  });
  db.client.destroyRawConnection = async () => {};

  await db.schema.createTable("users", (t) => {
    t.uuid("id").primary();
    t.text("email").unique();
    t.boolean("email_verified").defaultTo(true);
    t.uuid("referred_by_user_id").nullable();
    t.uuid("referral_code_id").nullable();
    t.text("referred_by_input").nullable();
    t.text("cash_app_tag").nullable();
    t.text("stripe_customer_id").nullable();
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
  });
  await db.schema.createTable("product_entitlements", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable();
    t.text("product_slug").notNullable();
    t.text("source");
    t.text("source_ref");
    t.text("status");
    t.timestamp("granted_at", { useTz: true });
    t.timestamp("expires_at", { useTz: true });
    t.jsonb("metadata").defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true });
    t.unique(["user_id", "product_slug"]);
  });
  await db.schema.createTable("referral_codes", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id");
    t.text("email");
    t.text("code").unique();
    t.text("cashapp_handle");
    t.text("status");
    t.jsonb("metadata").defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true });
  });
  await db.schema.createTable("referral_events", (t) => {
    t.uuid("id").primary();
    t.uuid("referral_code_id");
    t.uuid("referrer_user_id");
    t.uuid("referred_user_id");
    t.text("product_slug");
    t.text("purchase_ref");
    t.text("event_type");
    t.text("status");
    t.jsonb("metadata").defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true });
    t.unique(["referral_code_id", "purchase_ref"]);
  });
  await db.schema.createTable("reward_queue", (t) => {
    t.uuid("id").primary();
    t.uuid("referral_code_id");
    t.uuid("user_id");
    t.text("email");
    t.text("product_slug");
    t.text("reward_key");
    t.integer("reward_amount_cents");
    t.text("reward_type");
    t.text("cashapp_handle");
    t.text("status");
    t.text("admin_note");
    t.jsonb("metadata").defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true });
    t.unique(["user_id", "product_slug", "reward_key"]);
  });
  await db.schema.createTable("referral_programs", (t) => {
    t.uuid("id").primary();
    t.text("product_slug").notNullable().unique();
    t.integer("required_purchases").notNullable().defaultTo(5);
    t.integer("reward_amount_cents").notNullable().defaultTo(1000);
    t.text("reward_type").notNullable().defaultTo("cashapp_manual");
    t.integer("refund_hold_days").notNullable().defaultTo(14);
    t.text("status").notNullable().defaultTo("active");
    t.jsonb("metadata").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
  });
  await db.schema.createTable("billing_checkout_attempts", (t) => {
    t.uuid("id").primary();
    t.text("stripe_checkout_session_id");
    t.text("status");
    t.timestamp("updated_at", { useTz: true });
  });

  const { up: devicesUp } = await import("../../src/db/migrations/20260921_create_device_activations.js");
  const { up: seatsUp } = await import("../../src/db/migrations/20260924_create_product_seat_purchases.js");
  const { up: identityUp } = await import("../../src/db/migrations/20260927_device_identity_proof.js");
  await devicesUp(db);
  await seatsUp(db);
  await identityUp(db);

  return async () => {
    await db.destroy();
    await pg.close();
  };
}
