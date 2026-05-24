import crypto from "crypto";

const DEFAULT_PRODUCTS = [
  { slug: "tabforge", name: "TabForge", product_line: "tabforge", product_type: "software", description: "Chrome new-tab workspace and curated web launcher.", price_cents: 500, currency: "usd", entitlement_slug: "tabforge", status: "active", sort_order: 10 },
  { slug: "tuneforge", name: "TuneForge", product_line: "tuneforge", product_type: "software", description: "Music workflow product line.", price_cents: 0, currency: "usd", entitlement_slug: "tuneforge", status: "draft", sort_order: 20 },
  { slug: "tubeforge", name: "TubeForge", product_line: "tubeforge", product_type: "software", description: "Algorithm-control and video discovery product line.", price_cents: 0, currency: "usd", entitlement_slug: "tubeforge", status: "draft", sort_order: 30 },
  { slug: "youforge", name: "YouForge", product_line: "youforge", product_type: "software", description: "Creator/user workflow product line.", price_cents: 0, currency: "usd", entitlement_slug: "youforge", status: "draft", sort_order: 40 },
  { slug: "sendforge", name: "SendForge", product_line: "sendforge", product_type: "software", description: "Business messaging and communications platform.", price_cents: 0, currency: "usd", entitlement_slug: "sendforge", status: "draft", sort_order: 50 },
  { slug: "screenforge", name: "ScreenForge", product_line: "screenforge", product_type: "software", description: "Screen/capture/tutorial product line.", price_cents: 0, currency: "usd", entitlement_slug: "screenforge", status: "draft", sort_order: 60 },
  { slug: "rentawifey", name: "RentAWifey", product_line: "rentawifey", product_type: "brand", description: "Future brand/product line.", price_cents: 0, currency: "usd", entitlement_slug: "rentawifey", status: "draft", sort_order: 70 },
  { slug: "inmate-records", name: "Inmate Records", product_line: "inmate-records", product_type: "brand", description: "Music label and merch product line.", price_cents: 0, currency: "usd", entitlement_slug: "inmate-records", status: "active", sort_order: 80 },
  { slug: "escape-from-portland", name: "Escape From Portland", product_line: "escape-from-portland", product_type: "game", description: "Game project product line.", price_cents: 0, currency: "usd", entitlement_slug: "escape-from-portland", status: "draft", sort_order: 90 },
  { slug: "citadelforge", name: "CitadelForge", product_line: "citadelforge", product_type: "software", description: "Future product line.", price_cents: 0, currency: "usd", entitlement_slug: "citadelforge", status: "draft", sort_order: 100 },
];

export async function up(knex) {
  const hasUsers = await knex.schema.hasTable("users");
  if (!hasUsers) return;

  if (!(await knex.schema.hasTable("admin_mfa_codes"))) {
    await knex.schema.createTable("admin_mfa_codes", (t) => {
      t.uuid("id").primary();
      t.uuid("user_id").notNullable().index();
      t.text("email").notNullable().index();
      t.text("code_hash").notNullable();
      t.text("purpose").notNullable().defaultTo("admin_login");
      t.timestamp("expires_at", { useTz: true }).notNullable();
      t.timestamp("used_at", { useTz: true }).nullable();
      t.integer("attempts").notNullable().defaultTo(0);
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(["email", "purpose", "created_at"]);
    });
  }

  if (!(await knex.schema.hasTable("admin_audit_log"))) {
    await knex.schema.createTable("admin_audit_log", (t) => {
      t.uuid("id").primary();
      t.uuid("admin_user_id").nullable().index();
      t.text("admin_email").nullable().index();
      t.text("action").notNullable().index();
      t.text("resource_type").nullable().index();
      t.text("resource_id").nullable().index();
      t.jsonb("before_value").nullable();
      t.jsonb("after_value").nullable();
      t.text("ip_hash").nullable();
      t.text("user_agent").nullable();
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(["resource_type", "resource_id", "created_at"]);
    });
  }

  if (!(await knex.schema.hasTable("admin_products"))) {
    await knex.schema.createTable("admin_products", (t) => {
      t.uuid("id").primary();
      t.text("slug").notNullable().unique();
      t.text("name").notNullable();
      t.text("product_line").notNullable();
      t.text("product_type").notNullable().defaultTo("software");
      t.text("description").nullable();
      t.integer("price_cents").notNullable().defaultTo(0);
      t.text("currency").notNullable().defaultTo("usd");
      t.text("stripe_price_id").nullable();
      t.text("entitlement_slug").nullable();
      t.text("status").notNullable().defaultTo("draft");
      t.integer("sort_order").notNullable().defaultTo(1000);
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("deleted_at", { useTz: true }).nullable();
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(["product_line", "status"]);
      t.index(["deleted_at"]);
    });
  }

  if (!(await knex.schema.hasTable("referral_programs"))) {
    await knex.schema.createTable("referral_programs", (t) => {
      t.uuid("id").primary();
      t.text("product_slug").notNullable().unique();
      t.integer("required_purchases").notNullable().defaultTo(5);
      t.integer("reward_amount_cents").notNullable().defaultTo(1000);
      t.text("reward_type").notNullable().defaultTo("cashapp_manual");
      t.integer("refund_hold_days").notNullable().defaultTo(14);
      t.text("status").notNullable().defaultTo("active");
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  if (!(await knex.schema.hasTable("referral_codes"))) {
    await knex.schema.createTable("referral_codes", (t) => {
      t.uuid("id").primary();
      t.uuid("user_id").nullable().index();
      t.text("email").nullable().index();
      t.text("code").notNullable().unique();
      t.text("cashapp_handle").nullable();
      t.text("status").notNullable().defaultTo("active");
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  if (!(await knex.schema.hasTable("referral_events"))) {
    await knex.schema.createTable("referral_events", (t) => {
      t.uuid("id").primary();
      t.uuid("referral_code_id").nullable().index();
      t.uuid("referrer_user_id").nullable().index();
      t.uuid("referred_user_id").nullable().index();
      t.text("product_slug").nullable().index();
      t.text("purchase_ref").nullable().index();
      t.text("event_type").notNullable().defaultTo("purchase");
      t.text("status").notNullable().defaultTo("pending");
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(["referral_code_id", "purchase_ref"]);
    });
  }

  if (!(await knex.schema.hasTable("reward_queue"))) {
    await knex.schema.createTable("reward_queue", (t) => {
      t.uuid("id").primary();
      t.uuid("referral_code_id").nullable().index();
      t.uuid("user_id").nullable().index();
      t.text("email").nullable().index();
      t.text("product_slug").notNullable().index();
      t.integer("reward_amount_cents").notNullable();
      t.text("reward_type").notNullable().defaultTo("cashapp_manual");
      t.text("cashapp_handle").nullable();
      t.text("status").notNullable().defaultTo("pending");
      t.text("admin_note").nullable();
      t.uuid("approved_by").nullable();
      t.timestamp("approved_at", { useTz: true }).nullable();
      t.uuid("paid_by").nullable();
      t.timestamp("paid_at", { useTz: true }).nullable();
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  if (!(await knex.schema.hasTable("attribution_clicks"))) {
    await knex.schema.createTable("attribution_clicks", (t) => {
      t.uuid("id").primary();
      t.text("product_slug").nullable().index();
      t.text("source").nullable().index();
      t.text("medium").nullable().index();
      t.text("campaign").nullable().index();
      t.text("creator").nullable().index();
      t.text("referral_code").nullable().index();
      t.text("landing_url").nullable();
      t.text("ip_hash").nullable();
      t.text("user_agent").nullable();
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  if (!(await knex.schema.hasTable("user_attribution"))) {
    await knex.schema.createTable("user_attribution", (t) => {
      t.uuid("id").primary();
      t.uuid("user_id").notNullable().index();
      t.uuid("attribution_click_id").nullable().index();
      t.text("product_slug").nullable().index();
      t.text("source").nullable().index();
      t.text("medium").nullable();
      t.text("campaign").nullable();
      t.text("creator").nullable();
      t.text("referral_code").nullable();
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(["user_id", "product_slug"]);
    });
  }

  for (const product of DEFAULT_PRODUCTS) {
    await knex("admin_products")
      .insert({ id: crypto.randomUUID(), ...product, created_at: knex.fn.now(), updated_at: knex.fn.now() })
      .onConflict("slug")
      .merge({
        name: product.name,
        product_line: product.product_line,
        product_type: product.product_type,
        description: product.description,
        price_cents: product.price_cents,
        currency: product.currency,
        entitlement_slug: product.entitlement_slug,
        status: product.status,
        sort_order: product.sort_order,
        updated_at: knex.fn.now(),
      });
  }

  await knex("referral_programs")
    .insert({
      id: crypto.randomUUID(),
      product_slug: "tabforge",
      required_purchases: 5,
      reward_amount_cents: 1000,
      reward_type: "cashapp_manual",
      refund_hold_days: 14,
      status: "active",
      metadata: { description: "5 verified TabForge purchases = $10 CashApp manual payout" },
    })
    .onConflict("product_slug")
    .merge({
      required_purchases: 5,
      reward_amount_cents: 1000,
      reward_type: "cashapp_manual",
      refund_hold_days: 14,
      status: "active",
      updated_at: knex.fn.now(),
    });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("user_attribution");
  await knex.schema.dropTableIfExists("attribution_clicks");
  await knex.schema.dropTableIfExists("reward_queue");
  await knex.schema.dropTableIfExists("referral_events");
  await knex.schema.dropTableIfExists("referral_codes");
  await knex.schema.dropTableIfExists("referral_programs");
  await knex.schema.dropTableIfExists("admin_products");
  await knex.schema.dropTableIfExists("admin_audit_log");
  await knex.schema.dropTableIfExists("admin_mfa_codes");
}
