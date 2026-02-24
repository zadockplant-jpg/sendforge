// 0XX_contacts_org_and_uuid_default.cjs
// Adds contacts.organization + ensures contacts.id defaults to gen_random_uuid()

exports.up = async function (knex) {
  // gen_random_uuid() lives in pgcrypto on many Postgres installs
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  // 1) organization column
  const hasOrg = await knex.schema.hasColumn("contacts", "organization");
  if (!hasOrg) {
    await knex.schema.alterTable("contacts", (t) => {
      t.text("organization").nullable();
    });
  }

  // 2) DB default UUID for contacts.id (safe even if already set)
  // If contacts.id is UUID type, this is correct.
  // If contacts.id is TEXT, STOP and tell me—this would be wrong.
  await knex.raw(`
    ALTER TABLE contacts
    ALTER COLUMN id SET DEFAULT gen_random_uuid();
  `);
};

exports.down = async function (knex) {
  // Drop column if present
  const hasOrg = await knex.schema.hasColumn("contacts", "organization");
  if (hasOrg) {
    await knex.schema.alterTable("contacts", (t) => {
      t.dropColumn("organization");
    });
  }

  // Remove default (doesn't drop the column or type)
  await knex.raw(`
    ALTER TABLE contacts
    ALTER COLUMN id DROP DEFAULT;
  `);
};