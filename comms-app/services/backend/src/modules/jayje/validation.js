import { z } from 'zod';
import { SERVICE_NAMES, TIMEFRAMES } from './config.js';
const singleLine = z.string().trim().refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'Use a single line.');
export const requestSchema = z.object({
  requestKey: z.string().uuid('Refresh the page and send your request again.'),
  services: z.array(z.enum(Object.keys(SERVICE_NAMES))).min(1,'Choose at least one service.').max(8).transform(values=>[...new Set(values)].sort()),
  name: singleLine.pipe(z.string().min(2,'Enter your name.').max(120)),
  email: singleLine.pipe(z.string().email('Enter a valid email address.').max(254)).transform(value=>value.toLowerCase()),
  phone: singleLine.pipe(z.string().max(32)).optional().default('').refine(value=>!value || (/^[+\d\s().-]+$/.test(value) && value.replace(/\D/g,'').length >= 7),'Enter a valid phone number.'),
  contactMethod: z.enum(['email','phone']),
  location: singleLine.pipe(z.string().min(2,'Enter the city or ZIP code.').max(240)),
  timeframe: z.enum(Object.keys(TIMEFRAMES)),
  message: z.string().trim().min(10,'Add at least 10 characters about the work.').max(5000).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),'Remove unsupported characters.'),
  consent: z.literal(true,{errorMap:()=>({message:'Confirm that we may contact you about this request.'})}),
  website: z.string().max(0).optional().default(''),
}).strict().superRefine((data,context)=>{
  if (data.contactMethod === 'phone' && !data.phone) context.addIssue({code:z.ZodIssueCode.custom,path:['phone'],message:'Enter a number so we can call you.'});
});
export function fieldErrors(error) {
  const allowed = new Set(['services','name','email','phone','location','message','consent']);
  const result = {};
  for (const issue of error.issues || []) {
    const key = String(issue.path?.[0] || '');
    if (allowed.has(key) && !result[key]) result[key] = issue.message;
  }
  return result;
}
