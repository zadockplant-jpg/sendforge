import { SERVICE_NAMES, TIMEFRAMES } from './config.js';
export class JayjeMailError extends Error {
 constructor(code,unknown=false) { super(code);this.code=code;this.deliveryUnknown=unknown; }
}
const escape = value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function notificationBody(row, config) {
 const selected = (Array.isArray(row.services)?row.services:[]).map(id=>SERVICE_NAMES[id]||id).join(', ');
 const text = `New JayJe service request — ${row.reference}\n\nName: ${row.name}\nEmail: ${row.email}\nPhone: ${row.phone || 'Not provided'}\nContact by: ${row.contact_method}\nLocation: ${row.location}\nServices: ${selected}\nTimeframe: ${TIMEFRAMES[row.timeframe] || row.timeframe}\n\nProject details:\n${row.message}\n\nReply to this email to contact the customer.\n`;
 const fields = [['Name',row.name],['Email',row.email],['Phone',row.phone||'Not provided'],['Contact by',row.contact_method],['Location',row.location],['Services',selected],['Timeframe',TIMEFRAMES[row.timeframe]||row.timeframe]];
 const html = `<div style="font-family:Arial,sans-serif;color:#111111;line-height:1.7"><h1 style="font-size:24px">New JayJe service request</h1><p>${escape(row.reference)}</p>${fields.map(([label,value])=>`<p><strong>${label}:</strong> ${escape(value)}</p>`).join('')}<h2 style="font-size:18px">Project details</h2><p style="white-space:pre-wrap">${escape(row.message)}</p><p>Reply to this email to contact the customer.</p></div>`;
 return {
   personalizations:[{to:[{email:config.toEmail}],custom_args:{jayje_reference:row.reference}}],
   from:{email:config.fromEmail,name:config.fromName}, reply_to:{email:row.email,name:row.name},
   subject:`JayJe ${row.reference} | ${selected}`,
   content:[{type:'text/plain',value:text},{type:'text/html',value:html}],
   categories:['jayje-service-request'],
   tracking_settings:{click_tracking:{enable:false,enable_text:false},open_tracking:{enable:false},subscription_tracking:{enable:false}},
 };
}
export async function sendJayjeNotification(row,config,fetcher=fetch) {
 if(!config.sendgridKey||!config.fromEmail||!config.toEmail) throw new JayjeMailError('mail_not_configured');
 let response;
 try {
  response = await fetcher('https://api.sendgrid.com/v3/mail/send',{
    method:'POST',headers:{Authorization:`Bearer ${config.sendgridKey}`,'Content-Type':'application/json'},
    body:JSON.stringify(notificationBody(row,config)),signal:AbortSignal.timeout(7500),redirect:'error',
  });
 }catch { throw new JayjeMailError('mail_delivery_unknown',true); }
 if(response.status!==202) {
   // A 5xx/408 may be ambiguous after the provider started processing.
   const unknown = response.status>=500 || response.status===408;
   throw new JayjeMailError(`mail_http_${response.status}`,unknown);
 }
 return {messageId:response.headers.get('x-message-id')||null};
}
/** Claim before sending so concurrent request retries cannot send twice.
 * Pending, failed and ambiguous notifications remain inspectable in the inbox.
 */
export async function notifyStoredRequest(row,{repository,notify,logger=console},force=false) {
 let claimed;
 try { claimed = await repository.claimNotification(row.id,force); }
 catch { logger.error('[jayje] notification_claim_failed',row.reference);return; }
 if(!claimed) return;
 try {
   const result = await notify(claimed);
   try { await repository.markNotification(row.id,'accepted',null,result.messageId); }
   catch { logger.error('[jayje] notification_status_write_failed',row.reference); }
 }catch(error) {
   const code = /^mail_[a-z0-9_]+$/.test(error.code||'')?error.code:'mail_send_failed';
   const state = error.deliveryUnknown?'unknown':'failed';
   try { await repository.markNotification(row.id,state,code); } catch { /* row remains sending for manual reconciliation */ }
   logger.error('[jayje]',code,row.reference);
 }
}
