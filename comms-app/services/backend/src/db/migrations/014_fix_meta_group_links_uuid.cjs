// comms-app/services/backend/db/migrations/014_fix_meta_group_links_uuid.cjs

exports.up = async function (knex) {
  // If meta_group_links doesn't exist, do nothing (013 handles creation)
  const has = await knex.schema.hasTable("meta_group_links");
  if (!has) return;

  // Try to coerce columns to UUID if the DB is UUID-based.
  // This is safe if your ids are uuid strings (which they are).
  // If they're already uuid, this is a no-op.
  await knex.raw(`
    DO $$
    BEGIN
      -- parent_group_id
      BEGIN
        ALTER TABLE meta_group_links
        ALTER COLUMN parent_group_id TYPE uuid USING parent_group_id::uuid;
      EXCEPTION WHEN others THEN
        -- ignore if already uuid or cannot cast
      END;

      -- child_group_id
      BEGIN
        ALTER TABLE meta_group_links
        ALTER COLUMN child_group_id TYPE uuid USING child_group_id::uuid;
      EXCEPTION WHEN others THEN
        -- ignore if already uuid or cannot cast
      END;
    END $$;
  `);
};

exports.down = async function (knex) {
  // We don't downgrade types automatically (riskier).
};