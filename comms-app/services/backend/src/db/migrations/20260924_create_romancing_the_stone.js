// Romancing the Stone. Additive only: new rts_* tables, no change to existing
// tables. Production applies it with `npm run migrate` like the other
// migrations; do not point it at production from a local machine.
//
// user ids are stored without a foreign key to users, like the other product
// modules, so this module can be removed without touching account tables.

export async function up(knex) {
  await knex.schema.createTable("rts_circles", (t) => {
    t.uuid("id").primary();
    t.string("name", 60).notNullable();
    t.string("kind", 12).notNullable();
    t.string("invite_code", 12).notNullable().unique();
    // The account whose licence powers the circle. Null while no licence
    // covers it (its sponsor left or was removed): the circle is paused.
    t.uuid("sponsor_user_id").nullable().index();
    t.uuid("created_by_user_id").notNullable();
    t.string("timezone", 64).notNullable().defaultTo("UTC");
    t.bigInteger("seq").notNullable().defaultTo(0);
    t.timestamp("archived_at", { useTz: true }).nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable("rts_members", (t) => {
    t.uuid("id").primary();
    t.uuid("circle_id").notNullable().references("id").inTable("rts_circles").onDelete("CASCADE");
    t.uuid("user_id").nullable();
    t.string("display_name", 32).notNullable();
    t.string("role", 8).notNullable();
    t.string("avatar", 40).notNullable().defaultTo("gem");
    t.string("color", 12).notNullable().defaultTo("cyan");
    t.integer("balance").notNullable().defaultTo(0);
    t.timestamp("removed_at", { useTz: true }).nullable();
    t.timestamps(true, true);
    t.index(["circle_id"]);
    t.index(["user_id"]);
  });
  await knex.raw("ALTER TABLE rts_members ADD CONSTRAINT rts_members_balance_nonnegative CHECK (balance >= 0)");
  await knex.raw(
    "CREATE UNIQUE INDEX rts_members_circle_user_active ON rts_members (circle_id, user_id) WHERE user_id IS NOT NULL AND removed_at IS NULL"
  );

  await knex.schema.createTable("rts_paths", (t) => {
    t.uuid("id").primary();
    t.uuid("circle_id").notNullable().references("id").inTable("rts_circles").onDelete("CASCADE");
    t.string("title", 80).notNullable();
    t.string("teaser", 200).notNullable().defaultTo("");
    t.string("icon", 40).notNullable();
    t.string("color", 12).notNullable();
    t.integer("cost").nullable();
    t.boolean("repeatable").notNullable().defaultTo(false);
    t.jsonb("assignee_ids").notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.jsonb("graph").notNullable();
    // Everyone who has ever seen behind this path's doors. None of them can
    // ever walk it, whatever their role becomes later.
    t.jsonb("seen_by").notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.uuid("created_by_member").notNullable();
    t.timestamp("archived_at", { useTz: true }).nullable();
    t.timestamps(true, true);
    t.index(["circle_id", "archived_at"]);
  });

  await knex.schema.createTable("rts_quests", (t) => {
    t.uuid("id").primary();
    t.uuid("circle_id").notNullable().references("id").inTable("rts_circles").onDelete("CASCADE");
    t.string("title", 80).notNullable();
    t.string("description", 500).notNullable().defaultTo("");
    t.string("icon", 40).notNullable();
    t.integer("points").notNullable().defaultTo(0);
    t.uuid("key_path_id").nullable().references("id").inTable("rts_paths").onDelete("SET NULL");
    t.string("recurrence", 8).notNullable().defaultTo("once");
    t.jsonb("assignee_ids").notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.boolean("requires_approval").notNullable().defaultTo(true);
    t.uuid("created_by_member").notNullable();
    t.timestamp("archived_at", { useTz: true }).nullable();
    t.timestamps(true, true);
    t.index(["circle_id", "archived_at"]);
  });

  await knex.schema.createTable("rts_claims", (t) => {
    t.uuid("id").primary();
    t.uuid("circle_id").notNullable().references("id").inTable("rts_circles").onDelete("CASCADE");
    t.uuid("quest_id").notNullable().references("id").inTable("rts_quests").onDelete("CASCADE");
    t.uuid("member_id").notNullable().references("id").inTable("rts_members").onDelete("CASCADE");
    t.string("status", 10).notNullable();
    t.string("note", 280).notNullable().defaultTo("");
    t.string("period_key", 16).notNullable().defaultTo("");
    t.integer("points").notNullable().defaultTo(0);
    t.uuid("decided_by_member").nullable();
    t.string("decided_note", 280).notNullable().defaultTo("");
    t.timestamp("decided_at", { useTz: true }).nullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["circle_id", "status", "created_at"]);
  });
  // One live claim per quest, person and period. Rejected claims do not count,
  // and "always" quests (empty period) are not limited.
  await knex.raw(
    "CREATE UNIQUE INDEX rts_claims_one_per_period ON rts_claims (quest_id, member_id, period_key) WHERE status IN ('pending','approved') AND period_key <> ''"
  );

  await knex.schema.createTable("rts_runs", (t) => {
    t.uuid("id").primary();
    t.uuid("circle_id").notNullable().references("id").inTable("rts_circles").onDelete("CASCADE");
    t.uuid("path_id").notNullable().references("id").inTable("rts_paths").onDelete("CASCADE");
    t.uuid("member_id").notNullable().references("id").inTable("rts_members").onDelete("CASCADE");
    t.string("path_title", 80).notNullable();
    t.string("path_icon", 40).notNullable();
    t.string("path_color", 12).notNullable();
    t.jsonb("graph").notNullable();
    t.string("current_node", 24).nullable();
    t.string("status", 10).notNullable();
    t.string("paid_with", 8).notNullable();
    t.integer("cost_paid").notNullable().defaultTo(0);
    t.uuid("key_id").nullable();
    t.jsonb("steps").notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.jsonb("reward").nullable();
    t.string("fulfillment", 10).nullable();
    t.string("fulfillment_note", 280).notNullable().defaultTo("");
    t.uuid("fulfilled_by_member").nullable();
    t.timestamp("fulfilled_at", { useTz: true }).nullable();
    t.timestamp("started_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("completed_at", { useTz: true }).nullable();
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["circle_id", "status"]);
    t.index(["member_id", "path_id"]);
  });
  // One walk at a time per person and path, so two taps cannot pay twice.
  await knex.raw(
    "CREATE UNIQUE INDEX rts_runs_one_active ON rts_runs (member_id, path_id) WHERE status = 'active'"
  );

  await knex.schema.createTable("rts_keys", (t) => {
    t.uuid("id").primary();
    t.uuid("circle_id").notNullable().references("id").inTable("rts_circles").onDelete("CASCADE");
    t.uuid("member_id").notNullable().references("id").inTable("rts_members").onDelete("CASCADE");
    t.uuid("path_id").notNullable().references("id").inTable("rts_paths").onDelete("CASCADE");
    t.string("source", 8).notNullable();
    t.uuid("source_ref").nullable();
    t.uuid("used_run_id").nullable();
    t.timestamp("used_at", { useTz: true }).nullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["member_id", "path_id", "used_run_id"]);
  });

  await knex.schema.createTable("rts_ledger", (t) => {
    t.uuid("id").primary();
    t.uuid("circle_id").notNullable().references("id").inTable("rts_circles").onDelete("CASCADE");
    t.uuid("member_id").notNullable().references("id").inTable("rts_members").onDelete("CASCADE");
    t.integer("delta").notNullable();
    t.integer("balance_after").notNullable();
    t.string("kind", 10).notNullable();
    t.string("note", 200).notNullable().defaultTo("");
    t.uuid("ref_id").nullable();
    t.uuid("actor_member_id").nullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["circle_id", "member_id", "created_at"]);
  });

  await knex.schema.createTable("rts_events", (t) => {
    t.bigIncrements("seq").primary();
    t.uuid("circle_id").notNullable().references("id").inTable("rts_circles").onDelete("CASCADE");
    t.string("type", 32).notNullable();
    t.uuid("actor_member_id").nullable();
    t.jsonb("data").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["circle_id", "seq"]);
  });

  await knex.schema.createTable("rts_devices", (t) => {
    t.uuid("id").primary();
    t.uuid("sponsor_user_id").notNullable();
    t.string("device_id", 64).notNullable();
    t.string("label", 80).notNullable().defaultTo("Device");
    t.uuid("last_user_id").nullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("last_seen_at", { useTz: true }).nullable();
    t.timestamp("revoked_at", { useTz: true }).nullable();
    t.index(["sponsor_user_id"]);
  });
  await knex.raw(
    "CREATE UNIQUE INDEX rts_devices_sponsor_device_active ON rts_devices (sponsor_user_id, device_id) WHERE revoked_at IS NULL"
  );

  await knex.schema.createTable("rts_perk_claims", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable();
    t.string("perk_id", 40).notNullable();
    t.jsonb("choice").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.string("status", 16).notNullable().defaultTo("requested");
    t.timestamps(true, true);
    t.unique(["user_id", "perk_id"]);
  });
}

export async function down(knex) {
  for (const table of [
    "rts_perk_claims",
    "rts_devices",
    "rts_events",
    "rts_ledger",
    "rts_keys",
    "rts_runs",
    "rts_claims",
    "rts_quests",
    "rts_paths",
    "rts_members",
    "rts_circles",
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
