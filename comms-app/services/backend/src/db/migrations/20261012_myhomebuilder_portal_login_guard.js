// My Home Builder portal: sign-in protection per visitor address. Additive only.
//
// - mhb_login_guard: one row per address (an IPv4 address, or an IPv6 /64 network) with failed
//   sign-ins in a row (client login, crew login, admin code). The 5th blocks it for 20 minutes,
//   the 10th for 60 minutes and the 15th for good (guard.js). A successful sign-in removes the row,
//   and so does Unblock on the admin panel's Blocked sign-ins page.

export async function up(knex) {
  await knex.schema.createTable("mhb_login_guard", (t) => {
    t.string("address", 64).primary();
    t.integer("failures").notNullable().defaultTo(0);
    t.timestamp("blocked_until", { useTz: true }).nullable();
    t.boolean("permanent").notNullable().defaultTo(false);
    t.string("last_where", 16).nullable();
    t.timestamp("first_failed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("last_failed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("mhb_login_guard");
}
