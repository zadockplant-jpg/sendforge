// My Home Builder portal: invoices and quotes are numbered 1, 2, 3 … with no prefix, dash or
// leading zeros, each in its own sequence, so a number is unique per kind rather than overall.
// Numbers already issued as INV-0012 / QUO-0003 are rewritten in place as 12 / 3, including the
// cross-references between a quote and the invoice made from it. The counters are unchanged, so
// numbering continues where it was.

const PLAIN = (expression) => `regexp_replace(${expression}, '^[A-Z]+-0*', '')`;

export async function up(knex) {
  await knex.raw("ALTER TABLE mhb_billing DROP CONSTRAINT IF EXISTS mhb_billing_number_unique");
  await knex.raw(`UPDATE mhb_billing SET number = ${PLAIN("number")} WHERE number ~ '^[A-Z]+-'`);
  await knex.raw("UPDATE mhb_billing SET data = jsonb_set(data, '{number}', to_jsonb(number))");
  for (const field of ["invoiceNumber", "fromQuoteNumber"]) {
    await knex.raw(
      `UPDATE mhb_billing SET data = jsonb_set(data, '{${field}}', to_jsonb(${PLAIN(`data->>'${field}'`)}))
       WHERE data->>'${field}' ~ '^[A-Z]+-'`
    );
  }
  await knex.raw("ALTER TABLE mhb_billing ADD CONSTRAINT mhb_billing_kind_number_unique UNIQUE (kind, number)");
}

// Restores the single-sequence constraint. Numbers are not rewritten back, so this fails while an
// invoice and a quote share a number.
export async function down(knex) {
  await knex.raw("ALTER TABLE mhb_billing DROP CONSTRAINT IF EXISTS mhb_billing_kind_number_unique");
  await knex.raw("ALTER TABLE mhb_billing ADD CONSTRAINT mhb_billing_number_unique UNIQUE (number)");
}
