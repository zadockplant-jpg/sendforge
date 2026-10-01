// My Home Builder portal: Important notes and the job schedule. Additive only.
//
// - mhb_notes: notes the admin and team leaders leave each other, each Open, In progress,
//   Completed or Contingent, with who changed it and when (notes.js).
// - mhb_schedule: crews scheduled to jobs on the calendar, from a start date to an end date, with
//   notes (schedule.js). client_slug is the job (a client portal); null for a note-only day.

export async function up(knex) {
  await knex.schema.createTable("mhb_notes", (t) => {
    t.string("id", 32).primary();
    t.string("status", 16).notNullable();
    t.jsonb("data").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["status"]);
  });

  await knex.schema.createTable("mhb_schedule", (t) => {
    t.string("id", 32).primary();
    t.date("starts_on").notNullable();
    t.date("ends_on").notNullable();
    t.string("client_slug", 64).nullable();
    t.jsonb("data").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["starts_on"]);
    t.index(["ends_on"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("mhb_schedule");
  await knex.schema.dropTableIfExists("mhb_notes");
}
