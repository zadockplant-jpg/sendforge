import { randomUUID, createHash } from 'node:crypto';
import { CONSENT_VERSION } from './config.js';
import { notifyStoredRequest } from './notification.js';
export class JayjeRequestError extends Error {
 constructor(status,code) { super(code);this.status=status;this.code=code; }
}
export function requestRecord(data) {
 const canonical = {
   name:data.name,email:data.email,phone:data.phone,contact_method:data.contactMethod,
   location:data.location,services:data.services,timeframe:data.timeframe,message:data.message,
   consent_version:CONSENT_VERSION,
 };
 const id = randomUUID();
 return {...canonical,services:JSON.stringify(data.services),id,request_key:data.requestKey,
   payload_hash:createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
   reference:`JJ-${id.replaceAll('-','').slice(0,12).toUpperCase()}`,consent_at:new Date(),
   status:'new',notification_status:'pending',notification_attempts:0};
}
export async function acceptJayjeRequest(data,dependencies) {
 const candidate = requestRecord(data);
 const existing = await dependencies.repository.findByKey(data.requestKey);
 let saved = existing?{row:existing,created:false}:await dependencies.repository.createOrGet(candidate);
 if(!saved.row) throw new JayjeRequestError(503,'storage_unavailable');
 if(saved.row.payload_hash!==candidate.payload_hash) throw new JayjeRequestError(409,'request_key_conflict');
 await notifyStoredRequest(saved.row,dependencies);
 return {status:saved.created?202:200,body:{ok:true,reference:saved.row.reference}};
}
