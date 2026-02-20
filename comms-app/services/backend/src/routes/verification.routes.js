import { Router } from "express";
import crypto from "crypto";
import { db } from "../config/db.js";
import { env } from "../config/env.js";

/**
 * GET /v1/auth/verify?token=...
 * - validates token (hashed in DB)
 * - marks user email_verified=true
 */
export const verificationRouter = Router();

const TOKEN_TTL_HOURS = 24;

verificationRouter.get("/verify", async (req, res) => {
  const token = String(req.query.token || "").trim();
  if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

  const tokenHash = sha256(token);

  const user = await db("users")
    .where({ verification_token_hash: tokenHash })
    .first();

  if (!user) {
    return res.status(400).json({ ok: false, error: "invalid_or_used_token" });
  }

  // Expiry check (if sent_at exists)
  if (user.verification_sent_at) {
    const sentAt = new Date(user.verification_sent_at).getTime();
    const now = Date.now();
    const ttlMs = TOKEN_TTL_HOURS * 60 * 60 * 1000;
    if (now - sentAt > ttlMs) {
      return res.status(400).json({ ok: false, error: "token_expired" });
    }
  }

  await db("users")
    .where({ id: user.id })
    .update({
      email_verified: true,
      verified_at: new Date(),
      verification_token_hash: null,
    });

  // Minimal: JSON ok. (You can later redirect to a pretty page.)
  return res.json({
    ok: true,
    message: "Email verified. You can return to the app and log in.",
    publicBaseUrl: env.publicBaseUrl,
  });
});

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}