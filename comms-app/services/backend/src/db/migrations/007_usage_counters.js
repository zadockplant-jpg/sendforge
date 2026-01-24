// services/backend/src/db/migrations/007_usage_counters.js
export async function up(knex) {
  const exists = await knex.schema.hasTable("usage_counters");
  if (exists) return;

  await knex.schema.createTable("usage_counters", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();

    t.integer("sms_sent_month").notNullable().defaultTo(0);
    t.integer("email_sent_month").notNullable().defaultTo(0);
    t.integer("recipients_month").notNullable().defaultTo(0);

    t.timestamp("month_start", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(["user_id"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("usage_counters");
}
