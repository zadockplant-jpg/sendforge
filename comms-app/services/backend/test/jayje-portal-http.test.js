import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import Stripe from 'stripe';
process.env.JWT_SECRET ||= 'unit-test-secret-jayje-portal-only';
process.env.JAYJE_PORTAL_ENABLED='true';process.env.JAYJE_PROXY_SECRET='unit-test-only-secret'.repeat(3);
process.env.JAYJE_ALLOWED_ORIGINS='https://jayje.com';
process.env.STRIPE_SECRET_KEY='sk_test_not_real';process.env.JAYJE_STRIPE_WEBHOOK_SECRET='whsec_test_not_real';
const {db}=await import('../src/config/db.js');
const {issueCustomerAccessToken,issueAdminAccessToken,clearCustomerAuthStateCache}=await import('../src/services/auth.service.js');
const {validateGoogleIdentity}=await import('../src/modules/jayje-portal/google.js');
const {issueJayjeAdminToken}=await import('../src/modules/jayje-portal/admin-auth.js');
const {jayjePortalRouter}=await import('../src/modules/jayje-portal/index.js');
const app=express();app.use('/portal',jayjePortalRouter);const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}/portal`;
const user={id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',email:'client@example.com',email_verified:true,auth_version:0};
const connection={};db.client.acquireConnection=async()=>connection;db.client.releaseConnection=async()=>{};
// Counts per key hash, so the per-address and per-account buckets fill the way the real table does.
const limits=new Map();
db.client.query=async(_connection,query)=>{
  if(query.sql.includes('jayje_portal_limits')||query.sql.includes('jayje_oauth_states')) {
    let attempts=1;
    if(query.sql.startsWith('INSERT INTO jayje_portal_limits')){attempts=(limits.get(query.bindings[0])||0)+1;limits.set(query.bindings[0],attempts);}
    return {...query,response:{rows:[{attempts}],command:'SELECT'}};
  }
  if(query.sql.includes('admin_mfa_codes'))return {...query,response:{rows:[],rowCount:0,command:query.sql.trim().split(/\s/)[0].toUpperCase()}};
  assert.match(query.sql,/from "users"/);return {...query,response:{rows:[user],command:'SELECT'}};
};
const request=(path,{token,body,headers={},method=body===undefined?'GET':'POST'}={})=>fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Jayje-Proxy-Key':process.env.JAYJE_PROXY_SECRET,'X-Jayje-Origin':'https://jayje.com','X-Jayje-Client-Ip':'203.0.113.7',...(token?{Authorization:`Bearer ${token}`}:{ }),...headers},body:body===undefined?undefined:JSON.stringify(body)});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.destroy();});
test('portal requires proxy secret, allowed origin and a validated visitor IP',async()=>{
  for(const headers of [{'X-Jayje-Proxy-Key':'wrong'},{'X-Jayje-Origin':'https://evil.example'},{'X-Jayje-Client-Ip':'spoofed'}])assert.equal((await request('/config',{headers})).status,403);
  assert.equal((await request('/config')).status,200);
  assert.equal((await request('/me')).status,401);
});
test('shared customer tokens cannot write admin clients or documents',async()=>{
  const token=issueCustomerAccessToken({id:user.id,email:user.email,authVersion:0});
  for(const path of ['/clients','/documents'])assert.equal((await request(path,{token,body:{}})).status,403);
  assert.equal((await request('/clients',{body:{},token:'tampered'})).status,401);
});
test('admin JWT still requires current allowlist and shared verified account state',async()=>{
  // A SendForge admin session is not a JayJe session, whatever the allowlist says.
  process.env.JAYJE_ADMIN_EMAILS='paul@jayje.com,client@example.com';
  const sendforge=issueAdminAccessToken({id:user.id,email:user.email,authVersion:0});
  assert.equal((await request('/clients',{token:sendforge,body:{}})).status,401);
  const token=issueJayjeAdminToken({id:user.id,email:user.email,authVersion:0});
  process.env.JAYJE_ADMIN_EMAILS='paul@jayje.com';
  assert.equal((await request('/clients',{token,body:{}})).status,403);
  // Allowlisted: the request reaches the handler, whose client validation refuses the empty body.
  process.env.JAYJE_ADMIN_EMAILS='paul@jayje.com,client@example.com';
  assert.equal((await request('/clients',{token,body:{}})).status,400);
  user.email_verified=false;clearCustomerAuthStateCache(user.id);
  assert.equal((await request('/clients',{token,body:{}})).status,401);
  const customer=issueCustomerAccessToken({id:user.id,email:user.email,authVersion:0});
  assert.equal((await request('/clients',{token:customer,body:{}})).status,401);
  user.email_verified=true;clearCustomerAuthStateCache(user.id);
  user.auth_version=1;clearCustomerAuthStateCache(user.id);
  assert.equal((await request('/clients',{token,body:{}})).status,401);
  user.auth_version=0;clearCustomerAuthStateCache(user.id);delete process.env.JAYJE_ADMIN_EMAILS;
});
test('auth aliases reach only the shared login and MFA routes, not global admin actions',async()=>{
  assert.equal((await request('/auth/login',{body:{}})).status,400);
  assert.equal((await request('/admin/auth/login',{body:{}})).status,400);
  assert.equal((await request('/admin/auth/verify',{body:{}})).status,400);
  for(const path of ['/admin/auth/users','/auth/refresh','/admin/auth/me'])assert.equal((await request(path,{body:{}})).status,404);
});
test('admin sign-in is capped per account and per challenge, whichever addresses the guesses come from',async()=>{
  const login=(email,ip)=>request('/admin/auth/login',{body:{email,password:'not the password'},headers:{'X-Jayje-Client-Ip':ip}});
  for(let i=0;i<5;i++)assert.equal((await login('paul@jayje.com','198.51.100.1')).status,401);
  // The sixth guess at the same account is refused from a fresh address too, and letter case opens no new bucket.
  const capped=await login('Paul@JayJe.com ','198.51.100.2');
  assert.equal(capped.status,429);assert.deepEqual(await capped.json(),{error:'too_many_requests'});
  assert.equal((await login('other@example.com','198.51.100.1')).status,401);
  const verify=(challengeId,ip)=>request('/admin/auth/verify',{body:{challengeId,code:'123456'},headers:{'X-Jayje-Client-Ip':ip}});
  const challenge='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  for(let i=0;i<8;i++)assert.equal((await verify(challenge,'198.51.100.3')).status,401);
  assert.equal((await verify(challenge,'198.51.100.4')).status,429);
  assert.equal((await verify('cccccccc-cccc-4ccc-cccc-cccccccccccc','198.51.100.3')).status,401);
  // The account keys are hashed with the proxy secret: no email or challenge id reaches the table in clear.
  for(const key of limits.keys()){assert.match(key,/^[0-9a-f]{64}$/);}
});
test('webhook requires its own Stripe signature over unchanged raw bytes',async()=>{
  assert.equal((await request('/stripe/webhook',{body:{id:'evt_fake'}})).status,400);
  const payload=JSON.stringify({id:'evt_unit',type:'unhandled.test.event',data:{object:{}}});
  const signature=Stripe.webhooks.generateTestHeaderString({payload,secret:process.env.JAYJE_STRIPE_WEBHOOK_SECRET});
  const result=await fetch(base+'/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':signature},body:payload});
  assert.equal(result.status,200);
});
test('Google identity requires verified email, trusted issuer, subject and matching nonce',()=>{
  const good={iss:'https://accounts.google.com',sub:'immutable-google-id',email:'CLIENT@example.com',email_verified:true,nonce:'expected'};
  assert.deepEqual(validateGoogleIdentity(good,'expected'),{subject:'immutable-google-id',email:'client@example.com'});
  for(const changed of [{iss:'https://evil.example'},{email_verified:false},{sub:''},{nonce:'another-browser'}])assert.throws(()=>validateGoogleIdentity({...good,...changed},'expected'));
});
