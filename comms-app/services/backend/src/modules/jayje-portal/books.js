// JayJe's books: an activity log of everything done in the portal (admins by name, clients and
// Stripe), and a double-entry journal of its money that always balances. The admin's Books screen
// reads report() through GET /books. Tables: 20261002_create_jayje_books.js.
//
// Each invoice's entries follow its state. syncDocument compares what the journal holds for an
// invoice with what the invoice, its payment, refunds and dispute call for, and posts only the
// difference: a reversal of each part that no longer matches (on that part's own date) and the
// part as it is now. A repeated Stripe event posts nothing, and check() finds anything missed.
//   issue          Dr 1100 total, Dr 4100 discount / Cr 4000 subtotal, Cr 2200 tax     issue date
//   payment        Dr 1200 (Stripe) or 1300 (outside Stripe) / Cr 1100                 payment date
//   fee            Dr 6100 / Cr 1200, Stripe's fee                                      payment date
//   refund:<id>    Dr 4200 / Cr 1200, one part per refund                               refund date
//   dispute        Dr 1250 withdrawn, Dr 6200 Stripe's fee / Cr 1200                    opened
//   dispute-close  won: Dr 1200 / Cr 1250, a returned fee Dr 1200 / Cr 6200;
//                  lost: Dr 6200 / Cr 1250                                              closed
// Drafts, quotes and voided invoices post nothing. Money Stripe took that no invoice can take (a
// second payment, or one that fails the checks) is posted to 2100 Unapplied payments, once per
// Checkout, and a refund of such money comes out of it (Dr 2100 / Cr 1200), once per refund.
// Entries carry a source, an external id and labels, so the business bank account can
// join the journal later and be labeled and categorized against new accounts.
//
// Recording runs inside the caller's transaction, in a savepoint: when it works the action and its
// books commit together, and when it fails only the books roll back and the balance check shows
// what is missing.
import { randomUUID } from 'node:crypto';

export const TIME_ZONE='America/Detroit';
const A={receivable:'1100',stripe:'1200',disputed:'1250',received:'1300',unapplied:'2100',tax:'2200',sales:'4000',discounts:'4100',refunds:'4200',fees:'6100',disputes:'6200'};
const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
const n=value=>Number(value||0);

// The calendar day in Muskegon of a time, or a YYYY-MM-DD date as it is.
export function dayOf(value) {
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))) return String(value);
  const date=value instanceof Date?value:new Date(value||Date.now());
  return dayFormat.format(Number.isNaN(date.getTime())?new Date():date);
}
// A YYYY-MM-DD day as people read it: Jul 30, 2026.
export const dateText=day=>new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"});
export const money=cents=>`${n(cents)<0?'-':''}$${(Math.abs(n(cents))/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;

// ---------- What an invoice's books should hold ----------

export function documentParts(doc,payment=null,refunds=[]) {
  const parts={};
  if(!doc || doc.kind!=='invoice') return parts;
  if(['sent','paid'].includes(doc.status) && n(doc.total_cents)>0) {
    const lines=[[A.receivable,n(doc.total_cents),0]];
    if(n(doc.discount_cents)>0) lines.push([A.discounts,n(doc.discount_cents),0]);
    lines.push([A.sales,0,n(doc.subtotal_cents)]);
    if(n(doc.tax_cents)>0) lines.push([A.tax,0,n(doc.tax_cents)]);
    parts.issue={date:dayOf(doc.issued_at||doc.created_at),lines};
  }
  if(!payment || n(payment.amount_cents)<=0) return parts;
  const date=dayOf(payment.charged_at||payment.paid_at);
  parts.payment={date,lines:[[payment.source==='manual'?A.received:A.stripe,n(payment.amount_cents),0],[A.receivable,0,n(payment.amount_cents)]]};
  if(n(payment.fee_cents)>0) parts.fee={date,lines:[[A.fees,n(payment.fee_cents),0],[A.stripe,0,n(payment.fee_cents)]]};
  for(const refund of refunds) {
    if(n(refund.amount_cents)<=0 || ['failed','canceled'].includes(refund.status)) continue;
    parts[`refund:${refund.id}`]={date:dayOf(refund.refunded_at),lines:[[A.refunds,n(refund.amount_cents),0],[A.stripe,0,n(refund.amount_cents)]]};
  }
  const withdrawn=n(payment.dispute_amount_cents);
  if(payment.dispute_id && withdrawn>0 && payment.dispute_opened_at) {
    const fee=n(payment.dispute_fee_cents);
    parts.dispute={date:dayOf(payment.dispute_opened_at),lines:[[A.disputed,withdrawn,0],...(fee>0?[[A.disputes,fee,0]]:[]),[A.stripe,0,withdrawn+fee]]};
    if(payment.dispute_closed_at) {
      const returned=n(payment.dispute_fee_returned_cents);
      parts['dispute-close']={date:dayOf(payment.dispute_closed_at),lines:['won','warning_closed'].includes(payment.dispute_status)
        ?[[A.stripe,withdrawn+returned,0],[A.disputed,0,withdrawn],...(returned>0?[[A.disputes,0,returned]]:[])]
        :[[A.disputes,withdrawn,0],[A.disputed,0,withdrawn]]};
    }
  }
  return parts;
}

const partKind=part=>part.startsWith('refund:')?'refund':part;
const signature=part=>part?JSON.stringify([part.date,[...part.lines].sort((l,r)=>`${l}`.localeCompare(`${r}`))]):'';
const PART_NAMES={issue:'invoice',payment:'payment',fee:'Stripe fee',refund:'refund',dispute:'dispute','dispute-close':'dispute outcome'};

function memoFor(doc,part,{reversal=false,reason='',payment=null}={}) {
  const ref=doc?.reference||'An invoice';
  const kind=partKind(part);
  if(reversal) return `${ref} · ${PART_NAMES[kind]} ${({void:'voided','payment-removed':'removed',opening:'opening'})[reason]||'changed'}`;
  if(kind==='issue') return `${ref} · ${doc.title}`;
  if(kind==='fee') return `${ref} · Stripe fee`;
  if(kind==='refund') return `${ref} · refund`;
  if(kind==='dispute') return `${ref} · dispute opened`;
  if(kind==='dispute-close') return `${ref} · dispute ${['won','warning_closed'].includes(payment?.dispute_status)?'won':'lost'}`;
  return payment?.source==='manual'?`${ref} · paid by ${paymentLabel(payment)}`:`${ref} · paid online through Stripe`;
}

// ---------- Payments received outside Stripe ----------

export const PAYMENT_METHODS={check:'Check',cash:'Cash',zelle:'Zelle',venmo:'Venmo',cashapp:'Cash App',paypal:'PayPal',bank:'Bank transfer (ACH)',wire:'Wire transfer',card:'Credit or debit card',money_order:'Money order',other:'Other'};
export function paymentLabel(payment) {
  if(!payment) return '';
  if(payment.source!=='manual') return 'Stripe';
  const method=payment.method==='other'?(payment.method_name||'Other'):(PAYMENT_METHODS[payment.method]||'Payment');
  return payment.reference?`${method} ${payment.reference}`:method;
}

// ---------- The books ----------

export function createBooks({db}) {
  const data=value=>typeof value==='string'?JSON.parse(value):value;

  async function post(trx,{kind,part=null,reverses=null,date,memo,doc=null,clientId=null,lines,source,externalId=null,activityId=null}) {
    const debits=lines.reduce((sum,[,debit])=>sum+debit,0),credits=lines.reduce((sum,[,,credit])=>sum+credit,0);
    if(debits!==credits || debits<=0) throw new Error(`journal entry does not balance: ${debits} vs ${credits}`);
    const id=randomUUID(),client=doc?.client_id??clientId;
    const query=trx('jayje_journal_entries').insert({id,entry_date:date,kind,part,reverses,memo:String(memo).slice(0,300),client_id:client,document_id:doc?.id??null,
      document_reference:doc?.reference??null,source,external_id:externalId,activity_id:activityId});
    const inserted=await (externalId?query.onConflict(['kind','external_id']).ignore():query).returning('id');
    if(!inserted.length) return null;
    await trx('jayje_journal_lines').insert(lines.map(([account,debit,credit])=>({id:randomUUID(),entry_id:id,account,debit_cents:debit,credit_cents:credit,client_id:client,document_id:doc?.id??null})));
    return id;
  }

  // The parts the journal holds now for a document: postings not yet reversed, by part.
  async function heldParts(trx,documentId) {
    const {rows}=await trx.raw(`SELECT e.id, e.part, to_char(e.entry_date,'YYYY-MM-DD') AS entry_date, l.account, l.debit_cents, l.credit_cents
      FROM jayje_journal_entries e JOIN jayje_journal_lines l ON l.entry_id=e.id
      WHERE e.document_id=? AND e.part IS NOT NULL AND e.reverses IS NULL
        AND NOT EXISTS (SELECT 1 FROM jayje_journal_entries r WHERE r.reverses=e.id)
      ORDER BY e.seq, l.seq`,[documentId]);
    const entries=new Map();
    for(const row of rows) {
      if(!entries.has(row.id)) entries.set(row.id,{id:row.id,part:row.part,date:row.entry_date,lines:[]});
      entries.get(row.id).lines.push([row.account,n(row.debit_cents),n(row.credit_cents)]);
    }
    const held={};
    for(const entry of entries.values()) (held[entry.part]||=[]).push(entry);
    return held;
  }

  async function wantedFor(trx,doc) {
    const payment=doc.kind==='invoice'?await trx('jayje_payments').where({invoice_id:doc.id}).first():null;
    const refunds=payment?await trx('jayje_payment_refunds').where({payment_id:payment.id}):[];
    return {payment,parts:documentParts(doc,payment,refunds)};
  }

  const offParts=(held,wanted)=>[...new Set([...Object.keys(held),...Object.keys(wanted)])].filter(part=>{
    const have=held[part]||[],want=wanted[part]||null;
    return !(have.length===(want?1:0) && (!want || signature(have[0])===signature(want)));
  });

  // Brings one document's journal in line with its state (see the top of this file).
  async function syncDocument(trx,documentId,{reason='changed',source='portal',activityId=null}={}) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))',[`jayje-books:${documentId}`]);
    const doc=await trx('jayje_documents').where({id:documentId}).first();
    if(!doc) return 0;
    const [{payment,parts:wanted},held]=[await wantedFor(trx,doc),await heldParts(trx,documentId)];
    let posted=0;
    for(const part of offParts(held,wanted)) {
      for(const entry of held[part]||[]) {
        await post(trx,{kind:'reversal',part,reverses:entry.id,date:entry.date,doc,memo:memoFor(doc,part,{reversal:true,reason}),
          lines:entry.lines.map(([account,debit,credit])=>[account,credit,debit]),source,activityId});
        posted+=1;
      }
      if(wanted[part]) {
        await post(trx,{kind:partKind(part),part,date:wanted[part].date,doc,memo:memoFor(doc,part,{payment}),lines:wanted[part].lines,source,activityId});
        posted+=1;
      }
    }
    return posted;
  }

  async function insertActivity(trx,event) {
    const id=randomUUID();
    await trx('jayje_activity').insert({id,...(event.at?{at:event.at}:{}),actor:event.actor||'system',action:String(event.action).slice(0,48),
      user_id:event.userId??null,email:event.email?String(event.email).slice(0,254):null,client_id:event.clientId??null,document_id:event.documentId??null,
      document_reference:event.reference?String(event.reference).slice(0,40):null,amount_cents:Number.isInteger(event.amountCents)?event.amountCents:null,
      summary:String(event.summary||event.action).slice(0,500),ip:event.ip?String(event.ip).slice(0,64):null,data:JSON.stringify(event.data||{})});
    return id;
  }

  // Who did it, from a portal actor ({role, sub, email, ip}).
  const by=actor=>actor?{actor:actor.role==='admin'?'admin':'client',userId:actor.sub??null,email:actor.email??null,ip:actor.ip??null}:{actor:'system'};

  // Logs what happened and keeps the journal in step, inside the caller's transaction (a savepoint)
  // or its own. Never fails the action it follows.
  //   event: { actor, userId, email, ip, action, summary, clientId, documentId, reference,
  //            amountCents, data, sync: [document ids], reason,
  //            unapplied: { externalId, amountCents, date, clientId, doc, memo },
  //            unappliedRefund: { the same, for a refund of money no invoice took } }
  async function record(trx,event) {
    const work=async sp=>{
      // A repeated Stripe event for money no invoice can take was recorded the first time.
      if(event.unapplied && await sp('jayje_journal_entries').where({kind:'unapplied',external_id:event.unapplied.externalId}).first()) return;
      if(event.unappliedRefund && await sp('jayje_journal_entries').where({kind:'unapplied-refund',external_id:event.unappliedRefund.externalId}).first()) return;
      const activityId=await insertActivity(sp,event);
      for(const id of event.sync||[]) await syncDocument(sp,id,{reason:event.reason,source:event.actor==='stripe'?'stripe':'portal',activityId});
      if(event.unapplied) {
        const {externalId,amountCents,date,clientId,doc,memo}=event.unapplied;
        await post(sp,{kind:'unapplied',date:date||dayOf(new Date()),doc:doc||null,clientId,memo,externalId,lines:[[A.stripe,amountCents,0],[A.unapplied,0,amountCents]],source:'stripe',activityId});
      }
      if(event.unappliedRefund) {
        const {externalId,amountCents,date,clientId,doc,memo}=event.unappliedRefund;
        await post(sp,{kind:'unapplied-refund',date:date||dayOf(new Date()),doc:doc||null,clientId,memo,externalId,lines:[[A.unapplied,amountCents,0],[A.stripe,0,amountCents]],source:'stripe',activityId});
      }
    };
    try { await (trx?trx.transaction(work):db.transaction(work)); }
    catch(error) { console.error('[jayje-books] not recorded',JSON.stringify({action:event.action,error:error?.message||'Unknown error'})); }
  }

  // Re-syncs documents with no activity to log (Stripe's fee arriving on a payment already recorded).
  async function sync(trx,ids,{source='stripe'}={}) {
    try { await trx.transaction(async sp=>{ for(const id of ids) await syncDocument(sp,id,{source}); }); }
    catch(error) { console.error('[jayje-books] not synced',JSON.stringify({ids,error:error?.message||'Unknown error'})); }
  }

  // ---------- Opening ----------

  let opened=false;
  const isUuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value||''));
  const AUDIT_WORDS={client_created:'Added a client',document_created:'Created a document',quote_converted:'Made an invoice from a quote',document_issue:'Issued a document',
    document_void:'Voided a document',template_created:'Created a template',template_updated:'Changed a template',template_removed:'Deleted a template'};

  // The books start from what the portal already holds: the first time they are used, JayJe's
  // rows in admin_audit_log are copied into the activity log, each document's and payment's saved
  // times become its history (marked from records), and every invoice gets its opening entries.
  // History copies stop where the live log starts, so nothing is logged twice whatever came first.
  async function ensureOpened() {
    if(opened) return;
    await db.transaction(async trx=>{
      await trx.raw("SELECT pg_advisory_xact_lock(hashtext('jayje-books-open'))");
      if(await trx('jayje_books_meta').where({key:'opened'}).first()) return;
      const clients=new Map((await trx('jayje_clients').select('id','name')).map(row=>[row.id,row.name]));
      const live=(await trx('jayje_activity').min({at:'at'}).first())?.at;
      const before=at=>!live || new Date(at).getTime()<new Date(live).getTime();
      const audited=await trx('admin_audit_log').where('action','like','jayje.%').modify(q=>{if(live)q.where('created_at','<',live);}).orderBy('created_at');
      for(const row of audited) {
        const action=row.action.slice(6);
        // Only a well-formed id is looked up: one odd row must not stop the books from opening.
        const doc=['document_created','quote_converted','document_issue','document_void'].includes(action)&&isUuid(row.resource_id)?await trx('jayje_documents').where({id:row.resource_id}).first():null;
        await insertActivity(trx,{at:row.created_at,actor:'admin',action:`audit.${action}`.slice(0,48),userId:row.admin_user_id,email:row.admin_email,
          clientId:doc?.client_id??(action==='client_created'&&isUuid(row.resource_id)?row.resource_id:null),documentId:doc?.id??null,reference:doc?.reference??null,
          summary:`${AUDIT_WORDS[action]||action}${doc?` · ${doc.reference} · ${doc.title}`:action==='client_created'&&clients.get(row.resource_id)?` · ${clients.get(row.resource_id)}`:''}`,data:{fromRecords:true}});
      }
      const documents=await trx('jayje_documents').orderBy('created_at').orderBy('id');
      for(const doc of documents) {
        const payment=await trx('jayje_payments').where({invoice_id:doc.id}).first();
        const event=(at,actor,action,summary,amountCents)=>insertActivity(trx,{at,actor,action,clientId:doc.client_id,documentId:doc.id,reference:doc.reference,amountCents,summary,data:{fromRecords:true}});
        if((doc.status==='accepted'||doc.status==='declined') && before(doc.updated_at)) await event(doc.updated_at,'client',`quote.${doc.status}`,`${clients.get(doc.client_id)||'The client'} ${doc.status} ${doc.reference}`);
        if(payment && before(payment.paid_at)) await event(payment.paid_at,payment.source==='manual'?'admin':'stripe',payment.source==='manual'?'payment.recorded':'stripe.paid',
          payment.source==='manual'?`${paymentLabel(payment)} payment of ${money(payment.amount_cents)} for ${doc.reference}`:`Stripe payment of ${money(payment.amount_cents)} for ${doc.reference}`,n(payment.amount_cents));
        if(doc.kind==='invoice') await syncDocument(trx,doc.id,{reason:'opening',source:'opening'});
      }
      await trx('jayje_books_meta').insert({key:'opened',value:JSON.stringify({at:new Date().toISOString()})});
    });
    opened=true;
  }

  // ---------- Checking and correcting ----------

  async function check() {
    await ensureOpened();
    const totals=await db('jayje_journal_lines').sum({debits:'debit_cents',credits:'credit_cents'}).first();
    const problems=[];
    for(const doc of await db('jayje_documents').where({kind:'invoice'}).orderBy('created_at')) {
      const [{parts},held]=[await wantedFor(db,doc),await heldParts(db,doc.id)];
      const off=offParts(held,parts);
      if(off.length) problems.push({documentId:doc.id,reference:doc.reference,clientId:doc.client_id,parts:off.map(partKind)});
    }
    const debits=n(totals?.debits),credits=n(totals?.credits);
    return {balanced:debits===credits && !problems.length,debits,credits,problems};
  }

  async function correct(actor) {
    const {problems}=await check();
    if(!problems.length) return 0;
    let posted=0;
    await db.transaction(async trx=>{
      const activityId=await insertActivity(trx,{...by(actor),action:'books.corrected',summary:`Posted corrections for ${problems.map(problem=>problem.reference).join(', ')} to balance the books`});
      for(const problem of problems) posted+=await syncDocument(trx,problem.documentId,{activityId});
    });
    return posted;
  }

  // ---------- Reading ----------

  // The journal, account balances, activity and the balance check, for every client or one, over a
  // date range (inclusive, YYYY-MM-DD). The Books screen draws this and builds its downloads from it.
  async function report({clientId='',from='',to=''}={}) {
    const check_=await check();
    const [accounts,entryRows,lineRows,clientRows,credits,activityRows]=await Promise.all([
      db('jayje_accounts').orderBy('sort').select('code','name','type'),
      db('jayje_journal_entries').select('id','seq',db.raw("to_char(entry_date,'YYYY-MM-DD') AS entry_date"),'recorded_at','kind','part','memo','client_id','document_id','document_reference','source','external_id').orderBy([{column:'entry_date'},{column:'seq'}]),
      db('jayje_journal_lines').select('entry_id','account','debit_cents','credit_cents','client_id').orderBy('seq'),
      db('jayje_clients').select('id','name').orderBy('name'),
      db('jayje_referral_credits').where({status:'available'}).modify(q=>{if(clientId)q.where({client_id:clientId});}).sum({cents:'amount_cents'}).first(),
      db('jayje_activity').modify(q=>{if(clientId)q.where({client_id:clientId});}).orderBy([{column:'at',order:'desc'},{column:'seq',order:'desc'}]).limit(5000)
        .select('id','at','actor','action','email','client_id','document_id','document_reference','amount_cents','summary','ip')
    ]);
    const names=new Map(accounts.map(account=>[account.code,account.name]));
    const clientNames=new Map(clientRows.map(row=>[row.id,row.name]));
    const linesByEntry=new Map();
    for(const line of lineRows) {
      if(clientId && line.client_id!==clientId) continue;
      if(!linesByEntry.has(line.entry_id)) linesByEntry.set(line.entry_id,[]);
      linesByEntry.get(line.entry_id).push({account:line.account,name:names.get(line.account)||'',debit:n(line.debit_cents),credit:n(line.credit_cents)});
    }
    const net=(lines,codes,sign=1)=>sign*lines.filter(line=>codes.includes(line.account)).reduce((sum,line)=>sum+line.debit-line.credit,0);
    const balances=new Map(accounts.map(account=>[account.code,{debit:0,credit:0}]));
    const summary={invoiced:0,received:0,fees:0,refunds:0,salesTax:0,discounts:0};
    let owed=0;
    const entries=[];
    for(const row of entryRows) {
      const lines=linesByEntry.get(row.id);
      if(!lines?.length || (to && row.entry_date>to)) continue;
      for(const line of lines) {
        const balance=balances.get(line.account)||{debit:0,credit:0};
        balance.debit+=line.debit;balance.credit+=line.credit;balances.set(line.account,balance);
      }
      const kind=row.part?partKind(row.part):row.kind;
      const change={
        billed:kind==='issue'?net(lines,[A.receivable]):0,
        received:net(lines,[A.stripe,A.received]),
        owed:net(lines,[A.receivable])
      };
      if(from && row.entry_date<from) { owed+=change.owed; continue; }
      summary.invoiced+=change.billed;
      summary.received+=kind==='payment'||row.kind==='unapplied'?change.received:0;
      summary.fees+=net(lines,[A.fees]);
      summary.refunds+=net(lines,[A.refunds])+(row.kind==='unapplied-refund'?net(lines,[A.unapplied]):0);
      summary.salesTax+=net(lines,[A.tax],-1);
      summary.discounts+=net(lines,[A.discounts]);
      owed+=change.owed;
      entries.push({id:row.id,date:row.entry_date,recordedAt:new Date(row.recorded_at).toISOString(),kind:row.kind,part:row.part,memo:row.memo,
        clientId:row.client_id,clientName:clientNames.get(row.client_id)||'',documentId:row.document_id,reference:row.document_reference||'',
        source:row.source,externalId:row.external_id||'',lines,billed:change.billed,received:change.received,owed});
    }
    const balanceOf=code=>{const b=balances.get(code)||{debit:0,credit:0};return b.debit-b.credit;};
    const inRange=row=>{const day=dayOf(row.at);return (!from||day>=from)&&(!to||day<=to);};
    return {
      filters:{client:clientId,from,to},
      check:check_,
      summary:{...summary,outstanding:balanceOf(A.receivable),unapplied:-balanceOf(A.unapplied),disputed:balanceOf(A.disputed),stripeBalance:balanceOf(A.stripe),creditsAvailable:n(credits?.cents)},
      entries:entries.reverse(),
      accounts:accounts.map(account=>({...account,...balances.get(account.code)})),
      activity:activityRows.filter(inRange).map(row=>({id:row.id,at:new Date(row.at).toISOString(),actor:row.actor,action:row.action,email:row.email||'',
        clientId:row.client_id,clientName:clientNames.get(row.client_id)||'',documentId:row.document_id,reference:row.document_reference||'',
        amountCents:row.amount_cents===null||row.amount_cents===undefined?null:n(row.amount_cents),summary:row.summary,ip:row.ip||''})),
      clients:clientRows
    };
  }

  return {record,sync,syncDocument,ensureOpened,check,correct,report,by};
}
