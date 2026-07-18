export async function up(knex) {
  if (!(await knex.schema.hasTable("referral_events"))) return;

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS referral_events_invite_sender_window_idx
      ON referral_events (referrer_user_id, product_slug, created_at DESC)
      WHERE event_type = 'invite'
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS referral_events_invite_destination_window_idx
      ON referral_events (product_slug, (metadata->>'recipient_email'), created_at DESC)
      WHERE event_type = 'invite'
  `);
}

export async function down(knex) {
  await knex.raw(
    "DROP INDEX IF EXISTS referral_events_invite_destination_window_idx"
  );
  await knex.raw(
    "DROP INDEX IF EXISTS referral_events_invite_sender_window_idx"
  );
}
