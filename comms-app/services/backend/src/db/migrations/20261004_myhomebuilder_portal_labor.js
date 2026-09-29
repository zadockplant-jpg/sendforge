// My Home Builder portal: labor. Employees (W-2) and subcontractors (1099) sign in to the crew
// portal, send their hours and invoices, and fill out and sign their paperwork; the admin
// approves the work to a job, and the books carry it as job cost. Additive only.
//
// - mhb_workers: one row per employee or subcontractor. `data` holds the profile, the sign-in
//   (a password hash, and the hash of an invite or reset link) and which paperwork is done.
// - mhb_labor: hours and invoices sent in, and what became of them (approved to a job, returned,
//   paid).
// - mhb_secure: encrypted blobs (AES-256-GCM, secure.js): paperwork answers that hold Social
//   Security, tax id and bank numbers, and the signed forms themselves. `key_id` names the key
//   that sealed each one.
// - mhb_settings: the employer details printed on tax forms and lien waivers.
// - mhb_accounts gains 1000 Business checking, 2000 Accounts payable, 2300 Wages payable,
//   5000 Job labor, 5100 Subcontractors and 6450 Shop and overhead labor.

const ACCOUNTS = [
  { code: "1000", name: "Business checking", type: "asset", sort: 5 },
  { code: "2000", name: "Accounts payable", type: "liability", sort: 35 },
  { code: "2300", name: "Wages payable", type: "liability", sort: 45 },
  { code: "5000", name: "Job labor", type: "expense", sort: 56 },
  { code: "5100", name: "Subcontractors", type: "expense", sort: 57 },
  { code: "6450", name: "Shop and overhead labor", type: "expense", sort: 75 }
];

export async function up(knex) {
  await knex.schema.createTable("mhb_workers", (t) => {
    t.string("id", 32).primary();
    t.string("email", 254).notNullable().unique();
    t.string("kind", 16).notNullable();
    t.jsonb("data").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("mhb_labor", (t) => {
    t.string("id", 32).primary();
    t.string("worker_id", 32).notNullable().references("id").inTable("mhb_workers");
    t.string("kind", 8).notNullable();
    t.string("status", 16).notNullable();
    t.string("client_slug", 64).nullable();
    t.date("work_date").notNullable();
    t.bigInteger("amount_cents").notNullable().defaultTo(0);
    t.jsonb("data").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["worker_id"]);
    t.index(["status"]);
    t.index(["client_slug"]);
  });

  await knex.schema.createTable("mhb_secure", (t) => {
    t.string("key", 200).primary();
    t.string("key_id", 16).notNullable();
    t.binary("iv").notNullable();
    t.binary("tag").notNullable();
    t.binary("ciphertext").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("mhb_settings", (t) => {
    t.string("key", 64).primary();
    t.jsonb("data").notNullable().defaultTo("{}");
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex("mhb_accounts").insert(ACCOUNTS).onConflict("code").ignore();
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("mhb_settings");
  await knex.schema.dropTableIfExists("mhb_secure");
  await knex.schema.dropTableIfExists("mhb_labor");
  await knex.schema.dropTableIfExists("mhb_workers");
  await knex("mhb_accounts").whereIn("code", ACCOUNTS.map((account) => account.code)).delete();
}
