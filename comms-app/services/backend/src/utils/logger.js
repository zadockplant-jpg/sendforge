// src/utils/logger.js
import crypto from "crypto";

export function getRequestId(req) {
  const supplied =
    req.headers["x-request-id"] ||
    req.headers["cf-ray"] ||
    "";
  const candidate = String(supplied).trim();
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

export function log(level, msg, meta = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}

export function sanitizeEmail(email) {
  // Avoid logging raw emails. Keep domain + short prefix.
  if (!email || typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1) return "***";
  const user = e.slice(0, at);
  const domain = e.slice(at + 1);
  const prefix = user.slice(0, 2);
  return `${prefix}***@${domain}`;
}
