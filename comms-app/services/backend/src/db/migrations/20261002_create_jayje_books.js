// Additive JayJe books (jayje-portal/books.js). Render applies this migration on deploy. Do not run
// it locally.
//
// - jayje_accounts: the chart of accounts. Bank accounts and expense categories join it when the
//   business bank account is connected.
// - jayje_journal_entries / jayje_journal_lines: a double-entry journal. Each entry's debits equal
//   its credits, and each line is a debit or a credit, never both. `seq` keeps posting order.
//   Entries name a document and client without foreign keys, so the journal keeps its record
//   whatever happens to them. (kind, external_id) is unique, so a repeated Stripe event or bank
//   import posts once.
// - jayje_activity: everything done in the portal, by admins (named), clients and Stripe.
// - jayje_stripe_events: each Stripe event handled, by id.
// - jayje_payment_refunds: each refund, instead of only the running total on the payment.
// - jayje_payments gains Stripe's fee, the charge time and the dispute, and can hold a payment
//   received outside Stripe (check, cash, Zelle): no Stripe ids, a method and a reference.
// - jayje_books_meta: `opened` is set once invoices saved before the books have their entries.

const ACCOUNTS = [
  ['1100', 'Accounts receivable', 'asset'],
  ['1200', 'Stripe balance', 'asset'],
  ['1250', 'Funds held in disputes', 'asset'],
  ['1300', 'Payments received outside Stripe', 'asset'],
  ['2100', 'Unapplied payments', 'liability'],
  ['2200', 'Sales tax payable', 'liability'],
  ['4000', 'Sales', 'income'],
  ['4100', 'Discounts and referral credits', 'income'],
  ['4200', 'Refunds', 'income'],
  ['6100', 'Stripe fees', 'expense'],
  ['6200', 'Dispute losses and fees', 'expense']
];

export async function up(k) {
  await k.schema.createTable('jayje_accounts', t => {
    t.string('code', 8).primary(); t.string('name', 80).notNullable();
    t.string('type', 16).notNullable(); t.integer('sort').notNullable().defaultTo(0);
  });
  await k('jayje_accounts').insert(ACCOUNTS.map(([code, name, type], index) => ({ code, name, type, sort: (index + 1) * 10 })));

  await k.schema.createTable('jayje_journal_entries', t => {
    t.uuid('id').primary(); t.specificType('seq', 'bigserial');
    t.date('entry_date').notNullable(); t.timestamp('recorded_at', { useTz: true }).notNullable().defaultTo(k.fn.now());
    t.string('kind', 24).notNullable(); t.string('part', 48); t.uuid('reverses');
    t.string('memo', 300).notNullable();
    t.uuid('client_id'); t.uuid('document_id'); t.string('document_reference', 40);
    t.string('source', 16).notNullable(); t.string('external_id', 200); t.uuid('activity_id');
    t.jsonb('labels').notNullable().defaultTo('[]'); t.jsonb('data').notNullable().defaultTo('{}');
    t.unique(['kind', 'external_id']);
    t.index(['entry_date']); t.index(['document_id']); t.index(['reverses']); t.index(['client_id']);
  });
  await k.schema.createTable('jayje_journal_lines', t => {
    t.uuid('id').primary(); t.specificType('seq', 'bigserial');
    t.uuid('entry_id').notNullable().references('id').inTable('jayje_journal_entries').onDelete('CASCADE');
    t.string('account', 8).notNullable().references('code').inTable('jayje_accounts');
    t.bigInteger('debit_cents').notNullable().defaultTo(0); t.bigInteger('credit_cents').notNullable().defaultTo(0);
    t.uuid('client_id'); t.uuid('document_id');
    t.index(['entry_id']); t.index(['account']); t.index(['document_id']);
  });
  await k.raw('ALTER TABLE jayje_journal_lines ADD CONSTRAINT jayje_journal_lines_one_side CHECK (debit_cents >= 0 AND credit_cents >= 0 AND (debit_cents = 0) <> (credit_cents = 0))');

  await k.schema.createTable('jayje_activity', t => {
    t.uuid('id').primary(); t.specificType('seq', 'bigserial');
    t.timestamp('at', { useTz: true }).notNullable().defaultTo(k.fn.now());
    t.string('actor', 16).notNullable(); t.string('action', 48).notNullable();
    t.uuid('user_id'); t.string('email', 254);
    t.uuid('client_id'); t.uuid('document_id'); t.string('document_reference', 40);
    t.bigInteger('amount_cents'); t.string('summary', 500).notNullable(); t.string('ip', 64);
    t.jsonb('data').notNullable().defaultTo('{}');
    t.index(['at']); t.index(['client_id', 'at']); t.index(['document_id']);
  });

  await k.schema.createTable('jayje_stripe_events', t => {
    t.string('id', 255).primary(); t.string('type', 80).notNullable();
    t.timestamp('received_at', { useTz: true }).notNullable().defaultTo(k.fn.now());
  });
  await k.schema.createTable('jayje_payment_refunds', t => {
    t.string('id', 255).primary(); t.uuid('payment_id').notNullable().references('id').inTable('jayje_payments');
    t.integer('amount_cents').notNullable(); t.string('status', 25).notNullable();
    t.timestamp('refunded_at', { useTz: true }).notNullable(); t.timestamps(true, true);
    t.index(['payment_id']);
  });

  await k.schema.alterTable('jayje_payments', t => {
    t.string('source', 10).notNullable().defaultTo('stripe');
    t.string('method', 20); t.string('method_name', 60); t.string('reference', 80); t.uuid('recorded_by');
    t.integer('fee_cents'); t.timestamp('charged_at', { useTz: true });
    t.string('dispute_id', 255); t.string('dispute_status', 40); t.integer('dispute_amount_cents');
    t.integer('dispute_fee_cents'); t.integer('dispute_fee_returned_cents');
    t.timestamp('dispute_opened_at', { useTz: true }); t.timestamp('dispute_closed_at', { useTz: true });
  });
  // A payment received outside Stripe has no Stripe session or payment intent. The unique
  // constraints stay; Postgres treats each missing id as distinct.
  await k.raw('ALTER TABLE jayje_payments ALTER COLUMN stripe_session_id DROP NOT NULL');
  await k.raw('ALTER TABLE jayje_payments ALTER COLUMN stripe_payment_intent_id DROP NOT NULL');

  await k.schema.createTable('jayje_books_meta', t => {
    t.string('key', 40).primary(); t.jsonb('value').notNullable().defaultTo('{}');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(k.fn.now());
  });
}

export async function down(k) {
  await k.schema.dropTableIfExists('jayje_books_meta');
  await k.schema.dropTableIfExists('jayje_payment_refunds');
  await k.schema.dropTableIfExists('jayje_stripe_events');
  await k.schema.dropTableIfExists('jayje_activity');
  await k.schema.dropTableIfExists('jayje_journal_lines');
  await k.schema.dropTableIfExists('jayje_journal_entries');
  await k.schema.dropTableIfExists('jayje_accounts');
  await k.schema.alterTable('jayje_payments', t => {
    t.dropColumns('source', 'method', 'method_name', 'reference', 'recorded_by', 'fee_cents', 'charged_at',
      'dispute_id', 'dispute_status', 'dispute_amount_cents', 'dispute_fee_cents', 'dispute_fee_returned_cents',
      'dispute_opened_at', 'dispute_closed_at');
  });
}
