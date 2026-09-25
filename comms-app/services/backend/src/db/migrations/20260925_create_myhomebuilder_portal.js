// My Home Builder client portal (myhomebuilderllc.com/clients). Additive only: new mhb_*
// tables, no change to existing tables and no foreign keys to them, so the module can be
// removed whole. Production applies it with `npm run migrate` like the other migrations.
//
// Records keep their full JSON in `data`; the columns beside it are for lookups and
// constraints (unique invoice numbers and share links).

export async function up(knex) {
  await knex.schema.createTable("mhb_clients", (t) => {
    t.string("slug", 64).primary();
    t.jsonb("data").notNullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable("mhb_billing", (t) => {
    t.string("id", 32).primary();
    t.string("client_slug", 64).notNullable();
    t.string("kind", 8).notNullable();
    t.string("number", 16).notNullable().unique();
    t.string("share_token", 64).nullable().unique();
    t.jsonb("data").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable();
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["client_slug", "created_at"]);
  });

  // One row per sequence ("invoice", "quote"), incremented atomically.
  await knex.schema.createTable("mhb_counters", (t) => {
    t.string("name", 32).primary();
    t.integer("value").notNullable();
  });

  await knex.schema.createTable("mhb_templates", (t) => {
    t.string("id", 32).primary();
    t.jsonb("data").notNullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable("mhb_documents", (t) => {
    t.string("id", 32).primary();
    t.string("client_slug", 64).notNullable();
    t.jsonb("data").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable();
    t.index(["client_slug", "created_at"]);
  });

  // Uploaded documents, signature images and signed PDFs (20 MB each at most).
  await knex.schema.createTable("mhb_files", (t) => {
    t.string("key", 512).primary();
    t.string("content_type", 160).notNullable();
    t.integer("size").notNullable();
    t.binary("bytes").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Receipts and builder notices: one row per message, claimed before it is sent.
  await knex.schema.createTable("mhb_sent_emails", (t) => {
    t.string("key", 200).primary();
    t.string("recipient", 254).notNullable();
    t.string("status", 8).notNullable();
    t.string("message_id", 200).nullable();
    t.timestamp("claimed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("sent_at", { useTz: true }).nullable();
  });
  await knex.raw("ALTER TABLE mhb_sent_emails ADD CONSTRAINT mhb_sent_emails_status CHECK (status IN ('sending', 'sent'))");

  await knex.schema.createTable("mhb_admin_challenges", (t) => {
    t.string("id", 64).primary();
    t.string("code_hash", 64).notNullable();
    t.integer("attempts").notNullable().defaultTo(0);
    t.timestamp("expires_at", { useTz: true }).notNullable();
  });

  await knex.schema.createTable("mhb_rate_limits", (t) => {
    t.string("key_hash", 64).primary();
    t.integer("attempts").notNullable();
    t.timestamp("window_started", { useTz: true }).notNullable();
  });
}

export async function down(knex) {
  for (const table of [
    "mhb_rate_limits",
    "mhb_admin_challenges",
    "mhb_sent_emails",
    "mhb_files",
    "mhb_documents",
    "mhb_templates",
    "mhb_counters",
    "mhb_billing",
    "mhb_clients"
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
