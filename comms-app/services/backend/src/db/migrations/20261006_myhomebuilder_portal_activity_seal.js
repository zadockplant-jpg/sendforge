// My Home Builder portal: the activity log cannot be changed. Quotes, invoices and the books can
// be edited; the log of who did what is how any mismanagement is traced, so it only grows.
//
// - Postgres refuses any UPDATE, DELETE or TRUNCATE of mhb_activity (triggers
//   mhb_activity_no_change and mhb_activity_no_truncate), whoever sends it.
// - Each entry is sealed as it is added: chain_seq numbers entries in order, and chain_hash is the
//   SHA-256 of the previous entry's hash and this entry's fields (mhb_activity_row_hash). If the
//   protection were switched off and an entry changed or removed, the Books page's check
//   (books.js verifyActivityLog) finds the first entry that no longer matches.
// Entries already in the log are sealed in the order they were added (id).

export async function up(knex) {
  await knex.schema.alterTable("mhb_activity", (t) => {
    t.bigInteger("chain_seq").nullable();
    t.string("chain_hash", 64).nullable();
  });

  // One entry's seal. jsonb_build_array keeps every field distinct, nulls included.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION mhb_activity_row_hash(prev text, r mhb_activity) RETURNS text
    LANGUAGE sql STABLE AS $$
      SELECT encode(sha256(convert_to(jsonb_build_array(
        prev, r.chain_seq, r.id, to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
        r.actor, r.action, r.client_slug, r.item_id, r.item_kind, r.item_number, r.amount_cents,
        r.summary, r.ip, r.data
      )::text, 'UTF8')), 'hex')
    $$`);

  // Seal what is already in the log, in the order it was added.
  await knex.raw(`
    DO $$
    DECLARE
      r mhb_activity;
      prev text := NULL;
      n bigint := 0;
    BEGIN
      FOR r IN SELECT * FROM mhb_activity ORDER BY id LOOP
        n := n + 1;
        r.chain_seq := n;
        UPDATE mhb_activity SET chain_seq = n, chain_hash = mhb_activity_row_hash(prev, r) WHERE id = r.id RETURNING chain_hash INTO prev;
      END LOOP;
    END $$`);

  await knex.raw("ALTER TABLE mhb_activity ALTER COLUMN chain_seq SET NOT NULL, ALTER COLUMN chain_hash SET NOT NULL");
  await knex.raw("CREATE UNIQUE INDEX mhb_activity_chain_seq ON mhb_activity (chain_seq)");

  // New entries are sealed one at a time, after the last one.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION mhb_activity_seal() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      last_seq bigint;
      last_hash text;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('mhb-activity-chain'));
      SELECT chain_seq, chain_hash INTO last_seq, last_hash FROM mhb_activity ORDER BY chain_seq DESC LIMIT 1;
      NEW.chain_seq := coalesce(last_seq, 0) + 1;
      NEW.chain_hash := mhb_activity_row_hash(last_hash, NEW);
      RETURN NEW;
    END $$`);
  await knex.raw("CREATE TRIGGER mhb_activity_seal BEFORE INSERT ON mhb_activity FOR EACH ROW EXECUTE FUNCTION mhb_activity_seal()");

  // Nothing in the log can be changed, deleted or cleared.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION mhb_activity_no_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'The My Home Builder activity log cannot be changed or deleted' USING ERRCODE = 'insufficient_privilege';
    END $$`);
  await knex.raw("CREATE TRIGGER mhb_activity_no_change BEFORE UPDATE OR DELETE ON mhb_activity FOR EACH ROW EXECUTE FUNCTION mhb_activity_no_change()");
  await knex.raw("CREATE TRIGGER mhb_activity_no_truncate BEFORE TRUNCATE ON mhb_activity FOR EACH STATEMENT EXECUTE FUNCTION mhb_activity_no_change()");
}

export async function down(knex) {
  await knex.raw("DROP TRIGGER IF EXISTS mhb_activity_no_truncate ON mhb_activity");
  await knex.raw("DROP TRIGGER IF EXISTS mhb_activity_no_change ON mhb_activity");
  await knex.raw("DROP TRIGGER IF EXISTS mhb_activity_seal ON mhb_activity");
  await knex.raw("DROP FUNCTION IF EXISTS mhb_activity_no_change()");
  await knex.raw("DROP FUNCTION IF EXISTS mhb_activity_seal()");
  await knex.raw("DROP INDEX IF EXISTS mhb_activity_chain_seq");
  await knex.schema.alterTable("mhb_activity", (t) => {
    t.dropColumn("chain_hash");
    t.dropColumn("chain_seq");
  });
  await knex.raw("DROP FUNCTION IF EXISTS mhb_activity_row_hash(text, mhb_activity)");
}
