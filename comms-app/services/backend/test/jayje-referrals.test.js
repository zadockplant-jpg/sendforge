import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import { PGlite } from '@electric-sql/pglite';
import { up, down } from '../src/db/migrations/20260907_create_jayje_portal.js';
import { up as requestsUp, down as requestsDown } from '../src/db/migrations/20260906_create_jayje_service_requests.js';
import { up as referralsUp, down as referralsDown } from '../src/db/migrations/20260917_create_jayje_referrals.js';
import { createPortalService, totals } from '../src/modules/jayje-portal/service.js';
import { createPortalBilling } from '../src/modules/jayje-portal/billing.js';
import { createReferrals, share, discountableCents, WELCOME_LABEL, CREDIT_LABEL, MAX_INVITES_PER_DAY } from '../src/modules/jayje-portal/referrals.js';
import { inviteBody } from '../src/modules/jayje-portal/referral-mail.js';

let pg, db, service, referrals, billing, stripe, admin, alice, bob, carol, aliceClient, bobClient, carolClient;
const sent = [];
const sessions = new Map(), keys = new Map();

before(async () => {
  pg = new PGlite(); await pg.waitReady;
  db = knex({ client: 'pg', connection: {}, pool: { min: 0, max: 1 } });
  db.client.acquireRawConnection = async () => ({ query(config, callback) {
    pg.query(config.text, config.values).then(result => callback(null, { rows: result.rows, rowCount: result.affectedRows, command: config.text.trim().split(/\s/)[0].toUpperCase() }), callback);
  } });
  db.client.destroyRawConnection = async () => {};
  await db.schema.createTable('users', t => { t.uuid('id').primary(); t.text('email').unique(); });
  await db.schema.createTable('admin_audit_log', t => { t.uuid('id').primary(); t.uuid('admin_user_id'); t.text('admin_email'); t.text('action'); t.text('resource_type'); t.text('resource_id'); t.jsonb('metadata'); });
  await up(db); await requestsUp(db); await referralsUp(db);
  referrals = createReferrals({ db, siteUrl: 'https://jayje.com', mail: async context => { sent.push(context); return { messageId: 'msg-1' }; }, logger: { error() {} } });
  service = createPortalService(db, referrals);
  admin = { sub: randomUUID(), email: 'owner@example.com', role: 'admin' };
  alice = { sub: randomUUID(), email: 'alice@example.com', role: 'client' };
  bob = { sub: randomUUID(), email: 'bob@example.com', role: 'client' };
  carol = { sub: randomUUID(), email: 'carol@example.com', role: 'client' };
  await db('users').insert([admin, alice, bob, carol].map(a => ({ id: a.sub, email: a.email })));
  aliceClient = await service.ensureClient(alice);
  bobClient = await service.ensureClient(bob);
  carolClient = await service.ensureClient(carol);
  stripe = { checkout: { sessions: {
    async create(params, options) {
      let id = keys.get(options.idempotencyKey);
      if (!id) { id = `cs_test_${randomUUID()}`; keys.set(options.idempotencyKey, id);
        sessions.set(id, { id, mode: 'payment', status: 'open', payment_status: 'unpaid', metadata: params.metadata, amount_total: params.line_items[0].price_data.unit_amount, currency: 'usd', url: 'https://checkout.stripe.com/c/pay/test', payment_intent: `pi_${randomUUID()}` }); }
      return structuredClone(sessions.get(id));
    },
    async retrieve(id) { return structuredClone(sessions.get(id)); },
  } } };
  billing = createPortalBilling({ db, stripe, service, siteUrl: 'https://jayje.com', referrals });
});
after(async () => { if (db) { await referralsDown(db); await requestsDown(db); await down(db); await db.destroy(); } await pg?.close(); });
beforeEach(() => { sent.length = 0; });

const handyman = (cents = 100000) => ({ description: 'Door and trim repairs', quantity_milli: 1000, unit_cents: cents, category: 'handyman' });
const plumbing = (cents = 100000) => ({ description: 'Water heater swap', quantity_milli: 1000, unit_cents: cents, category: 'plumbing' });
const doc = (client, overrides = {}) => ({ client_id: client.id, kind: 'invoice', title: 'Work', items: [handyman()], tax_bps: 0, ...overrides });
async function pay(invoice, actor) {
  const issued = await service.action(admin, invoice.id, 'issue');
  const { url } = await billing.checkout(actor, issued.id);
  assert.ok(url);
  const session = [...sessions.values()].find(s => s.metadata.jayje_invoice_id === issued.id);
  sessions.set(session.id, { ...session, status: 'complete', payment_status: 'paid' });
  await billing.sync(actor, issued.id);
  return issued;
}

test('the discount lands on handyman line items only and tax follows it', () => {
  assert.equal(discountableCents([handyman(100000), plumbing(100000)]), 100000);
  assert.equal(share(100000), 5000);
  const result = totals([handyman(100000), plumbing(100000)], 600, 5000);
  assert.equal(result.subtotal_cents, 200000);
  assert.equal(result.discount_cents, 5000);
  assert.equal(result.tax_cents, 11700, 'tax is charged on 195000, not 200000');
  assert.equal(result.total_cents, 206700);
  // A document with no handyman work gets no referral discount at all.
  assert.equal(share(discountableCents([plumbing(100000)])), 0);
});

test('an invite is stored before it is mailed and carries the referrer link', async () => {
  const referral = await referrals.invite(aliceClient, { email: 'Friend@Example.com', name: 'Friend' });
  assert.equal(referral.invited_email, 'friend@example.com');
  assert.equal(referral.status, 'invited');
  assert.equal(referral.notification_status, 'accepted');
  assert.equal(sent.length, 1);
  assert.match(sent[0].link, /^https:\/\/jayje\.com\/services\/\?ref=[A-Z0-9]{8}$/);
  const body = inviteBody(sent[0], { fromEmail: 'referrals@sendforge.app' });
  assert.match(body.subject, /5% off handyman services/);
  assert.equal(body.personalizations[0].to[0].email, 'friend@example.com');
  assert.ok(body.content.every(part => !part.value.includes('<script')));
});

test('a failed provider leaves a retryable row rather than losing the referral', async () => {
  const failing = createReferrals({ db, mail: async () => { throw Object.assign(new Error('mail_http_401'), { code: 'mail_http_401' }); }, logger: { error() {} } });
  const referral = await failing.invite(bobClient, { email: 'retry@example.com' });
  assert.equal(referral.status, 'invited');
  assert.equal(referral.notification_status, 'failed');
  assert.equal(referral.notification_error_code, 'mail_http_401');
  await referrals.send(referral, { referrer: bobClient });
  assert.equal((await db('jayje_referrals').where({ id: referral.id }).first()).notification_status, 'accepted');
});

test('a client cannot refer themselves, be referred twice, or take a stranger’s invite', async () => {
  await assert.rejects(referrals.invite(aliceClient, { email: aliceClient.email }), { publicCode: 'referral_self_invite' });
  const code = await referrals.codeFor(aliceClient.id);
  await assert.rejects(referrals.claim(aliceClient, { code }), { publicCode: 'referral_self_invite' });
  await assert.rejects(referrals.claim(carolClient, { code: 'ZZZZZZZZ' }), { publicCode: 'referral_code_not_found' });
  const claimed = await referrals.claim(carolClient, { code });
  assert.equal(claimed.status, 'joined');
  assert.equal(claimed.referrer_client_id, aliceClient.id);
  // Claiming again is idempotent and never re-points an existing referral.
  const again = await referrals.claim(carolClient, { code: await referrals.codeFor(bobClient.id) });
  assert.equal(again.id, claimed.id);
  assert.equal(again.referrer_client_id, aliceClient.id);
});

test('the friend’s first invoice is discounted once, and paying it credits the referrer', async () => {
  const draft = await service.createDocument(admin, doc(carolClient, { items: [handyman(100000), plumbing(60000)], tax_bps: 600 }));
  assert.equal(draft.discount_cents, 5000);
  assert.equal(draft.discount_detail[0].label, WELCOME_LABEL);
  assert.equal(draft.subtotal_cents, 160000);
  assert.equal(draft.total_cents, 155000 + 9300);
  // A second live invoice cannot claim the same welcome discount.
  await assert.rejects(service.createDocument(admin, doc(carolClient)), { publicCode: 'referral_already_applied' });
  await pay(draft, carol);
  const referral = await db('jayje_referrals').where({ referred_client_id: carolClient.id }).first();
  assert.equal(referral.status, 'redeemed');
  assert.equal(referral.credit_cents, 5000);
  const summary = await referrals.summary(aliceClient.id);
  assert.equal(summary.credit_available_cents, 5000);
  // The discount is spent: a later invoice for the same client is full price.
  const next = await service.createDocument(admin, doc(carolClient));
  assert.equal(next.discount_cents, 0);
  assert.equal(next.referral_id, null);
});

test('the referrer’s credit applies to one later document and returns if it is voided', async () => {
  const [credit] = await db('jayje_referral_credits').where({ client_id: aliceClient.id, status: 'available' });
  assert.ok(credit);
  const draft = await service.createDocument(admin, doc(aliceClient, { items: [plumbing(80000)], apply_credit_ids: [credit.id] }));
  assert.equal(draft.discount_cents, credit.amount_cents);
  assert.equal(draft.discount_detail[0].label, CREDIT_LABEL, 'a cash credit is not limited to handyman work');
  assert.equal(draft.total_cents, 80000 - credit.amount_cents);
  assert.equal((await db('jayje_referral_credits').where({ id: credit.id }).first()).status, 'applied');
  await assert.rejects(service.createDocument(admin, doc(aliceClient, { apply_credit_ids: [credit.id] })), { publicCode: 'referral_credit_unavailable' });
  await service.action(admin, draft.id, 'void');
  const returned = await db('jayje_referral_credits').where({ id: credit.id }).first();
  assert.equal(returned.status, 'available');
  assert.equal(returned.applied_document_id, null);
});

test('an accepted quote carries its discount into the invoice it converts to', async () => {
  const friend = { sub: randomUUID(), email: 'dave@example.com', role: 'client' };
  await db('users').insert({ id: friend.sub, email: friend.email });
  const friendClient = await service.ensureClient(friend);
  await referrals.claim(friendClient, { code: await referrals.codeFor(bobClient.id) });
  const quote = await service.createDocument(admin, doc(friendClient, { kind: 'quote', items: [handyman(200000)] }));
  assert.equal(quote.discount_cents, 10000);
  await service.action(admin, quote.id, 'issue');
  await service.action(friend, quote.id, 'accept');
  const invoice = await service.action(admin, quote.id, 'convert');
  assert.equal(invoice.referral_id, quote.referral_id);
  assert.equal(invoice.discount_cents, 10000);
  assert.equal(invoice.total_cents, 190000);
  await pay(invoice, friend);
  assert.equal((await referrals.summary(bobClient.id)).credit_available_cents, 10000);
});

test('an established customer cannot be referred, and invites are rate limited', async () => {
  await assert.rejects(referrals.invite(bobClient, { email: carolClient.email }), { publicCode: 'referral_existing_customer' });
  // An address someone else already invited stays with the first referrer.
  await referrals.invite(aliceClient, { email: 'erin@example.com' });
  const erin = { sub: randomUUID(), email: 'erin@example.com', role: 'client' };
  await db('users').insert({ id: erin.sub, email: erin.email });
  const erinClient = await service.ensureClient(erin);
  await assert.rejects(referrals.claim(erinClient, { code: await referrals.codeFor(bobClient.id) }), { publicCode: 'referral_already_invited' });
  const kept = await referrals.claim(erinClient, { code: await referrals.codeFor(aliceClient.id) });
  assert.equal(kept.referrer_client_id, aliceClient.id);
  assert.equal(kept.status, 'joined');
  const quiet = createReferrals({ db, mail: null, logger: { error() {} } });
  for (let i = 0; i < MAX_INVITES_PER_DAY; i++) await quiet.invite(bobClient, { email: `limit${i}@example.com` }).catch(() => {});
  await assert.rejects(quiet.invite(bobClient, { email: 'one-too-many@example.com' }), { publicCode: 'referral_invite_limit' });
});
