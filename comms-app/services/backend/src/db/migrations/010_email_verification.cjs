/**
 * 010_email_verification.cjs
 */

exports.up = async function (knex) {
  const hasVerified = await knex.schema.hasColumn('users', 'email_verified');
  if (!hasVerified) {
    await knex.schema.alterTable('users', (table) => {
      table.boolean('email_verified').notNullable().defaultTo(false);
    });
  }

  const hasToken = await knex.schema.hasColumn('users', 'email_verify_token');
  if (!hasToken) {
    await knex.schema.alterTable('users', (table) => {
      table.text('email_verify_token');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('email_verified');
    table.dropColumn('email_verify_token');
  });
};
