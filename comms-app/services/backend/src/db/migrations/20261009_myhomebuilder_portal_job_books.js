// My Home Builder portal: job books and overhead expenses. Additive only.
//
// - mhb_accounts gains 5500 Land, 5510 House and 5520 Commercial property, job costs for property
//   bought for a job.
// - mhb_expenses.client_slug may be empty: an expense added on the Books page with no job is
//   overhead (an overhead account instead of a job cost).

const ACCOUNTS = [
  { code: "5500", name: "Land", type: "expense", sort: 57 },
  { code: "5510", name: "House", type: "expense", sort: 57 },
  { code: "5520", name: "Commercial property", type: "expense", sort: 57 }
];

export async function up(knex) {
  await knex("mhb_accounts").insert(ACCOUNTS).onConflict("code").ignore();
  await knex.raw("ALTER TABLE mhb_expenses ALTER COLUMN client_slug DROP NOT NULL");
}

export async function down(knex) {
  await knex("mhb_expenses").whereNull("client_slug").delete();
  await knex.raw("ALTER TABLE mhb_expenses ALTER COLUMN client_slug SET NOT NULL");
  const used = await knex("mhb_journal_lines").whereIn("account", ACCOUNTS.map((account) => account.code)).first();
  if (!used) await knex("mhb_accounts").whereIn("code", ACCOUNTS.map((account) => account.code)).delete();
}
