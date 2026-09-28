import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import { PGlite } from '@electric-sql/pglite';
import { up,down } from '../src/db/migrations/20260907_create_jayje_portal.js';
import { up as templatesUp, down as templatesDown } from '../src/db/migrations/20260920_create_jayje_document_templates.js';
import { up as requestsUp, down as requestsDown } from '../src/db/migrations/20260906_create_jayje_service_requests.js';
import { up as referralsUp, down as referralsDown } from '../src/db/migrations/20260917_create_jayje_referrals.js';
import { createPortalService } from '../src/modules/jayje-portal/service.js';
import { createTemplates,templateSchema } from '../src/modules/jayje-portal/templates.js';

let pg,db,service,templates,admin,alice,client;
before(async()=>{
  pg=new PGlite();await pg.waitReady;
  db=knex({client:'pg',connection:{},pool:{min:0,max:1}});
  db.client.acquireRawConnection=async()=>({query(config,callback){
    pg.query(config.text,config.values).then(result=>callback(null,{rows:result.rows,rowCount:result.affectedRows,command:config.text.trim().split(/\s/)[0].toUpperCase()}),callback);
  }});
  db.client.destroyRawConnection=async()=>{};
  await db.schema.createTable('users',t=>{t.uuid('id').primary();t.text('email').unique();});
  await db.schema.createTable('admin_audit_log',t=>{t.uuid('id').primary();t.uuid('admin_user_id');t.text('admin_email');t.text('action');t.text('resource_type');t.text('resource_id');t.jsonb('metadata');});
  await up(db);await requestsUp(db);await referralsUp(db);await templatesUp(db);
  service=createPortalService(db);templates=createTemplates({db,audit:service.audit});
  admin={sub:randomUUID(),email:'owner@example.com',role:'admin'};alice={sub:randomUUID(),email:'alice@example.com',role:'client'};
  await db('users').insert([admin,alice].map(a=>({id:a.sub,email:a.email})));
  client=await service.createClient(admin,{name:'Alice Example',email:'alice@example.com'});
});
after(async()=>{if(db){await templatesDown(db);await referralsDown(db);await requestsDown(db);await down(db);await db.destroy();}await pg?.close();});
const input=(overrides={})=>({name:'Furnace service visit',title:'Furnace service',
  items:[{description:'Diagnostic and safety check',quantity_milli:1000,unit_cents:12500,category:'hvac'}],
  tax_bps:600,notes:'Parts quoted after the diagnostic.',valid_days:30,...overrides});

test('a template stores the line shape a document uses and defaults the rest',async()=>{
  const saved=await templates.create(admin,input());
  assert.equal(saved.kind,'quote');
  assert.equal(saved.valid_days,30);
  assert.deepEqual(saved.items,[{description:'Diagnostic and safety check',quantity_milli:1000,unit_cents:12500,category:'hvac'}]);
  assert.equal(saved.created_by,undefined,'internal columns stay out of the response');
  assert.equal(saved.archived_at,undefined);
  const parsed=templateSchema.parse({name:'Bare',title:'Bare',items:[{description:'Labor',quantity_milli:1000,unit_cents:0}]});
  assert.equal(parsed.kind,'quote');assert.equal(parsed.tax_bps,0);assert.equal(parsed.notes,'');
  assert.equal(parsed.valid_days,null);assert.equal(parsed.items[0].category,null);
});
test('template input is validated the same way a document line is',()=>{
  assert.equal(templateSchema.safeParse(input({items:[]})).success,false);
  assert.equal(templateSchema.safeParse(input({items:[{description:'Bad',quantity_milli:1000,unit_cents:-1}]})).success,false);
  assert.equal(templateSchema.safeParse(input({items:[{description:'Bad',quantity_milli:1000,unit_cents:100,category:'roofing'}]})).success,false);
  assert.equal(templateSchema.safeParse(input({valid_days:400})).success,false);
  assert.equal(templateSchema.safeParse(input({tax_bps:10001})).success,false);
  assert.equal(templateSchema.safeParse(input({total_cents:100})).success,false);
  // A price of zero is allowed so a starter template can ship without rates.
  assert.equal(templateSchema.safeParse(input({items:[{description:'Labor',quantity_milli:1000,unit_cents:0}]})).success,true);
});
test('live template names are unique and a removed name becomes free again',async()=>{
  const first=await templates.create(admin,input({name:'Recessed lighting'}));
  await assert.rejects(templates.create(admin,input({name:'recessed lighting'})),{publicCode:'template_name_taken'});
  await templates.remove(admin,first.id);
  const replacement=await templates.create(admin,input({name:'Recessed lighting'}));
  assert.notEqual(replacement.id,first.id);
  await assert.rejects(templates.update(admin,first.id,input()),{publicCode:'template_not_found'});
  await assert.rejects(templates.remove(admin,first.id),{publicCode:'template_not_found'});
});
test('removed templates leave the list and every change is written to the audit log',async()=>{
  const saved=await templates.create(admin,input({name:'Plumbing repair visit'}));
  await templates.update(admin,saved.id,input({name:'Plumbing repair visit',title:'Plumbing repair',items:[{description:'Labor',quantity_milli:2000,unit_cents:9500,category:'plumbing'}]}));
  const listed=(await templates.list()).templates.find(t=>t.id===saved.id);
  assert.equal(listed.title,'Plumbing repair');assert.equal(listed.items[0].quantity_milli,2000);
  await templates.remove(admin,saved.id);
  assert.equal((await templates.list()).templates.some(t=>t.id===saved.id),false);
  const trail=await db('admin_audit_log').where({resource_id:saved.id}).orderBy('action');
  assert.deepEqual(trail.map(row=>row.action),['jayje.template_created','jayje.template_removed','jayje.template_updated']);
  for(const row of trail)assert.equal(row.admin_email,'owner@example.com');
});
test('a template carries its lines into a real draft without being changed by it',async()=>{
  const saved=await templates.create(admin,input({name:'Handyman punch list',kind:'quote',
    items:[{description:'Day rate',quantity_milli:1000,unit_cents:48000,category:'handyman'},
      {description:'Materials',quantity_milli:1000,unit_cents:7500,category:'handyman'}]}));
  const draft=await service.createDocument(admin,{client_id:client.id,kind:saved.kind,title:saved.title,
    items:saved.items.map(({description,quantity_milli,unit_cents,category})=>({description,quantity_milli,unit_cents,category})),
    tax_bps:saved.tax_bps,notes:saved.notes,due_date:null});
  assert.equal(draft.subtotal_cents,55500);
  assert.equal(draft.tax_cents,3330);
  assert.equal(draft.total_cents,58830);
  await templates.update(admin,saved.id,input({name:'Handyman punch list',title:'Different title',
    items:[{description:'Day rate',quantity_milli:1000,unit_cents:99000,category:'handyman'}]}));
  const unchanged=await service.document(admin,draft.id);
  assert.equal(unchanged.title,saved.title);
  assert.equal(unchanged.total_cents,58830);
});
