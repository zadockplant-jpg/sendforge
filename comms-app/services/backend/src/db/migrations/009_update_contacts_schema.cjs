/**
 * 009_update_contacts_schema.cjs
 */

exports.up = async function (knex) {
  const hasPhone = await knex.schema.hasColumn('contacts', 'phone');
  if (!hasPhone) {
    await knex.schema.alterTable('contacts', (table) => {
      table.string('phone');
    });
  }

  const hasSource = await knex.schema.hasColumn('contacts', 'source');
  if (!hasSource) {
    await knex.schema.alterTable('contacts', (table) => {
      table.string('source').defaultTo('manual');
    });
  }

  const hasUserId = await knex.schema.hasColumn('contacts', 'user_id');
  if (!hasUserId) {
    await knex.schema.alterTable('contacts', (table) => {
      table.string('user_id').notNullable().defaultTo('local-user');
    });
  }

  // Composite uniqueness (safe attempt)
  try {
    await knex.schema.alterTable('contacts', (table) => {
      table.unique(['user_id', 'phone', 'email']);
    });
  } catch (e) {
    // index may already exist — ignore
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('contacts', (table) => {
    table.dropColumn('phone');
    table.dropColumn('source');
  });
};
