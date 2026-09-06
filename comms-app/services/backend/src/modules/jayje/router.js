import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { configReady, JAYJE_VERSION } from './config.js';
import { requestSchema, fieldErrors } from './validation.js';
import { acceptJayjeRequest } from './service.js';
export function secureEqual(a,b) {
 const hash = value=>createHash('sha256').update(String(value||'')).digest();
 return timingSafeEqual(hash(a),hash(b));
}
/** The trusted proxy is the JayJe Pages Function, not an arbitrary browser.
 * Only that Function has the shared secret and may forward the client IP.
 */
export function createJayjeRouter({getConfig,loadDependencies,logger=console}) {
 const router = express.Router();
 router.use((req,res,next)=>{
   res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   const config = getConfig();req.jayjeConfig = config;
   if(!configReady(config)) return res.status(503).json({ok:false,error:'service_unavailable'});
   if(!secureEqual(req.get('X-Jayje-Proxy-Key'),config.proxySecret)) return res.status(403).json({ok:false,error:'forbidden'});
   if(!config.origins.includes(req.get('X-Jayje-Origin'))) return res.status(403).json({ok:false,error:'forbidden'});
   return next();
 });
 router.get('/health',async(req,res)=>{
   try {
     const dependencies=await loadDependencies(req.jayjeConfig);
     if(!(await dependencies.repository.ready())) throw new Error('not_ready');
     if(dependencies.ping) await dependencies.ping();
     return res.json({ok:true,service:'jayje',version:JAYJE_VERSION});
   } catch { return res.status(503).json({ok:false,error:'service_unavailable'}); }
 });
 router.use('/requests',(req,res,next)=>{
   if(req.method!=='POST') return res.status(405).set('Allow','POST').json({ok:false,error:'method_not_allowed'});
   if(!req.is('application/json')) return res.status(415).json({ok:false,error:'json_required'});
   if(!isIP(req.get('X-Jayje-Client-Ip')||'')) return res.status(403).json({ok:false,error:'forbidden'});
   return next();
 });
 router.use(express.json({limit:'24kb',strict:true}));
 router.post('/requests',async(req,res)=>{
   const parsed=requestSchema.safeParse(req.body);
   if(!parsed.success) return res.status(400).json({ok:false,error:'invalid_request',fields:fieldErrors(parsed.error)});
   try {
     const dependencies=await loadDependencies(req.jayjeConfig);
     const allowed=await dependencies.rateLimit({ip:req.get('X-Jayje-Client-Ip'),email:parsed.data.email});
     if(!allowed) return res.status(429).set('Retry-After','3600').json({ok:false,error:'too_many_requests'});
     const result=await acceptJayjeRequest(parsed.data,{...dependencies,logger});
     return res.status(result.status).json(result.body);
   } catch(error) {
     if(error.status===409) return res.status(409).json({ok:false,error:'request_key_conflict'});
     logger.error('[jayje] request_storage_or_limit_unavailable');
     return res.status(503).json({ok:false,error:'service_unavailable'});
   }
 });
 router.use((_req,res)=>res.status(404).json({ok:false,error:'not_found'}));
 router.use((error,_req,res,_next)=>{
   if(error.type==='entity.too.large') return res.status(413).json({ok:false,error:'payload_too_large'});
   if(error instanceof SyntaxError || error.type==='entity.parse.failed') return res.status(400).json({ok:false,error:'invalid_json'});
   logger.error('[jayje] request_processing_failed');
   return res.status(500).json({ok:false,error:'request_failed'});
 });
 return router;
}
