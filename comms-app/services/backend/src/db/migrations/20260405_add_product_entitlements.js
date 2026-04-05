export async function up(knex) {
  const hasUsers = await knex.schema.hasTable("users");
  if (!hasUsers) return;

  const hasTable = await knex.schema.hasTable("product_entitlements");
  if (hasTable) return;

  await knex.schema.createTable("product_entitlements", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.text("product_slug").notNullable();
    t.text("source").notNullable().defaultTo("manual");
    t.text("source_ref").nullable();
    t.text("status").notNullable().defaultTo("active");
    t.timestamp("granted_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("expires_at", { useTz: true }).nullable();
    t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(["user_id", "product_slug"]);
    t.index(["product_slug", "status"]);
  });
}

export async function down(knex) {
  const hasTable = await knex.schema.hasTable("product_entitlements");
  if (!hasTable) return;

  await knex.schema.dropTableIfExists("product_entitlements");
}