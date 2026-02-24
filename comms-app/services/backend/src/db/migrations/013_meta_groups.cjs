// 0XX_meta_groups.cjs
// Adds groups.type (snapshot|meta) and creates meta_group_links(parent_group_id, child_group_id)

exports.up = async function (knex) {
  // 1) groups.type column
  const hasType = await knex.schema.hasColumn("groups", "type");
  if (!hasType) {
    await knex.schema.alterTable("groups", (t) => {
      t.text("type").notNullable().defaultTo("snapshot");
    });
  }

  // 2) meta_group_links table
  const hasLinks = await knex.schema.hasTable("meta_group_links");
  if (!hasLinks) {
    await knex.schema.createTable("meta_group_links", (t) => {
      // IMPORTANT: use UUID if groups.id is UUID (most likely in your app)
      t.uuid("parent_group_id").notNullable();
      t.uuid("child_group_id").notNullable();

      t.timestamp("created_at").defaultTo(knex.fn.now());

      t.primary(["parent_group_id", "child_group_id"]);

      t.foreign("parent_group_id")
        .references("id")
        .inTable("groups")
        .onDelete("CASCADE");

      t.foreign("child_group_id")
        .references("id")
        .inTable("groups")
        .onDelete("CASCADE");
    });

    // 3) helpful indexes
    await knex.schema.alterTable("meta_group_links", (t) => {
      t.index(["parent_group_id"], "idx_meta_parent");
      t.index(["child_group_id"], "idx_meta_child");
    });
  }
};

exports.down = async function (knex) {
  const hasLinks = await knex.schema.hasTable("meta_group_links");
  if (hasLinks) {
    await knex.schema.dropTable("meta_group_links");
  }

  const hasType = await knex.schema.hasColumn("groups", "type");
  if (hasType) {
    await knex.schema.alterTable("groups", (t) => {
      t.dropColumn("type");
    });
  }
};