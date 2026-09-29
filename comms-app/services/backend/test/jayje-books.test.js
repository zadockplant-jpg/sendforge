import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import { PGlite } from '@electric-sql/pglite';
import { up,down } from '../src/db/migrations/20260907_create_jayje_portal.js';
import { up as requestsUp, down as requestsDown } from '../src/db/migrations/20260906_create_jayje_service_requests.js';
import { up as referralsUp, down as referralsDown } from '../src/db/migrations/20260917_create_jayje_referrals.js';
import { up as booksUp, down as booksDown } from '../src/db/migrations/20261002_create_jayje_books.js';
import { createPortalService } from '../src/modules/jayje-portal/service.js';
import { createPortalBilling } from '../src/modules/jayje-portal/billing.js';
import { createReferrals } from '../src/modules/jayje-portal/referrals.js';
import { createBooks,dayOf,documentParts,money,paymentLabel } from '../src/modules/jayje-portal/books.js';
import { documentPdf } from '../src/modules/jayje-portal/pdf.js';

let pg,db,books,referrals,legacy,legacyBilling,service,billing,admin,alice,bob,carol,client,other,friend;
const sessions=new Map(),keys=new Map(),intents=new Map(),charges=new Map(),refundLists=new Map(),disputes=new Map();
const seconds=iso=>Math.floor(Date.parse(iso)/1000);
const daysAgo=n=>dayOf(new Date(Date.now()-n*86400000));
const stripe={
  checkout:{sessions:{
    async create(params,options){let id=keys.get(options.idempotencyKey);if(!id){id=`cs_test_${randomUUID()}`;keys.set(options.idempotencyKey,id);sessions.set(id,{id,mode:'payment',status:'open',payment_status:'unpaid',metadata:params.metadata,amount_total:params.line_items[0].price_data.unit_amount,currency:'usd',url:'https://checkout.stripe.com/c/pay/test',payment_intent:`pi_${randomUUID()}`});}return structuredClone(sessions.get(id));},
    async retrieve(id){if(!sessions.has(id))throw new Error('unknown session');return structuredClone(sessions.get(id));},
    async expire(id){const s=sessions.get(id);if(s?.status!=='open')throw new Error('session is not open');s.status='expired';return structuredClone(s);},
  }},
  paymentIntents:{async retrieve(id){if(!intents.has(id))throw new Error('unknown intent');return structuredClone(intents.get(id));}},
  charges:{async retrieve(id){if(!charges.has(id))throw new Error('unknown charge');return structuredClone(charges.get(id));}},
  refunds:{async list({charge}){return {data:structuredClone(refundLists.get(charge)||[])};}},
  disputes:{async retrieve(id){return structuredClone(disputes.get(id));}},
};
// Stripe takes the card payment for a Checkout: the session is paid and its charge carries the fee.
function pay(sessionId,{fee=350,at='2026-09-15T15:00:00Z'}={}) {
  const session=sessions.get(sessionId),chargeId=`ch_${randomUUID()}`;
  Object.assign(session,{status:'complete',payment_status:'paid'});
  intents.set(session.payment_intent,{id:session.payment_intent,metadata:session.metadata,latest_charge:{id:chargeId,created:seconds(at),balance_transaction:{fee}}});
  charges.set(chargeId,{id:chargeId,payment_intent:session.payment_intent,amount_refunded:0,refunded:false,disputed:false});
  return {session,chargeId};
}
const webhook=(type,object,id=`evt_${randomUUID()}`)=>billing.event({id,type,created:seconds('2026-09-20T15:00:00Z'),data:{object}});

before(async()=>{
  pg=new PGlite();await pg.waitReady;
  db=knex({client:'pg',connection:{},pool:{min:0,max:1}});
  db.client.acquireRawConnection=async()=>({query(config,callback){
    pg.query(config.text,config.values).then(result=>callback(null,{rows:result.rows,rowCount:result.affectedRows,command:config.text.trim().split(/\s/)[0].toUpperCase()}),callback);
  }});
  db.client.destroyRawConnection=async()=>{};
  await db.schema.createTable('users',t=>{t.uuid('id').primary();t.text('email').unique();});
  await db.schema.createTable('admin_audit_log',t=>{t.uuid('id').primary();t.uuid('admin_user_id');t.text('admin_email');t.text('action');t.text('resource_type');t.text('resource_id');t.jsonb('metadata');t.timestamp('created_at',{useTz:true}).defaultTo(db.fn.now());});
  await up(db);await requestsUp(db);await referralsUp(db);await booksUp(db);
  books=createBooks({db});referrals=createReferrals({db,siteUrl:'https://jayje.com'});
  // The portal as it ran before the books, to leave history for the books to open from.
  legacy=createPortalService(db,referrals);legacyBilling=createPortalBilling({db,stripe,service:legacy,siteUrl:'https://jayje.com',referrals});
  service=createPortalService(db,referrals,books);billing=createPortalBilling({db,stripe,service,siteUrl:'https://jayje.com',referrals,books});
  admin={sub:randomUUID(),email:'owner@example.com',role:'admin',ip:'203.0.113.9'};
  alice={sub:randomUUID(),email:'alice@example.com',role:'client'};bob={sub:randomUUID(),email:'bob@example.com',role:'client'};carol={sub:randomUUID(),email:'carol@example.com',role:'client'};
  await db('users').insert([admin,alice,bob,carol].map(a=>({id:a.sub,email:a.email})));
  client=await legacy.createClient(admin,{name:'Alice Example',email:'alice@example.com'});
  other=await legacy.createClient(admin,{name:'Bob Example',email:'bob@example.com'});
  await legacy.ensureClient(alice);await legacy.ensureClient(bob);
});
after(async()=>{if(db){await booksDown(db);await referralsDown(db);await requestsDown(db);await down(db);await db.destroy();}await pg?.close();});

const input=(overrides={})=>({client_id:client.id,kind:'invoice',title:'Lighting installation',items:[{description:'Install fixtures',quantity_milli:2000,unit_cents:10000}],tax_bps:600,...overrides});
async function invoice(overrides={},portal=service){const d=await portal.createDocument(admin,input(overrides));return portal.action(admin,d.id,'issue');}
// What the journal holds for a document, as each account's net (debits minus credits).
async function balances(documentId) {
  const rows=await db('jayje_journal_lines').where({document_id:documentId}).select('account').sum({debit:'debit_cents',credit:'credit_cents'}).groupBy('account');
  return Object.fromEntries(rows.map(row=>[row.account,Number(row.debit)-Number(row.credit)]).filter(([,net])=>net!==0).sort());
}
const entries=documentId=>db('jayje_journal_entries').where({document_id:documentId}).orderBy('seq').select('id','kind','part','reverses','source',db.raw("to_char(entry_date,'YYYY-MM-DD') AS date"));
const activity=(action,documentId)=>db('jayje_activity').where({action,...(documentId?{document_id:documentId}:{})}).orderBy('seq');
async function paidByStripe(overrides={},options={}) {
  const d=await invoice(overrides);await billing.checkout(alice,d.id);
  const attempt=await db('jayje_checkout_attempts').where({invoice_id:d.id}).first();
  const {session,chargeId}=pay(attempt.stripe_session_id,options);
  await webhook('checkout.session.completed',{id:session.id,metadata:session.metadata});
  return {d,session,chargeId};
}

test('the books open from what the portal already holds, once',async()=>{
  const issued=await invoice({title:'Porch light'},legacy);
  const paid=await invoice({title:'Kitchen lights'},legacy);
  await legacyBilling.checkout(alice,paid.id);
  const attempt=await db('jayje_checkout_attempts').where({invoice_id:paid.id}).first();
  const {session}=pay(attempt.stripe_session_id,{fee:610});
  await legacyBilling.reconcile(sessions.get(session.id),{fee:610,chargedAt:new Date('2026-09-15T15:00:00Z')});
  assert.equal(await db('jayje_activity').count({n:'*'}).first().then(r=>Number(r.n)),0);

  // A malformed row cannot stop the books from opening.
  await db('admin_audit_log').insert({id:randomUUID(),admin_user_id:admin.sub,admin_email:'owner@example.com',action:'jayje.document_issue',resource_type:'jayje',resource_id:'not-a-uuid',metadata:{}});
  await books.ensureOpened();await books.ensureOpened();
  const copied=await db('jayje_activity').where('action','like','audit.%').orderBy('at');
  assert.deepEqual(copied.map(row=>row.action).slice(0,2),['audit.client_created','audit.client_created']);
  assert.ok(copied.some(row=>row.action==='audit.document_issue' && row.document_id===paid.id && row.email==='owner@example.com'));
  assert.ok(copied.some(row=>row.action==='audit.document_issue' && row.document_id===null),'the malformed row is copied without a document');
  assert.equal((await activity('stripe.paid',paid.id)).length,1);
  assert.deepEqual((await entries(issued.id)).map(e=>[e.part,e.source]),[['issue','opening']]);
  assert.deepEqual((await entries(paid.id)).map(e=>e.part),['issue','payment','fee']);
  assert.equal((await entries(paid.id)).find(e=>e.part==='payment').date,'2026-09-15');
  assert.deepEqual(await balances(paid.id),{1200:21200-610,2200:-1200,4000:-20000,6100:610});
  const check=await books.check();
  assert.equal(check.balanced,true);assert.equal(check.debits,check.credits);assert.deepEqual(check.problems,[]);
  assert.equal(await db('jayje_books_meta').where({key:'opened'}).count({n:'*'}).first().then(r=>Number(r.n)),1);
});

test('a Stripe payment posts with its fee, refunds post each on its own day, and repeats post nothing',async()=>{
  const {d,chargeId}=await paidByStripe();
  const payment=await db('jayje_payments').where({invoice_id:d.id}).first();
  assert.equal(payment.fee_cents,350);assert.equal(new Date(payment.charged_at).toISOString(),'2026-09-15T15:00:00.000Z');
  assert.deepEqual(await balances(d.id),{1200:21200-350,2200:-1200,4000:-20000,6100:350});
  const [paid]=await activity('stripe.paid',d.id);
  assert.equal(paid.actor,'stripe');assert.equal(paid.summary,`Stripe payment of $212.00 for ${d.reference}, Stripe fee $3.50`);
  assert.ok(await db('jayje_activity').where({action:'stripe.checkout',document_id:d.id,actor:'client',email:'alice@example.com'}).first());
  const count=(await entries(d.id)).length;
  const session=sessions.get((await db('jayje_checkout_attempts').where({invoice_id:d.id}).first()).stripe_session_id);
  await webhook('checkout.session.completed',{id:session.id,metadata:session.metadata},'evt_repeat');
  await webhook('checkout.session.completed',{id:session.id,metadata:session.metadata},'evt_repeat');
  assert.equal((await entries(d.id)).length,count);
  assert.ok(await db('jayje_stripe_events').where({id:'evt_repeat',type:'checkout.session.completed'}).first());

  Object.assign(charges.get(chargeId),{amount_refunded:5000});
  refundLists.set(chargeId,[{id:'re_first',amount:5000,status:'succeeded',created:seconds('2026-09-18T14:00:00Z')}]);
  await webhook('charge.refunded',{id:chargeId});await webhook('charge.refunded',{id:chargeId});
  Object.assign(charges.get(chargeId),{amount_refunded:21200,refunded:true});
  refundLists.set(chargeId,[...refundLists.get(chargeId),{id:'re_rest',amount:16200,status:'succeeded',created:seconds('2026-09-19T14:00:00Z')}]);
  await webhook('charge.refunded',{id:chargeId});
  assert.equal((await db('jayje_payments').where({invoice_id:d.id}).first()).status,'refunded');
  assert.deepEqual((await db('jayje_payment_refunds').where({payment_id:payment.id}).orderBy('refunded_at')).map(r=>[r.id,r.amount_cents]),[['re_first',5000],['re_rest',16200]]);
  assert.deepEqual((await entries(d.id)).filter(e=>e.kind==='refund').map(e=>e.date),['2026-09-18','2026-09-19']);
  assert.equal((await activity('stripe.refunded',d.id)).length,2);
  assert.deepEqual(await balances(d.id),{1200:-350,2200:-1200,4000:-20000,4200:21200,6100:350});

  // A refund Stripe could not make comes back off the books.
  refundLists.set(chargeId,[refundLists.get(chargeId)[0],{...refundLists.get(chargeId)[1],status:'failed'}]);
  Object.assign(charges.get(chargeId),{amount_refunded:5000,refunded:false});
  await webhook('charge.refund.updated',{id:'re_rest',charge:chargeId});
  assert.equal((await db('jayje_payment_refunds').where({id:'re_rest'}).first()).status,'failed');
  assert.equal((await activity('stripe.refund_failed',d.id)).length,1);
  assert.equal((await balances(d.id))[4200],5000);
  assert.equal((await books.check()).balanced,true);
});

test('a dispute holds the money until it closes; a win returns it and a loss is written off',async()=>{
  const won=await paidByStripe();
  disputes.set('dp_won',{id:'dp_won',charge:won.chargeId,status:'needs_response',created:seconds('2026-09-21T15:00:00Z'),balance_transactions:[{amount:-21200,fee:1500,created:seconds('2026-09-21T15:00:00Z')}]});
  await webhook('charge.dispute.created',{id:'dp_won',charge:won.chargeId});
  assert.equal((await db('jayje_payments').where({invoice_id:won.d.id}).first()).status,'disputed');
  assert.deepEqual(await balances(won.d.id),{1200:21200-350-21200-1500,1250:21200,2200:-1200,4000:-20000,6100:350,6200:1500});
  assert.equal((await books.report({clientId:client.id})).summary.disputed>=21200,true);
  disputes.get('dp_won').status='won';
  disputes.get('dp_won').balance_transactions.push({amount:21200,fee:-1500,created:seconds('2026-09-25T15:00:00Z')});
  await webhook('charge.dispute.closed',{id:'dp_won',charge:won.chargeId});
  assert.deepEqual(await balances(won.d.id),{1200:21200-350,2200:-1200,4000:-20000,6100:350});
  assert.equal((await entries(won.d.id)).find(e=>e.part==='dispute-close').date,'2026-09-25');
  assert.deepEqual((await activity('stripe.dispute',won.d.id)).map(a=>a.summary),[
    `A dispute opened on ${won.d.reference}; Stripe is holding $212.00 and charged a $15.00 fee`,`Won the dispute on ${won.d.reference}; Stripe returned $212.00`]);

  const lost=await paidByStripe();
  disputes.set('dp_lost',{id:'dp_lost',charge:lost.chargeId,status:'under_review',created:seconds('2026-09-21T15:00:00Z'),balance_transactions:[{amount:-21200,fee:1500,created:seconds('2026-09-21T15:00:00Z')}]});
  await webhook('charge.dispute.created',{id:'dp_lost',charge:lost.chargeId});
  disputes.get('dp_lost').status='lost';
  await webhook('charge.dispute.closed',{id:'dp_lost',charge:lost.chargeId});
  assert.deepEqual(await balances(lost.d.id),{1200:21200-350-21200-1500,2200:-1200,4000:-20000,6100:350,6200:21200+1500});
  assert.equal((await books.check()).balanced,true);
});

test('payments outside Stripe are recorded, corrected and removed by the admin only',async()=>{
  const d=await invoice();
  await assert.rejects(billing.recordPayment(alice,d.id,{method:'check',paid_on:daysAgo(3)}),{publicCode:'admin_required'});
  await assert.rejects(billing.recordPayment(admin,d.id,{method:'other',paid_on:daysAgo(3)}));
  await assert.rejects(billing.recordPayment(admin,d.id,{method:'check',paid_on:daysAgo(-2)}));
  await assert.rejects(billing.recordPayment(admin,d.id,{method:'check',paid_on:'2026-02-30'}));
  const {document,payment}=await billing.recordPayment(admin,d.id,{method:'check',reference:'1042',paid_on:daysAgo(8)});
  assert.equal(document.status,'paid');assert.equal(dayOf(document.paid_at),daysAgo(8));
  assert.deepEqual([payment.source,payment.method,payment.reference,payment.recorded_by,payment.stripe_session_id],['manual','check','1042',admin.sub,null]);
  assert.equal(paymentLabel(payment),'Check 1042');
  assert.deepEqual(await balances(d.id),{1300:21200,2200:-1200,4000:-20000});
  assert.equal((await entries(d.id)).find(e=>e.part==='payment').date,daysAgo(8));
  const [recorded]=await activity('payment.recorded',d.id);
  assert.equal(recorded.email,'owner@example.com');assert.equal(recorded.ip,'203.0.113.9');assert.match(recorded.summary,/^Recorded a Check 1042 payment of \$212\.00 for JJ-INV-/);
  await assert.rejects(billing.recordPayment(admin,d.id,{method:'cash',paid_on:daysAgo(1)}),{publicCode:'invoice_not_payable'});

  await billing.correctPayment(admin,d.id,{method:'zelle',paid_on:daysAgo(7)});
  const moved=await entries(d.id);
  assert.equal(moved.filter(e=>e.part==='payment' && !e.reverses).length,2);
  assert.equal(moved.find(e=>e.kind==='reversal').date,daysAgo(8));
  assert.deepEqual(await balances(d.id),{1300:21200,2200:-1200,4000:-20000});
  assert.match((await activity('payment.corrected',d.id))[0].summary,/Check 1042, .* → Zelle, /);

  await billing.removePayment(admin,d.id);
  assert.equal((await db('jayje_documents').where({id:d.id}).first()).status,'sent');
  assert.equal(await db('jayje_payments').where({invoice_id:d.id}).first(),undefined);
  assert.deepEqual(await balances(d.id),{1100:21200,2200:-1200,4000:-20000});
  assert.equal((await activity('payment.removed',d.id)).length,1);
  // Open again, the client can pay it by card.
  assert.match((await billing.checkout(alice,d.id)).url,/^https:\/\/checkout\.stripe\.com\//);

  const card=await paidByStripe();
  await assert.rejects(billing.correctPayment(admin,card.d.id,{method:'cash',paid_on:daysAgo(1)}),{publicCode:'stripe_payment_not_editable'});
  await assert.rejects(billing.removePayment(admin,card.d.id),{publicCode:'stripe_payment_not_editable'});
  assert.equal((await books.check()).balanced,true);
});

test('recording a payment closes the open Checkout; a card payment made first stands',async()=>{
  const open=await invoice();await billing.checkout(alice,open.id);
  const attempt=await db('jayje_checkout_attempts').where({invoice_id:open.id}).first();
  await billing.recordPayment(admin,open.id,{method:'cash',paid_on:daysAgo(1)});
  assert.equal(sessions.get(attempt.stripe_session_id).status,'expired');
  assert.equal((await db('jayje_checkout_attempts').where({id:attempt.id}).first()).status,'expired');
  assert.equal((await activity('stripe.expired',open.id)).length,1);

  const raced=await invoice();await billing.checkout(alice,raced.id);
  const racedAttempt=await db('jayje_checkout_attempts').where({invoice_id:raced.id}).first();
  pay(racedAttempt.stripe_session_id);
  await assert.rejects(billing.recordPayment(admin,raced.id,{method:'cash',paid_on:daysAgo(1)}),{publicCode:'invoice_not_payable'});
  assert.equal((await db('jayje_payments').where({invoice_id:raced.id}).first()).source,'stripe');
  assert.equal((await books.check()).balanced,true);
});

test('money Stripe took that no invoice can take is kept as unapplied, once',async()=>{
  const {d}=await paidByStripe();
  const [attempt]=await db('jayje_checkout_attempts').insert({id:randomUUID(),invoice_id:d.id,status:'open',amount_cents:d.total_cents,currency:'usd',expires_at:new Date(Date.now()+3600000),stripe_session_id:`cs_test_${randomUUID()}`}).returning('*');
  sessions.set(attempt.stripe_session_id,{id:attempt.stripe_session_id,mode:'payment',status:'complete',payment_status:'paid',amount_total:d.total_cents,currency:'usd',payment_intent:`pi_${randomUUID()}`,metadata:{jayje_invoice_id:d.id,jayje_attempt_id:attempt.id}});
  const before=(await books.report()).summary.unapplied;
  for(let i=0;i<2;i++) await assert.rejects(webhook('checkout.session.completed',{id:attempt.stripe_session_id,metadata:{jayje_invoice_id:d.id}}),{publicCode:'duplicate_invoice_payment'});
  assert.equal(await db('jayje_journal_entries').where({kind:'unapplied',external_id:attempt.stripe_session_id}).count({n:'*'}).first().then(r=>Number(r.n)),1);
  assert.equal((await books.report()).summary.unapplied-before,d.total_cents);
  assert.equal((await activity('stripe.unapplied',d.id)).length,1);
  assert.equal((await books.check()).balanced,true);
});

test('a refund of money no invoice could take comes out of Unapplied payments, once, and the webhook succeeds',async()=>{
  const {d}=await paidByStripe();
  const [attempt]=await db('jayje_checkout_attempts').insert({id:randomUUID(),invoice_id:d.id,status:'open',amount_cents:d.total_cents,currency:'usd',expires_at:new Date(Date.now()+3600000),stripe_session_id:`cs_test_${randomUUID()}`}).returning('*');
  const pi=`pi_${randomUUID()}`,chargeId=`ch_${randomUUID()}`;
  sessions.set(attempt.stripe_session_id,{id:attempt.stripe_session_id,mode:'payment',status:'complete',payment_status:'paid',amount_total:d.total_cents,currency:'usd',payment_intent:pi,metadata:{jayje_invoice_id:d.id,jayje_attempt_id:attempt.id}});
  await assert.rejects(webhook('checkout.session.completed',{id:attempt.stripe_session_id,metadata:{jayje_invoice_id:d.id}}),{publicCode:'duplicate_invoice_payment'});
  const before=(await books.report()).summary.unapplied;
  intents.set(pi,{id:pi,metadata:{jayje_invoice_id:d.id,jayje_attempt_id:attempt.id}});
  charges.set(chargeId,{id:chargeId,payment_intent:pi,amount_refunded:d.total_cents,refunded:true,disputed:false});
  refundLists.set(chargeId,[{id:`re_${randomUUID()}`,amount:d.total_cents,status:'succeeded',created:seconds('2026-09-22T15:00:00Z')}]);
  await webhook('charge.refunded',{id:chargeId},'evt_unapplied_refund');
  await webhook('charge.refunded',{id:chargeId});
  assert.equal(before-(await books.report()).summary.unapplied,d.total_cents,'the refund comes out of Unapplied payments');
  assert.equal(await db('jayje_journal_entries').where({kind:'unapplied-refund'}).count({n:'*'}).first().then(r=>Number(r.n)),1);
  assert.equal((await activity('stripe.refunded',d.id)).length,1);
  assert.equal((await activity('stripe.refunded',d.id))[0].summary,`Refunded $212.00 of a payment for ${d.reference} that was not applied to it`);
  assert.ok(await db('jayje_stripe_events').where({id:'evt_unapplied_refund'}).first());
  assert.equal((await db('jayje_payments').where({invoice_id:d.id}).first()).status,'paid','the invoice keeps its own payment');
  assert.equal((await books.check()).balanced,true);
});

test('referral discounts and credits: counted as discounts, withdrawn with a removed payment unless spent',async()=>{
  const referrer=await service.createClient(admin,{name:'Carol Referrer',email:'carol@example.com'});
  friend=await service.createClient(admin,{name:'Dana Friend',email:'dana@example.com'});
  await referrals.claim(friend,{code:await referrals.codeFor(referrer.id)});
  const d=await invoice({client_id:friend.id,items:[{description:'Fix the fence',quantity_milli:1000,unit_cents:20000,category:'handyman'}]});
  assert.equal(d.discount_cents,1000);
  assert.deepEqual(documentParts(d).issue.lines,[['1100',d.total_cents,0],['4100',1000,0],['4000',0,20000],['2200',0,d.tax_cents]]);
  await billing.recordPayment(admin,d.id,{method:'venmo',paid_on:daysAgo(2)});
  assert.equal((await books.report({clientId:referrer.id})).summary.creditsAvailable,1000);
  assert.equal((await books.report({clientId:friend.id})).summary.discounts,1000);

  await billing.removePayment(admin,d.id);
  assert.equal((await books.report({clientId:referrer.id})).summary.creditsAvailable,0);
  assert.equal((await db('jayje_referrals').where({referred_client_id:friend.id}).first()).status,'joined');

  await billing.recordPayment(admin,d.id,{method:'venmo',paid_on:daysAgo(2)});
  const credit=await db('jayje_referral_credits').where({client_id:referrer.id,status:'available'}).first();
  const spent=await service.createDocument(admin,input({client_id:referrer.id,apply_credit_ids:[credit.id]}));
  assert.equal(spent.discount_cents,1000);
  await assert.rejects(billing.removePayment(admin,d.id),{publicCode:'referral_credit_in_use'});
  assert.equal((await db('jayje_payments').where({invoice_id:d.id}).first()).method,'venmo');
});

test('voiding reverses an invoice; the check finds what is missing and corrections post it',async()=>{
  const d=await invoice();
  await service.action(admin,d.id,'void');
  assert.deepEqual(await balances(d.id),{});
  assert.deepEqual((await entries(d.id)).map(e=>e.kind),['issue','reversal']);
  assert.equal((await activity('invoice.voided',d.id)).length,1);

  const missed=await invoice();
  await db('jayje_journal_entries').where({document_id:missed.id}).delete();
  const check=await books.check();
  assert.equal(check.balanced,false);assert.deepEqual(check.problems.map(p=>[p.reference,p.parts]),[[missed.reference,['issue']]]);
  assert.ok((await books.correct(admin))>=1);
  assert.equal((await books.check()).balanced,true);
  const [corrected]=await activity('books.corrected');
  assert.equal(corrected.email,'owner@example.com');assert.match(corrected.summary,new RegExp(missed.reference));
  assert.equal(await books.correct(admin),0);
});

test('the report adds up by client and date, and keeps the running amount owed',async()=>{
  const d=await invoice({client_id:other.id});
  await billing.recordPayment(admin,d.id,{method:'cash',paid_on:daysAgo(5)});
  const one=await books.report({clientId:other.id});
  assert.ok(one.entries.length>=2 && one.entries.every(e=>e.clientId===other.id));
  assert.ok(one.activity.length && one.activity.every(a=>a.clientId===other.id));
  assert.equal(one.summary.outstanding,0);
  const until=await books.report({clientId:other.id,to:daysAgo(5)});
  assert.deepEqual(until.entries.map(e=>e.kind),['payment']);
  assert.equal(until.entries[0].owed,-21200);assert.equal(until.summary.received,21200);
  const from=await books.report({clientId:other.id,from:dayOf(new Date())});
  assert.equal(from.entries.at(-1).owed,0);assert.equal(from.summary.invoiced,21200);assert.equal(from.summary.received,0);
  const all=await books.report();
  assert.equal(all.check.balanced,true);
  assert.equal(all.accounts.reduce((sum,a)=>sum+a.debit,0),all.accounts.reduce((sum,a)=>sum+a.credit,0));
  assert.ok(all.clients.some(c=>c.id===other.id));
  assert.equal(money(-1234),'-$12.34');
});

test('clients never see Stripe fees or who recorded a payment; receipts name the method',async()=>{
  const {d}=await paidByStripe();
  const seen=(await service.clientDetail(alice,client.id)).payments.find(p=>p.invoice_id===d.id);
  assert.equal('fee_cents' in seen,false);assert.equal('recorded_by' in seen,false);
  assert.equal((await service.clientDetail(admin,client.id)).payments.find(p=>p.invoice_id===d.id).fee_cents,350);
  const synced=await billing.sync(alice,d.id);
  assert.equal('fee_cents' in synced.payment,false);
  const cash=await invoice();const {payment}=await billing.recordPayment(admin,cash.id,{method:'money_order',reference:'MO-9',paid_on:daysAgo(1)});
  const pdf=await documentPdf(await db('jayje_documents').where({id:cash.id}).first(),payment);
  assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
  const message=await service.sendMessage(alice,client.id,{body:'Thanks!',request_key:randomUUID()});
  assert.ok(message.id);
  assert.equal((await activity('message.sent')).filter(a=>a.client_id===client.id).at(-1).summary,'Alice Example sent a message');
});
