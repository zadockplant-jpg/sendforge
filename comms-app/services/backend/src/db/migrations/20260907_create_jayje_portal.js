// Additive JayJe tables. Applied by the existing Render migration step.
export async function up(k) {
  await k.schema.createTable('jayje_clients', t => {
    t.uuid('id').primary(); t.string('email',254).notNullable().unique();
    t.uuid('user_id').unique().references('id').inTable('users');
    t.string('name',160).notNullable(); t.string('phone',40).notNullable().defaultTo('');
    t.text('address').notNullable().defaultTo(''); t.timestamps(true,true);
  });
  await k.schema.createTable('jayje_messages', t => {
    t.uuid('id').primary(); t.uuid('client_id').notNullable().references('id').inTable('jayje_clients');
    t.uuid('sender_id').notNullable().references('id').inTable('users'); t.string('sender_role',10).notNullable();
    t.uuid('request_key').notNullable(); t.text('body').notNullable(); t.timestamp('created_at',{useTz:true}).defaultTo(k.fn.now());
    t.unique(['sender_id','request_key']); t.index(['client_id','created_at']);
  });
  await k.schema.createTable('jayje_documents', t => {
    t.uuid('id').primary(); t.string('reference',40).notNullable().unique();
    t.uuid('client_id').notNullable().references('id').inTable('jayje_clients');
    t.uuid('created_by').notNullable().references('id').inTable('users');
    t.string('kind',10).notNullable(); t.string('status',20).notNullable().defaultTo('draft');
    t.string('title',180).notNullable(); t.jsonb('items').notNullable(); t.jsonb('customer').notNullable();
    t.integer('subtotal_cents').notNullable(); t.integer('tax_bps').notNullable();
    t.integer('tax_cents').notNullable(); t.integer('total_cents').notNullable();
    t.string('currency',3).notNullable().defaultTo('usd'); t.text('notes').notNullable().defaultTo('');
    t.date('due_date'); t.uuid('source_quote_id').unique().references('id').inTable('jayje_documents');
    t.timestamp('issued_at',{useTz:true}); t.timestamp('paid_at',{useTz:true}); t.timestamps(true,true);
    t.index(['client_id','created_at']);
  });
  await k.schema.createTable('jayje_checkout_attempts', t => {
    t.uuid('id').primary(); t.uuid('invoice_id').notNullable().references('id').inTable('jayje_documents');
    t.string('status',20).notNullable(); t.string('stripe_session_id',255).unique();
    t.integer('amount_cents').notNullable(); t.string('currency',3).notNullable();
    t.timestamp('expires_at',{useTz:true}).notNullable(); t.timestamps(true,true);
  });
  await k.raw("CREATE UNIQUE INDEX jayje_one_active_checkout ON jayje_checkout_attempts(invoice_id) WHERE status IN ('creating','open','pending')");
  await k.schema.createTable('jayje_payments', t => {
    t.uuid('id').primary(); t.uuid('invoice_id').notNullable().unique().references('id').inTable('jayje_documents');
    t.string('stripe_session_id',255).notNullable().unique(); t.string('stripe_payment_intent_id',255).notNullable().unique();
    t.integer('amount_cents').notNullable(); t.string('currency',3).notNullable();
    t.string('status',25).notNullable().defaultTo('paid'); t.integer('refunded_cents').notNullable().defaultTo(0);
    t.timestamp('paid_at',{useTz:true}).notNullable(); t.timestamps(true,true);
  });
  await k.schema.createTable('jayje_google_identities', t => {
    t.string('subject',255).primary(); t.uuid('user_id').notNullable().unique().references('id').inTable('users');
    t.timestamp('created_at',{useTz:true}).defaultTo(k.fn.now());
  });
}
export async function down(k) {
  for(const table of ['jayje_google_identities','jayje_payments','jayje_checkout_attempts','jayje_documents','jayje_messages','jayje_clients']) await k.schema.dropTableIfExists(table);
}
