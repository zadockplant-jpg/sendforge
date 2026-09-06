import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import { PGlite } from '@electric-sql/pglite';
import { up,down } from '../src/db/migrations/20260907_create_jayje_portal.js';
import { createPortalService,documentSchema,totals } from '../src/modules/jayje-portal/service.js';
import { createPortalBilling,assertSessionMatches } from '../src/modules/jayje-portal/billing.js';
import { documentPdf } from '../src/modules/jayje-portal/pdf.js';

let pg,db,service,admin,alice,bob,client,other,stripe,billing;
const sessions=new Map(),keys=new Map();let calls=0;
before(async()=>{
  pg=new PGlite();await pg.waitReady;
  // Execute the production migration and repository SQL in PostgreSQL/WASM.
  // One actual PG connection mirrors a single-connection Knex test database.
  db=knex({client:'pg',connection:{},pool:{min:0,max:1}});
  db.client.acquireRawConnection=async()=>({query(config,callback){
    pg.query(config.text,config.values).then(result=>callback(null,{rows:result.rows,rowCount:result.affectedRows,command:config.text.trim().split(/\s/)[0].toUpperCase()}),callback);
  }});
  db.client.destroyRawConnection=async()=>{};
  await db.schema.createTable('users',t=>{t.uuid('id').primary();t.text('email').unique();});
  await db.schema.createTable('admin_audit_log',t=>{t.uuid('id').primary();t.uuid('admin_user_id');t.text('admin_email');t.text('action');t.text('resource_type');t.text('resource_id');t.jsonb('metadata');});
  await up(db);service=createPortalService(db);
  admin={sub:randomUUID(),email:'owner@example.com',role:'admin'};alice={sub:randomUUID(),email:'alice@example.com',role:'client'};bob={sub:randomUUID(),email:'bob@example.com',role:'client'};
  await db('users').insert([admin,alice,bob].map(a=>({id:a.sub,email:a.email})));
  client=await service.createClient(admin,{name:'Alice Example',email:'ALICE@example.com'});
  await service.ensureClient(alice);other=await service.ensureClient(bob);
  stripe={checkout:{sessions:{
    async create(params,options){calls++;let id=keys.get(options.idempotencyKey);if(!id){id=`cs_test_${randomUUID()}`;keys.set(options.idempotencyKey,id);sessions.set(id,{id,mode:'payment',status:'open',payment_status:'unpaid',metadata:params.metadata,amount_total:params.line_items[0].price_data.unit_amount,currency:'usd',url:'https://checkout.stripe.com/c/pay/test',payment_intent:`pi_${randomUUID()}`});}
      assert.equal(params.metadata.user_id,undefined);assert.equal(params.client_reference_id,undefined);assert.equal(params.customer,undefined);assert.equal(params.mode,'payment');return structuredClone(sessions.get(id));},
    async retrieve(id){if(!sessions.has(id))throw new Error('unknown session');return structuredClone(sessions.get(id));},
  }}};
  billing=createPortalBilling({db,stripe,service,siteUrl:'https://jayje.com'});
});
after(async()=>{if(db){await down(db);await db.destroy();}await pg?.close();});
const input=(overrides={})=>({client_id:client.id,kind:'invoice',title:'Lighting installation',items:[{description:'Install fixtures',quantity_milli:1500,unit_cents:12345}],tax_bps:600,notes:'Discuss placement before work.',...overrides});
async function invoice(){const d=await service.createDocument(admin,input());return service.action(admin,d.id,'issue');}

test('verified clients claim only their own email and cannot read another client, messages or documents',async()=>{
  assert.equal((await service.overview(alice)).clients[0].id,client.id);
  assert.equal((await service.overview(bob)).clients[0].id,other.id);
  await assert.rejects(service.clientDetail(bob,client.id),{publicCode:'client_not_found'});
  await assert.rejects(service.messages(bob,client.id),{publicCode:'client_not_found'});
  const d=await invoice();await assert.rejects(service.document(bob,d.id),{publicCode:'client_not_found'});
  await assert.rejects(billing.checkout(bob,d.id),{publicCode:'client_not_found'});
});
test('quotes and invoices use integer rounding and reject negative, malformed or excessive amounts',()=>{
  const result=totals([{description:'Work',quantity_milli:1500,unit_cents:12345}],600);
  assert.equal(result.subtotal_cents,18518);assert.equal(result.tax_cents,1111);assert.equal(result.total_cents,19629);
  assert.equal(documentSchema.safeParse(input({total_cents:1})).success,false);
  assert.equal(documentSchema.safeParse(input({items:[{description:'bad',quantity_milli:1000,unit_cents:-10}]})).success,false);
  assert.equal(documentSchema.safeParse(input({due_date:'2026-02-30'})).success,false);
  assert.throws(()=>totals([{quantity_milli:1000000,unit_cents:99999999}],10000),{publicCode:'invoice_amount_out_of_range'});
});
test('drafts stay private, clients cannot issue or void; accepted quotes convert to one invoice',async()=>{
  const quote=await service.createDocument(admin,input({kind:'quote'}));
  await assert.rejects(service.document(alice,quote.id),{publicCode:'document_not_found'});
  await service.action(admin,quote.id,'issue');
  await assert.rejects(service.action(alice,quote.id,'void'),{publicCode:'document_action_unavailable'});
  await assert.rejects(service.action(admin,quote.id,'accept'),{publicCode:'document_action_unavailable'});
  await service.action(alice,quote.id,'accept');
  const converted=await Promise.all([service.action(admin,quote.id,'convert'),service.action(admin,quote.id,'convert')]);
  assert.equal(converted[0].id,converted[1].id);assert.equal(converted[0].total_cents,quote.total_cents);assert.equal(converted[0].status,'draft');
});
test('both sides can message and retries preserve exactly one message without key substitution',async()=>{
  const data={body:'Can we use warm white fixtures?',request_key:randomUUID()};
  const all=await Promise.all([service.sendMessage(alice,client.id,data),service.sendMessage(alice,client.id,data)]);
  assert.equal(all[0].id,all[1].id);
  await service.sendMessage(admin,client.id,{body:'Yes, I will update the scope.',request_key:randomUUID()});
  const conversation=await service.messages(alice,client.id);assert.equal(conversation.messages.length,2);assert.equal(conversation.messages[1].sender_role,'admin');
  await assert.rejects(service.sendMessage(alice,client.id,{...data,body:'changed'}),{publicCode:'request_key_conflict'});
  await assert.rejects(service.sendMessage(bob,client.id,{body:'intrusion',request_key:randomUUID()}),{publicCode:'client_not_found'});
});
test('concurrent checkout requests reserve a single Stripe session and do not mark browser returns paid',async()=>{
  const d=await invoice(),beforeKeys=keys.size;
  const results=await Promise.all(Array.from({length:4},()=>billing.checkout(alice,d.id)));
  assert.ok(results.every(r=>r.url.startsWith('https://checkout.stripe.com/')));assert.equal(keys.size,beforeKeys+1);
  assert.equal((await db('jayje_checkout_attempts').where({invoice_id:d.id})).length,1);
  assert.equal((await billing.sync(alice,d.id)).document.status,'sent');
  assert.equal((await db('jayje_payments').where({invoice_id:d.id})).length,0);
  await assert.rejects(service.action(admin,d.id,'void'),{publicCode:'checkout_active_wait_for_expiry'});
});
test('verified paid session creates one permanent client receipt despite duplicate and reordered events',async()=>{
  const d=await invoice();await billing.checkout(alice,d.id);
  const a=await db('jayje_checkout_attempts').where({invoice_id:d.id}).first();
  const s=sessions.get(a.stripe_session_id);s.status='complete';s.payment_status='paid';
  await Promise.all(Array.from({length:3},()=>billing.event({type:'checkout.session.completed',data:{object:s}})));
  const payments=await db('jayje_payments').where({invoice_id:d.id});assert.equal(payments.length,1);assert.equal(payments[0].amount_cents,d.total_cents);
  assert.equal((await service.document(alice,d.id)).status,'paid');
  assert.ok((await service.clientDetail(alice,client.id)).payments.some(p=>p.invoice_id===d.id));
  await billing.reconcile({...s,status:'expired',payment_status:'unpaid'});
  assert.equal((await db('jayje_checkout_attempts').where({id:a.id}).first()).status,'paid');
  await assert.rejects(billing.checkout(alice,d.id),{publicCode:'invoice_not_payable'});
});
test('mismatched amount, currency, metadata and Stripe session IDs never create payment records',async()=>{
  const d=await invoice();await billing.checkout(alice,d.id);
  const a=await db('jayje_checkout_attempts').where({invoice_id:d.id}).first();const s=sessions.get(a.stripe_session_id);
  for(const change of [{amount_total:1},{currency:'eur'},{id:'cs_other'},{metadata:{...s.metadata,jayje_invoice_id:other.id}}])assert.throws(()=>assertSessionMatches({...s,...change},a,d),{publicCode:'payment_verification_failed'});
  await assert.rejects(billing.reconcile({...s,amount_total:1,payment_status:'paid'}),{publicCode:'payment_verification_failed'});
  assert.equal((await db('jayje_payments').where({invoice_id:d.id})).length,0);
});
test('Stripe timeouts retry the same reserved key; confirmed expiry permits exactly one new attempt',async()=>{
  const d=await invoice(),create=stripe.checkout.sessions.create;let once=true;
  stripe.checkout.sessions.create=async(...args)=>{const result=await create(...args);if(once){once=false;throw new Error('simulated connection loss after creation');}return result;};
  try{
    await assert.rejects(billing.checkout(alice,d.id));const size=keys.size;
    await billing.checkout(alice,d.id);assert.equal(keys.size,size);
    const a=await db('jayje_checkout_attempts').where({invoice_id:d.id}).first();sessions.get(a.stripe_session_id).status='expired';
    await assert.rejects(billing.checkout(alice,d.id),{publicCode:'checkout_expired_try_again'});
    await billing.checkout(alice,d.id);assert.equal(keys.size,size+1);
  }finally{stripe.checkout.sessions.create=create;}
});
test('expired ambiguous creation blocks replacement and refunds preserve the paid invoice history',async()=>{
  const d=await invoice();await db('jayje_checkout_attempts').insert({id:randomUUID(),invoice_id:d.id,status:'creating',amount_cents:d.total_cents,currency:'usd',expires_at:new Date(Date.now()-1000)});
  await assert.rejects(billing.checkout(alice,d.id),{publicCode:'payment_attempt_needs_review'});
  const paid=await db('jayje_payments').first();stripe.charges={retrieve:async()=>({id:'ch_refund',payment_intent:paid.stripe_payment_intent_id,amount_refunded:paid.amount_cents,refunded:true,disputed:false})};
  await billing.event({type:'charge.refunded',data:{object:{id:'ch_refund'}}});
  assert.equal((await db('jayje_payments').where({id:paid.id}).first()).status,'refunded');
  assert.equal((await db('jayje_documents').where({id:paid.invoice_id}).first()).status,'paid');
});
test('downloadable documents are valid PDFs including long multi-page scopes and payment receipts',async()=>{
  const paid=await db('jayje_payments').first(),d=await db('jayje_documents').where({id:paid.invoice_id}).first();
  const pdf=await documentPdf({...d,items:Array.from({length:40},(_,i)=>({...d.items[0],description:`Line ${i}: `+'Fixture placement and installation details. '.repeat(8)}))},paid);
  assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>5000);assert.match(pdf.toString('latin1'),/\/Type \/Pages/);
});
test('later refund events do not reopen a dispute that was won',async()=>{
  const d=await invoice();await billing.checkout(alice,d.id);
  const a=await db('jayje_checkout_attempts').where({invoice_id:d.id}).first();const s=sessions.get(a.stripe_session_id);s.payment_status='paid';s.status='complete';await billing.reconcile(s);
  const charge={id:'ch_won',payment_intent:s.payment_intent,amount_refunded:100,refunded:false,disputed:true};
  stripe.charges={retrieve:async()=>charge};stripe.disputes={retrieve:async()=>({status:'won'})};
  await billing.event({type:'charge.dispute.closed',data:{object:{id:'dp_won',charge:'ch_won'}}});
  await billing.event({type:'charge.refunded',data:{object:{id:'ch_won'}}});
  assert.equal((await db('jayje_payments').where({invoice_id:d.id}).first()).status,'partially_refunded');
});
