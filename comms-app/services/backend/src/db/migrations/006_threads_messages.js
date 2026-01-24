export async function up(knex) {
  await knex.schema.createTable("threads", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.uuid("group_id").nullable().index();
    t.text("channel").notNullable(); // sms|email
    t.text("peer").notNullable(); // phone/email
    t.text("title").notNullable().defaultTo("");
    t.timestamp("last_message_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(["user_id", "channel", "peer"]);
  });

  await knex.schema.createTable("messages", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.uuid("thread_id").notNullable().index();
    t.text("direction").notNullable(); // inbound|outbound
    t.text("channel").notNullable(); // sms|email
    t.text("from").notNullable().defaultTo("");
    t.text("to").notNullable().defaultTo("");
    t.text("body").notNullable().defaultTo("");
    t.text("provider").notNullable().defaultTo(""); // twilio|sendgrid
    t.text("provider_message_id").notNullable().defaultTo("");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["thread_id", "created_at"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("messages");
  await knex.schema.dropTableIfExists("threads");
}
