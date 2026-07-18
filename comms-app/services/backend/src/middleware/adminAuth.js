import {
  adminTokenMatchesUser,
  getCurrentCustomerAuthState,
  verifyAdminAccessToken,
} from "../services/auth.service.js";
import { getRequestId, log } from "../utils/logger.js";

export function adminWritesEnabled() {
  return String(process.env.ADMIN_WRITES_ENABLED || "true").toLowerCase() !== "false";
}

export async function requireAdminAuth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

  if (!token) return res.status(401).json({ error: "missing_admin_token" });

  let payload;
  try {
    payload = verifyAdminAccessToken(token);
  } catch {
    return res.status(401).json({ error: "invalid_admin_token" });
  }

  try {
    const user = await getCurrentCustomerAuthState(payload.sub);
    if (!adminTokenMatchesUser(payload, user)) {
      return res.status(401).json({ error: "invalid_admin_token" });
    }
    req.admin = {
      ...payload,
      sub: user.id,
      email: user.email,
      auth_version: user.auth_version,
    };
    return next();
  } catch (error) {
    log("error", "admin_auth_state_lookup_failed", {
      requestId: getRequestId(req),
      userId: payload.sub,
      code: error?.code,
      message: String(error?.message || error),
    });
    return res.status(503).json({ error: "admin_auth_temporarily_unavailable" });
  }
}

export function requireAdminWritesEnabled(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!adminWritesEnabled()) {
    return res.status(423).json({ error: "admin_writes_disabled" });
  }
  return next();
}
