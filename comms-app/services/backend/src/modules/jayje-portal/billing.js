import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail,paymentView } from './service.js';
import { dateText,dayOf,money,PAYMENT_METHODS,paymentLabel } from './books.js';

export function assertSessionMatches(session,attempt,invoice) {
  if(session.id!==attempt.stripe_session_id || session.mode!=='payment' ||
    session.metadata?.jayje_invoice_id!==invoice.id || session.metadata?.jayje_attempt_id!==attempt.id ||
    session.amount_total!==invoice.total_cents || session.amount_total!==attempt.amount_cents ||
    session.currency!==invoice.currency || session.currency!==attempt.currency) throw fail(409,'payment_verification_failed');
}

// A payment received outside Stripe (check, cash, Zelle): how it was paid, an optional reference
// such as a check number, and the day it came in, which cannot be in the future.
export const manualPaymentSchema=z.object({method:z.enum(Object.keys(PAYMENT_METHODS)),method_name:z.string().trim().max(60).default(''),
  reference:z.string().trim().max(80).default(''),
  paid_on:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s && s>='2000-01-01' && s<=dayOf(new Date()))}).strict()
  .refine(input=>input.method!=='other' || input.method_name);

// Stripe's fee and the charge time of a paid Checkout, for the books. A payment is still recorded
// without them when Stripe cannot say, and they are filled in when the payment is next reconciled.
async function chargeDetails(stripe,session) {
  const intentId=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
  if(!intentId || !stripe.paymentIntents?.retrieve) return null;
  try {
    const intent=await stripe.paymentIntents.retrieve(intentId,{expand:['latest_charge.balance_transaction']});
    const charge=intent?.latest_charge&&typeof intent.latest_charge==='object'?intent.latest_charge:null;
    const fee=charge?.balance_transaction&&typeof charge.balance_transaction==='object'?charge.balance_transaction.fee:null;
    return {fee:Number.isInteger(fee)&&fee>=0?fee:null,chargedAt:Number.isInteger(charge?.created)?new Date(charge.created*1000):null};
  } catch { return null; }
}

const fromSeconds=seconds=>Number.isInteger(seconds)?new Date(seconds*1000):null;
// A dispute as the books need it: what Stripe withdrew, its fee, any fee returned, and when it
// opened and closed. `at` is the event's time, for when Stripe gives none.
function disputeFields(dispute,payment,at) {
  const moves=Array.isArray(dispute.balance_transactions)?dispute.balance_transactions:[];
  const sum=pick=>moves.reduce((total,move)=>total+Math.max(Number(pick(move))||0,0),0);
  const closed=['won','lost','warning_closed'].includes(dispute.status);
  const reinstated=moves.filter(move=>Number(move.amount)>0 && Number.isInteger(move.created)).map(move=>move.created).sort((a,b)=>a-b).pop();
  return {dispute_id:dispute.id,dispute_status:dispute.status,dispute_amount_cents:sum(move=>-move.amount),
    dispute_fee_cents:sum(move=>move.fee),dispute_fee_returned_cents:sum(move=>-move.fee),
    dispute_opened_at:payment.dispute_opened_at||fromSeconds(dispute.created)||at,
    dispute_closed_at:closed?(payment.dispute_closed_at||fromSeconds(reinstated)||at):null};
}

// `books` (books.js) logs each payment event and keeps the invoice's entries in step; tests may
// leave it out. `stripe` is null when Stripe is not set up: payments received outside Stripe are
// still recorded.
export function createPortalBilling({db,stripe,service,siteUrl,referrals=null,books=null}) {
  async function reconcile(session,details=null) {
    const attemptId=session.metadata?.jayje_attempt_id;
    if(!attemptId || !/^[a-f0-9-]{36}$/i.test(attemptId)) return null;
    const found=await db('jayje_checkout_attempts').where({id:attemptId}).first();
    if(!found) throw fail(409,'payment_attempt_not_found');
    // A webhook can arrive before the create response is persisted. The signed
    // session metadata and stable idempotency key identify that reserved attempt.
    return db.transaction(async trx=>{
      const invoice=await trx('jayje_documents').where({id:found.invoice_id}).forUpdate().first();
      const attempt=await trx('jayje_checkout_attempts').where({id:attemptId}).forUpdate().first();
      if(!attempt.stripe_session_id) {
        await trx('jayje_checkout_attempts').where({id:attempt.id}).update({stripe_session_id:session.id});
        attempt.stripe_session_id=session.id;
      }
      assertSessionMatches(session,attempt,invoice);
      if(session.payment_status==='paid') {
        const paymentIntent=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
        if(!paymentIntent || invoice.kind!=='invoice' || !['sent','paid'].includes(invoice.status)) throw fail(409,'payment_verification_failed');
        const existing=await trx('jayje_payments').where({invoice_id:invoice.id}).first();
        if(existing && existing.stripe_session_id!==session.id) throw fail(409,'duplicate_invoice_payment');
        const [inserted]=await trx('jayje_payments').insert({id:randomUUID(),invoice_id:invoice.id,stripe_session_id:session.id,
          stripe_payment_intent_id:paymentIntent,amount_cents:invoice.total_cents,currency:invoice.currency,paid_at:trx.fn.now(),
          ...(details?{fee_cents:details.fee,charged_at:details.chargedAt}:{})}).onConflict('invoice_id').ignore().returning('*');
        await trx('jayje_documents').where({id:invoice.id}).whereNot({status:'paid'}).update({status:'paid',paid_at:trx.fn.now(),updated_at:trx.fn.now()});
        await trx('jayje_checkout_attempts').where({id:attempt.id}).update({status:'paid',updated_at:trx.fn.now()});
        // The friend's discount is now spent and the referrer earns their credit.
        await referrals?.settle(trx,invoice);
        if(inserted) {
          await books?.record(trx,{actor:'stripe',action:'stripe.paid',clientId:invoice.client_id,documentId:invoice.id,reference:invoice.reference,amountCents:inserted.amount_cents,
            summary:`Stripe payment of ${money(inserted.amount_cents)} for ${invoice.reference}${Number.isInteger(inserted.fee_cents)?`, Stripe fee ${money(inserted.fee_cents)}`:''}`,
            data:{session:session.id,paymentIntent},sync:[invoice.id]});
        } else if(existing && details && ((existing.fee_cents===null && details.fee!==null) || (existing.charged_at===null && details.chargedAt))) {
          // A payment first recorded without Stripe's fee or charge time gets them now.
          await trx('jayje_payments').where({id:existing.id}).update({fee_cents:existing.fee_cents??details.fee,charged_at:existing.charged_at??details.chargedAt,updated_at:trx.fn.now()});
          await books?.sync(trx,[invoice.id]);
        }
      } else if(attempt.status!=='paid') {
        const status=session.status==='expired'?'expired':session.status==='complete'?'pending':'open';
        await trx('jayje_checkout_attempts').where({id:attempt.id}).update({status,updated_at:trx.fn.now()});
        if(status!==attempt.status && ['expired','pending'].includes(status)) {
          await books?.record(trx,{actor:'stripe',action:status==='expired'?'stripe.expired':'stripe.processing',clientId:invoice.client_id,documentId:invoice.id,
            reference:invoice.reference,amountCents:invoice.total_cents,data:{session:session.id},
            summary:status==='expired'?`A Stripe Checkout for ${invoice.reference} closed unpaid`:`Bank payment started for ${invoice.reference}`});
        }
      }
      return trx('jayje_payments').where({invoice_id:invoice.id}).first();
    });
  }

  // Money Stripe took that no invoice can take (a second payment, or one that failed the checks) is
  // kept in the books as unapplied, once per Checkout, so nothing received goes unrecorded.
  async function recordUnapplied(session,why,details) {
    const amount=Number(session.amount_total||0);
    if(!books || !Number.isInteger(amount) || amount<=0) return;
    const invoice=/^[a-f0-9-]{36}$/i.test(session.metadata?.jayje_invoice_id||'')?await db('jayje_documents').where({id:session.metadata.jayje_invoice_id}).first():null;
    const ref=invoice?.reference||'an invoice';
    await books.record(null,{actor:'stripe',action:'stripe.unapplied',clientId:invoice?.client_id??null,documentId:invoice?.id??null,reference:invoice?.reference??null,amountCents:amount,
      summary:why==='duplicate_invoice_payment'?`Stripe took a second payment of ${money(amount)} for ${ref}, which was already paid`:`Stripe took ${money(amount)} for ${ref}, but it did not match the invoice`,
      data:{session:session.id,why},unapplied:{externalId:session.id,amountCents:amount,date:details?.chargedAt?dayOf(details.chargedAt):null,doc:invoice||null,clientId:invoice?.client_id??null,
        memo:`${invoice?.reference||'An invoice'} · payment not applied (refund it or apply it)`}});
  }

  // Reconciles a Checkout with its fee and charge time, which are read before the transaction and
  // only while the payment lacks them.
  async function settle(session) {
    let details=null;
    if(session.payment_status==='paid') {
      const known=await db('jayje_payments').where({stripe_session_id:session.id}).first();
      if(!known || known.fee_cents===null || known.charged_at===null) details=await chargeDetails(stripe,session);
    }
    try { return await reconcile(session,details); }
    catch(error) {
      if(session.payment_status==='paid' && ['duplicate_invoice_payment','payment_verification_failed'].includes(error?.publicCode)) await recordUnapplied(session,error.publicCode,details);
      throw error;
    }
  }

  async function checkout(actor,id) {
    await service.document(actor,id);
    if(actor.role!=='client') throw fail(403,'client_payment_required');
    // Reserve once under an invoice lock. Concurrent requests reuse the same
    // Stripe idempotency key; a network timeout never creates another charge.
    const {invoice,attempt}=await db.transaction(async trx=>{
      const invoice=await service.document(actor,id,trx,{lock:true});
      if(invoice.kind!=='invoice' || invoice.status!=='sent') throw fail(409,'invoice_not_payable');
      let attempt=await trx('jayje_checkout_attempts').where({invoice_id:id}).whereIn('status',['creating','open','pending']).first();
      if(!attempt) {
        [attempt]=await trx('jayje_checkout_attempts').insert({id:randomUUID(),invoice_id:id,status:'creating',amount_cents:invoice.total_cents,currency:invoice.currency,
          expires_at:new Date(Math.floor(Date.now()/1000)*1000+3600000)}).returning('*');
      }
      return {invoice,attempt};
    });
    let session;
    if(attempt.stripe_session_id) {
      session=await stripe.checkout.sessions.retrieve(attempt.stripe_session_id);
    } else {
      // Do not reuse an idempotency key after Stripe's retention window or
      // silently replace an ambiguous payment attempt. Admin can investigate.
      if(new Date(attempt.expires_at).getTime()<Date.now()+31*60000) throw fail(409,'payment_attempt_needs_review');
      const metadata={jayje_invoice_id:invoice.id,jayje_attempt_id:attempt.id};
      session=await stripe.checkout.sessions.create({mode:'payment',payment_method_types:['card'],customer_email:invoice.customer.email,
        line_items:[{price_data:{currency:invoice.currency,unit_amount:invoice.total_cents,product_data:{name:`JayJe invoice ${invoice.reference}`,description:invoice.title}},quantity:1}],
        metadata,payment_intent_data:{metadata},expires_at:Math.floor(new Date(attempt.expires_at).getTime()/1000),
        success_url:`${siteUrl}/account/?payment=return&invoice=${invoice.id}`,cancel_url:`${siteUrl}/account/?payment=cancel&invoice=${invoice.id}`,
      },{idempotencyKey:`jayje-invoice-${attempt.id}`});
      await books?.record(null,{...books.by(actor),action:'stripe.checkout',clientId:invoice.client_id,documentId:invoice.id,reference:invoice.reference,
        amountCents:invoice.total_cents,summary:`Opened Stripe Checkout to pay ${invoice.reference} (${money(invoice.total_cents)})`,data:{session:session.id}});
    }
    await settle(session);
    if(session.payment_status==='paid') return {paid:true};
    if(session.status==='expired') throw fail(409,'checkout_expired_try_again');
    if(session.status==='complete') return {pending:true};
    if(!session.url?.startsWith('https://checkout.stripe.com/')) throw fail(503,'checkout_unavailable');
    return {url:session.url};
  }
  async function sync(actor,id) {
    const invoice=await service.document(actor,id);
    if(invoice.kind!=='invoice') throw fail(400,'invoice_required');
    const attempts=await db('jayje_checkout_attempts').where({invoice_id:id}).whereIn('status',['creating','open','pending']).whereNotNull('stripe_session_id');
    for(const attempt of attempts) await settle(await stripe.checkout.sessions.retrieve(attempt.stripe_session_id));
    return {document:await service.document(actor,id),payment:paymentView(actor,await db('jayje_payments').where({invoice_id:id}).first()||null)};
  }

  // Each Stripe event handled is kept by id, for the record.
  const remember=async event=>{ if(event.id) await db('jayje_stripe_events').insert({id:String(event.id).slice(0,255),type:String(event.type).slice(0,80)}).onConflict('id').ignore(); };
  const refundsOf=async charge=>stripe.refunds?.list?(await stripe.refunds.list({charge:charge.id,limit:100})).data||[]:charge.refunds?.data||[];
  // A refund or dispute of money no invoice could take (kept as unapplied): its refunds come out of
  // Unapplied payments, once each, and a dispute is logged for the admin to follow in Stripe.
  async function notApplied(event,charge,attempt) {
    const invoice=await db('jayje_documents').where({id:attempt.invoice_id}).first();
    const ref=invoice?.reference||'an invoice';
    const who={actor:'stripe',clientId:invoice?.client_id??null,documentId:invoice?.id??null,reference:invoice?.reference??null};
    if(event.type.startsWith('charge.dispute.')) {
      if(['charge.dispute.created','charge.dispute.closed'].includes(event.type)) await books?.record(null,{...who,action:'stripe.dispute',data:{dispute:event.data.object.id},
        summary:`The dispute on a payment for ${ref} that was not applied to it is ${String(event.data.object.status||'open').replaceAll('_',' ')}; see the Stripe dashboard`});
      return;
    }
    for(const refund of await refundsOf(charge)) {
      if(!(refund.amount>0) || ['failed','canceled'].includes(refund.status)) continue;
      await books?.record(null,{...who,action:'stripe.refunded',amountCents:refund.amount,data:{refund:refund.id},
        summary:`Refunded ${money(refund.amount)} of a payment for ${ref} that was not applied to it`,
        unappliedRefund:{externalId:refund.id,amountCents:refund.amount,date:dayOf(fromSeconds(refund.created)||new Date()),doc:invoice||null,clientId:invoice?.client_id??null,
          memo:`${invoice?.reference||'An invoice'} · refund of a payment not applied to it`}});
    }
  }
  async function event(event) {
    const object=event.data.object;
    const at=fromSeconds(event.created)||new Date();
    if(event.type.startsWith('checkout.session.')) {
      if(!object.metadata?.jayje_invoice_id) return;
      const session=await stripe.checkout.sessions.retrieve(object.id);
      await settle(session);
      if(event.type==='checkout.session.async_payment_failed' && session.payment_status!=='paid') {
        const failed=await db('jayje_checkout_attempts').where({stripe_session_id:session.id}).whereNotIn('status',['paid','failed']).update({status:'failed',updated_at:db.fn.now()});
        const invoice=failed?await db('jayje_documents').where({id:session.metadata.jayje_invoice_id}).first():null;
        if(invoice) await books?.record(null,{actor:'stripe',action:'stripe.failed',clientId:invoice.client_id,documentId:invoice.id,reference:invoice.reference,
          amountCents:invoice.total_cents,summary:`Bank payment failed for ${invoice.reference}`,data:{session:session.id}});
      }
      return remember(event);
    }
    const refundEvent=event.type==='charge.refunded' || event.type==='charge.refund.updated';
    if(refundEvent || event.type.startsWith('charge.dispute.')) {
      const chargeId=event.type==='charge.refunded'?object.id:typeof object.charge==='string'?object.charge:object.charge?.id;
      if(!chargeId) return;
      const charge=await stripe.charges.retrieve(chargeId);
      const pi=typeof charge.payment_intent==='string'?charge.payment_intent:charge.payment_intent?.id;
      if(!pi) return;
      let payment=await db('jayje_payments').where({stripe_payment_intent_id:pi}).first();
      if(!payment) {
        const intent=await stripe.paymentIntents.retrieve(pi);
        if(!intent.metadata?.jayje_attempt_id) return;
        const attempt=await db('jayje_checkout_attempts').where({id:intent.metadata.jayje_attempt_id}).first();
        if(!attempt?.stripe_session_id) throw fail(409,'payment_not_recorded_yet');
        try { payment=await settle(await stripe.checkout.sessions.retrieve(attempt.stripe_session_id)); }
        catch(error) {
          if(!['duplicate_invoice_payment','payment_verification_failed'].includes(error?.publicCode)) throw error;
          await notApplied(event,charge,attempt);
          return remember(event);
        }
        if(!payment) throw fail(409,'payment_not_recorded_yet');
      }
      // A charge's `disputed` flag can remain true after the dispute is won.
      // Refund events must preserve the last resolved dispute state.
      let disputed=payment.status==='disputed',dispute=null;
      if(event.type.startsWith('charge.dispute.')) {
        dispute=await stripe.disputes.retrieve(object.id);
        disputed=!['won','warning_closed'].includes(dispute.status);
      }
      // Each refund is kept with its own time, so the books date it when it happened.
      const refunds=refundEvent?await refundsOf(charge):[];
      await db.transaction(async trx=>{
        const invoice=await trx('jayje_documents').where({id:payment.invoice_id}).first();
        const current=await trx('jayje_payments').where({id:payment.id}).forUpdate().first();
        const fields=dispute?disputeFields(dispute,current,at):null;
        await trx('jayje_payments').where({id:payment.id}).update({refunded_cents:charge.amount_refunded,
          status:disputed?'disputed':charge.refunded?'refunded':charge.amount_refunded>0?'partially_refunded':'paid',updated_at:trx.fn.now(),...(fields||{})});
        const known=new Map((await trx('jayje_payment_refunds').where({payment_id:payment.id})).map(row=>[row.id,row]));
        for(const refund of refunds) {
          const status=String(refund.status||'succeeded').slice(0,25),amount=Number(refund.amount);
          if(!refund.id || !Number.isInteger(amount)) continue;
          const saved=known.get(refund.id);
          if(saved) {
            if(saved.status===status) continue;
            await trx('jayje_payment_refunds').where({id:refund.id}).update({status,updated_at:trx.fn.now()});
            if(['failed','canceled'].includes(status)) await books?.record(trx,{actor:'stripe',action:'stripe.refund_failed',clientId:invoice.client_id,documentId:invoice.id,
              reference:invoice.reference,amountCents:amount,summary:`A refund of ${money(amount)} on ${invoice.reference} ${status==='canceled'?'was canceled':'failed'}`,data:{refund:refund.id},sync:[invoice.id]});
            continue;
          }
          await trx('jayje_payment_refunds').insert({id:String(refund.id).slice(0,255),payment_id:payment.id,amount_cents:amount,status,refunded_at:fromSeconds(refund.created)||at});
          await books?.record(trx,{actor:'stripe',action:'stripe.refunded',clientId:invoice.client_id,documentId:invoice.id,reference:invoice.reference,amountCents:amount,
            summary:`Refunded ${money(amount)} of ${invoice.reference} through Stripe`,data:{refund:refund.id},sync:[invoice.id]});
        }
        if(fields && dispute.status!==current.dispute_status) {
          const summary=dispute.status==='won'?`Won the dispute on ${invoice.reference}; Stripe returned ${money(fields.dispute_amount_cents)}`
            :dispute.status==='lost'?`Lost the dispute on ${invoice.reference} (${money(fields.dispute_amount_cents)})`
            :current.dispute_status?`The dispute on ${invoice.reference} is now ${dispute.status.replaceAll('_',' ')}`
            :`A dispute opened on ${invoice.reference}${fields.dispute_amount_cents?`; Stripe is holding ${money(fields.dispute_amount_cents)}`:''}${fields.dispute_fee_cents?` and charged a ${money(fields.dispute_fee_cents)} fee`:''}`;
          await books?.record(trx,{actor:'stripe',action:'stripe.dispute',clientId:invoice.client_id,documentId:invoice.id,reference:invoice.reference,
            amountCents:fields.dispute_amount_cents,summary,data:{dispute:dispute.id,status:dispute.status},sync:[invoice.id]});
        }
        // Anything the events above did not post (a refund's total, a dispute's status) posts here.
        await books?.sync(trx,[invoice.id]);
      });
      return remember(event);
    }
  }

  // ---------- Payments received outside Stripe ----------

  // Noon in Muskegon's winter time, so the day entered is the day in every season.
  const paidAtFor=day=>new Date(`${day}T17:00:00Z`);

  // The admin records a payment that did not go through Stripe, and the invoice is paid in full on
  // the day given. An open Checkout is closed first so the client cannot also pay by card; if
  // Stripe says it was paid meanwhile, that payment stands and this one is refused.
  async function recordPayment(actor,id,input) {
    if(actor.role!=='admin') throw fail(403,'admin_required');
    const entered=manualPaymentSchema.parse(input);
    const invoice=await service.document(actor,id);
    if(invoice.kind!=='invoice' || invoice.status!=='sent') throw fail(409,'invoice_not_payable');
    const active=await db('jayje_checkout_attempts').where({invoice_id:id}).whereIn('status',['creating','open','pending']);
    if(active.some(attempt=>attempt.status==='pending')) throw fail(409,'bank_payment_processing');
    for(const attempt of active) {
      if(!attempt.stripe_session_id) continue;
      if(!stripe) throw fail(503,'checkout_still_open');
      await stripe.checkout.sessions.expire(attempt.stripe_session_id).catch(()=>null);
      const session=await stripe.checkout.sessions.retrieve(attempt.stripe_session_id).catch(()=>null);
      if(!session) throw fail(503,'checkout_still_open');
      await settle(session);
      if(session.status==='open') throw fail(503,'checkout_still_open');
    }
    return db.transaction(async trx=>{
      const row=await service.document(actor,id,trx,{lock:true});
      if(row.status!=='sent') throw fail(409,'invoice_not_payable');
      if(await trx('jayje_checkout_attempts').where({invoice_id:id}).whereIn('status',['open','pending']).first()) throw fail(409,'checkout_still_open');
      await trx('jayje_checkout_attempts').where({invoice_id:id,status:'creating'}).update({status:'expired',updated_at:trx.fn.now()});
      const paidAt=paidAtFor(entered.paid_on);
      const [payment]=await trx('jayje_payments').insert({id:randomUUID(),invoice_id:id,source:'manual',method:entered.method,method_name:entered.method==='other'?entered.method_name:null,
        reference:entered.reference||null,recorded_by:actor.sub,amount_cents:row.total_cents,currency:row.currency,paid_at:paidAt}).returning('*');
      await trx('jayje_documents').where({id}).update({status:'paid',paid_at:paidAt,updated_at:trx.fn.now()});
      await referrals?.settle(trx,row);
      await books?.record(trx,{...books.by(actor),action:'payment.recorded',clientId:row.client_id,documentId:id,reference:row.reference,amountCents:payment.amount_cents,
        summary:`Recorded a ${paymentLabel(payment)} payment of ${money(payment.amount_cents)} for ${row.reference}, received ${dateText(entered.paid_on)}`,sync:[id]});
      return {document:await trx('jayje_documents').where({id}).first(),payment};
    });
  }

  // Corrects a payment recorded by hand: its method, reference or day. A Stripe payment keeps what
  // Stripe recorded.
  async function correctPayment(actor,id,input) {
    if(actor.role!=='admin') throw fail(403,'admin_required');
    const entered=manualPaymentSchema.parse(input);
    return db.transaction(async trx=>{
      const row=await service.document(actor,id,trx,{lock:true});
      const payment=await trx('jayje_payments').where({invoice_id:id}).forUpdate().first();
      if(!payment) throw fail(404,'payment_not_found');
      if(payment.source!=='manual') throw fail(409,'stripe_payment_not_editable');
      const paidAt=paidAtFor(entered.paid_on);
      const [updated]=await trx('jayje_payments').where({id:payment.id}).update({method:entered.method,method_name:entered.method==='other'?entered.method_name:null,
        reference:entered.reference||null,paid_at:paidAt,updated_at:trx.fn.now()}).returning('*');
      await trx('jayje_documents').where({id}).update({paid_at:paidAt,updated_at:trx.fn.now()});
      const was=`${paymentLabel(payment)}, ${dateText(dayOf(payment.paid_at))}`,now=`${paymentLabel(updated)}, ${dateText(entered.paid_on)}`;
      await books?.record(trx,{...books.by(actor),action:'payment.corrected',clientId:row.client_id,documentId:id,reference:row.reference,amountCents:updated.amount_cents,
        summary:was===now?`Saved the payment for ${row.reference} unchanged`:`Changed the payment for ${row.reference}: ${was} → ${now}`,sync:[id]});
      return {document:await trx('jayje_documents').where({id}).first(),payment:updated};
    });
  }

  // Removes a payment recorded by mistake, and the invoice is open for payment again. A referral
  // credit the payment earned is withdrawn; if the referrer has already used it, nothing changes.
  async function removePayment(actor,id) {
    if(actor.role!=='admin') throw fail(403,'admin_required');
    return db.transaction(async trx=>{
      const row=await service.document(actor,id,trx,{lock:true});
      const payment=await trx('jayje_payments').where({invoice_id:id}).forUpdate().first();
      if(!payment) throw fail(404,'payment_not_found');
      if(payment.source!=='manual') throw fail(409,'stripe_payment_not_editable');
      await referrals?.unsettle(trx,row);
      await trx('jayje_payments').where({id:payment.id}).delete();
      await trx('jayje_documents').where({id}).update({status:'sent',paid_at:null,updated_at:trx.fn.now()});
      await books?.record(trx,{...books.by(actor),action:'payment.removed',clientId:row.client_id,documentId:id,reference:row.reference,amountCents:payment.amount_cents,
        summary:`Removed the ${paymentLabel(payment)} payment of ${money(payment.amount_cents)} from ${row.reference}; it is open for payment again`,sync:[id],reason:'payment-removed'});
      return {document:await trx('jayje_documents').where({id}).first()};
    });
  }

  return {checkout,sync,event,reconcile,recordPayment,correctPayment,removePayment};
}
