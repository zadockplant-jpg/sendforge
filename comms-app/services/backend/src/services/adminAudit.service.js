import crypto from "crypto";
import { db } from "../config/db.js";

function hashIp(value) {
  const input = String(value || "");
  if (!input) return null;
  return crypto.createHash("sha256").update(input).digest("hex");
}

function requestIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "";
}

export async function writeAdminAudit(req, {
  action,
  resourceType = null,
  resourceId = null,
  beforeValue = null,
  afterValue = null,
  metadata = {},
}, database = db) {
  try {
    await database("admin_audit_log").insert({
      id: crypto.randomUUID(),
      admin_user_id: req.admin?.sub || null,
      admin_email: req.admin?.email || null,
      action,
      resource_type: resourceType,
      resource_id: resourceId ? String(resourceId) : null,
      before_value: beforeValue,
      after_value: afterValue,
      ip_hash: hashIp(requestIp(req)),
      user_agent: String(req.headers["user-agent"] || "").slice(0, 500),
      metadata,
    });
  } catch (err) {
    // Admin audit failure must not expose internals to the client, but should fail closed for writes.
    err.adminAuditFailed = true;
    throw err;
  }
}
