import { createHmac } from 'node:crypto';
// Intake counters live in the shared PostgreSQL database, in the same
// jayje_portal_limits table the account portal uses. Keys are HMAC digests of a
// JayJe-prefixed value, so no raw IP address or email address is stored. Redis
// is not required: the separately managed SendForge Redis service may stay
// suspended without disabling public service requests.
export const WINDOW_SECONDS = 3600;
export const LIMITS = Object.freeze({ ip: 10, email: 4 });
export const RATE_SQL = `INSERT INTO jayje_portal_limits (key_hash, attempts, window_started)
  VALUES (?, 1, now()) ON CONFLICT (key_hash) DO UPDATE SET
  attempts = CASE WHEN jayje_portal_limits.window_started < now() - (? * interval '1 second')
    THEN 1 ELSE jayje_portal_limits.attempts + 1 END,
  window_started = CASE WHEN jayje_portal_limits.window_started < now() - (? * interval '1 second')
    THEN now() ELSE jayje_portal_limits.window_started END
  RETURNING attempts`;
export function createJayjeLimiter(db, secret) {
  const hash = value=>createHmac('sha256',secret).update(value).digest('hex');
  async function count(key) {
    const result = await db.raw(RATE_SQL,[key,WINDOW_SECONDS,WINDOW_SECONDS]).timeout(2500);
    return Number(result.rows[0].attempts);
  }
  // A database failure rejects, and the router fails closed with 503. There is
  // no unbounded in-memory fallback.
  return async ({ip,email}) => {
    const ipCount = await count(hash(`jayje:intake:ip:${ip}`));
    const emailCount = await count(hash(`jayje:intake:email:${email.toLowerCase()}`));
    return ipCount<=LIMITS.ip && emailCount<=LIMITS.email;
  };
}
