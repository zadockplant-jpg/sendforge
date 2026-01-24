export async function up(knex) {
  // Global suppressions: opt-outs, bounces, complaints, manual blocks
  await knex.schema.createTable("suppressions", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.text("channel").notNullable();      // sms|email
    t.text("destination").notNullable();  // phone/email
    t.text("reason").notNullable().defaultTo(""); // stop|bounce|complaint|manual
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(["user_id", "channel", "destination"]);
  });

  // Unsubscribe tokens for email links (maps token -> user + destination)
  await knex.schema.createTable("unsubscribe_tokens", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.text("channel").notNullable();     // email
    t.text("destination").notNullable(); // email
    t.text("token").notNullable().unique();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("unsubscribe_tokens");
  await knex.schema.dropTableIfExists("suppressions");
}
