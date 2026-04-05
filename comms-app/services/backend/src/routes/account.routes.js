import { Router } from "express";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getActivePlan,
  listProductEntitlements,
} from "../services/entitlement.service.js";

export const accountRouter = Router();

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
        "stripe_payment_method_attached"
      )
      .where({ id: req.user.sub })
      .first();

    if (!user) {
      return res.status(404).json({ error: "user_not_found" });
    }

    const activePlan = await getActivePlan(req.user.sub);
    const entitlements = await listProductEntitlements(req.user.sub);

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