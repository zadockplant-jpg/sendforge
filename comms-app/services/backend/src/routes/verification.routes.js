// src/routes/verification.routes.js
import { Router } from "express";
import crypto from "crypto";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import { log, getRequestId } from "../utils/logger.js";
import { recordVerifiedReferralPurchases, recordVerifiedReferralSignup } from "../services/referrals/referral.service.js";
import { redeemPendingCompCodeForVerifiedUser } from "../services/compCodes.service.js";
import { issueCustomerAccessToken } from "../services/auth.service.js";
import { safeSitePath, siteUrl } from "../utils/sitePaths.js";

export const verificationRouter = Router();

const TOKEN_TTL_HOURS = 24;

// A person clicking the emailed link is sent back to the website, signed in,
// and on to where they were headed (`next`, such as a program's checkout):
// the owner asked for verifying to go straight back to paying (2026-09-27).
// The link could only have reached the address's owner, so it signs them in
// the way a password would. Anything that does not ask for a page (scripts,
// tests) keeps the JSON answer.
function wantsPage(req) {
  return String(req.get("accept") || "").toLowerCase().includes("text/html");
}

// The session rides in the fragment, which browsers never send to a server
// and never put in a Referer header; /verified.html stores it and moves on.
export function verifiedPageUrl({ token = "", error = "", next = "" } = {}) {
  const page = siteUrl("/verified.html");
  const back = next ? `&next=${encodeURIComponent(next)}` : "";
  if (token) return `${page}#token=${encodeURIComponent(token)}${back}`;
  return `${page}?error=${encodeURIComponent(error || "server_error")}${back}`;
}

verificationRouter.get("/verify", async (req, res) => {
  const requestId = getRequestId(req);
  const page = wantsPage(req);
  const next = safeSitePath(String(req.query.next || ""));

  const fail = (status, error) => {
    if (!page) return res.status(status).json({ ok: false, error });
    res.set("Cache-Control", "no-store");
    return res.redirect(302, verifiedPageUrl({ error, next }));
  };

  const token = String(req.query.token || "").trim();
  if (!token) {
    return fail(400, "missing_token");
  }

  const tokenHash = sha256(token);

  try {
    const user = await db("users")
      .where({ verification_token_hash: tokenHash })
      .first();

    if (!user) {
      log("warn", "verify_invalid_token", { requestId });
      return fail(400, "invalid_or_used_token");
    }

    // Expiry check
    if (user.verification_sent_at) {
      const sentAt = new Date(user.verification_sent_at).getTime();
      const ttlMs = TOKEN_TTL_HOURS * 60 * 60 * 1000;
      if (Date.now() - sentAt > ttlMs) {
        log("warn", "verify_token_expired", { requestId, userId: user.id });
        return fail(400, "token_expired");
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

    log("info", "verify_success", { requestId, userId: user.id, next: next || null });

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

    if (!page) return res.json({ ok: true });

    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    let session = "";
    try {
      session = env.jwtSecret
        ? issueCustomerAccessToken({ id: user.id, email: user.email, authVersion: user.auth_version || 0 })
        : "";
    } catch (tokenError) {
      log("error", "verify_session_failed", { requestId, userId: user.id, code: tokenError?.code || null });
    }
    // Verified either way; without a session the page asks them to sign in.
    return res.redirect(302, session
      ? verifiedPageUrl({ token: session, next })
      : verifiedPageUrl({ error: "sign_in_needed", next }));
  } catch (e) {
    log("error", "verify_server_error", {
      requestId,
      error: String(e?.message || e),
    });
    return fail(500, "server_error");
  }
});

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}
