import { Router } from "express";
import { z } from "zod";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getActivePlan,
  listProductEntitlements,
} from "../services/entitlement.service.js";
import { ensureReferralCodeForUser, updateUserCashAppTag } from "../services/referrals/referral.service.js";

export const accountRouter = Router();

const CashAppSchema = z.object({
  cashAppTag: z.string().max(100).optional().nullable(),
});

/**
 * GET /v1/account/me
 * Safe account snapshot for website / extension / future clients.
 */
accountRouter.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await db("users")
      .select(
        "id",
        "email",
        "created_at",
        "plan_tier",
        "billing_source",
        "email_verified",
        "verified_at",
        "stripe_customer_id",
        "stripe_payment_method_attached",
        "cash_app_tag",
        "referred_by_user_id",
        "referral_code_id"
      )
      .where({ id: req.user.sub })
      .first();

    if (!user) {
      return res.status(404).json({ error: "user_not_found" });
    }

    const activePlan = await getActivePlan(req.user.sub);
    const entitlements = await listProductEntitlements(req.user.sub);
    const referralCode = await ensureReferralCodeForUser(user);

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.created_at,
        emailVerified: Boolean(user.email_verified),
        verifiedAt: user.verified_at,
        planTier: user.plan_tier || "free",
        billingSource: user.billing_source || "stripe",
        hasStripeCustomer: Boolean(user.stripe_customer_id),
        stripePaymentMethodAttached: Boolean(user.stripe_payment_method_attached),
        cashAppTag: user.cash_app_tag || null,
        referralCode: referralCode?.code || null,
        referredByUserId: user.referred_by_user_id || null,
      },
      billing: {
        activePlan: activePlan.plan,
        limits: activePlan.limits,
        subscription: activePlan.subscription
          ? {
              provider: activePlan.subscription.provider,
              plan: activePlan.subscription.plan,
              status: activePlan.subscription.status,
              currentPeriodStart: activePlan.subscription.current_period_start,
              currentPeriodEnd: activePlan.subscription.current_period_end,
            }
          : null,
      },
      entitlements: entitlements.map((row) => ({
        productSlug: row.product_slug,
        status: row.status,
        source: row.source,
        grantedAt: row.granted_at,
        expiresAt: row.expires_at,
      })),
    });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});

/**
 * GET /v1/account/entitlements
 * Direct owned-products endpoint.
 */
accountRouter.get("/entitlements", requireAuth, async (req, res) => {
  try {
    const entitlements = await listProductEntitlements(req.user.sub);
    return res.json({
      items: entitlements.map((row) => ({
        productSlug: row.product_slug,
        status: row.status,
        source: row.source,
        sourceRef: row.source_ref,
        grantedAt: row.granted_at,
        expiresAt: row.expires_at,
        metadata: row.metadata || {},
      })),
    });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});
/**
 * PATCH /v1/account/cashapp
 * Adds or updates the Cash App tag used for manual referral payouts.
 */
accountRouter.patch("/cashapp", requireAuth, async (req, res) => {
  const parsed = CashAppSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });

  try {
    const user = await updateUserCashAppTag({
      userId: req.user.sub,
      cashAppTag: parsed.data.cashAppTag || "",
    });

    if (!user) return res.status(404).json({ error: "user_not_found" });

    return res.json({
      ok: true,
      cashAppTag: user.cash_app_tag || null,
    });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});
