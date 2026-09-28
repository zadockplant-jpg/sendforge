// My Home Builder portal: the books. Additive only: new mhb_* tables, no change to existing ones.
//
// - mhb_accounts: the chart of accounts. Bank accounts and expense categories are added here when
//   the business bank account is connected.
// - mhb_journal_entries and mhb_journal_lines: a double-entry journal. Each entry's lines balance
//   (debits equal credits), and each line is a debit or a credit, never both. An entry is one part
//   of an invoice's books (its issue, its payment, the Stripe fee), a reversal of one, or a
//   payment not tied to an invoice. `source`, `external_id` and `labels` let bank transactions
//   join later and be labeled and categorized; (kind, external_id) is unique, so a repeated
//   Stripe event or bank import posts once.
// - mhb_activity: everything done in the portal, by the admin, clients and Stripe.
//
// Invoices saved before this get their opening entries and history the first time the books are
// used (books.js, ensureBooksOpened).

const ACCOUNTS = [
  { code: "1100", name: "Accounts receivable", type: "asset", sort: 10 },
  { code: "1200", name: "Stripe balance", type: "asset", sort: 20 },
  { code: "1300", name: "Payments received outside Stripe", type: "asset", sort: 30 },
  { code: "2100", name: "Unapplied payments", type: "liability", sort: 40 },
  { code: "4000", name: "Sales", type: "income", sort: 50 },
  { code: "6100", name: "Stripe fees", type: "expense", sort: 60 }
];

export async function up(knex) {
  await knex.schema.createTable("mhb_accounts", (t) => {
    t.string("code", 8).primary();
    t.string("name", 80).notNullable();
    t.string("type", 16).notNullable();
    t.integer("sort").notNullable().defaultTo(0);
  });
  await knex("mhb_accounts").insert(ACCOUNTS);

  await knex.schema.createTable("mhb_journal_entries", (t) => {
    t.bigIncrements("id").primary();
    t.date("entry_date").notNullable();
    t.timestamp("recorded_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.string("kind", 24).notNullable();
    t.string("part", 16).nullable();
    t.bigInteger("reverses").nullable();
    t.string("memo", 300).notNullable();
    t.string("client_slug", 64).nullable();
    t.string("item_id", 32).nullable();
    t.string("item_number", 16).nullable();
    t.string("source", 16).notNullable();
    t.string("external_id", 200).nullable();
    t.bigInteger("activity_id").nullable();
    t.jsonb("labels").notNullable().defaultTo("[]");
    t.jsonb("data").notNullable().defaultTo("{}");
    t.unique(["kind", "external_id"]);
    t.index(["entry_date"]);
    t.index(["item_id"]);
    t.index(["reverses"]);
    t.index(["client_slug"]);
  });

  await knex.schema.createTable("mhb_journal_lines", (t) => {
    t.bigIncrements("id").primary();
    t.bigInteger("entry_id").notNullable().references("id").inTable("mhb_journal_entries").onDelete("CASCADE");
    t.string("account", 8).notNullable().references("code").inTable("mhb_accounts");
    t.bigInteger("debit_cents").notNullable().defaultTo(0);
    t.bigInteger("credit_cents").notNullable().defaultTo(0);
    t.string("client_slug", 64).nullable();
    t.string("item_id", 32).nullable();
    t.index(["entry_id"]);
    t.index(["account"]);
    t.index(["item_id"]);
  });
  await knex.raw(
    "ALTER TABLE mhb_journal_lines ADD CONSTRAINT mhb_journal_lines_one_side CHECK (debit_cents >= 0 AND credit_cents >= 0 AND (debit_cents = 0) <> (credit_cents = 0))"
  );

  await knex.schema.createTable("mhb_activity", (t) => {
    t.bigIncrements("id").primary();
    t.timestamp("at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.string("actor", 16).notNullable();
    t.string("action", 48).notNullable();
    t.string("client_slug", 64).nullable();
    t.string("item_id", 32).nullable();
    t.string("item_kind", 8).nullable();
    t.string("item_number", 16).nullable();
    t.bigInteger("amount_cents").nullable();
    t.string("summary", 500).notNullable();
    t.string("ip", 64).nullable();
    t.jsonb("data").notNullable().defaultTo("{}");
    t.index(["at"]);
    t.index(["client_slug", "at"]);
    t.index(["item_id"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("mhb_activity");
  await knex.schema.dropTableIfExists("mhb_journal_lines");
  await knex.schema.dropTableIfExists("mhb_journal_entries");
  await knex.schema.dropTableIfExists("mhb_accounts");
  await knex("mhb_counters").where({ name: "books-opened" }).del();
}
