exports.up = async function (knex) {
  const has = await knex.schema.hasColumn("groups", "avatar_key");
  if (!has) {
    await knex.schema.alterTable("groups", (t) => {
      t.text("avatar_key").nullable();
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn("groups", "avatar_key");
  if (has) {
    await knex.schema.alterTable("groups", (t) => {
      t.dropColumn("avatar_key");
    });
  }
};