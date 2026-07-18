import {
  customerTokenMatchesUser,
  getCurrentCustomerAuthState,
  verifyCustomerAccessToken,
} from "../services/auth.service.js";
import { log, getRequestId } from "../utils/logger.js";

/**
 * Sets req.user = { sub: userId, email }
 */
export async function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

  if (!token) return res.status(401).json({ error: "missing_token" });

  let payload;
  try {
    payload = verifyCustomerAccessToken(token);
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }

  try {
    const user = await getCurrentCustomerAuthState(payload.sub);
    if (!customerTokenMatchesUser(payload, user)) {
      return res.status(401).json({ error: "invalid_token" });
    }
    req.user = {
      ...payload,
      sub: user.id,
      email: user.email,
      auth_version: user.auth_version,
    };
    return next();
  } catch (error) {
    log("error", "auth_state_lookup_failed", {
      requestId: getRequestId(req),
      userId: payload.sub,
      code: error?.code,
      message: String(error?.message || error),
    });
    return res.status(503).json({ error: "auth_temporarily_unavailable" });
  }
}
