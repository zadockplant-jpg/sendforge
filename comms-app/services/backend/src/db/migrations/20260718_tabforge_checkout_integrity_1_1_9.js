export async function up(knex) {
  if (!(await knex.schema.hasTable("billing_checkout_attempts"))) {
    await knex.schema.createTable("billing_checkout_attempts", (table) => {
      table.uuid("id").primary();
      table
        .uuid("user_id")
        .notNullable()
        .references("id")
        .inTable("users")
        .onDelete("CASCADE");
      table.text("product_slug").notNullable();
      table.text("selection_key").notNullable();
      table.text("stripe_checkout_session_id").notNullable().unique();
      table.text("checkout_url").notNullable();
      table.text("status").notNullable().defaultTo("open");
      table.timestamp("expires_at", { useTz: true }).notNullable();
      table.jsonb("metadata").notNullable().defaultTo("{}");
      table
        .timestamp("created_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());
      table
        .timestamp("updated_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table.index(["user_id", "product_slug", "status"]);
      table.index(["user_id", "selection_key", "expires_at"]);
    });
  }

  if (await knex.schema.hasTable("subscriptions")) {
    // Preserve (rather than delete) any historical race-created duplicates.
    // The newest row stays canonical; older rows are made inert and retain
    // their original status in raw for billing support/audit purposes.
    await knex.raw(`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY provider, provider_subscription_id
                 ORDER BY updated_at DESC NULLS LAST,
                          created_at DESC NULLS LAST,
                          id DESC
               ) AS duplicate_rank
          FROM subscriptions
         WHERE provider = 'stripe'
           AND provider_subscription_id <> ''
      )
      UPDATE subscriptions AS subscription
         SET provider = 'stripe_duplicate_archive',
             provider_subscription_id = subscription.provider_subscription_id || ':duplicate:' || subscription.id::text,
             status = 'archived_duplicate',
             raw = coalesce(subscription.raw, '{}'::jsonb) || jsonb_build_object(
               'archived_duplicate_at', now(),
               'archived_duplicate_original_status', subscription.status
             ),
             updated_at = now()
        FROM ranked
       WHERE subscription.id = ranked.id
         AND ranked.duplicate_rank > 1
    `);

    // Stripe can deliver created/updated webhooks concurrently. Historical
    // manual subscriptions use an empty provider ID, so uniqueness is limited
    // to real provider identifiers.
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_subscription_unique
        ON subscriptions (provider, provider_subscription_id)
        WHERE provider_subscription_id <> ''
    `);
  }
}

export async function down(knex) {
  await knex.raw(
    "DROP INDEX IF EXISTS subscriptions_provider_subscription_unique"
  );
  await knex.schema.dropTableIfExists("billing_checkout_attempts");
}
