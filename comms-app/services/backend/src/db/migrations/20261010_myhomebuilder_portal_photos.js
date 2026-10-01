// My Home Builder portal: the photo gallery. Additive only.
//
// - mhb_photos: one row per photo added by the client, the crew or the admin. `data` holds the
//   file (its key in mhb_files, name, type and size), the note, who added it (uploadedBy,
//   uploaderName and, for crew, workerId) and whether it is hidden from the client portal.
//   client_slug is the project (client portal) it belongs to.

export async function up(knex) {
  await knex.schema.createTable("mhb_photos", (t) => {
    t.string("id", 32).primary();
    t.string("client_slug", 64).notNullable();
    t.jsonb("data").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["client_slug", "created_at"]);
  });
}

export async function down(knex) {
  await knex("mhb_files").where("key", "like", "photos/%").delete();
  await knex.schema.dropTableIfExists("mhb_photos");
}
