export async function up(knex) {
  await knex.schema.createTable("subscriptions", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();

    t.text("provider").notNullable(); // apple|google|stripe|manual
    t.text("provider_customer_id").notNullable().defaultTo(""); // stripe customer id, etc
    t.text("provider_subscription_id").notNullable().defaultTo(""); // stripe sub id, etc

    t.text("plan").notNullable(); // basic|pro|enterprise
    t.text("status").notNullable(); // active|canceled|expired|trialing|past_due
    t.timestamp("current_period_start", { useTz: true });
    t.timestamp("current_period_end", { useTz: true });

    t.jsonb("raw").notNullable().defaultTo("{}"); // store provider payloads safely

    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(["user_id", "status"]);
  });

  await knex.schema.createTable("usage_counters", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();

    // YYYY-MM for monthly bucket (simple + effective)
    t.text("period").notNullable(); // e.g. "2025-12"
    t.text("channel").notNullable(); // sms|email
    t.integer("count").notNullable().defaultTo(0);

    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(["user_id", "period", "channel"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("usage_counters");
  await knex.schema.dropTableIfExists("subscriptions");
}
