import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import express from 'express';
import knex from 'knex';
import { getJayjeConfig, configReady, SERVICE_NAMES } from '../src/modules/jayje/config.js';
import { requestSchema, fieldErrors } from '../src/modules/jayje/validation.js';
import { acceptJayjeRequest, requestRecord } from '../src/modules/jayje/service.js';
import { notificationBody, sendJayjeNotification, JayjeMailError } from '../src/modules/jayje/notification.js';
import { createJayjeLimiter } from '../src/modules/jayje/rate-limit.js';
import { createJayjeRouter, secureEqual } from '../src/modules/jayje/router.js';
import { up } from '../src/db/migrations/20260906_create_jayje_service_requests.js';
const secret = 'unit-test-secret-'.repeat(4);
const environment = {JAYJE_ENABLED:'true',JAYJE_PROXY_SECRET:secret,JAYJE_CONTACT_TO_EMAIL:'inbox@example.com',JAYJE_FROM_EMAIL:'sender@example.com',SENDGRID_API_KEY:'test-not-a-key'};
const config = getJayjeConfig(environment);
const valid = changes=>({requestKey:randomUUID(),services:['hvac','plumbing'],name:'Test Customer',email:'customer@example.com',phone:'',contactMethod:'email',location:'Muskegon',timeframe:'month',message:'Please replace the kitchen light and inspect the drain.',consent:true,website:'',...changes});
const logger = {error(){}};
function fakeStore() {
 const rows = new Map();
 return {rows,
  async findByKey(key){return structuredClone([...rows.values()].find(row=>row.request_key===key));},
  async createOrGet(row){const existing=[...rows.values()].find(r=>r.request_key===row.request_key);if(existing)return{row:structuredClone(existing),created:false};const stored={...row,services:JSON.parse(row.services)};rows.set(row.id,stored);return{row:structuredClone(stored),created:true};},
  async claimNotification(id,force=false){const row=rows.get(id);if(!row||(!force&&(!['pending','failed'].includes(row.notification_status)||row.notification_attempts>=5)))return null;row.notification_status='sending';row.notification_attempts++;return structuredClone(row);},
  async markNotification(id,status,code,messageId){Object.assign(rows.get(id),{notification_status:status,notification_error_code:code,notification_provider_id:messageId});},
  async ready(){return true;},
 };
}
function dependencies(overrides={}){return{repository:fakeStore(),rateLimit:async()=>true,notify:async()=>({messageId:'test-provider-id'}),logger,...overrides};}

test('JayJe config is disabled by default and fails closed without inbox or secret',()=>{
 assert.equal(getJayjeConfig({}).enabled,false);assert.equal(configReady(config),true);
 for(const change of [{JAYJE_ENABLED:'false'},{JAYJE_PROXY_SECRET:'short'},{JAYJE_CONTACT_TO_EMAIL:''},{SENDGRID_API_KEY:''},{JAYJE_ALLOWED_ORIGINS:'https://*.example.com/,javascript:hi,http://jayje.com'}])assert.equal(configReady(getJayjeConfig({...environment,...change})),false);
});
test('sender falls back to existing configured SendForge sender without changing its name',()=>{
 const c=getJayjeConfig({...environment,JAYJE_FROM_EMAIL:'',CONTACT_FROM_EMAIL:'shared@example.com'});assert.equal(c.fromEmail,'shared@example.com');assert.equal(c.fromName,'JayJe service requests');assert.equal(c.toEmail,'inbox@example.com');
});
test('origin allowlist rejects credentials, paths, wildcards and insecure origins',()=>{
 assert.deepEqual(getJayjeConfig({...environment,JAYJE_ALLOWED_ORIGINS:'https://jayje.com, https://preview.pages.dev,https://user:pw@jayje.com,https://jayje.com/path,http://jayje.com,https://jayje.com/'}).origins,['https://jayje.com','https://preview.pages.dev']);
});
test('validation normalizes addresses and deduplicates service IDs',()=>{
 const parsed=requestSchema.parse(valid({name:'  Test Customer  ',email:'Customer@EXAMPLE.com',services:['plumbing','hvac','hvac']}));assert.equal(parsed.name,'Test Customer');assert.equal(parsed.email,'customer@example.com');assert.deepEqual(parsed.services,['hvac','plumbing']);assert.equal(Object.keys(SERVICE_NAMES).length,8);
});
test('validation rejects honeypots, unknown fields, invalid consent, IDs and injected lines',()=>{
 for(const changes of [{services:[]},{services:['unknown']},{name:'Test\r\nBcc: injected'},{email:'bad'},{contactMethod:'phone',phone:''},{phone:'12345abc'},{consent:false},{website:'spam.example'},{unexpected:'field'},{requestKey:'not-a-uuid'},{message:'short'},{message:'a'.repeat(5001)}])assert.equal(requestSchema.safeParse(valid(changes)).success,false,JSON.stringify(changes).slice(0,120));
});
test('validation error map never reflects unknown field names',()=>{
 const parsed=requestSchema.safeParse(valid({name:'',email:'bad',website:'bot',unknown:'x'}));assert.deepEqual(Object.keys(fieldErrors(parsed.error)).sort(),['email','name']);
});
test('request references and hashes are deterministic for data, not personal identifiers',()=>{
 const data=requestSchema.parse(valid());const one=requestRecord(data),two=requestRecord(data);assert.match(one.reference,/^JJ-[A-F0-9]{12}$/);assert.notEqual(one.id,two.id);assert.equal(one.payload_hash,two.payload_hash);assert.equal(one.request_key,data.requestKey);assert.equal(one.status,'new');assert.equal(one.consent_version,'2026-09-06');
});
test('new lead is stored before notification; customer receives no personal data',async()=>{
 const d=dependencies();let count=0;d.notify=async row=>{assert.equal(d.repository.rows.size,1);assert.equal(row.notification_status,'sending');count++;return{messageId:'queued'};};const r=await acceptJayjeRequest(requestSchema.parse(valid()),d);assert.equal(r.status,202);assert.deepEqual(Object.keys(r.body).sort(),['ok','reference']);assert.equal(count,1);assert.equal([...d.repository.rows.values()][0].notification_status,'accepted');
});
test('unchanged sequential retry returns the same reference and no duplicate email',async()=>{
 let count=0;const d=dependencies({notify:async()=>{count++;return{};}});const data=requestSchema.parse(valid());const one=await acceptJayjeRequest(data,d),two=await acceptJayjeRequest(data,d);assert.equal(two.status,200);assert.equal(one.body.reference,two.body.reference);assert.equal(d.repository.rows.size,1);assert.equal(count,1);
});
test('concurrent retries store and notify once',async()=>{
 let count=0;const d=dependencies({notify:async()=>{count++;await new Promise(r=>setTimeout(r,10));return{};}});const data=requestSchema.parse(valid());const all=await Promise.all(Array.from({length:6},()=>acceptJayjeRequest(data,d)));assert.equal(new Set(all.map(r=>r.body.reference)).size,1);assert.equal(d.repository.rows.size,1);assert.equal(count,1);
});
test('reused key with different project data returns conflict',async()=>{
 const d=dependencies(),data=requestSchema.parse(valid());await acceptJayjeRequest(data,d);await assert.rejects(acceptJayjeRequest({...data,message:'A different project description'},d),error=>error.status===409);
});
test('email rejection does not lose a persisted lead and a safe retry can notify',async()=>{
 const d=dependencies({notify:async()=>{throw new JayjeMailError('mail_http_401');}}),data=requestSchema.parse(valid());const first=await acceptJayjeRequest(data,d);assert.equal(first.status,202);assert.equal([...d.repository.rows.values()][0].notification_status,'failed');d.notify=async()=>({messageId:'accepted-after-fix'});const second=await acceptJayjeRequest(data,d);assert.equal(second.body.reference,first.body.reference);assert.equal([...d.repository.rows.values()][0].notification_status,'accepted');
});
test('ambiguous email outcome is recorded and is not resent by browser retry',async()=>{
 let count=0;const d=dependencies({notify:async()=>{count++;throw new JayjeMailError('mail_delivery_unknown',true);}}),data=requestSchema.parse(valid());await acceptJayjeRequest(data,d);await acceptJayjeRequest(data,d);assert.equal([...d.repository.rows.values()][0].notification_status,'unknown');assert.equal(count,1);
});
test('notification claiming and writeback failures leave the durable lead intact',async()=>{
 const d=dependencies();d.repository.markNotification=async()=>{throw new Error('database unavailable');};const r=await acceptJayjeRequest(requestSchema.parse(valid()),d);assert.equal(r.status,202);assert.equal([...d.repository.rows.values()][0].notification_status,'sending');
 const d2=dependencies();d2.repository.claimNotification=async()=>{throw new Error('db');};assert.equal((await acceptJayjeRequest(requestSchema.parse(valid()),d2)).status,202);assert.equal([...d2.repository.rows.values()][0].notification_status,'pending');
});
test('mail HTML escapes project fields and notifies only the configured business inbox',()=>{
 const row={...requestRecord(requestSchema.parse(valid({name:'<Customer>',message:'<script>alert(1)</script> & repair'}))),services:['plumbing','hvac']};const body=notificationBody(row,config);assert.deepEqual(body.personalizations[0].to,[{email:'inbox@example.com'}]);assert.equal(body.reply_to.email,'customer@example.com');assert.ok(body.subject.includes('Heating & cooling'));assert.ok(!body.content[1].value.includes('<script>'));assert.ok(body.content[1].value.includes('&lt;script&gt;'));assert.equal(body.tracking_settings.open_tracking.enable,false);
});
test('SendGrid 202 means accepted; HTTP and network ambiguity are classified',async()=>{
 const row={...requestRecord(requestSchema.parse(valid())),services:['hvac']};let sent;
 const ok=await sendJayjeNotification(row,config,async(url,options)=>{sent={url,options};return new Response(null,{status:202,headers:{'x-message-id':'provider-ref'}});});assert.equal(ok.messageId,'provider-ref');assert.equal(sent.url,'https://api.sendgrid.com/v3/mail/send');assert.equal(sent.options.redirect,'error');
 await assert.rejects(sendJayjeNotification(row,config,async()=>new Response('{}',{status:400})),e=>e.code==='mail_http_400'&&!e.deliveryUnknown);
 await assert.rejects(sendJayjeNotification(row,config,async()=>new Response('{}',{status:503})),e=>e.deliveryUnknown);
 await assert.rejects(sendJayjeNotification(row,config,async()=>{throw new Error('network');}),e=>e.deliveryUnknown);
});
test('limiter uses atomic Redis counters, hashes PII and enforces both limits',async()=>{
 let args;let counts=[10,4];const limiter=createJayjeLimiter({status:'ready',eval:async(...a)=>{args=a;return counts;}},secret);assert.equal(await limiter({ip:'203.0.113.7',email:'CUSTOMER@example.com'}),true);assert.equal(args[1],2);assert.equal(args[4],3600);assert.match(args[2],/^jayje:intake:ip:[0-9a-f]{64}$/);assert.ok(!args.join(' ').includes('203.0.113.7'));assert.ok(!args.join(' ').includes('CUSTOMER'));counts=[11,2];assert.equal(await limiter({ip:'203.0.113.7',email:'customer@example.com'}),false);counts=[2,5];assert.equal(await limiter({ip:'203.0.113.8',email:'customer@example.com'}),false);
});
test('limiter refuses disconnected Redis instead of queueing requests',async()=>{
 let called=false;await assert.rejects(createJayjeLimiter({status:'reconnecting',eval(){called=true;}},secret)({ip:'203.0.113.7',email:'a@example.com'}));assert.equal(called,false);
});
test('timing-safe proxy secret comparison handles missing and unequal lengths',()=>{assert.equal(secureEqual(secret,secret),true);assert.equal(secureEqual('',secret),false);assert.equal(secureEqual('a',secret),false);assert.equal(secureEqual(undefined,secret),false);});

test('router HTTP contract: auth, validation, limits, persistence, health and isolation',async t=>{
 let current=config;let deps=dependencies();const app=express();app.use('/v1/jayje',createJayjeRouter({getConfig:()=>current,loadDependencies:async()=>deps,logger}));app.use(express.json({limit:'25mb'}));app.post('/v1/existing',(_req,res)=>res.json({untouched:true}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const headers={'Content-Type':'application/json','X-Jayje-Proxy-Key':secret,'X-Jayje-Origin':'https://jayje.com','X-Jayje-Client-Ip':'203.0.113.7'};
 const send=(body=valid(),extra={})=>fetch(base+'/v1/jayje/requests',{method:'POST',headers,body:JSON.stringify(body),...extra});
 await t.test('rejects unauthenticated and non-allowlisted proxy calls',async()=>{assert.equal((await send(valid(),{headers:{...headers,'X-Jayje-Proxy-Key':'bad'}})).status,403);assert.equal((await send(valid(),{headers:{...headers,'X-Jayje-Origin':'https://other.example'}})).status,403);assert.equal((await send(valid(),{headers:{...headers,'X-Jayje-Client-Ip':'bad-ip'}})).status,403);});
 await t.test('disables route unless explicitly configured',async()=>{current={...config,enabled:false};assert.equal((await send()).status,503);current=config;});
 await t.test('health does not disclose keys and checks isolated storage',async()=>{const r=await fetch(base+'/v1/jayje/health',{headers});assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,service:'jayje',version:'1.0.0'});deps.repository.ready=async()=>false;assert.equal((await fetch(base+'/v1/jayje/health',{headers})).status,503);deps.repository.ready=async()=>true;});
 await t.test('enforces method, content type, JSON parsing and 24 KiB limit before shared parser',async()=>{assert.equal((await fetch(base+'/v1/jayje/requests',{headers})).status,405);assert.equal((await send(valid(),{headers:{...headers,'Content-Type':'text/plain'}})).status,415);assert.equal((await send(null,{body:'{broken'})).status,400);assert.equal((await send(valid({message:'x'.repeat(26*1024)}))).status,413);assert.equal((await send(valid({consent:false}))).status,400);});
 await t.test('returns confirmed reference and a duplicate returns 200',async()=>{const body=valid();const one=await send(body);assert.equal(one.status,202);const first=await one.json();const two=await send(body);assert.equal(two.status,200);assert.equal((await two.json()).reference,first.reference);assert.equal(one.headers.get('cache-control'),'no-store');assert.equal((await send({...body,message:'A changed description for the same key'})).status,409);});
 await t.test('rate limit blocks new storage with retry hint',async()=>{deps.rateLimit=async()=>false;const size=deps.repository.rows.size;const response=await send();assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'3600');assert.equal(deps.repository.rows.size,size);deps.rateLimit=async()=>true;});
 await t.test('storage outages return non-PII failure',async()=>{const original=deps.repository.findByKey;deps.repository.findByKey=async()=>{throw new Error('private database detail');};const response=await send();assert.equal(response.status,503);assert.equal((await response.text()).includes('private'),false);deps.repository.findByKey=original;});
 await t.test('other route retains the existing larger JSON parser',async()=>{const r=await fetch(base+'/v1/existing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'x'.repeat(40*1024)})});assert.equal(r.status,200);assert.deepEqual(await r.json(),{untouched:true});});
});

test('migration compiles only JayJe table and indexes without connecting to a database',async()=>{
 const database=knex({client:'pg'});let sql;
 await up({schema:{createTable(name,builder){assert.equal(name,'jayje_service_requests');sql=database.schema.createTable(name,builder).toSQL();return Promise.resolve();}}});
 const text=sql.map(q=>q.sql).join('\n');assert.ok(text.includes('"request_key"'));assert.ok(text.includes('"services" jsonb'));assert.ok(text.includes('jayje_requests_status_created_idx'));assert.ok(!/alter table "(?:users|accounts|contacts|tabforge)/.test(text));await database.destroy();
});
test('integration mount precedes shared JSON and keeps all other route calls in place',async()=>{
 const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');assert.ok(source.indexOf('app.use("/v1/jayje", jayjeRouter)')<source.search(/app\.use\(\s*express\.json/));assert.ok(source.includes('/v1/tabforge'));assert.ok(source.includes('/v1/billing'));assert.ok(source.includes('rawBody'));
});
