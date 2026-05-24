import crypto from "crypto";

const PRODUCT_SLUGS = [
  "tabforge",
  "tuneforge",
  "tubeforge",
  "youforge",
  "sendforge",
  "screenforge",
  "rentawifey",
  "inmate-records",
  "escape-from-portland",
  "citadelforge",
];

const DEFAULT_TIERS = [
  { requiredPurchases: 5, rewardAmountCents: 1000 },
  { requiredPurchases: 15, rewardAmountCents: 4000 },
  { requiredPurchases: 50, rewardAmountCents: 20000 },
];

async function addColumnIfMissing(knex, table, column, addColumn) {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, addColumn);
}

export async function up(knex) {
  if (!(await knex.schema.hasTable("users"))) return;

  await addColumnIfMissing(knex, "users", "cash_app_tag", (t) => t.text("cash_app_tag").nullable());
  await addColumnIfMissing(knex, "users", "referred_by_user_id", (t) => t.uuid("referred_by_user_id").nullable().index());
  await addColumnIfMissing(knex, "users", "referral_code_id", (t) => t.uuid("referral_code_id").nullable().index());
  await addColumnIfMissing(knex, "users", "referred_by_input", (t) => t.text("referred_by_input").nullable());

  if (await knex.schema.hasTable("referral_programs")) {
    for (const slug of PRODUCT_SLUGS) {
      await knex("referral_programs")
        .insert({
          id: crypto.randomUUID(),
          product_slug: slug,
          required_purchases: 5,
          reward_amount_cents: 1000,
          reward_type: "cashapp_manual",
          refund_hold_days: 0,
          status: "active",
          metadata: {
            tiers: DEFAULT_TIERS,
            description: "Manual Cash App referral payouts at 5, 15, and 50 verified purchases.",
          },
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        })
        .onConflict("product_slug")
        .merge({
          reward_type: "cashapp_manual",
          refund_hold_days: 0,
          status: "active",
          metadata: knex.raw("coalesce(referral_programs.metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ tiers: DEFAULT_TIERS })]),
          updated_at: knex.fn.now(),
        });
    }
  }
}

export async function down(knex) {
  if (!(await knex.schema.hasTable("users"))) return;

  if (await knex.schema.hasColumn("users", "referred_by_input")) {
    await knex.schema.alterTable("users", (t) => t.dropColumn("referred_by_input"));
  }
  if (await knex.schema.hasColumn("users", "referral_code_id")) {
    await knex.schema.alterTable("users", (t) => t.dropColumn("referral_code_id"));
  }
  if (await knex.schema.hasColumn("users", "referred_by_user_id")) {
    await knex.schema.alterTable("users", (t) => t.dropColumn("referred_by_user_id"));
  }
  if (await knex.schema.hasColumn("users", "cash_app_tag")) {
    await knex.schema.alterTable("users", (t) => t.dropColumn("cash_app_tag"));
  }
}
