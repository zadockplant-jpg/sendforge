import { createHmac } from 'node:crypto';
// The one Redis command sets both counters and TTLs atomically. Keys are
// JayJe-prefixed and contain no raw IP address or email address.
export const RATE_SCRIPT = `
local ip = redis.call('INCR', KEYS[1])
if ip == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local email = redis.call('INCR', KEYS[2])
if email == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
return {ip, email}
`;
export function createJayjeLimiter(redis, secret) {
  const hash = value=>createHmac('sha256',secret).update(value).digest('hex');
  return async ({ip,email}) => {
    if (redis.status && redis.status !== 'ready') throw new Error('jayje_rate_limit_unavailable');
    let timer;
    const deadline = new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('jayje_rate_limit_timeout')),2500);});
    let counts;
    try { counts = await Promise.race([redis.eval(RATE_SCRIPT,2,
      `jayje:intake:ip:${hash(ip)}`,`jayje:intake:email:${hash(email.toLowerCase())}`,3600),deadline]); }
    finally { clearTimeout(timer); }
    const [ipCount,emailCount] = counts;
    return Number(ipCount)<=10 && Number(emailCount)<=4;
  };
}
