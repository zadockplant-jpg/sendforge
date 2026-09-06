// Portal state uses the available shared PostgreSQL database. It does not require
// resuming or changing the separately managed SendForge Redis service.
export async function up(k) {
  await k.schema.createTable('jayje_portal_limits',t=>{
    t.string('key_hash',64).primary();t.integer('attempts').notNullable();
    t.timestamp('window_started',{useTz:true}).notNullable().index();
  });
  await k.schema.createTable('jayje_oauth_states',t=>{
    t.string('state_hash',64).primary();t.jsonb('payload').notNullable();
    t.timestamp('expires_at',{useTz:true}).notNullable().index();
  });
}
export async function down(k) {
  await k.schema.dropTableIfExists('jayje_oauth_states');
  await k.schema.dropTableIfExists('jayje_portal_limits');
}
