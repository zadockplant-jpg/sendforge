const buckets = new Map();

function nowMs() {
  return Date.now();
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function cleanOldBuckets(currentTime) {
  if (buckets.size < 10000) return;
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= currentTime) buckets.delete(key);
  }
}

export function createRateLimiter({
  name,
  windowMs,
  max,
  keyGenerator,
  message = "rate_limited",
}) {
  if (!name || !Number.isFinite(windowMs) || !Number.isFinite(max)) {
    throw new Error("invalid_rate_limiter_config");
  }

  return function rateLimit(req, res, next) {
    const currentTime = nowMs();
    cleanOldBuckets(currentTime);

    const identity = String(keyGenerator ? keyGenerator(req) : getClientIp(req) || "unknown");
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
  const email = String(req.body?.email || "").toLowerCase().trim() || "unknown-email";
  return `${ip}:${email}`;
}

export function rateLimitByUserOrIp(req) {
  return req.user?.sub || getClientIp(req);
}
