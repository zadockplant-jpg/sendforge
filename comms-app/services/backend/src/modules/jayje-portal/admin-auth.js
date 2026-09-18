import { createHash,randomInt,randomUUID,timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { CUSTOMER_TOKEN_ISSUER,ADMIN_TOKEN_TTL_SECONDS } from '../../services/auth.service.js';
import { fail } from './service.js';

// JayJe's own admin sign-in. The session it issues is scoped to the JayJe portal:
// SendForge's admin API rejects it, and the portal rejects SendForge admin tokens.
export const JAYJE_ADMIN_TOKEN_AUDIENCE='jayje-admin';
export const JAYJE_ADMIN_TOKEN_USE='jayje_admin_access';
export const JAYJE_ADMIN_CODE_PURPOSE='jayje_admin_login';
const DEFAULT_ADMIN_EMAILS=Object.freeze(['paul@jayje.com','zadockplant@gmail.com']);
const CODE_TTL_MS=5*60*1000, MAX_ATTEMPTS=5, CLOCK_TOLERANCE_SECONDS=30;
const emailShape=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const normalize=value=>String(value||'').trim().toLowerCase();
const sha256=value=>createHash('sha256').update(String(value)).digest('hex');
const integerClaim=value=>typeof value==='number' && Number.isSafeInteger(value)?value:null;
const tokenError=code=>Object.assign(new Error(code),{code});

export function jayjeAdminEmails() {
  const configured=String(process.env.JAYJE_ADMIN_EMAILS||'').split(',').map(normalize).filter(Boolean);
  return configured.length?configured:[...DEFAULT_ADMIN_EMAILS];
}
export const isJayjeAdmin=email=>jayjeAdminEmails().includes(normalize(email));
export function adminCodeRecipient(user) {
  const configured=String(process.env.JAYJE_ADMIN_CODE_EMAIL||'').trim();
  return configured.length<=254 && emailShape.test(configured)?configured:user.email;
}
export function maskEmail(email) {
  const value=String(email||''),at=value.indexOf('@');
  const local=at>=0?value.slice(0,at):value, domain=at>=0?value.slice(at+1):'';
  return `${local.slice(0,1)}***@${domain}`;
}

export function issueJayjeAdminToken({id,email,authVersion=0},{nowSeconds=Math.floor(Date.now()/1000)}={}) {
  if(!env.jwtSecret)throw new Error('JWT_SECRET missing');
  const subject=String(id||''),normalizedEmail=normalize(email),version=integerClaim(authVersion);
  if(!subject || !normalizedEmail || version===null || version<0)throw tokenError('invalid_jayje_admin_session');
  return jwt.sign({sub:subject,email:normalizedEmail,admin:true,role:'jayje_admin',token_use:JAYJE_ADMIN_TOKEN_USE,auth_version:version,iat:nowSeconds},
    env.jwtSecret,{algorithm:'HS256',issuer:CUSTOMER_TOKEN_ISSUER,audience:JAYJE_ADMIN_TOKEN_AUDIENCE,expiresIn:ADMIN_TOKEN_TTL_SECONDS});
}
export function verifyJayjeAdminToken(token,{nowSeconds=Math.floor(Date.now()/1000)}={}) {
  if(!env.jwtSecret)throw new Error('JWT_SECRET missing');
  // The audience check is what turns a SendForge admin token away.
  const payload=jwt.verify(token,env.jwtSecret,{algorithms:['HS256'],issuer:CUSTOMER_TOKEN_ISSUER,audience:JAYJE_ADMIN_TOKEN_AUDIENCE,clockTimestamp:nowSeconds,clockTolerance:CLOCK_TOLERANCE_SECONDS});
  const authVersion=integerClaim(payload?.auth_version),issuedAt=integerClaim(payload?.iat),expiresAt=integerClaim(payload?.exp);
  const subject=String(payload?.sub||''),email=normalize(payload?.email);
  if(payload?.token_use!==JAYJE_ADMIN_TOKEN_USE || payload?.admin!==true || payload?.role!=='jayje_admin' || !subject || subject.length>128 || !email ||
    authVersion===null || authVersion<0 || issuedAt===null || expiresAt===null || issuedAt>nowSeconds+CLOCK_TOLERANCE_SECONDS || expiresAt<=issuedAt || expiresAt-issuedAt>ADMIN_TOKEN_TTL_SECONDS)throw tokenError('invalid_jayje_admin_token_claims');
  return {...payload,sub:subject,email,auth_version:authVersion,iat:issuedAt,exp:expiresAt};
}

// Starts the emailed challenge for an admin whose account is already proven (password or Google).
// A code that cannot be delivered leaves no row behind, so the next attempt starts clean.
export async function startAdminChallenge({db,sendCode,user,source}) {
  const code=String(randomInt(100000,1000000)),challengeId=randomUUID();
  await db('admin_mfa_codes').insert({id:challengeId,user_id:user.id,email:user.email,code_hash:sha256(code),purpose:JAYJE_ADMIN_CODE_PURPOSE,expires_at:new Date(Date.now()+CODE_TTL_MS),metadata:{source}});
  const to=adminCodeRecipient(user);
  try{await sendCode({to,code,requestId:challengeId});}
  catch{await db('admin_mfa_codes').where({id:challengeId}).delete().catch(()=>{});throw fail(503,'code_delivery_failed');}
  return {challengeId,sentTo:maskEmail(to)};
}

const loginSchema=z.object({email:z.string().email().max(254),password:z.string().min(1).max(200)});
const verifySchema=z.object({challengeId:z.string().uuid(),code:z.string().regex(/^\d{6}$/)});
export function createJayjeAdminAuth({db,sendCode}) {
  return {
    async login(body) {
      const parsed=loginSchema.safeParse(body);
      if(!parsed.success)throw fail(400,'invalid_input');
      const user=await db('users').whereRaw('lower(email) = ?',[normalize(parsed.data.email)]).first();
      // One answer for an unknown address and a wrong password, so neither leaks which accounts exist.
      if(!user?.password_hash || !(await bcrypt.compare(parsed.data.password,user.password_hash)))throw fail(401,'bad_credentials');
      if(!user.email_verified)throw fail(403,'email_not_verified');
      if(!isJayjeAdmin(user.email))throw fail(403,'admin_not_allowed');
      return startAdminChallenge({db,sendCode,user,source:'jayje_password'});
    },
    async verify(body) {
      const parsed=verifySchema.safeParse(body);
      if(!parsed.success)throw fail(400,'invalid_input');
      const {challengeId,code}=parsed.data;
      // One attempt is consumed atomically before the compare, so parallel guesses cannot exceed the cap.
      const [row]=await db('admin_mfa_codes').where({id:challengeId,purpose:JAYJE_ADMIN_CODE_PURPOSE}).whereNull('used_at').where('expires_at','>',db.fn.now()).where('attempts','<',MAX_ATTEMPTS).increment('attempts',1).returning('*');
      if(!row) {
        const stale=await db('admin_mfa_codes').where({id:challengeId,purpose:JAYJE_ADMIN_CODE_PURPOSE}).first();
        if(stale && !stale.used_at && new Date(stale.expires_at).getTime()>Date.now() && Number(stale.attempts||0)>=MAX_ATTEMPTS)throw fail(423,'mfa_locked');
        throw fail(401,'invalid_or_expired_code');
      }
      const expected=Buffer.from(String(row.code_hash)),given=Buffer.from(sha256(code));
      if(expected.length!==given.length || !timingSafeEqual(expected,given))throw fail(401,'invalid_code');
      // Single use: only the conditional update consumes the code, even under concurrent submissions.
      const consumed=await db('admin_mfa_codes').where({id:row.id}).whereNull('used_at').update({used_at:db.fn.now()});
      if(!consumed)throw fail(401,'invalid_or_expired_code');
      const user=await db('users').where({id:row.user_id}).first();
      if(!user?.email_verified || !isJayjeAdmin(user.email))throw fail(403,'admin_not_allowed');
      return {token:issueJayjeAdminToken({id:user.id,email:user.email,authVersion:user.auth_version||0})};
    },
  };
}
