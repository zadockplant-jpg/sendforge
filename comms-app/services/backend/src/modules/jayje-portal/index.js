import express from 'express';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import Stripe from 'stripe';
import { z } from 'zod';
import { db } from '../../config/db.js';
import { authRouter } from '../../routes/auth.routes.js';
import { adminRouter } from '../../routes/admin.routes.js';
import { verifyCustomerAccessToken,verifyAdminAccessToken,getCurrentCustomerAuthState,customerTokenMatchesUser,adminTokenMatchesUser } from '../../services/auth.service.js';
import { adminWritesEnabled } from '../../middleware/adminAuth.js';
import { secureEqual } from '../jayje/router.js';
import { createPortalService,fail } from './service.js';
import { createPortalBilling } from './billing.js';
import { createGoogleAuth,googleReady,allowedAdmin } from './google.js';
import { documentPdf } from './pdf.js';
import { createPortalState } from './state.js';

const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const service=createPortalService(db);
const stateStore=createPortalState(db);
const google=createGoogleAuth({db,stateStore});
let stripe;
function billing() {
  if(!process.env.STRIPE_SECRET_KEY || !process.env.JAYJE_STRIPE_WEBHOOK_SECRET)throw fail(503,'billing_unavailable');
  stripe ||= new Stripe(process.env.STRIPE_SECRET_KEY,{apiVersion:'2024-06-20',timeout:15000,maxNetworkRetries:1});
  return createPortalBilling({db,stripe,service,siteUrl:process.env.JAYJE_SITE_URL||'https://jayje.com'});
}
async function identity(req,required=true) {
  const token=req.get('Authorization')?.replace(/^Bearer /,'');
  if(!token){if(required)throw fail(401,'sign_in_required');return null;}
  let payload,role='client';
  try{payload=verifyCustomerAccessToken(token);}catch{try{payload=verifyAdminAccessToken(token);role='admin';}catch{throw fail(401,'session_expired');}}
  const user=await getCurrentCustomerAuthState(payload.sub);
  if(!(role==='admin'?adminTokenMatchesUser(payload,user):customerTokenMatchesUser(payload,user)))throw fail(401,'session_expired');
  if(role==='admin' && !allowedAdmin(user.email))throw fail(403,'admin_not_authorized');
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
  authRouter(req,res,next);
});
jayjePortalRouter.use('/admin/auth',(req,res,next)=>{
  if(req.method!=='POST'||!['/login','/verify'].includes(req.path))return res.status(404).json({error:'not_found'});
  req.url=`/auth${req.url}`;adminRouter(req,res,next);
});
jayjePortalRouter.post('/google/start',wrap(async(req,res)=>res.json(await google.start({origin:req.get('X-Jayje-Origin'),mode:req.body?.mode,actor:await identity(req,false)}))));
jayjePortalRouter.post('/google/callback',wrap(async(req,res)=>res.json(await google.callback({...req.body,origin:req.get('X-Jayje-Origin'),actor:await identity(req,false)}))));
jayjePortalRouter.use(wrap(async(req,_res,next)=>{
  req.actor=await identity(req);
  if(req.actor.role==='admin' && !['GET','HEAD'].includes(req.method) && !adminWritesEnabled())throw fail(423,'admin_writes_disabled');
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
jayjePortalRouter.post('/documents',admin,wrap(async(req,res)=>res.status(201).json(await service.createDocument(req.actor,req.body))));
jayjePortalRouter.get('/documents/:id',wrap(async(req,res)=>res.json(await service.document(req.actor,req.params.id))));
jayjePortalRouter.post('/documents/:id/action',wrap(async(req,res)=>res.json(await service.action(req.actor,req.params.id,req.body?.action))));
jayjePortalRouter.post('/documents/:id/checkout',wrap(async(req,res)=>res.json(await billing().checkout(req.actor,req.params.id))));
jayjePortalRouter.post('/documents/:id/sync',wrap(async(req,res)=>res.json(await billing().sync(req.actor,req.params.id))));
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
