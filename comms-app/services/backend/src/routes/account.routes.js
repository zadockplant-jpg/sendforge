import { Router } from "express";
import { z } from "zod";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getActivePlan,
  listProductEntitlements,
} from "../services/entitlement.service.js";
import { ensureReferralCodeForUser, updateUserCashAppTag, tiersFromProgram } from "../services/referrals/referral.service.js";
import { sendReferralInviteEmail } from "../services/email.service.js";
import { env } from "../config/env.js";
import { getRequestId } from "../utils/logger.js";

export const accountRouter = Router();

const CashAppSchema = z.object({
  cashAppTag: z.string().max(100).optional().nullable(),
});

const ReferralInviteSchema = z.object({
  toEmail: z.string().email(),
  productSlug: z.string().max(80).optional().default("tabforge"),
});

function normalizeProductSlug(value) {
  return String(value || "tabforge").trim().toLowerCase() || "tabforge";
}

function publicSiteBase() {
  return String(env.publicSiteUrl || env.publicBaseUrl || "https://sendforge.app").replace(/\/+$/, "");
}

function toCamelReward(row) {
  return {
    id: row.id,
    productSlug: row.product_slug,
    rewardAmountCents: row.reward_amount_cents,
    rewardType: row.reward_type,
    cashAppHandle: row.cashapp_handle,
    status: row.status,
    adminNote: row.admin_note,
    approvedAt: row.approved_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    metadata: row.metadata || {},
  };
}

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
 * GET /v1/account/referrals
 * Account-owned referral dashboard snapshot.
 */
accountRouter.get("/referrals", requireAuth, async (req, res) => {
  try {
    const user = await db("users")
      .select("id", "email", "cash_app_tag", "referred_by_user_id", "referral_code_id")
      .where({ id: req.user.sub })
      .first();

    if (!user) return res.status(404).json({ error: "user_not_found" });

    const code = await ensureReferralCodeForUser(user);

    const [programRows, eventRows, rewardRows, entitlementRows] = await Promise.all([
      db("referral_programs").where({ status: "active" }).orderBy("product_slug", "asc"),
      db("referral_events")
        .where({ referrer_user_id: user.id, event_type: "purchase" })
        .orderBy("created_at", "desc")
        .limit(500),
      db("reward_queue")
        .where({ user_id: user.id })
        .orderBy("created_at", "desc")
        .limit(100),
      listProductEntitlements(user.id).catch(() => []),
    ]);

    const ownedProductSlugs = new Set(
      (entitlementRows || [])
        .map((row) => String(row.product_slug || "").toLowerCase())
        .filter(Boolean)
    );

    const verifiedByProduct = new Map();
    for (const row of eventRows) {
      if (row.status !== "verified") continue;
      const slug = row.product_slug || "unknown";
      verifiedByProduct.set(slug, (verifiedByProduct.get(slug) || 0) + 1);
    }

    const programs = programRows
      .filter((program) => {
        const slug = String(program.product_slug || "").toLowerCase();
        if (!slug || slug === "rentawifey") return false;
        return ownedProductSlugs.has(slug) || (verifiedByProduct.get(slug) || 0) > 0;
      })
      .map((program) => {
        const slug = String(program.product_slug || "").toLowerCase();
        const verifiedPurchases = verifiedByProduct.get(slug) || 0;
        const tiers = tiersFromProgram(program).map((tier) => ({
          requiredPurchases: tier.requiredPurchases,
          rewardAmountCents: tier.rewardAmountCents,
          reached: verifiedPurchases >= tier.requiredPurchases,
          remaining: Math.max(0, tier.requiredPurchases - verifiedPurchases),
        }));
        return {
          productSlug: slug,
          status: program.status,
          rewardType: program.reward_type,
          verifiedPurchases,
          tiers,
        };
      });

    return res.json({
      code: code
        ? {
            id: code.id,
            code: code.code,
            email: code.email,
            status: code.status,
            cashAppHandle: code.cashapp_handle,
          }
        : null,
      cashAppTag: user.cash_app_tag || null,
      referredByUserId: user.referred_by_user_id || null,
      totals: {
        verifiedPurchases: eventRows.filter((row) => row.status === "verified").length,
        pendingRewards: rewardRows.filter((row) => row.status === "pending").length,
        paidRewards: rewardRows.filter((row) => row.status === "paid").length,
      },
      programs,
      events: eventRows.slice(0, 25).map((row) => ({
        id: row.id,
        productSlug: row.product_slug,
        eventType: row.event_type,
        status: row.status,
        createdAt: row.created_at,
      })),
      rewards: rewardRows.map(toCamelReward),
    });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});

/**
 * POST /v1/account/referrals/invite
 * Sends a TabForge/product referral invite with this user's referral code.
 */
accountRouter.post("/referrals/invite", requireAuth, async (req, res) => {
  const parsed = ReferralInviteSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });

  try {
    const user = await db("users")
      .select("id", "email", "cash_app_tag")
      .where({ id: req.user.sub })
      .first();
    if (!user) return res.status(404).json({ error: "user_not_found" });

    const code = await ensureReferralCodeForUser(user);
    const productSlug = normalizeProductSlug(parsed.data.productSlug);
    const productName = productSlug === "tabforge" ? "TabForge" : productSlug;
    const params = new URLSearchParams();
    params.set("code", code?.code || user.email);
    params.set("next", "/account/index.html");
    params.set("product", productSlug);
    const referralUrl = `${publicSiteBase()}/signup.html?${params.toString()}`;

    const sendResult = await sendReferralInviteEmail({
      to: parsed.data.toEmail.toLowerCase().trim(),
      fromEmail: user.email,
      referralUrl,
      productName,
      requestId: getRequestId(req),
    });

    return res.json({
      ok: true,
      referralUrl,
      emailMode: sendResult?.mode || "sendgrid",
    });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});

async function handleCashAppUpdate(req, res) {
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
}

/**
 * PATCH /v1/account/cashapp
 * Adds or updates the Cash App tag used for manual referral payouts.
 */
accountRouter.patch("/cashapp", requireAuth, handleCashAppUpdate);

/**
 * PATCH /v1/account/cash-app
 * Compatibility alias for Cash App tag updates while frontend/backend deploys catch up.
 */
accountRouter.patch("/cash-app", requireAuth, handleCashAppUpdate);
