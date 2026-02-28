// services/backend/src/db/migrations/20260228_contacts_onconflict_unique.js

export async function up(knex) {
  // Create the EXACT unique index needed for:
  // .onConflict(["user_id", "phone_e164", "email"]).ignore()
  //
  // Guarded so it won't explode if schema differs.
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'contacts'
      ) THEN

        -- Ensure columns exist before creating index
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='contacts' AND column_name='user_id'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='contacts' AND column_name='phone_e164'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='contacts' AND column_name='email'
        )
        THEN
          -- Postgres unique index: NULLs are allowed (treated as distinct)
          EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS contacts_user_phonee164_email_uniq
                   ON contacts (user_id, phone_e164, email)';
        END IF;

      END IF;
    END $$;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS contacts_user_phonee164_email_uniq;`);
}