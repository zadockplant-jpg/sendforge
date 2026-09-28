import express from 'express';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import Stripe from 'stripe';
import { z } from 'zod';
import { db } from '../../config/db.js';
import { authRouter } from '../../routes/auth.routes.js';
import { verifyCustomerAccessToken,getCurrentCustomerAuthState,customerTokenMatchesUser } from '../../services/auth.service.js';
import { sendJayjeAdminCodeEmail } from '../../services/email.service.js';
import { adminWritesEnabled } from '../../middleware/adminAuth.js';
import { secureEqual } from '../jayje/router.js';
import { createPortalService,fail } from './service.js';
import { createJayjeAdminAuth,verifyJayjeAdminToken,isJayjeAdmin } from './admin-auth.js';
import { createPortalBilling } from './billing.js';
import { createGoogleAuth,googleReady } from './google.js';
import { documentPdf } from './pdf.js';
import { createPortalState } from './state.js';
import { createReferrals } from './referrals.js';
import { createInviteMailer } from './referral-mail.js';
import { createTemplates } from './templates.js';
import { createBooks } from './books.js';

const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const siteUrl=process.env.JAYJE_SITE_URL||'https://jayje.com';
const referrals=createReferrals({db,siteUrl,mail:createInviteMailer()});
// The books log everything done here and keep the journal (books.js); the admin reads them at GET /books.
const books=createBooks({db});
const service=createPortalService(db,referrals,books);
const TEMPLATE_WORDS={template_created:'Created',template_updated:'Changed',template_removed:'Deleted'};
const templates=createTemplates({db,audit:async(trx,actor,action,id)=>{
  await service.audit(trx,actor,action,id);
  const row=await trx('jayje_document_templates').where({id}).first();
  await books.record(trx,{...books.by(actor),action:action.replace('_','.'),summary:`${TEMPLATE_WORDS[action]||'Changed'} the ${row?.kind||''} template${row?.name?` "${row.name}"`:''}`.replace(/ +/g,' ')});
}});
const stateStore=createPortalState(db);
const google=createGoogleAuth({db,stateStore});
const adminAuth=createJayjeAdminAuth({db,sendCode:sendJayjeAdminCodeEmail});
let stripe;
const stripeReady=()=>Boolean(process.env.STRIPE_SECRET_KEY && process.env.JAYJE_STRIPE_WEBHOOK_SECRET);
// Payments received outside Stripe are recorded without it: billing({requireStripe:false}).
function billing({requireStripe=true}={}) {
  if(requireStripe && !stripeReady())throw fail(503,'billing_unavailable');
  if(stripeReady()) stripe ||= new Stripe(process.env.STRIPE_SECRET_KEY,{apiVersion:'2024-06-20',timeout:15000,maxNetworkRetries:1});
  return createPortalBilling({db,stripe:stripeReady()?stripe:null,service,siteUrl,referrals,books});
}
// The books open from the portal's records before anything new is logged. A failure is logged
// and retried on a later request; it never stops the portal.
const openBooks=()=>books.ensureOpened().catch(error=>console.error('[jayje-books] not opened',error?.message||'Unknown error'));
// Sign-ins go to the activity log with the visitor's address, and the client when there is one.
async function logSignIn(req,{actor,action,email,userId=null,summary}) {
  const address=String(email||'').trim().toLowerCase().slice(0,254);
  const client=address?await db('jayje_clients').where({email:address}).first().catch(()=>null):null;
  await books.record(null,{actor,action,email:address||null,userId,ip:req.ip,clientId:client?.id??null,summary});
}
const reason=error=>String(error?.publicCode||'refused').replaceAll('_',' ');
const challengeFor=async id=>z.string().uuid().safeParse(id).success?db('admin_mfa_codes').where({id}).first().catch(()=>null):null;
async function identity(req,required=true) {
  const token=req.get('Authorization')?.replace(/^Bearer /,'');
  if(!token){if(required)throw fail(401,'sign_in_required');return null;}
  let payload,role='client';
  // Only shared customer sessions and JayJe admin sessions are read here; a SendForge admin token is turned away.
  try{payload=verifyCustomerAccessToken(token);}catch{try{payload=verifyJayjeAdminToken(token);role='admin';}catch{throw fail(401,'session_expired');}}
  const user=await getCurrentCustomerAuthState(payload.sub);
  // Both roles are tied to the shared account state, so a password or auth_version change ends the session.
  if(!customerTokenMatchesUser(payload,user))throw fail(401,'session_expired');
  if(role==='admin' && !isJayjeAdmin(user.email))throw fail(403,'admin_not_authorized');
  return {...payload,sub:user.id,email:user.email,role};
}
export const jayjePortalRouter=express.Router();
jayjePortalRouter.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  if(process.env.JAYJE_PORTAL_ENABLED!=='true')return res.status(503).json({error:'portal_unavailable'});
  next();
});
// Dedicated signature and raw parser; this route never consumes SendForge events.
jayjePortalRouter.post('/stripe/webhook',express.raw({type:'application/json',limit:'256kb'}),wrap(async(req,res)=>{
  const handler=billing();let event;
  try{event=stripe.webhooks.constructEvent(req.body,req.get('stripe-signature'),process.env.JAYJE_STRIPE_WEBHOOK_SECRET);}catch{throw fail(400,'invalid_signature');}
  await openBooks();
  await handler.event(event);res.json({received:true});
}));
jayjePortalRouter.use(wrap(async(req,res,next)=>{
  const secret=process.env.JAYJE_PROXY_SECRET,origin=req.get('X-Jayje-Origin'),ip=req.get('X-Jayje-Client-Ip');
  const origins=(process.env.JAYJE_ALLOWED_ORIGINS||'https://jayje.com,https://www.jayje.com').split(',').map(s=>s.trim());
  if(!secret || secret.length<32 || !secureEqual(req.get('X-Jayje-Proxy-Key'),secret) || !origins.includes(origin) || !isIP(ip||''))throw fail(403,'forbidden');
  const authRequest=req.path.startsWith('/auth/')||req.path.startsWith('/admin/auth/')||req.path.startsWith('/google/');
  const key=createHash('sha256').update(`${secret}:${authRequest?'auth':'api'}:${ip}`).digest('hex');
  const count=await stateStore.rate(key);
  if(Number(count)>(authRequest?20:180))throw fail(429,'too_many_requests');
  // Existing login limiters receive the trusted visitor IP, never a browser header.
  Object.defineProperty(req,'ip',{value:ip,configurable:true});next();
}));
jayjePortalRouter.use(express.json({limit:'64kb',strict:true}));
jayjePortalRouter.get('/config',(_req,res)=>res.json({google:googleReady(),billing:Boolean(process.env.STRIPE_SECRET_KEY&&process.env.JAYJE_STRIPE_WEBHOOK_SECRET)}));
// Expose only these shared authentication operations, not the global admin API.
jayjePortalRouter.use('/auth',(req,res,next)=>{
  if(req.method!=='POST'||!['/login','/register','/forgot-password','/resend-verification','/reset-password'].includes(req.path))return res.status(404).json({error:'not_found'});
  req.body=Object.fromEntries(['email','password','token'].filter(k=>typeof req.body?.[k]==='string').map(k=>[k,req.body[k]]));
  if(['/login','/register'].includes(req.path)) {
    const email=req.body.email||'',path=req.path;
    res.on('finish',()=>{
      const ok=res.statusCode<300;
      if(path==='/register' && ok) void logSignIn(req,{actor:'client',action:'client.registered',email,summary:`${email} created an account`});
      else if(path==='/login' && ok) void logSignIn(req,{actor:'client',action:'client.signed_in',email,summary:`${email} signed in`});
      else if(path==='/login' && [401,403].includes(res.statusCode)) void logSignIn(req,{actor:'client',action:'client.sign_in_failed',email,summary:`Sign-in refused for ${email||'an unknown address'}`});
    });
  }
  authRouter(req,res,next);
});
// Per-account caps on top of the per-address bucket above: guesses at one admin email or one
// challenge are counted together wherever they come from, so a pool of addresses gains nothing.
const accountLimit=(scope,field,max)=>wrap(async(req,_res,next)=>{
  const value=typeof req.body?.[field]==='string'?req.body[field].trim().toLowerCase().slice(0,254):'';
  if(value && await stateStore.rate(createHash('sha256').update(`${process.env.JAYJE_PROXY_SECRET}:${scope}:${value}`).digest('hex'))>max)throw fail(429,'too_many_requests');
  next();
});
// JayJe's own admin sign-in: password, then a six-digit code mailed to the JayJe admin inbox. Nothing else under /admin exists here.
jayjePortalRouter.post('/admin/auth/login',accountLimit('admin-login','email',5),wrap(async(req,res)=>{
  const email=typeof req.body?.email==='string'?req.body.email:'';
  try {
    const result=await adminAuth.login(req.body);
    await logSignIn(req,{actor:'admin',action:'admin.code_sent',email,summary:`Admin password accepted for ${email}; sent a sign-in code to ${result.sentTo}`});
    res.json(result);
  } catch(error) {
    if([401,403].includes(error?.status)) await logSignIn(req,{actor:'admin',action:'admin.sign_in_failed',email,summary:`Admin sign-in refused for ${email||'an unknown address'} (${reason(error)})`});
    throw error;
  }
}));
jayjePortalRouter.post('/admin/auth/verify',accountLimit('admin-verify','challengeId',8),wrap(async(req,res)=>{
  const challenge=await challengeFor(req.body?.challengeId);
  try {
    const result=await adminAuth.verify(req.body);
    await logSignIn(req,{actor:'admin',action:'admin.signed_in',email:challenge?.email,userId:challenge?.user_id??null,summary:`${challenge?.email||'An admin'} signed in as admin`});
    res.json(result);
  } catch(error) {
    if([401,403,423].includes(error?.status)) await logSignIn(req,{actor:'admin',action:'admin.code_refused',email:challenge?.email,summary:`A sign-in code for ${challenge?.email||'an admin'} was refused (${reason(error)})`});
    throw error;
  }
}));
jayjePortalRouter.use('/admin/auth',(_req,res)=>res.status(404).json({error:'not_found'}));
jayjePortalRouter.post('/google/start',wrap(async(req,res)=>res.json(await google.start({origin:req.get('X-Jayje-Origin'),mode:req.body?.mode,actor:await identity(req,false)}))));
jayjePortalRouter.post('/google/callback',wrap(async(req,res)=>{
  const actor=await identity(req,false);
  const result=await google.callback({...req.body,origin:req.get('X-Jayje-Origin'),actor});
  if(result.linked) await logSignIn(req,{actor:'client',action:'client.google_linked',email:actor?.email,userId:actor?.sub??null,summary:`${actor?.email||'A client'} connected Google sign-in`});
  else if(result.challengeId) {
    const challenge=await challengeFor(result.challengeId);
    await logSignIn(req,{actor:'admin',action:'admin.code_sent',email:challenge?.email,userId:challenge?.user_id??null,summary:`Google confirmed ${challenge?.email||'an admin'}; sent a sign-in code to ${result.sentTo}`});
  } else if(result.token) {
    let email='';try{email=verifyCustomerAccessToken(result.token).email||'';}catch{/* logged without the address */}
    await logSignIn(req,{actor:'client',action:'client.signed_in',email,summary:`${email||'A client'} signed in with Google`});
  }
  res.json(result);
}));
jayjePortalRouter.use(wrap(async(req,_res,next)=>{
  req.actor={...await identity(req),ip:req.ip};
  if(req.actor.role==='admin' && !['GET','HEAD'].includes(req.method) && !adminWritesEnabled())throw fail(423,'admin_writes_disabled');
  await openBooks();
  next();
}));
jayjePortalRouter.param('id',(req,res,next,id)=>{if(!z.string().uuid().safeParse(id).success)return res.status(400).json({error:'invalid_id'});next();});
const admin=(req,_res,next)=>req.actor.role==='admin'?next():next(fail(403,'admin_required'));
jayjePortalRouter.get('/me',wrap(async(req,res)=>res.json(await service.overview(req.actor))));
jayjePortalRouter.post('/clients',admin,wrap(async(req,res)=>res.status(201).json(await service.createClient(req.actor,req.body))));
jayjePortalRouter.get('/clients/:id',wrap(async(req,res)=>res.json(await service.clientDetail(req.actor,req.params.id))));
jayjePortalRouter.get('/clients/:id/messages',wrap(async(req,res)=>{
  const before=req.query.before;if(before&&!z.string().uuid().safeParse(before).success)throw fail(400,'invalid_cursor');
  res.json(await service.messages(req.actor,req.params.id,before));
}));
jayjePortalRouter.post('/clients/:id/messages',wrap(async(req,res)=>res.status(201).json(await service.sendMessage(req.actor,req.params.id,req.body))));
// Referrals belong to the signed-in client; the admin reads them per client.
const asClient=async req=>{
  if(req.actor.role!=='client')throw fail(403,'client_account_required');
  return service.ensureClient(req.actor);
};
jayjePortalRouter.get('/referrals',wrap(async(req,res)=>res.json(await referrals.summary((await asClient(req)).id))));
jayjePortalRouter.post('/referrals/invite',wrap(async(req,res)=>{
  const client=await asClient(req);
  const row=await referrals.invite(client,req.body);
  await books.record(null,{...books.by(req.actor),action:'referral.invited',clientId:client.id,summary:`${client.name} invited ${row.invited_email} with a referral`});
  res.status(201).json(row);
}));
jayjePortalRouter.post('/referrals/claim',wrap(async(req,res)=>{
  const client=await asClient(req);
  const had=await db('jayje_referrals').where({referred_client_id:client.id}).first();
  const row=await referrals.claim(client,req.body);
  if(!had) {
    const referrer=await db('jayje_clients').where({id:row.referrer_client_id}).first();
    await books.record(null,{...books.by(req.actor),action:'referral.claimed',clientId:client.id,summary:`${client.name} joined with a referral from ${referrer?.name||'a client'}`});
  }
  res.json(row);
}));
// Saved quote and invoice templates belong to the business, not to one client.
jayjePortalRouter.get('/templates',admin,wrap(async(_req,res)=>res.json(await templates.list())));
jayjePortalRouter.post('/templates',admin,wrap(async(req,res)=>res.status(201).json(await templates.create(req.actor,req.body))));
jayjePortalRouter.post('/templates/:id',admin,wrap(async(req,res)=>res.json(await templates.update(req.actor,req.params.id,req.body))));
jayjePortalRouter.post('/templates/:id/delete',admin,wrap(async(req,res)=>res.json(await templates.remove(req.actor,req.params.id))));
jayjePortalRouter.post('/documents',admin,wrap(async(req,res)=>res.status(201).json(await service.createDocument(req.actor,req.body))));
jayjePortalRouter.get('/documents/:id',wrap(async(req,res)=>res.json(await service.document(req.actor,req.params.id))));
jayjePortalRouter.post('/documents/:id/action',wrap(async(req,res)=>res.json(await service.action(req.actor,req.params.id,req.body?.action))));
jayjePortalRouter.post('/documents/:id/checkout',wrap(async(req,res)=>res.json(await billing().checkout(req.actor,req.params.id))));
jayjePortalRouter.post('/documents/:id/sync',wrap(async(req,res)=>res.json(await billing().sync(req.actor,req.params.id))));
// Payments received outside Stripe (check, cash, Zelle): record, correct or remove.
jayjePortalRouter.post('/documents/:id/payment',admin,wrap(async(req,res)=>res.status(201).json(await billing({requireStripe:false}).recordPayment(req.actor,req.params.id,req.body))));
jayjePortalRouter.post('/documents/:id/payment/update',admin,wrap(async(req,res)=>res.json(await billing({requireStripe:false}).correctPayment(req.actor,req.params.id,req.body))));
jayjePortalRouter.post('/documents/:id/payment/remove',admin,wrap(async(req,res)=>res.json(await billing({requireStripe:false}).removePayment(req.actor,req.params.id))));
// The books: journal, account balances, activity and the balance check, for one client or all.
const day=z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/),z.literal('')]).default('');
const booksQuery=z.object({client:z.union([z.string().uuid(),z.literal('')]).default(''),from:day,to:day});
jayjePortalRouter.get('/books',admin,wrap(async(req,res)=>{
  const {client,from,to}=booksQuery.parse(req.query);
  res.json(await books.report({clientId:client,from,to}));
}));
jayjePortalRouter.post('/books/correct',admin,wrap(async(req,res)=>res.json({posted:await books.correct(req.actor),check:await books.check()})));
jayjePortalRouter.get('/documents/:id/pdf',wrap(async(req,res)=>{
  const invoice=await service.document(req.actor,req.params.id);
  let payment=null;
  if(req.query.receipt==='1'){payment=await db('jayje_payments').where({invoice_id:invoice.id}).first();if(!payment)throw fail(404,'receipt_not_found');}
  const pdf=await documentPdf(invoice,payment);
  res.set({'Content-Type':'application/pdf','Content-Disposition':`${req.query.download==='1'?'attachment':'inline'}; filename="${invoice.reference}${payment?'-receipt':''}.pdf"`}).send(pdf);
}));
jayjePortalRouter.use((_req,res)=>res.status(404).json({error:'not_found'}));
jayjePortalRouter.use((error,_req,res,_next)=>{
  if(error instanceof z.ZodError)return res.status(400).json({error:'invalid_request'});
  if(error.type==='entity.too.large')return res.status(413).json({error:'payload_too_large'});
  if(error.type==='entity.parse.failed')return res.status(400).json({error:'invalid_json'});
  if(error.code==='23505')return res.status(409).json({error:'record_already_exists'});
  if(!error.publicCode)console.error('[jayje-portal] request failed',error.code||error.type||'internal');
  res.status(error.publicCode?error.status:503).json({error:error.publicCode||'portal_temporarily_unavailable'});
});
