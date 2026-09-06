/** Run only in the existing Render service Shell. No new public admin route. */
import 'dotenv/config';
import { db } from '../../config/db.js';
import { createJayjeRepository } from './repository.js';
import { getJayjeConfig } from './config.js';
import { sendJayjeNotification, notifyStoredRequest } from './notification.js';
const repository=createJayjeRepository(db);
const [command='list',id,argument]=process.argv.slice(2);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
try {
 if(command==='list') console.table(await repository.list(30));
 else if(!uuid.test(id||'')) throw new Error('Provide the request UUID from the list.');
 else if(command==='show') {
   const row=await repository.find(id);if(!row) throw new Error('Request not found.');
   console.log(JSON.stringify(row,null,2));
 }else if(command==='status') {
   if(!['new','contacted','scheduled','closed'].includes(argument)) throw new Error('Status must be new, contacted, scheduled or closed.');
   if(!(await repository.updateStatus(id,argument))) throw new Error('Request not found.');
   console.log('Status updated.');
 }else if(command==='retry') {
   const row=await repository.find(id);if(!row) throw new Error('Request not found.');
   const force=argument==='--force';
   if(!force&&!['pending','failed'].includes(row.notification_status)) throw new Error('This notification may already have been sent. Check SendGrid activity first; --force explicitly allows another send.');
   await notifyStoredRequest(row,{repository,notify:r=>sendJayjeNotification(r,getJayjeConfig())},force);
   const updated=await repository.find(id);
   console.log('Notification status:',updated.notification_status);
   if(updated.notification_status!=='accepted') process.exitCode=1;
 }else throw new Error('Commands: list | show <uuid> | status <uuid> <new|contacted|scheduled|closed> | retry <uuid> [--force]');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{await db.destroy();}
