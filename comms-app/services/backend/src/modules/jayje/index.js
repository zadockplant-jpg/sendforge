import { getJayjeConfig } from './config.js';
import { createJayjeRouter } from './router.js';
import { createJayjeRepository } from './repository.js';
import { createJayjeLimiter } from './rate-limit.js';
import { sendJayjeNotification } from './notification.js';
// JayJe creates no new database connection during application startup. The
// existing SendForge Knex instance is loaded only when this module is enabled.
// Intake depends on PostgreSQL only; the suspended Redis service is not used.
let infrastructure;
async function loadInfrastructure() {
 if(!infrastructure) infrastructure=import('../../config/db.js');
 try { return await infrastructure; } catch(error) { infrastructure=null;throw error; }
}
export const jayjeRouter = createJayjeRouter({
 getConfig:getJayjeConfig,
 loadDependencies:async config=>{
   const {db}=await loadInfrastructure();
   return {repository:createJayjeRepository(db),rateLimit:createJayjeLimiter(db,config.proxySecret),
     notify:row=>sendJayjeNotification(row,config),
     ping:async()=>{ if(!(await db.schema.hasTable('jayje_portal_limits'))) throw new Error('jayje_limits_table_missing'); }};
 },
});
