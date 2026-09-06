import { randomUUID } from 'node:crypto';
import { fail } from './service.js';

export function assertSessionMatches(session,attempt,invoice) {
  if(session.id!==attempt.stripe_session_id || session.mode!=='payment' ||
    session.metadata?.jayje_invoice_id!==invoice.id || session.metadata?.jayje_attempt_id!==attempt.id ||
    session.amount_total!==invoice.total_cents || session.amount_total!==attempt.amount_cents ||
    session.currency!==invoice.currency || session.currency!==attempt.currency) throw fail(409,'payment_verification_failed');
}
export function createPortalBilling({db,stripe,service,siteUrl}) {
  async function reconcile(session) {
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
        await trx('jayje_payments').insert({id:randomUUID(),invoice_id:invoice.id,stripe_session_id:session.id,
          stripe_payment_intent_id:paymentIntent,amount_cents:invoice.total_cents,currency:invoice.currency,paid_at:trx.fn.now()}).onConflict('invoice_id').ignore();
        await trx('jayje_documents').where({id:invoice.id}).whereNot({status:'paid'}).update({status:'paid',paid_at:trx.fn.now(),updated_at:trx.fn.now()});
        await trx('jayje_checkout_attempts').where({id:attempt.id}).update({status:'paid',updated_at:trx.fn.now()});
      } else if(attempt.status!=='paid') {
        const status=session.status==='expired'?'expired':session.status==='complete'?'pending':'open';
        await trx('jayje_checkout_attempts').where({id:attempt.id}).update({status,updated_at:trx.fn.now()});
      }
      return trx('jayje_payments').where({invoice_id:invoice.id}).first();
    });
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
    }
    await reconcile(session);
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
    for(const attempt of attempts) await reconcile(await stripe.checkout.sessions.retrieve(attempt.stripe_session_id));
    return {document:await service.document(actor,id),payment:await db('jayje_payments').where({invoice_id:id}).first()||null};
  }
  async function event(event) {
    const object=event.data.object;
    if(event.type.startsWith('checkout.session.')) {
      if(!object.metadata?.jayje_invoice_id) return;
      const session=await stripe.checkout.sessions.retrieve(object.id);
      await reconcile(session);
      if(event.type==='checkout.session.async_payment_failed' && session.payment_status!=='paid') {
        await db('jayje_checkout_attempts').where({stripe_session_id:session.id}).whereNot({status:'paid'}).update({status:'failed',updated_at:db.fn.now()});
      }
      return;
    }
    if(event.type==='charge.refunded' || event.type.startsWith('charge.dispute.')) {
      const charge=event.type==='charge.refunded'?await stripe.charges.retrieve(object.id):await stripe.charges.retrieve(typeof object.charge==='string'?object.charge:object.charge.id);
      const pi=typeof charge.payment_intent==='string'?charge.payment_intent:charge.payment_intent?.id;
      if(!pi) return;
      let payment=await db('jayje_payments').where({stripe_payment_intent_id:pi}).first();
      if(!payment) {
        const intent=await stripe.paymentIntents.retrieve(pi);
        if(!intent.metadata?.jayje_attempt_id) return;
        const attempt=await db('jayje_checkout_attempts').where({id:intent.metadata.jayje_attempt_id}).first();
        if(!attempt?.stripe_session_id) throw fail(409,'payment_not_recorded_yet');
        payment=await reconcile(await stripe.checkout.sessions.retrieve(attempt.stripe_session_id));
        if(!payment) throw fail(409,'payment_not_recorded_yet');
      }
      // A charge's `disputed` flag can remain true after the dispute is won.
      // Refund events must preserve the last resolved dispute state.
      let disputed=payment.status==='disputed';
      if(event.type.startsWith('charge.dispute.')) {
        const dispute=await stripe.disputes.retrieve(object.id);
        disputed=!['won','warning_closed'].includes(dispute.status);
      }
      await db('jayje_payments').where({id:payment.id}).update({refunded_cents:charge.amount_refunded,
        status:disputed?'disputed':charge.refunded?'refunded':charge.amount_refunded>0?'partially_refunded':'paid',updated_at:db.fn.now()});
    }
  }
  return {checkout,sync,event,reconcile};
}
