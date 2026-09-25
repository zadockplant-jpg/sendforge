// My Home Builder portal: addresses the portal has emailed (quotes, invoices and receipts), newest
// first, for the pick list under the admin panel's email fields. Additive only. Addresses already
// emailed are loaded from the quotes and invoices (their last send) and the sent receipts.

export async function up(knex) {
  await knex.schema.createTable("mhb_recipients", (t) => {
    // Lowercased for matching; `display` keeps the address as it was typed.
    t.string("email", 254).primary();
    t.string("display", 254).notNullable();
    t.integer("send_count").notNullable().defaultTo(1);
    t.timestamp("last_sent_at", { useTz: true }).notNullable();
    t.index(["last_sent_at"]);
  });

  await knex.raw(`
    INSERT INTO mhb_recipients (email, display, send_count, last_sent_at)
    SELECT lower(address), max(address), count(*), max(sent_at)
    FROM (
      SELECT data->>'sentTo' AS address, (data->>'sentAt')::timestamptz AS sent_at
      FROM mhb_billing
      WHERE coalesce(data->>'sentTo', '') <> '' AND coalesce(data->>'sentAt', '') <> ''
      UNION ALL
      SELECT recipient, sent_at
      FROM mhb_sent_emails
      WHERE status = 'sent' AND key LIKE '%:receipt' AND sent_at IS NOT NULL
    ) AS sends
    GROUP BY lower(address)
    ON CONFLICT (email) DO NOTHING`);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("mhb_recipients");
}
