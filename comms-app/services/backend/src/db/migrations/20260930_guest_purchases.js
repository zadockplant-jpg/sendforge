// Purchases paid at Stripe before an account exists, held for the account
// that verifies the email they were paid with (services/guestPurchases).
// The service also creates this table on first use if it is missing.
import { createGuestPurchasesTable, GUEST_PURCHASES_TABLE } from "../../services/guestPurchases.service.js";

export async function up(knex) {
  await createGuestPurchasesTable(knex);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists(GUEST_PURCHASES_TABLE);
}
