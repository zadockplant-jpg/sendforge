// My Home Builder portal: each project keeps a list of email addresses (`emails` in its JSON)
// that every quote, invoice and receipt for it is addressed to, replacing the single `email`.
//
// - A project's saved email becomes its list.
// - A project with no saved email starts with the addresses its most recent quote or invoice was
//   emailed to. The Muskegon project may have no row yet (its defaults live in code), so it gets
//   one holding only the list.
// - A payment recorded by hand is the invoice paid in full, so its amount is set to the invoice
//   total where an edit to the invoice left them apart.
// - The sent-email log may now name several addresses, so its recipient column becomes text.

const DEFAULT_CLIENT_SLUG = "muskegon-addition";

// The addresses of each project's most recent send, newest first per project.
const LATEST_SENDS = `
  SELECT DISTINCT ON (client_slug) client_slug,
    to_jsonb(regexp_split_to_array(trim(data->>'sentTo'), '\\s*[,;]\\s*')) AS emails
  FROM mhb_billing
  WHERE coalesce(trim(data->>'sentTo'), '') <> '' AND coalesce(data->>'sentAt', '') <> ''
  ORDER BY client_slug, (data->>'sentAt')::timestamptz DESC`;

export async function up(knex) {
  await knex.raw("ALTER TABLE mhb_sent_emails ALTER COLUMN recipient TYPE text");

  await knex.raw(`
    UPDATE mhb_clients
    SET data = (data - 'email') || jsonb_build_object('emails', jsonb_build_array(data->>'email')), updated_at = now()
    WHERE data->'emails' IS NULL AND coalesce(data->>'email', '') <> ''`);

  await knex.raw(`
    UPDATE mhb_clients
    SET data = (mhb_clients.data - 'email') || jsonb_build_object('emails', latest.emails), updated_at = now()
    FROM (${LATEST_SENDS}) AS latest
    WHERE mhb_clients.slug = latest.client_slug AND mhb_clients.data->'emails' IS NULL`);

  await knex.raw(`
    INSERT INTO mhb_clients (slug, data)
    SELECT latest.client_slug, jsonb_build_object('slug', latest.client_slug, 'emails', latest.emails)
    FROM (${LATEST_SENDS}) AS latest
    WHERE latest.client_slug = ?
    ON CONFLICT (slug) DO NOTHING`, [DEFAULT_CLIENT_SLUG]);

  await knex.raw(`
    UPDATE mhb_billing
    SET data = jsonb_set(data, '{payment,amountCents}', data->'amountCents'), updated_at = now()
    WHERE data->>'kind' = 'invoice' AND data->>'status' = 'paid' AND data->'payment'->>'source' = 'manual'
      AND data->'amountCents' IS NOT NULL AND data->'payment'->'amountCents' IS DISTINCT FROM data->'amountCents'`);
}

// The lists and corrected amounts stay: the code before this migration reads `email`, which the
// first address restores, and a payment amount that matches its invoice is right either way.
export async function down(knex) {
  await knex.raw(`
    UPDATE mhb_clients
    SET data = (data - 'emails') || jsonb_build_object('email', coalesce(data->'emails'->>0, ''))
    WHERE data->'emails' IS NOT NULL`);
}
