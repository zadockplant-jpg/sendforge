// My Home Builder portal: refunds, disputes and Stripe event ids in the books. Additive only.
//
// - mhb_stripe_events: each Stripe event the portal handled, by id.
// - mhb_accounts gains 1250 Funds held in disputes, 4200 Refunds and 6200 Dispute losses and fees.
// - mhb_journal_entries.part widens to 48 characters: each refund is its own part
//   ("refund:<Stripe refund id>"), and a dispute's outcome is "dispute-close".

const ACCOUNTS = [
  { code: "1250", name: "Funds held in disputes", type: "asset", sort: 25 },
  { code: "4200", name: "Refunds", type: "income", sort: 55 },
  { code: "6200", name: "Dispute losses and fees", type: "expense", sort: 70 }
];

export async function up(knex) {
  await knex.schema.createTable("mhb_stripe_events", (t) => {
    t.string("id", 255).primary();
    t.string("type", 80).notNullable();
    t.timestamp("received_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex("mhb_accounts").insert(ACCOUNTS).onConflict("code").ignore();
  await knex.raw("ALTER TABLE mhb_journal_entries ALTER COLUMN part TYPE varchar(48)");
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("mhb_stripe_events");
  await knex("mhb_accounts").whereIn("code", ACCOUNTS.map((account) => account.code)).delete();
}
