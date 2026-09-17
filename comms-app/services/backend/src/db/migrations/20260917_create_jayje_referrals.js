// Additive JayJe referral tables and document discount columns.
// Render applies this migration on deploy. Do not run it locally.
export async function up(k) {
  await k.schema.createTable('jayje_referral_codes', t => {
    t.string('code', 16).primary();
    t.uuid('client_id').notNullable().unique().references('id').inTable('jayje_clients');
    t.timestamp('created_at', { useTz: true }).defaultTo(k.fn.now());
  });
  await k.schema.createTable('jayje_referrals', t => {
    t.uuid('id').primary();
    t.string('code', 16).notNullable().references('code').inTable('jayje_referral_codes');
    t.uuid('referrer_client_id').notNullable().references('id').inTable('jayje_clients');
    t.string('invited_email', 254).notNullable();
    t.uuid('referred_client_id').references('id').inTable('jayje_clients');
    // invited -> joined -> redeemed. cancelled is terminal and frees the email.
    t.string('status', 12).notNullable().defaultTo('invited');
    t.integer('discount_cents').notNullable().defaultTo(0);
    t.integer('credit_cents').notNullable().defaultTo(0);
    t.string('notification_status', 20).notNullable().defaultTo('pending');
    t.integer('notification_attempts').notNullable().defaultTo(0);
    t.string('notification_error_code', 80);
    t.string('notification_provider_id', 250);
    t.timestamp('notification_attempted_at', { useTz: true });
    t.timestamp('notified_at', { useTz: true });
    t.timestamp('joined_at', { useTz: true });
    t.timestamp('redeemed_at', { useTz: true });
    t.timestamps(true, true);
    t.index(['referrer_client_id', 'created_at']);
    t.index(['notification_status', 'created_at']);
  });
  // One live referral per invited address, and a client is referred only once.
  await k.raw("CREATE UNIQUE INDEX jayje_referral_open_email ON jayje_referrals(invited_email) WHERE status <> 'cancelled'");
  await k.raw('CREATE UNIQUE INDEX jayje_referral_one_per_client ON jayje_referrals(referred_client_id) WHERE referred_client_id IS NOT NULL');
  await k.schema.createTable('jayje_referral_credits', t => {
    t.uuid('id').primary();
    t.uuid('referral_id').notNullable().unique().references('id').inTable('jayje_referrals');
    t.uuid('client_id').notNullable().references('id').inTable('jayje_clients');
    t.integer('amount_cents').notNullable();
    // available -> applied. A voided document returns the credit to available.
    t.string('status', 12).notNullable().defaultTo('available');
    t.uuid('applied_document_id').references('id').inTable('jayje_documents');
    t.timestamps(true, true);
    t.index(['client_id', 'status']);
  });
  await k.schema.alterTable('jayje_documents', t => {
    // The referral whose welcome discount this document carries, if any.
    t.uuid('referral_id').references('id').inTable('jayje_referrals');
    t.integer('discount_cents').notNullable().defaultTo(0);
    t.jsonb('discount_detail').notNullable().defaultTo('[]');
  });
  // A referral's discount lives on at most one open quote and one open invoice.
  await k.raw("CREATE UNIQUE INDEX jayje_referral_one_live_document ON jayje_documents(referral_id, kind) WHERE referral_id IS NOT NULL AND status <> 'void'");
  await k.schema.alterTable('jayje_service_requests', t => {
    t.string('referral_code', 16);
  });
}
export async function down(k) {
  await k.schema.alterTable('jayje_service_requests', t => t.dropColumn('referral_code'));
  await k.raw('DROP INDEX IF EXISTS jayje_referral_one_live_document');
  await k.schema.alterTable('jayje_documents', t => {
    t.dropColumn('discount_detail'); t.dropColumn('discount_cents'); t.dropColumn('referral_id');
  });
  for (const table of ['jayje_referral_credits', 'jayje_referrals', 'jayje_referral_codes']) await k.schema.dropTableIfExists(table);
}
