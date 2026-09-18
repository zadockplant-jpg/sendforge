import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import knex from 'knex';
import { PGlite } from '@electric-sql/pglite';
process.env.JWT_SECRET ||= 'unit-test-secret-jayje-admin-auth-only';
process.env.JAYJE_ADMIN_EMAILS='paul@jayje.com,pending@jayje.com,owner@example.com';
delete process.env.JAYJE_ADMIN_CODE_EMAIL;
const {jayjeAdminEmails,isJayjeAdmin,adminCodeRecipient,maskEmail,issueJayjeAdminToken,verifyJayjeAdminToken,createJayjeAdminAuth,startAdminChallenge}=await import('../src/modules/jayje-portal/admin-auth.js');
const {issueAdminAccessToken,verifyAdminAccessToken,issueCustomerAccessToken,verifyCustomerAccessToken}=await import('../src/services/auth.service.js');

let pg,db,auth;const sent=[];let deliveryFails=false;
const paul={id:randomUUID(),email:'paul@jayje.com'},owner={id:randomUUID(),email:'owner@example.com'},pending={id:randomUUID(),email:'pending@jayje.com'},client={id:randomUUID(),email:'client@example.com'};
const sha256=value=>createHash('sha256').update(value).digest('hex');
const rows=()=>db('admin_mfa_codes').count('* as n').first().then(r=>Number(r.n));
async function challenge(email='paul@jayje.com'){const result=await auth.login({email,password:'correct horse'});return {id:result.challengeId,code:sent.at(-1).code,result};}
before(async()=>{
  pg=new PGlite();await pg.waitReady;
  // Real PostgreSQL (WASM) behind a single-connection Knex, as in jayje-portal.test.js.
  db=knex({client:'pg',connection:{},pool:{min:0,max:1}});
  db.client.acquireRawConnection=async()=>({query(config,callback){
    pg.query(config.text,config.values).then(result=>callback(null,{rows:result.rows,rowCount:result.affectedRows,command:config.text.trim().split(/\s/)[0].toUpperCase()}),callback);
  }});
  db.client.destroyRawConnection=async()=>{};
  await db.schema.createTable('users',t=>{t.uuid('id').primary();t.text('email');t.boolean('email_verified');t.text('password_hash');t.integer('auth_version').defaultTo(0);});
  // Same shape as 20260523_create_admin_growth_engine.js, so the SQL exercised here is what production runs.
  await db.schema.createTable('admin_mfa_codes',t=>{
    t.uuid('id').primary();t.uuid('user_id').notNullable().index();t.text('email').notNullable().index();t.text('code_hash').notNullable();
    t.text('purpose').notNullable().defaultTo('admin_login');t.timestamp('expires_at',{useTz:true}).notNullable();t.timestamp('used_at',{useTz:true}).nullable();
    t.integer('attempts').notNullable().defaultTo(0);t.jsonb('metadata').notNullable().defaultTo(db.raw("'{}'::jsonb"));
    t.timestamp('created_at',{useTz:true}).notNullable().defaultTo(db.fn.now());t.index(['email','purpose','created_at']);
  });
  const hash=await bcrypt.hash('correct horse',4);
  await db('users').insert([{...paul,email_verified:true,password_hash:hash,auth_version:3},{...owner,email_verified:true,password_hash:hash},{...pending,email_verified:false,password_hash:hash},{...client,email_verified:true,password_hash:hash}]);
  auth=createJayjeAdminAuth({db,sendCode});
});
async function sendCode(message){if(deliveryFails)throw new Error('sendgrid down');sent.push(message);}
after(async()=>{await db?.destroy();await pg?.close();});

test('allowlist parsing trims, lowercases, drops empties and falls back to the JayJe defaults',()=>{
  const saved=process.env.JAYJE_ADMIN_EMAILS;
  try {
    delete process.env.JAYJE_ADMIN_EMAILS;assert.deepEqual(jayjeAdminEmails(),['paul@jayje.com','zadockplant@gmail.com']);
    process.env.JAYJE_ADMIN_EMAILS='   ';assert.deepEqual(jayjeAdminEmails(),['paul@jayje.com','zadockplant@gmail.com']);
    process.env.JAYJE_ADMIN_EMAILS=' Paul@JayJe.com ,, owner@Example.com ,';assert.deepEqual(jayjeAdminEmails(),['paul@jayje.com','owner@example.com']);
    assert.equal(isJayjeAdmin('PAUL@jayje.com '),true);assert.equal(isJayjeAdmin('zadockplant@gmail.com'),false);assert.equal(isJayjeAdmin(''),false);assert.equal(isJayjeAdmin(undefined),false);
  } finally {process.env.JAYJE_ADMIN_EMAILS=saved;}
});
test('the code goes to JAYJE_ADMIN_CODE_EMAIL only when it is a real address, and is masked in responses',()=>{
  try {
    assert.equal(adminCodeRecipient(client),'client@example.com');
    process.env.JAYJE_ADMIN_CODE_EMAIL='not an address';assert.equal(adminCodeRecipient(client),'client@example.com');
    process.env.JAYJE_ADMIN_CODE_EMAIL='paul@jayje.com';assert.equal(adminCodeRecipient(client),'paul@jayje.com');
  } finally {delete process.env.JAYJE_ADMIN_CODE_EMAIL;}
  assert.equal(maskEmail('paul@jayje.com'),'p***@jayje.com');assert.equal(maskEmail('zadockplant@gmail.com'),'z***@gmail.com');
});
test('login refuses malformed, unknown, wrong-password, unverified and non-admin sign-ins without sending a code',async()=>{
  await assert.rejects(auth.login({}),{status:400,publicCode:'invalid_input'});
  await assert.rejects(auth.login({email:'not-an-email',password:'x'}),{status:400,publicCode:'invalid_input'});
  await assert.rejects(auth.login({email:'nobody@jayje.com',password:'correct horse'}),{status:401,publicCode:'bad_credentials'});
  await assert.rejects(auth.login({email:'paul@jayje.com',password:'wrong'}),{status:401,publicCode:'bad_credentials'});
  await assert.rejects(auth.login({email:'pending@jayje.com',password:'correct horse'}),{status:403,publicCode:'email_not_verified'});
  await assert.rejects(auth.login({email:'client@example.com',password:'correct horse'}),{status:403,publicCode:'admin_not_allowed'});
  assert.equal(sent.length,0);assert.equal(await rows(),0);
});
test('login mails a six-digit JayJe code to the configured inbox, or to the admin when none is configured',async()=>{
  process.env.JAYJE_ADMIN_CODE_EMAIL='paul@jayje.com';
  try {
    const {result,code}=await challenge('OWNER@example.com');
    assert.match(result.challengeId,/^[0-9a-f-]{36}$/);assert.equal(result.sentTo,'p***@jayje.com');
    assert.deepEqual(sent.at(-1),{to:'paul@jayje.com',code,requestId:result.challengeId});assert.match(code,/^\d{6}$/);
    const row=await db('admin_mfa_codes').where({id:result.challengeId}).first();
    assert.equal(row.purpose,'jayje_admin_login');assert.equal(row.user_id,owner.id);assert.equal(row.email,'owner@example.com');
    assert.equal(row.code_hash,sha256(code));assert.deepEqual(row.metadata,{source:'jayje_password'});assert.equal(row.attempts,0);assert.equal(row.used_at,null);
    const ttl=new Date(row.expires_at).getTime()-Date.now();assert.ok(ttl>240000 && ttl<=300000);
  } finally {delete process.env.JAYJE_ADMIN_CODE_EMAIL;}
  const {result}=await challenge('owner@example.com');
  assert.equal(sent.at(-1).to,'owner@example.com');assert.equal(result.sentTo,'o***@example.com');
});
test('a code that cannot be delivered is reported and leaves no challenge behind',async()=>{
  const before=await rows();deliveryFails=true;
  try {await assert.rejects(auth.login({email:'paul@jayje.com',password:'correct horse'}),{status:503,publicCode:'code_delivery_failed'});}
  finally {deliveryFails=false;}
  assert.equal(await rows(),before);
});
test('Google admin sign-in starts the same challenge, and a failed delivery leaves nothing behind there either',async()=>{
  process.env.JAYJE_ADMIN_CODE_EMAIL='paul@jayje.com';
  let result;
  try {result=await startAdminChallenge({db,sendCode,user:owner,source:'jayje_google'});}
  finally {delete process.env.JAYJE_ADMIN_CODE_EMAIL;}
  assert.equal(result.sentTo,'p***@jayje.com');assert.equal(sent.at(-1).to,'paul@jayje.com');assert.equal(sent.at(-1).requestId,result.challengeId);
  const row=await db('admin_mfa_codes').where({id:result.challengeId}).first();
  assert.equal(row.purpose,'jayje_admin_login');assert.equal(row.user_id,owner.id);assert.deepEqual(row.metadata,{source:'jayje_google'});assert.equal(row.code_hash,sha256(sent.at(-1).code));
  // The code it mailed is verified by the same endpoint as a password sign-in.
  const {token}=await auth.verify({challengeId:result.challengeId,code:sent.at(-1).code});
  assert.equal(verifyJayjeAdminToken(token).sub,owner.id);
  const before=await rows();deliveryFails=true;
  try {await assert.rejects(startAdminChallenge({db,sendCode,user:paul,source:'jayje_google'}),{status:503,publicCode:'code_delivery_failed'});}
  finally {deliveryFails=false;}
  assert.equal(await rows(),before);
});
test('verify counts wrong codes and locks the challenge after five of them',async()=>{
  const {id,code}=await challenge();
  await assert.rejects(auth.verify({challengeId:id,code:'12345'}),{status:400,publicCode:'invalid_input'});
  await assert.rejects(auth.verify({challengeId:'not-a-uuid',code:'123456'}),{status:400,publicCode:'invalid_input'});
  const wrong=String((Number(code)+1)%1000000).padStart(6,'0');
  for(let attempt=1;attempt<=5;attempt++) {
    await assert.rejects(auth.verify({challengeId:id,code:wrong}),{status:401,publicCode:'invalid_code'});
    assert.equal((await db('admin_mfa_codes').where({id}).first()).attempts,attempt);
  }
  await assert.rejects(auth.verify({challengeId:id,code}),{status:423,publicCode:'mfa_locked'});
  assert.equal((await db('admin_mfa_codes').where({id}).first()).used_at,null);
});
test('expired, unknown and SendForge-purpose challenges are refused',async()=>{
  const code='123456';
  const expired=randomUUID();await db('admin_mfa_codes').insert({id:expired,user_id:paul.id,email:paul.email,code_hash:sha256(code),purpose:'jayje_admin_login',expires_at:new Date(Date.now()-1000)});
  await assert.rejects(auth.verify({challengeId:expired,code}),{status:401,publicCode:'invalid_or_expired_code'});
  await assert.rejects(auth.verify({challengeId:randomUUID(),code}),{status:401,publicCode:'invalid_or_expired_code'});
  const sendforge=randomUUID();await db('admin_mfa_codes').insert({id:sendforge,user_id:paul.id,email:paul.email,code_hash:sha256(code),purpose:'admin_login',expires_at:new Date(Date.now()+300000)});
  await assert.rejects(auth.verify({challengeId:sendforge,code}),{status:401,publicCode:'invalid_or_expired_code'});
  const untouched=await db('admin_mfa_codes').where({id:sendforge}).first();assert.equal(untouched.used_at,null);assert.equal(untouched.attempts,0);
});
test('verify re-checks the account: unverified or de-listed users get no session',async()=>{
  const code='654321';
  const forPending=randomUUID();await db('admin_mfa_codes').insert({id:forPending,user_id:pending.id,email:pending.email,code_hash:sha256(code),purpose:'jayje_admin_login',expires_at:new Date(Date.now()+300000)});
  await assert.rejects(auth.verify({challengeId:forPending,code}),{status:403,publicCode:'admin_not_allowed'});
  const {id,code:ownerCode}=await challenge('owner@example.com');
  process.env.JAYJE_ADMIN_EMAILS='paul@jayje.com';
  try {await assert.rejects(auth.verify({challengeId:id,code:ownerCode}),{status:403,publicCode:'admin_not_allowed'});}
  finally {process.env.JAYJE_ADMIN_EMAILS='paul@jayje.com,pending@jayje.com,owner@example.com';}
});
test('the right code issues a JayJe-only session, exactly once',async()=>{
  const {id,code}=await challenge();
  const {token}=await auth.verify({challengeId:id,code});
  const payload=verifyJayjeAdminToken(token);
  assert.equal(payload.sub,paul.id);assert.equal(payload.email,'paul@jayje.com');assert.equal(payload.admin,true);assert.equal(payload.role,'jayje_admin');
  assert.equal(payload.token_use,'jayje_admin_access');assert.equal(payload.auth_version,3);assert.equal(payload.aud,'jayje-admin');assert.equal(payload.exp-payload.iat,8*60*60);
  assert.throws(()=>verifyAdminAccessToken(token));assert.throws(()=>verifyCustomerAccessToken(token));
  await assert.rejects(auth.verify({challengeId:id,code}),{status:401,publicCode:'invalid_or_expired_code'});
  const row=await db('admin_mfa_codes').where({id}).first();assert.ok(row.used_at);assert.equal(row.attempts,1);
});
test('JayJe admin tokens are their own audience: SendForge admin and customer tokens fail, as do stale or tampered claims',()=>{
  assert.throws(()=>verifyJayjeAdminToken(issueAdminAccessToken({id:paul.id,email:paul.email,authVersion:3})));
  assert.throws(()=>verifyJayjeAdminToken(issueCustomerAccessToken({id:paul.id,email:paul.email,authVersion:3})));
  const now=Math.floor(Date.now()/1000),token=issueJayjeAdminToken({id:paul.id,email:paul.email,authVersion:3},{nowSeconds:now});
  assert.equal(verifyJayjeAdminToken(token,{nowSeconds:now+8*60*60-60}).sub,paul.id);
  assert.throws(()=>verifyJayjeAdminToken(token,{nowSeconds:now+8*60*60+120}));
  assert.throws(()=>verifyJayjeAdminToken(token.slice(0,-3)+'abc'));
  assert.throws(()=>issueJayjeAdminToken({id:paul.id,email:paul.email,authVersion:-1}));
  assert.throws(()=>issueJayjeAdminToken({id:'',email:paul.email}));
});
