const TABLE = 'jayje_service_requests';
/** Injecting Knex makes this module testable without a live database. */
export function createJayjeRepository(database) {
 return {
  async findByKey(key) { return database(TABLE).where({request_key:key}).first().timeout(5000); },
  async createOrGet(row) {
    const [created] = await database(TABLE).insert(row).onConflict('request_key').ignore().returning('*').timeout(5000);
    if(created) return {row:created,created:true};
    return {row:await database(TABLE).where({request_key:row.request_key}).first(),created:false};
  },
  async claimNotification(id, force = false) {
    const query = database(TABLE).where({id});
    if(!force) query.whereIn('notification_status',['pending','failed']).andWhere('notification_attempts','<',5);
    const [row] = await query.update({notification_status:'sending',notification_attempted_at:database.fn.now(),notification_attempts:database.raw('notification_attempts + 1'),updated_at:database.fn.now()}).returning('*').timeout(5000);
    return row || null;
  },
  async markNotification(id, status, code = null, messageId = null) {
    await database(TABLE).where({id}).update({notification_status:status,
      notification_error_code:code ? String(code).slice(0,80) : null,
      notification_provider_id:messageId ? String(messageId).slice(0,250) : null,
      notified_at:status === 'accepted'?database.fn.now():null,updated_at:database.fn.now()}).timeout(5000);
  },
  async list(limit=30) { return database(TABLE).select('id','reference','name','services','status','notification_status','created_at').orderBy('created_at','desc').limit(limit).timeout(5000); },
  async find(id) { return database(TABLE).where({id}).first().timeout(5000); },
  async updateStatus(id,status) { return database(TABLE).where({id}).update({status,updated_at:database.fn.now()}).timeout(5000); },
  async ready() { return database.schema.hasTable(TABLE); },
 };
}
