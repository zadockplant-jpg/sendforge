exports.up = async function (knex) {
  const has = await knex.schema.hasColumn("groups", "updated_at");
  if (!has) {
    await knex.schema.alterTable("groups", (t) => {
      t.timestamp("updated_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn("groups", "updated_at");
  if (has) {
    await knex.schema.alterTable("groups", (t) => {
      t.dropColumn("updated_at");
    });
  }
};