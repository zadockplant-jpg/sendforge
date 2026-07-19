import crypto from "node:crypto";

const buckets = new Map();
const MAX_RATE_LIMIT_IDENTITY_CHARS = 512;
const MAX_RATE_LIMIT_EMAIL_CHARS = 320;

function nowMs() {
  return Date.now();
}

function getClientIp(req) {
  // Express resolves req.ip using the configured trust-proxy boundary.
  // Reading X-Forwarded-For directly would let clients mint new buckets.
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function cleanOldBuckets(currentTime) {
  if (buckets.size < 10000) return;
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= currentTime) buckets.delete(key);
  }
}

export function normalizeRateLimitEmail(value) {
  return (
    String(value || "")
      .toLowerCase()
      .trim()
      .slice(0, MAX_RATE_LIMIT_EMAIL_CHARS) || "unknown-email"
  );
}

export function hashRateLimitIdentity(value) {
  // Store only a fixed-size digest. Request bodies are parsed before route
  // validation and may be large, so never retain their raw values in Map keys.
  const bounded = String(value || "unknown").slice(
    0,
    MAX_RATE_LIMIT_IDENTITY_CHARS
  );
  return crypto
    .createHash("sha256")
    .update(bounded)
    .digest("base64url");
}

export function createRateLimiter({
  name,
  windowMs,
  max,
  keyGenerator,
  message = "rate_limited",
  skip,
}) {
  if (!name || !Number.isFinite(windowMs) || !Number.isFinite(max)) {
    throw new Error("invalid_rate_limiter_config");
  }

  return function rateLimit(req, res, next) {
    if (skip?.(req)) return next();

    const currentTime = nowMs();
    cleanOldBuckets(currentTime);

    const identity = hashRateLimitIdentity(
      keyGenerator ? keyGenerator(req) : getClientIp(req) || "unknown"
    );
    const key = `${name}:${identity}`;
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= currentTime) {
      bucket = { count: 0, resetAt: currentTime + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000));
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ error: message, retryAfterSeconds });
    }

    return next();
  };
}

export function rateLimitByIpAndBodyEmail(req) {
  const ip = getClientIp(req);
  const email = normalizeRateLimitEmail(req.body?.email);
  return `${ip}:${email}`;
}

export function rateLimitByIp(req) {
  return getClientIp(req);
}

export function rateLimitByUserOrIp(req) {
  return req.user?.sub || getClientIp(req);
}
