// My Home Builder portal: banking. The business bank account is linked through Stripe
// (Financial Connections, from Stripe's hosted page) or its statements are uploaded (CSV, OFX or
// QFX), and each transaction is filed with one click to a job's costs, an overhead category, or
// what it was (a Stripe payout, a client's check deposited, a crew payment...). Filed
// transactions post to the books. Additive only.
//
// - mhb_bank_accounts: each linked or uploaded account, and the books account it posts to
//   (1000 Business checking for the first, then 1010, 1020... or 2010, 2020... for credit cards).
// - mhb_bank_transactions: every transaction imported, once per account (account_id,
//   external_id): Stripe's transaction id, the statement's FITID, or a hash of the statement row.
//   `target` is what it is filed to, or null while it waits to be filed.
// - mhb_accounts gains job cost, overhead, equity, other income and transfer accounts.

const ACCOUNTS = [
  { code: "1900", name: "Transfers between accounts", type: "asset", sort: 33 },
  { code: "3000", name: "Owner contributions", type: "equity", sort: 47 },
  { code: "3100", name: "Owner draws", type: "equity", sort: 48 },
  { code: "4300", name: "Other income", type: "income", sort: 55 },
  { code: "5200", name: "Materials", type: "expense", sort: 57 },
  { code: "5300", name: "Equipment rental", type: "expense", sort: 57 },
  { code: "5400", name: "Permits and fees", type: "expense", sort: 57 },
  { code: "5900", name: "Other job costs", type: "expense", sort: 57 },
  { code: "6300", name: "Advertising and marketing", type: "expense", sort: 74 },
  { code: "6310", name: "Vehicles and fuel", type: "expense", sort: 74 },
  { code: "6320", name: "Insurance", type: "expense", sort: 74 },
  { code: "6330", name: "Office supplies and software", type: "expense", sort: 74 },
  { code: "6340", name: "Phone and internet", type: "expense", sort: 74 },
  { code: "6350", name: "Rent and utilities", type: "expense", sort: 74 },
  { code: "6360", name: "Legal and accounting", type: "expense", sort: 74 },
  { code: "6370", name: "Business licenses and dues", type: "expense", sort: 74 },
  { code: "6380", name: "Tools and small equipment", type: "expense", sort: 74 },
  { code: "6390", name: "Bank and card fees", type: "expense", sort: 74 },
  { code: "6400", name: "Meals", type: "expense", sort: 74 },
  { code: "6410", name: "Travel", type: "expense", sort: 74 },
  { code: "6420", name: "Payroll taxes", type: "expense", sort: 74 },
  { code: "6430", name: "Training and education", type: "expense", sort: 74 },
  { code: "6440", name: "Repairs and maintenance", type: "expense", sort: 74 },
  { code: "6490", name: "Other overhead", type: "expense", sort: 76 }
];

export async function up(knex) {
  await knex.schema.createTable("mhb_bank_accounts", (t) => {
    t.string("id", 32).primary();
    t.string("source", 16).notNullable();
    t.string("stripe_account_id", 64).nullable().unique();
    t.jsonb("data").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("mhb_bank_transactions", (t) => {
    t.string("id", 32).primary();
    t.string("account_id", 32).notNullable().references("id").inTable("mhb_bank_accounts");
    t.string("external_id", 128).notNullable();
    t.date("posted_on").notNullable();
    t.bigInteger("amount_cents").notNullable();
    t.string("status", 16).notNullable();
    t.string("target", 120).nullable();
    t.jsonb("data").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(["account_id", "external_id"]);
    t.index(["posted_on"]);
    t.index(["target"]);
  });

  await knex("mhb_accounts").insert(ACCOUNTS).onConflict("code").ignore();
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("mhb_bank_transactions");
  await knex.schema.dropTableIfExists("mhb_bank_accounts");
  await knex("mhb_accounts").whereIn("code", ACCOUNTS.map((account) => account.code)).delete();
}
