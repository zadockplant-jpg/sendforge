import { createInstallTokensTable, INSTALL_TOKENS_TABLE } from "../../services/installTokens.service.js";

export async function up(knex) {
  await createInstallTokensTable(knex);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists(INSTALL_TOKENS_TABLE);
}
