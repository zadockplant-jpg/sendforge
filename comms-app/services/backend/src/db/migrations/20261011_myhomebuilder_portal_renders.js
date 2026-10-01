// My Home Builder portal: renders for the live material designer. Additive only.
//
// - mhb_renders: one row per render a project's designer offers. `data` holds the render's name,
//   room, its PNG and surface-map PNG (files in mhb_files) and the package (camera, scale, and each
//   surface's category and plane) the designer composites finishes with (designer.js).

export async function up(knex) {
  await knex.schema.createTable("mhb_renders", (t) => {
    t.string("id", 32).primary();
    t.string("client_slug", 64).notNullable();
    t.jsonb("data").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["client_slug", "created_at"]);
  });
}

export async function down(knex) {
  await knex("mhb_files").where("key", "like", "renders/%").delete();
  await knex.schema.dropTableIfExists("mhb_renders");
}
