import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const fail = (status, code) => Object.assign(new Error(code),{status,publicCode:code});
export const isoDate = value => value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10);
export const clientSchema = z.object({email:z.string().trim().email().max(254).transform(s=>s.toLowerCase()),name:z.string().trim().min(1).max(160),phone:z.string().trim().max(40).default(''),address:z.string().trim().max(1000).default('')}).strict();
export const documentSchema = z.object({client_id:z.string().uuid(),kind:z.enum(['quote','invoice']),title:z.string().trim().min(1).max(180),
  items:z.array(z.object({description:z.string().trim().min(1).max(500),quantity_milli:z.number().int().min(1).max(1000000),unit_cents:z.number().int().min(0).max(99999999)}).strict()).min(1).max(40),
  tax_bps:z.number().int().min(0).max(10000).default(0),notes:z.string().trim().max(5000).default(''),
  due_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s).nullable().default(null)}).strict();
export function totals(items,taxBps) {
  const lines=items.map(item=>({...item,total_cents:Number((BigInt(item.quantity_milli)*BigInt(item.unit_cents)+500n)/1000n)}));
  const subtotal=lines.reduce((n,item)=>n+item.total_cents,0);
  const tax=Number((BigInt(subtotal)*BigInt(taxBps)+5000n)/10000n);
  if(!Number.isSafeInteger(subtotal+tax) || subtotal+tax<50 || subtotal+tax>99999999) throw fail(400,'invoice_amount_out_of_range');
  return {items:lines,subtotal_cents:subtotal,tax_cents:tax,total_cents:subtotal+tax};
}
export function createPortalService(db) {
  const ensureClient=async actor => {
    if(actor.role==='admin') return null;
    const email=actor.email.toLowerCase();
    await db('jayje_clients').insert({id:randomUUID(),email,name:email,user_id:actor.sub}).onConflict('email').ignore();
    // Only a verified shared account can claim its exact email address.
    await db('jayje_clients').where({email}).whereNull('user_id').update({user_id:actor.sub,updated_at:db.fn.now()});
    const row=await db('jayje_clients').where({user_id:actor.sub}).first();
    if(!row) throw fail(403,'client_account_mismatch');
    return row;
  };
  async function client(actor,id, database=db) {
    const q=database('jayje_clients').where({id});
    if(actor.role!=='admin') q.andWhere({user_id:actor.sub});
    const row=await q.first(); if(!row) throw fail(404,'client_not_found'); return row;
  }
  async function document(actor,id,database=db,{lock=false}={}) {
    const q=database('jayje_documents').where({id}); if(lock) q.forUpdate();
    const row=await q.first(); if(!row) throw fail(404,'document_not_found');
    await client(actor,row.client_id,database);
    if(actor.role!=='admin' && row.status==='draft') throw fail(404,'document_not_found');
    return row;
  }
  async function audit(trx,actor,action,id) {
    if(actor.role!=='admin') return;
    await trx('admin_audit_log').insert({id:randomUUID(),admin_user_id:actor.sub,admin_email:actor.email,action:`jayje.${action}`,resource_type:'jayje',resource_id:id,metadata:{}});
  }
  return {ensureClient,client,document,audit,
    async overview(actor) {
      const own=await ensureClient(actor);
      const clients=own?[own]:await db('jayje_clients').orderBy('updated_at','desc').limit(500);
      return {user:{email:actor.email,role:actor.role},clients};
    },
    async clientDetail(actor,id) {
      const row=await client(actor,id);
      const query=db('jayje_documents').where({client_id:id}).orderBy('created_at','desc');
      if(actor.role!=='admin') query.whereNot({status:'draft'});
      const documents=await query.limit(500);
      const payments=await db('jayje_payments').whereIn('invoice_id',documents.map(d=>d.id)).orderBy('paid_at','desc');
      return {client:row,documents,payments};
    },
    async createClient(actor,input) {
      const data=clientSchema.parse(input);
      return db.transaction(async trx=>{
        const existing=await trx('jayje_clients').where({email:data.email}).first();
        if(existing) throw fail(409,'client_already_exists');
        const [row]=await trx('jayje_clients').insert({id:randomUUID(),...data}).returning('*');
        await audit(trx,actor,'client_created',row.id);return row;
      });
    },
    async messages(actor,id,before) {
      await client(actor,id);
      const query=db('jayje_messages').where({client_id:id}).orderBy('created_at','desc').orderBy('id','desc').limit(100);
      if(before) {const cursor=await db('jayje_messages').where({id:before,client_id:id}).first();if(!cursor)throw fail(400,'invalid_cursor');query.whereRaw('(created_at, id) < (?, ?)',[cursor.created_at,cursor.id]);}
      const rows=await query;return {messages:rows.reverse(),has_more:rows.length===100};
    },
    async sendMessage(actor,id,input) {
      await client(actor,id);
      const {body,request_key}=z.object({body:z.string().trim().min(1).max(10000),request_key:z.string().uuid()}).strict().parse(input);
      const row={id:randomUUID(),client_id:id,sender_id:actor.sub,sender_role:actor.role,body,request_key};
      await db('jayje_messages').insert(row).onConflict(['sender_id','request_key']).ignore();
      const saved=await db('jayje_messages').where({sender_id:actor.sub,request_key}).first();
      if(saved.body!==body || saved.client_id!==id) throw fail(409,'request_key_conflict');
      await db('jayje_clients').where({id}).update({updated_at:db.fn.now()});return saved;
    },
    async createDocument(actor,input) {
      const data=documentSchema.parse(input); const amounts=totals(data.items,data.tax_bps);
      return db.transaction(async trx=>{
        const customer=await client(actor,data.client_id,trx);
        const [row]=await trx('jayje_documents').insert({id:randomUUID(),...data,...amounts,items:JSON.stringify(amounts.items),created_by:actor.sub,
          reference:`JJ-${data.kind==='quote'?'Q':'INV'}-${new Date().getUTCFullYear()}-${randomUUID().slice(0,8).toUpperCase()}`,
          customer:{name:customer.name,email:customer.email,address:customer.address,phone:customer.phone}}).returning('*');
        await audit(trx,actor,'document_created',row.id);return row;
      });
    },
    async action(actor,id,action) {
      return db.transaction(async trx=>{
        const row=await document(actor,id,trx,{lock:true});let status;
        if(action==='issue' && actor.role==='admin' && row.status==='draft') status='sent';
        else if(['accept','decline'].includes(action) && actor.role==='client' && row.kind==='quote' && row.status==='sent') {
          if(row.due_date && isoDate(row.due_date)<new Date().toISOString().slice(0,10))throw fail(409,'quote_expired');
          status=action==='accept'?'accepted':'declined';
        } else if(action==='void' && actor.role==='admin' && ['draft','sent','accepted','declined'].includes(row.status)) {
          const active=await trx('jayje_checkout_attempts').where({invoice_id:id}).whereIn('status',['creating','open','pending']).first();
          if(active) throw fail(409,'checkout_active_wait_for_expiry');status='void';
        } else if(action==='convert' && actor.role==='admin' && row.kind==='quote' && row.status==='accepted') {
          const existing=await trx('jayje_documents').where({source_quote_id:id}).first();if(existing)return existing;
          const {created_at,updated_at,issued_at,paid_at,...copy}=row;
          const [invoice]=await trx('jayje_documents').insert({...copy,id:randomUUID(),kind:'invoice',status:'draft',due_date:null,created_by:actor.sub,source_quote_id:id,
            reference:`JJ-INV-${new Date().getUTCFullYear()}-${randomUUID().slice(0,8).toUpperCase()}`,items:JSON.stringify(row.items)}).returning('*');
          await audit(trx,actor,'quote_converted',invoice.id);return invoice;
        } else throw fail(409,'document_action_unavailable');
        const [saved]=await trx('jayje_documents').where({id}).update({status,updated_at:trx.fn.now(),...(action==='issue'?{issued_at:trx.fn.now()}: {})}).returning('*');
        await audit(trx,actor,`document_${action}`,id);return saved;
      });
    },
  };
}
