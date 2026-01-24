export async function up(knex) {
  // Contacts
  await knex.schema.createTable("contacts", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.text("name").notNullable().defaultTo("");
    t.text("email");          // optional
    t.text("phone_e164");     // optional
    t.text("tags").notNullable().defaultTo(""); // comma list (simple for v1)
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(["user_id", "email"]);
    t.unique(["user_id", "phone_e164"]);
  });

  // Groups
  await knex.schema.createTable("groups", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.text("name").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(["user_id", "name"]);
  });

  // Group Members
  await knex.schema.createTable("group_members", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.uuid("group_id").notNullable().index();
    t.uuid("contact_id").notNullable().index();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(["group_id", "contact_id"]);
  });

  // Templates
  await knex.schema.createTable("templates", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.text("name").notNullable();
    t.text("channel").notNullable(); // sms|email
    t.text("subject").notNullable().defaultTo(""); // email optional
    t.text("body").notNullable(); // supports {{name}} etc (render later)
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(["user_id", "name", "channel"]);
  });

  // Blasts
  await knex.schema.createTable("blasts", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.text("name").notNullable().defaultTo("");
    t.text("channel").notNullable(); // sms|email
    t.text("subject").notNullable().defaultTo("");
    t.text("body").notNullable();
    t.text("status").notNullable().defaultTo("draft"); // draft|queued|sending|done
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Blast Recipients
  await knex.schema.createTable("blast_recipients", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.uuid("blast_id").notNullable().index();
    t.uuid("contact_id").notNullable().index();
    t.text("destination").notNullable(); // email or phone
    t.text("status").notNullable().defaultTo("queued"); // queued|sent|failed
    t.text("fail_code").notNullable().defaultTo("");
    t.text("provider_message_id").notNullable().defaultTo("");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(["blast_id", "destination"]);
  });

  // Message events (audit trail for delivery + internal status)
  await knex.schema.createTable("message_events", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.uuid("blast_id").notNullable().index();
    t.uuid("blast_recipient_id").notNullable().index();
    t.text("event_type").notNullable(); // queued|sending|sent|failed|provider_update
    t.jsonb("payload").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("message_events");
  await knex.schema.dropTableIfExists("blast_recipients");
  await knex.schema.dropTableIfExists("blasts");
  await knex.schema.dropTableIfExists("templates");
  await knex.schema.dropTableIfExists("group_members");
  await knex.schema.dropTableIfExists("groups");
  await knex.schema.dropTableIfExists("contacts");
}
