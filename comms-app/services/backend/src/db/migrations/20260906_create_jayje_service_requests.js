// Render applies this migration on deploy. Do not run it locally.
export async function up(knex) {
 await knex.schema.createTable('jayje_service_requests',table=>{
  table.uuid('id').primary();
  table.uuid('request_key').notNullable().unique();
  table.string('payload_hash',64).notNullable();
  table.string('reference',20).notNullable().unique();
  table.string('name',120).notNullable();
  table.string('email',254).notNullable();
  table.string('phone',32).notNullable().defaultTo('');
  table.string('contact_method',10).notNullable();
  table.string('location',240).notNullable();
  table.jsonb('services').notNullable();
  table.string('timeframe',24).notNullable();
  table.text('message').notNullable();
  table.string('consent_version',20).notNullable();
  table.timestamp('consent_at',{useTz:true}).notNullable();
  table.string('status',20).notNullable().defaultTo('new');
  table.string('notification_status',20).notNullable().defaultTo('pending');
  table.integer('notification_attempts').notNullable().defaultTo(0);
  table.string('notification_error_code',80).nullable();
  table.string('notification_provider_id',250).nullable();
  table.timestamp('notification_attempted_at',{useTz:true}).nullable();
  table.timestamp('notified_at',{useTz:true}).nullable();
  table.timestamps(true,true);
  table.index(['status','created_at'],'jayje_requests_status_created_idx');
  table.index(['notification_status','created_at'],'jayje_requests_notification_created_idx');
 });
}
export async function down(knex) { await knex.schema.dropTableIfExists('jayje_service_requests'); }
