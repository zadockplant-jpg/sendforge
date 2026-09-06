import { getJayjeConfig } from './config.js';
import { createJayjeRouter } from './router.js';
import { createJayjeRepository } from './repository.js';
import { createJayjeLimiter } from './rate-limit.js';
import { sendJayjeNotification } from './notification.js';
// JayJe creates no new database/Redis connection during application startup.
// Existing SendForge infrastructure is loaded only when this module is enabled.
let infrastructure;
async function loadInfrastructure() {
 if(!infrastructure) infrastructure=Promise.all([import('../../config/db.js'),import('../../config/redis.js')]);
 try { return await infrastructure; } catch(error) { infrastructure=null;throw error; }
}
export const jayjeRouter = createJayjeRouter({
 getConfig:getJayjeConfig,
 loadDependencies:async config=>{
   const [{db},{redis}]=await loadInfrastructure();
   return {repository:createJayjeRepository(db),rateLimit:createJayjeLimiter(redis,config.proxySecret),
     notify:row=>sendJayjeNotification(row,config),ping:async()=>{ if(redis.status !== 'ready') throw new Error('redis_unavailable');return redis.ping(); }};
 },
});
