// src/routes/verification.routes.js
import { Router } from "express";
import crypto from "crypto";
import { db } from "../config/db.js";
import { log, getRequestId } from "../utils/logger.js";

/**
 * GET /v1/auth/verify?token=...
 * - validates token (hashed in DB)
 * - marks user email_verified=true
 */
export const verificationRouter = Router();

const TOKEN_TTL_HOURS = 24;

verificationRouter.get("/verify", async (req, res) => {
  const requestId = getRequestId(req);

  const token = String(req.query.token || "").trim();
  if (!token) {
    return res.status(400).json({ ok: false, error: "missing_token" });
  }

  const tokenHash = sha256(token);

  try {
    const user = await db("users")
      .where({ verification_token_hash: tokenHash })
      .first();

    if (!user) {
      log("warn", "verify_invalid_token", { requestId });
      return res.status(400).json({ ok: false, error: "invalid_or_used_token" });
    }

    // Expiry check (if sent_at exists)
    if (user.verification_sent_at) {
      const sentAt = new Date(user.verification_sent_at).getTime();
      const now = Date.now();
      const ttlMs = TOKEN_TTL_HOURS * 60 * 60 * 1000;
      if (now - sentAt > ttlMs) {
        log("warn", "verify_token_expired", { requestId, userId: user.id });
        return res.status(400).json({ ok: false, error: "token_expired" });
      }
    }

    await db("users")
      .where({ id: user.id })
      .update({
        email_verified: true,
        verified_at: new Date(),
        verification_token_hash: null,
        verification_sent_at: null,
      });

    log("info", "verify_success", { requestId, userId: user.id });

    return res.json({
      ok: true,
      message: "Email verified. You can return to the app and log in.",
    });
  } catch (e) {
    log("error", "verify_server_error", {
      requestId,
      error: String(e?.message || e),
    });
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}