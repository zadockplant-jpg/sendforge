import { randomBytes,randomUUID,createHash,randomInt } from 'node:crypto';
import bcrypt from 'bcrypt';
import { OAuth2Client } from 'google-auth-library';
import { issueCustomerAccessToken } from '../../services/auth.service.js';
import { sendAdminMfaCodeEmail } from '../../services/email.service.js';
import { fail } from './service.js';

export const googleReady=()=>Boolean(process.env.JAYJE_GOOGLE_CLIENT_ID && process.env.JAYJE_GOOGLE_CLIENT_SECRET);
export const allowedAdmin=email=>String(process.env.ADMIN_ALLOWED_EMAILS||process.env.ADMIN_EMAIL||'zadockplant@gmail.com').split(',').map(s=>s.trim().toLowerCase()).includes(email.toLowerCase());
export function validateGoogleIdentity(payload,nonce) {
  if(!payload?.sub || !payload.email || payload.email_verified!==true || payload.nonce!==nonce || !['accounts.google.com','https://accounts.google.com'].includes(payload.iss))throw fail(401,'google_identity_invalid');
  return {subject:payload.sub,email:payload.email.toLowerCase()};
}
export function createGoogleAuth({db,stateStore}) {
  return {
    async start({origin,mode,actor}) {
      if(!googleReady())throw fail(503,'google_not_configured');
      if(!['client','admin','link'].includes(mode))throw fail(400,'invalid_google_mode');
      if(mode==='link' && !actor)throw fail(401,'sign_in_required');
      const state=randomBytes(32).toString('base64url'), nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
      const redirectUri=`${origin}/api/account/google/callback`;
      await stateStore.saveGoogleState(state,{nonce,verifier,redirectUri,mode,userId:mode==='link'?actor.sub:null});
      const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for(const [k,v]of Object.entries({client_id:process.env.JAYJE_GOOGLE_CLIENT_ID,redirect_uri:redirectUri,response_type:'code',scope:'openid email profile',state,nonce,
        code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'select_account'}))url.searchParams.set(k,v);
      return {url:url.toString(),state};
    },
    async callback({state,code,actor,origin}) {
      if(!googleReady())throw fail(503,'google_not_configured');
      if(!/^[A-Za-z0-9_-]{43}$/.test(state||'') || typeof code!=='string' || code.length>4096)throw fail(400,'google_state_invalid');
      const data=await stateStore.consumeGoogleState(state);
      if(!data)throw fail(400,'google_state_expired');
      if(data.redirectUri!==`${origin}/api/account/google/callback` || (data.mode==='link' && data.userId!==actor?.sub))throw fail(403,'google_state_invalid');
      const oauth=new OAuth2Client(process.env.JAYJE_GOOGLE_CLIENT_ID,process.env.JAYJE_GOOGLE_CLIENT_SECRET,data.redirectUri);
      const {tokens}=await oauth.getToken({code,codeVerifier:data.verifier,redirect_uri:data.redirectUri});
      const ticket=await oauth.verifyIdToken({idToken:tokens.id_token,audience:process.env.JAYJE_GOOGLE_CLIENT_ID});
      const identity=validateGoogleIdentity(ticket.getPayload(),data.nonce);
      const user=await db.transaction(async trx=>{
        const linked=await trx('jayje_google_identities').where({subject:identity.subject}).first();
        if(data.mode==='link') {
          if(linked && linked.user_id!==actor.sub)throw fail(409,'google_already_linked');
          const current=await trx('users').where({id:actor.sub}).first();
          if(current.email.toLowerCase()!==identity.email)throw fail(409,'google_email_mismatch');
          if(!linked)await trx('jayje_google_identities').insert({subject:identity.subject,user_id:actor.sub});
          return current;
        }
        if(linked) return trx('users').where({id:linked.user_id}).first();
        const existing=await trx('users').whereRaw('lower(email) = ?',[identity.email]).first();
        if(existing)throw fail(409,'google_link_required');
        if(data.mode==='admin')throw fail(403,'admin_not_authorized');
        const [created]=await trx('users').insert({id:randomUUID(),email:identity.email,password_hash:await bcrypt.hash(randomBytes(48).toString('hex'),12),email_verified:true,verified_at:trx.fn.now()}).returning('*');
        await trx('jayje_google_identities').insert({subject:identity.subject,user_id:created.id});return created;
      });
      if(!user?.email_verified)throw fail(403,'email_not_verified');
      if(data.mode==='link')return {linked:true};
      if(data.mode==='admin') {
        if(!allowedAdmin(user.email))throw fail(403,'admin_not_authorized');
        const code=String(randomInt(100000,1000000)),challengeId=randomUUID();
        await db('admin_mfa_codes').insert({id:challengeId,user_id:user.id,email:user.email,code_hash:createHash('sha256').update(code).digest('hex'),purpose:'admin_login',expires_at:new Date(Date.now()+300000),metadata:{source:'jayje_google'}});
        await sendAdminMfaCodeEmail({to:process.env.ADMIN_MFA_EMAIL||user.email,code,requestId:challengeId});
        return {challengeId};
      }
      return {token:issueCustomerAccessToken({id:user.id,email:user.email,authVersion:user.auth_version||0})};
    },
  };
}
