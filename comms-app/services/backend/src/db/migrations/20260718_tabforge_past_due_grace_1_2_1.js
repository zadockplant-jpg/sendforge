const TABFORGE_SYNC_PLANS = [
  "tabforge_private_sync",
  "tabforge_sync_collections",
  "tabforge_collections",
];

export async function up(knex) {
  if (!(await knex.schema.hasTable("subscriptions"))) return;

  // Existing past-due rows predate the explicit grace marker. Their most
  // recent local update is the safest durable lower bound available; future
  // Stripe upserts preserve the first marker until the status changes.
  await knex("subscriptions")
    .where({ provider: "stripe", status: "past_due" })
    .whereIn("plan", TABFORGE_SYNC_PLANS)
    .whereRaw("coalesce(raw->>'past_due_since', '') = ''")
    .update({
      raw: knex.raw(
        "coalesce(raw, '{}'::jsonb) || jsonb_build_object('past_due_since', coalesce(updated_at, current_period_end, created_at, now()))"
      ),
    });
}

export async function down(knex) {
  if (!(await knex.schema.hasTable("subscriptions"))) return;
  await knex("subscriptions")
    .where({ provider: "stripe", status: "past_due" })
    .whereIn("plan", TABFORGE_SYNC_PLANS)
    .update({ raw: knex.raw("coalesce(raw, '{}'::jsonb) - 'past_due_since'") });
}
