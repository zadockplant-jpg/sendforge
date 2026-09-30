// My Home Builder portal: job expenses. Add expense on a client portal's panel records a cost of
// that job (materials, equipment rental, permits and fees, other job costs) with what paid it, and
// an optional receipt. The books post it as that job's cost (books.js expenseParts). Additive only.
//
// - mhb_expenses: one row per expense. `data` holds the vendor, what it was for, its category
//   (a job cost account), what paid it (a bank account, the owner's own money, or not paid yet),
//   the receipt's file, and the bank transaction it was matched to on the Banking page.

export async function up(knex) {
  await knex.schema.createTable("mhb_expenses", (t) => {
    t.string("id", 32).primary();
    t.string("client_slug", 64).notNullable();
    t.date("spent_on").notNullable();
    t.bigInteger("amount_cents").notNullable();
    t.jsonb("data").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["client_slug", "spent_on"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("mhb_expenses");
}
