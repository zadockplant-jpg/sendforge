export async function up(knex) {
  if (!(await knex.schema.hasTable("webauthn_credentials"))) {
    await knex.schema.createTable("webauthn_credentials", (table) => {
      table.uuid("id").primary();
      table
        .uuid("user_id")
        .notNullable()
        .references("id")
        .inTable("users")
        .onDelete("CASCADE");
      table.text("credential_id").notNullable().unique();
      table.text("user_handle").notNullable();
      table.binary("public_key").notNullable();
      table.bigInteger("counter").notNullable().defaultTo(0);
      table
        .jsonb("transports")
        .notNullable()
        .defaultTo(knex.raw("'[]'::jsonb"));
      table.text("aaguid").notNullable();
      table.text("device_type").notNullable();
      table.boolean("backed_up").notNullable().defaultTo(false);
      table.text("name").notNullable().defaultTo("ForgePass");
      table
        .timestamp("created_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());
      table
        .timestamp("updated_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());
      table.timestamp("last_used_at", { useTz: true }).nullable();

      table.index(
        ["user_id", "created_at"],
        "webauthn_credentials_user_created_idx"
      );
      table.index(["user_handle"], "webauthn_credentials_user_handle_idx");
      table.check("counter >= 0", [], "webauthn_credentials_counter_check");
      table.check(
        "jsonb_typeof(transports) = 'array'",
        [],
        "webauthn_credentials_transports_check"
      );
    });
  }

  if (!(await knex.schema.hasTable("webauthn_challenges"))) {
    await knex.schema.createTable("webauthn_challenges", (table) => {
      table.uuid("id").primary();
      table
        .uuid("user_id")
        .nullable()
        .references("id")
        .inTable("users")
        .onDelete("CASCADE");
      table.text("purpose").notNullable();
      table.text("challenge").notNullable().unique();
      table.timestamp("expires_at", { useTz: true }).notNullable();
      table
        .timestamp("created_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table.index(["expires_at"], "webauthn_challenges_expiry_idx");
      table.index(
        ["user_id", "purpose", "created_at"],
        "webauthn_challenges_user_purpose_idx"
      );
      table.check(
        "purpose IN ('registration', 'authentication')",
        [],
        "webauthn_challenges_purpose_check"
      );
    });
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("webauthn_challenges");
  await knex.schema.dropTableIfExists("webauthn_credentials");
}
