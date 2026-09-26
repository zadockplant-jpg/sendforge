// src/routes/verification.routes.js
import { Router } from "express";
import crypto from "crypto";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import { log, getRequestId } from "../utils/logger.js";
import { recordVerifiedReferralPurchases, recordVerifiedReferralSignup } from "../services/referrals/referral.service.js";
import { redeemPendingCompCodeForVerifiedUser } from "../services/compCodes.service.js";

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

    // Expiry check
    if (user.verification_sent_at) {
      const sentAt = new Date(user.verification_sent_at).getTime();
      const ttlMs = TOKEN_TTL_HOURS * 60 * 60 * 1000;
      if (Date.now() - sentAt > ttlMs) {
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

    // Verification does not qualify a payout by itself. It only records the
    // verified account and promotes any already-completed TabForge Pro purchase
    // from pending to qualified. Referral processing must never block verification.
    try {
      const referralResult = await recordVerifiedReferralSignup({
        referredUserId: user.id,
        productSlug: "tabforge",
      });
      log("info", "verified_referral_state_processed", {
        requestId,
        userId: user.id,
        signupRecorded: Boolean(referralResult?.recorded),
        qualifiedPurchaseCount: Number(referralResult?.verifiedCount || 0),
        promotedPurchases: Number(referralResult?.promotedPurchases || 0),
        rewardsQueued: Array.isArray(referralResult?.rewards) ? referralResult.rewards.length : 0,
        reason: referralResult?.reason || null,
      });
      // Purchases of the other products with a referral programme (Rose
      // Colored Glasses, ForgeDrop) made before verifying count now too.
      const productResult = await recordVerifiedReferralPurchases({ referredUserId: user.id });
      if (productResult.promoted) {
        log("info", "verified_referral_purchases_promoted", {
          requestId,
          userId: user.id,
          promotedPurchases: productResult.promoted,
          rewardsQueued: productResult.rewards.length,
        });
      }
    } catch (referralError) {
      log("error", "verified_referral_state_failed", {
        requestId,
        userId: user.id,
        error: String(referralError?.message || referralError),
      });
    }

    // A comp code entered at signup grants TabForge Pro and Private Sync now
    // that the address is verified. It must never block verification either.
    try {
      const comp = await redeemPendingCompCodeForVerifiedUser(user.id);
      if (comp?.granted || (comp?.reason && comp.reason !== "no_code")) {
        log("info", "comp_code_signup_processed", { requestId, userId: user.id, granted: Boolean(comp?.granted), reason: comp?.reason || null });
      }
    } catch (compError) {
      log("error", "comp_code_signup_failed", { requestId, userId: user.id, error: String(compError?.message || compError) });
    }

    // Keep it simple for now: JSON response. (You can later redirect to app deep link.)
    return res.json({ ok: true });
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