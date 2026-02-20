export async function up(knex) {
  await knex.schema.alterTable("users", (table) => {
    table.boolean("email_verified").notNullable().defaultTo(false);
    table.text("verification_token_hash");
    table.timestamp("verification_sent_at");
    table.timestamp("verified_at");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("users", (table) => {
    table.dropColumn("email_verified");
    table.dropColumn("verification_token_hash");
    table.dropColumn("verification_sent_at");
    table.dropColumn("verified_at");
  });
}