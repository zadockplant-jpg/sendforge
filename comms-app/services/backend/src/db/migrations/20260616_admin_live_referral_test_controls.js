export async function up(knex) {
  if (!(await knex.schema.hasTable("users"))) return;

  if (!(await knex.schema.hasTable("admin_live_test_sessions"))) {
    await knex.schema.createTable("admin_live_test_sessions", (t) => {
      t.uuid("id").primary();
      t.uuid("owner_user_id").notNullable().index();
      t.text("owner_email").notNullable().unique();
      t.text("product_slug").notNullable().defaultTo("tabforge");
      t.text("status").notNullable().defaultTo("active").index();
      t.jsonb("snapshot").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("reset_at", { useTz: true }).nullable();
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }
}

export async function down() {
  // Intentionally non-destructive. Test rows are explicitly tagged and can be
  // removed from the owner-only admin test lab without dropping audit history.
}
