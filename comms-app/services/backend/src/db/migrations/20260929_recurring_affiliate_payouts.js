/**
 * Recurring affiliate payouts. Affiliates earn a share of every paid invoice
 * of the subscriptions they referred (TabForge Private Sync, ForgeDrop Cloud
 * pickup); the owner sets that share from the admin dashboard and pays each
 * affiliate once a month, by Cash App, from a statement of the month's shares.
 *
 *  - subscription_share_programs: one row per programme, its rate in basis
 *    points (500 is 5%) and an on/off switch. Seeded at 500 and on, which is
 *    exactly what the share recorders paid before the rate could be set.
 *  - subscription_share_overrides: one affiliate's own rate on a programme;
 *    0 turns the share off for that affiliate.
 *  - affiliate_payout_settings: one row, the minimum payout (a statement under
 *    it carries over to the next month) and the day of the month payouts run.
 *    No minimum and the 15th by default: the 15th is past the 10-day review
 *    period of every share from the month before.
 *  - affiliate_payout_statements: statements the owner acted on (approved,
 *    paid under one Cash App reference, or rejected with a note). Nothing else
 *    is stored: statements are computed from reward_queue when asked.
 *
 * Additive: four new tables, nothing else touched. Running it again changes
 * nothing, and never resets a rate the owner set. Render applies it on deploy.
 */

const PROGRAMS = [
  { program_slug: "tabforge-subscription", label: "TabForge Private Sync" },
  { program_slug: "forgedrop-cloud-pickup", label: "ForgeDrop Cloud pickup" },
];

export async function up(knex) {
  if (!(await knex.schema.hasTable("subscription_share_programs"))) {
    await knex.schema.createTable("subscription_share_programs", (t) => {
      t.text("program_slug").primary();
      t.text("label").notNullable();
      t.integer("rate_bps").notNullable().defaultTo(500).checkBetween([0, 10000]);
      t.boolean("enabled").notNullable().defaultTo(true);
      t.uuid("updated_by").nullable();
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }
  await knex("subscription_share_programs")
    .insert(PROGRAMS.map((program) => ({ ...program, rate_bps: 500, enabled: true })))
    .onConflict("program_slug")
    .ignore();

  if (!(await knex.schema.hasTable("subscription_share_overrides"))) {
    await knex.schema.createTable("subscription_share_overrides", (t) => {
      t.uuid("id").primary();
      t.uuid("user_id").notNullable();
      t.text("program_slug").notNullable();
      t.integer("rate_bps").notNullable().checkBetween([0, 10000]);
      t.text("note").nullable();
      t.uuid("updated_by").nullable();
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(["user_id", "program_slug"]);
    });
  }

  if (!(await knex.schema.hasTable("affiliate_payout_settings"))) {
    await knex.schema.createTable("affiliate_payout_settings", (t) => {
      t.text("id").primary();
      t.integer("minimum_payout_cents").notNullable().defaultTo(0).checkBetween([0, 100000000]);
      t.integer("payout_day").notNullable().defaultTo(15).checkBetween([1, 28]);
      t.uuid("updated_by").nullable();
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }
  await knex("affiliate_payout_settings")
    .insert({ id: "default", minimum_payout_cents: 0, payout_day: 15 })
    .onConflict("id")
    .ignore();

  if (!(await knex.schema.hasTable("affiliate_payout_statements"))) {
    await knex.schema.createTable("affiliate_payout_statements", (t) => {
      t.uuid("id").primary();
      t.uuid("user_id").notNullable();
      // The calendar month (UTC) the statement covers, as YYYY-MM.
      t.text("month").notNullable();
      t.text("status").notNullable().checkIn(["approved", "paid", "rejected"]);
      // What was approved, paid or rejected, and which reward_queue rows.
      t.integer("total_cents").notNullable().defaultTo(0);
      t.jsonb("reward_ids").notNullable().defaultTo("[]");
      // The one Cash App reference the whole statement was paid under.
      t.text("payout_reference").nullable();
      t.text("note").nullable();
      t.uuid("approved_by").nullable();
      t.timestamp("approved_at", { useTz: true }).nullable();
      t.uuid("paid_by").nullable();
      t.timestamp("paid_at", { useTz: true }).nullable();
      t.uuid("rejected_by").nullable();
      t.timestamp("rejected_at", { useTz: true }).nullable();
      t.jsonb("metadata").notNullable().defaultTo("{}");
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(["user_id", "month"]);
      t.index(["month", "status"]);
    });
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("affiliate_payout_statements");
  await knex.schema.dropTableIfExists("affiliate_payout_settings");
  await knex.schema.dropTableIfExists("subscription_share_overrides");
  await knex.schema.dropTableIfExists("subscription_share_programs");
}
