exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  await knex.schema.alterTable("contacts", (t) => {
    t.text("organization").nullable();
  });

  await knex.raw(`
    ALTER TABLE contacts
    ALTER COLUMN id SET DEFAULT gen_random_uuid();
  `);
};

exports.down = async function (knex) {
  await knex.schema.alterTable("contacts", (t) => {
    t.dropColumn("organization");
  });

  await knex.raw(`
    ALTER TABLE contacts
    ALTER COLUMN id DROP DEFAULT;
  `);
};