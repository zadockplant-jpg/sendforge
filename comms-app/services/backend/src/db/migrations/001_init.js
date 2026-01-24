export async function up(knex) {
  await knex.schema.createTable("users", (t) => {
    t.uuid("id").primary();
    t.text("email").notNullable().unique();
    t.text("password_hash").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("users");
}
