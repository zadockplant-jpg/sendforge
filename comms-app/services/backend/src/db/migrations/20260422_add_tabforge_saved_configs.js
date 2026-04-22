export async function up(knex) {
  const hasUsers = await knex.schema.hasTable("users");
  if (!hasUsers) return;

  const hasTable = await knex.schema.hasTable("tabforge_saved_configs");
  if (hasTable) return;

  await knex.schema.createTable("tabforge_saved_configs", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.text("name").notNullable();
    t.jsonb("payload").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(["user_id", "name"]);
    t.index(["user_id", "updated_at"]);
  });
}

export async function down(knex) {
  const hasTable = await knex.schema.hasTable("tabforge_saved_configs");
  if (!hasTable) return;

  await knex.schema.dropTableIfExists("tabforge_saved_configs");
}