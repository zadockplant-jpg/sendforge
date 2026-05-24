import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export function adminWritesEnabled() {
  return String(process.env.ADMIN_WRITES_ENABLED || "true").toLowerCase() !== "false";
}

export function requireAdminAuth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

  if (!token) return res.status(401).json({ error: "missing_admin_token" });

  try {
    const payload = jwt.verify(token, env.jwtSecret, { audience: "sendforge-admin" });
    if (!payload?.admin || !payload?.sub || !payload?.email) {
      return res.status(403).json({ error: "not_admin" });
    }
    req.admin = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "invalid_admin_token" });
  }
}

export function requireAdminWritesEnabled(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!adminWritesEnabled()) {
    return res.status(423).json({ error: "admin_writes_disabled" });
  }
  return next();
}
