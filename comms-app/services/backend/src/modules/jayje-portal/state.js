import { createHash } from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function createPortalState(db) {
  let lastCleanup=0;
  async function cleanup() {
    if(Date.now()-lastCleanup<60000)return;
    lastCleanup=Date.now();
    try {
      await db('jayje_portal_limits').where('window_started','<',db.raw("now() - interval '1 day'")).del().timeout(3000);
      await db('jayje_oauth_states').where('expires_at','<',db.fn.now()).del().timeout(3000);
    }catch(error){lastCleanup=0;throw error;}
  }
  return {
    async rate(key) {
      await cleanup();
      const result=await db.raw(`INSERT INTO jayje_portal_limits (key_hash, attempts, window_started)
        VALUES (?, 1, now()) ON CONFLICT (key_hash) DO UPDATE SET
        attempts = CASE WHEN jayje_portal_limits.window_started < now() - interval '60 seconds'
          THEN 1 ELSE jayje_portal_limits.attempts + 1 END,
        window_started = CASE WHEN jayje_portal_limits.window_started < now() - interval '60 seconds'
          THEN now() ELSE jayje_portal_limits.window_started END RETURNING attempts`,[key]).timeout(3000);
      return Number(result.rows[0].attempts);
    },
    async saveGoogleState(state,payload) {
      await db('jayje_oauth_states').insert({state_hash:hash(state),payload,expires_at:db.raw("now() + interval '10 minutes'")}).timeout(3000);
    },
    async consumeGoogleState(state) {
      // DELETE RETURNING is atomic: concurrent callbacks cannot reuse the code
      // transaction even if they reach different backend instances.
      const [row]=await db('jayje_oauth_states').where({state_hash:hash(state)}).where('expires_at','>',db.fn.now()).del().returning('payload').timeout(3000);
      return row?.payload||null;
    },
  };
}
