export async function up(knex) {
  if (!(await knex.schema.hasColumn("users", "auth_version"))) {
    await knex.schema.alterTable("users", (table) => {
      table.integer("auth_version").notNullable().defaultTo(0);
    });
  }
}

export async function down(knex) {
  if (await knex.schema.hasColumn("users", "auth_version")) {
    await knex.schema.alterTable("users", (table) => {
      table.dropColumn("auth_version");
    });
  }
}
