import { Router } from "express";
import { z } from "zod";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getActivePlan,
  listProductEntitlements,
} from "../services/entitlement.service.js";
import {
  TABFORGE_SYNC_PLAN_ALIASES,
  tabForgeAccountBillingStatus,
} from "../services/tabforgeBilling.service.js";
import {
  createReferralInvite,
  ensureReferralCodeForUser,
  hasReferralProgramEligibility,
  REFERRAL_REQUIRED_PRODUCT_SLUG,
  resolveReferralInviteToken,
  tiersForVerifiedCount,
  updateUserCashAppTag,
} from "../services/referrals/referral.service.js";
import {
  EmailSendError,
  sendReferralInviteEmail,
} from "../services/email.service.js";
import {
  markReferralInviteEmailAccepted,
  markReferralInviteEmailFailed,
  referralInviteCooldownRemainingMs,
  REFERRAL_INVITE_AMBIGUITY_COOLDOWN_MS,
  REFERRAL_INVITE_DELIVERY_COOLDOWN_MS,
} from "../services/emailDelivery.service.js";
import {
  createRateLimiter,
  normalizeRateLimitEmail,
  rateLimitByUserOrIp,
} from "../middleware/rateLimit.js";
import {
  createEmailUnsubscribeToken,
  isSuppressed,
  isReferralDestinationSuppressed,
} from "../services/suppression.service.js";
import { env } from "../config/env.js";
import {
  clearCustomerAuthStateCache,
  issueCustomerAccessToken,
} from "../services/auth.service.js";
import { preparePasswordChange } from "../services/passwordChange.service.js";
import {
  getRequestId,
  log,
  sanitizeEmail,
} from "../utils/logger.js";

export const accountRouter = Router();

const CashAppSchema = z.object({
  cashAppTag: z.string().max(100).optional().nullable(),
});

const ReferralInviteSchema = z.object({
  toEmail: z.string().email().max(320),
  productSlug: z.literal("tabforge").optional().default("tabforge"),
  recipientConsent: z.literal(true),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(1024),
  newPassword: z.string().min(8).max(72),
});

const REFERRAL_INVITE_HOURLY_LIMIT = 100;
const REFERRAL_UNLIMITED_TEST_EMAILS = new Set(
  String(
    process.env.REFERRAL_UNLIMITED_TEST_EMAILS ||
      "zadockplant@gmail.com"
  )
    .split(/[\s,]+/)
    .map((email) => normalizeRateLimitEmail(email))
    .filter((email) => email !== "unknown-email")
);

function isUnlimitedReferralTestEmail(email) {
  return REFERRAL_UNLIMITED_TEST_EMAILS.has(
    normalizeRateLimitEmail(email)
  );
}

function referralInviteLimitsBypassedForRequest(req) {
  return isUnlimitedReferralTestEmail(req.user?.email);
}

const referralInviteUserRateLimiter = createRateLimiter({
  name: "referral-invite-user",
  windowMs: 60 * 60 * 1000,
  max: REFERRAL_INVITE_HOURLY_LIMIT,
  keyGenerator: rateLimitByUserOrIp,
  message: "too_many_referral_invites",
  skip: referralInviteLimitsBypassedForRequest,
});

const passwordChangeRateLimiter = createRateLimiter({
  name: "account-password-change",
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: rateLimitByUserOrIp,
  message: "too_many_password_change_attempts",
});

const referralInviteRecipientRateLimiter = createRateLimiter({
  name: "referral-invite-user-recipient",
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => {
    const userId = rateLimitByUserOrIp(req);
    const recipient = normalizeRateLimitEmail(req.body?.toEmail);
    return `${userId}:${recipient}`;
  },
  message: "too_many_invites_to_recipient",
  skip: referralInviteLimitsBypassedForRequest,
});

const referralInviteDestinationRateLimiter = createRateLimiter({
  name: "referral-invite-destination",
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => normalizeRateLimitEmail(req.body?.toEmail),
  message: "too_many_invites_to_recipient",
  skip: referralInviteLimitsBypassedForRequest,
});

function normalizeProductSlug(value) {
  return String(value || "tabforge").trim().toLowerCase() || "tabforge";
}

function publicSiteBase() {
  return String(env.publicSiteUrl || env.publicBaseUrl || "https://sendforge.app").replace(/\/+$/, "");
}

async function prepareReferralInvite({
  user,
  recipientEmail,
  productSlug,
  recipientConsentAttested,
  bypassLimits = false,
}) {
  const senderWindowMs = 60 * 60 * 1000;
  const senderLimit = REFERRAL_INVITE_HOURLY_LIMIT;
  const lockKeys = [
    `referral-destination:${productSlug}:${recipientEmail}`,
    `referral-sender:${productSlug}:${user.id}`,
  ].sort();

  return db.transaction(async (trx) => {
    if (
      !(await hasReferralProgramEligibility(
        user.id,
        productSlug,
        trx
      ))
    ) {
      return {
        error: "tabforge_pro_required",
        statusCode: 403,
      };
    }

    if (!bypassLimits) {
      // These transaction-scoped locks make the durable sender and destination
      // counts race-safe across every Render process. Sorting prevents deadlocks.
      for (const lockKey of lockKeys) {
        await trx.raw(
          "select pg_advisory_xact_lock(hashtextextended(?::text, 0))",
          [lockKey]
        );
      }

      const senderRows = await trx("referral_events")
        .select("created_at")
        .where({
          referrer_user_id: user.id,
          product_slug: productSlug,
          event_type: "invite",
        })
        .where("created_at", ">", new Date(Date.now() - senderWindowMs))
        .orderBy("created_at", "asc");
      if (senderRows.length >= senderLimit) {
        const oldestAt = new Date(senderRows[0].created_at).getTime();
        const remainingMs = Number.isFinite(oldestAt)
          ? Math.max(1, oldestAt + senderWindowMs - Date.now())
          : senderWindowMs;
        return {
          error: "too_many_referral_invites",
          statusCode: 429,
          retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
        };
      }

      const recentRows = await trx("referral_events")
        .select("created_at", "status", "metadata")
        .where({
          product_slug: productSlug,
          event_type: "invite",
        })
        .where(
          "created_at",
          ">",
          new Date(
            Date.now() - REFERRAL_INVITE_DELIVERY_COOLDOWN_MS
          )
        )
        .whereRaw("metadata ->> 'recipient_email' = ?", [recipientEmail])
        .orderBy("created_at", "desc")
        .limit(50);

      const stateCooldownRemainingMs = recentRows.reduce(
        (max, row) =>
          Math.max(max, referralInviteCooldownRemainingMs(row)),
        0
      );
      const oldestLimitedRow =
        recentRows.length >= 5
          ? recentRows[4]
          : null;
      const oldestLimitedAt = oldestLimitedRow
        ? new Date(oldestLimitedRow.created_at).getTime()
        : Number.NaN;
      const volumeCooldownRemainingMs =
        Number.isFinite(oldestLimitedAt)
          ? Math.max(
              0,
              oldestLimitedAt +
                REFERRAL_INVITE_DELIVERY_COOLDOWN_MS -
                Date.now()
            )
          : 0;
      const remainingMs = Math.max(
        stateCooldownRemainingMs,
        volumeCooldownRemainingMs
      );
      if (remainingMs > 0) {
        return {
          error:
            volumeCooldownRemainingMs > 0
              ? "too_many_invites_to_recipient"
              : "invite_recently_sent",
          statusCode: volumeCooldownRemainingMs > 0 ? 429 : 409,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(remainingMs / 1000)
          ),
        };
      }
    }

    const code = await ensureReferralCodeForUser(user, trx);
    const invite = await createReferralInvite({
      referrerUser: user,
      referralCode: code,
      recipientEmail,
      productSlug,
      recipientConsentAttested,
      trx,
    });
    const unsubscribeToken = await createEmailUnsubscribeToken({
      userId: user.id,
      destination: recipientEmail,
      trx,
    });
    return { invite, unsubscribeToken };
  });
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

    const [activePlan, entitlementRows, tabForgeSubscription] =
      await Promise.all([
        getActivePlan(req.user.sub),
        listProductEntitlements(req.user.sub),
        db("subscriptions")
          .where({
            user_id: req.user.sub,
            provider: "stripe",
          })
          .whereIn("plan", TABFORGE_SYNC_PLAN_ALIASES)
          .orderByRaw(
            "case when status in ('active', 'trialing') then 0 else 1 end"
          )
          .orderBy("updated_at", "desc")
          .first(),
      ]);
    const referralEligible = await hasReferralProgramEligibility(user.id);
    const referralCode = referralEligible
      ? await ensureReferralCodeForUser(user)
      : null;

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
        referralEligible,
        referredByUserId: user.referred_by_user_id || null,
      },
      referralEligibility: {
        eligible: referralEligible,
        reason: referralEligible ? null : "tabforge_pro_required",
        requiredProductSlug: REFERRAL_REQUIRED_PRODUCT_SLUG,
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
        tabForge: tabForgeAccountBillingStatus({
          entitlements: entitlementRows,
          subscription: tabForgeSubscription,
          hasStripeCustomer: Boolean(user.stripe_customer_id),
        }),
      },
      // Keep every active entitlement. The extension relies on legacy pack
      // and skin slugs as well as the canonical Pro/Private Sync products.
      entitlements: entitlementRows.map((row) => ({
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
 * PATCH /v1/account/password
 * Changes the signed-in customer's password and revokes every older token.
 * A replacement token keeps only this browser signed in.
 */
accountRouter.patch(
  "/password",
  requireAuth,
  passwordChangeRateLimiter,
  async (req, res) => {
    const requestId = getRequestId(req);
    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_input" });
    }

    try {
      const user = await db("users")
        .select("id", "email", "password_hash", "auth_version")
        .where({ id: req.user.sub })
        .first();
      if (!user) return res.status(404).json({ error: "user_not_found" });

      const replacement = await preparePasswordChange({
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
        passwordHash: user.password_hash,
      });
      if (replacement.error === "current_password_incorrect") {
        return res.status(403).json({ error: replacement.error });
      }
      if (replacement.error) {
        return res.status(400).json({ error: replacement.error });
      }

      const currentAuthVersion = Number(user.auth_version || 0);
      const nextAuthVersion = currentAuthVersion + 1;
      const token = issueCustomerAccessToken({
        id: user.id,
        email: user.email,
        authVersion: nextAuthVersion,
        sessionStartedAt: req.user.session_started_at,
      });
      const updated = await db("users")
        .where({
          id: user.id,
          password_hash: user.password_hash,
          auth_version: currentAuthVersion,
        })
        .update({
          password_hash: replacement.passwordHash,
          verification_token_hash: null,
          verification_sent_at: null,
          auth_version: nextAuthVersion,
        });

      if (!updated) {
        return res.status(409).json({ error: "password_changed_elsewhere" });
      }

      clearCustomerAuthStateCache(user.id);
      log("info", "account_password_change_success", {
        requestId,
        userId: user.id,
      });
      return res.json({ ok: true, token, email: user.email });
    } catch (error) {
      log("error", "account_password_change_failed", {
        requestId,
        userId: req.user?.sub,
        code: error?.code,
        message: String(error?.message || error),
      });
      return res.status(500).json({ error: "server_error" });
    }
  }
);

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

    const eligible = await hasReferralProgramEligibility(user.id);
    const unlimitedTesting = isUnlimitedReferralTestEmail(user.email);
    const code = eligible ? await ensureReferralCodeForUser(user) : null;

    const [
      programRows,
      inviteRows,
      signupRows,
      purchaseRows,
      rewardRows,
      inviteCountRow,
      verifiedSignupCountRow,
      verifiedPurchaseCountRow,
    ] = await Promise.all([
      db("referral_programs")
        .where({ product_slug: "tabforge", status: "active" })
        .orderBy("product_slug", "asc"),
      db("referral_events")
        .where({
          referrer_user_id: user.id,
          product_slug: "tabforge",
          event_type: "invite",
        })
        .orderBy("created_at", "desc")
        .limit(500),
      db("referral_events")
        .where({
          referrer_user_id: user.id,
          product_slug: "tabforge",
          event_type: "signup",
        })
        .orderBy("created_at", "desc")
        .limit(500),
      db("referral_events")
        .where({
          referrer_user_id: user.id,
          product_slug: "tabforge",
          event_type: "purchase",
        })
        .orderBy("created_at", "desc")
        .limit(500),
      db("reward_queue")
        .where({ user_id: user.id, product_slug: "tabforge" })
        .orderBy("created_at", "desc")
        .limit(100),
      db("referral_events")
        .where({ referrer_user_id: user.id, product_slug: "tabforge", event_type: "invite" })
        .andWhere(function countAcceptedOrClaimedInvites() {
          this.whereIn("status", ["sent", "claimed"]).orWhereRaw(
            "metadata #>> '{email_delivery,status}' in (?, ?, ?, ?)",
            ["accepted", "processed", "deferred", "delivered"]
          );
        })
        .count({ count: "id" })
        .first(),
      db("referral_events")
        .where({ referrer_user_id: user.id, product_slug: "tabforge", event_type: "signup", status: "verified" })
        .count({ count: "id" })
        .first(),
      db("referral_events")
        .where({ referrer_user_id: user.id, product_slug: "tabforge", event_type: "purchase", status: "verified" })
        .whereRaw("metadata->>'initial_net_paid_cents' ~ '^[1-9][0-9]*$'")
        .countDistinct({ count: "referred_user_id" })
        .first(),
    ]);

    const invitesSent = Number(inviteCountRow?.count || 0);
    const verifiedReferrals = Number(verifiedSignupCountRow?.count || 0);
    const verifiedPurchases = Number(verifiedPurchaseCountRow?.count || 0);

    const programs = programRows.map((program) => {
      const tiers = tiersForVerifiedCount(program, verifiedPurchases).map((tier) => ({
        requiredPurchases: tier.requiredPurchases,
        rewardAmountCents: tier.rewardAmountCents,
        recurring: Boolean(tier.recurring),
        reached: verifiedPurchases >= tier.requiredPurchases,
        remaining: Math.max(0, tier.requiredPurchases - verifiedPurchases),
      }));

      return {
        productSlug: "tabforge",
        status: program.status,
        rewardType: program.reward_type,
        qualification: "verified_purchase",
        referrerPurchaseRequired: true,
        requiredReferrerProductSlug: REFERRAL_REQUIRED_PRODUCT_SLUG,
        referredPurchaseRequired: true,
        verifiedReferrals,
        verifiedPurchases,
        tiers,
      };
    });

    const fallbackTiers = [
      { requiredPurchases: 5, rewardAmountCents: 1700, reached: verifiedPurchases >= 5, remaining: Math.max(0, 5 - verifiedPurchases) },
      { requiredPurchases: 15, rewardAmountCents: 3500, reached: verifiedPurchases >= 15, remaining: Math.max(0, 15 - verifiedPurchases) },
      { requiredPurchases: 25, rewardAmountCents: 4000, reached: verifiedPurchases >= 25, remaining: Math.max(0, 25 - verifiedPurchases) },
      { requiredPurchases: 50, rewardAmountCents: 15000, reached: verifiedPurchases >= 50, remaining: Math.max(0, 50 - verifiedPurchases) },
    ];

    return res.json({
      eligible,
      eligibility: {
        eligible,
        reason: eligible ? null : "tabforge_pro_required",
        requiredProductSlug: REFERRAL_REQUIRED_PRODUCT_SLUG,
      },
      invitePolicy: {
        hourlyLimit: unlimitedTesting
          ? null
          : REFERRAL_INVITE_HOURLY_LIMIT,
        unlimitedTesting,
        duplicateRecipientCooldownHours: unlimitedTesting ? 0 : 24,
        supportsBulkPaste: true,
        supportsCsvImport: true,
      },
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
      rule: {
        productSlug: "tabforge",
        requiredPurchases: 5,
        rewardAmountCents: 1700,
        qualification: "verified_purchase",
        referrerPurchaseRequired: true,
        requiredReferrerProductSlug: REFERRAL_REQUIRED_PRODUCT_SLUG,
        referredPurchaseRequired: true,
        tiers: programs[0]?.tiers || fallbackTiers,
      },
      totals: {
        invitesSent,
        verifiedReferrals,
        verifiedPurchases,
        pendingRewards: rewardRows.filter((row) => row.status === "pending").length,
        paidRewards: rewardRows.filter((row) => row.status === "paid").length,
      },
      programs,
      events: [...inviteRows, ...signupRows, ...purchaseRows]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 25)
        .map((row) => ({
          id: row.id,
          productSlug: row.product_slug,
          eventType: row.event_type,
          status: row.status,
          emailStatus:
            row.event_type === "invite"
              ? row.metadata?.email_delivery?.status ||
                (row.status === "sent" ? "accepted" : null)
              : null,
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
 * GET /v1/account/referrals/invite/:token
 * Public invite resolver used by the signup page. Returns only the invited
 * recipient email and product context; the referrer stays server-side.
 */
accountRouter.get("/referrals/invite/:token", async (req, res) => {
  try {
    const invite = await resolveReferralInviteToken(req.params.token);
    if (!invite) return res.status(404).json({ error: "invalid_or_expired_invite" });

    return res.json({
      ok: true,
      recipientEmail: invite.recipientEmail,
      productSlug: invite.productSlug,
      referralCode: invite.referralCode?.code || null,
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
 * Sends a tracked TabForge invite. The recipient email is bound to a private
 * invite token and is prefilled on signup; the referrer's identity is not put
 * into the signup email field.
 */
accountRouter.post(
  "/referrals/invite",
  requireAuth,
  referralInviteUserRateLimiter,
  referralInviteDestinationRateLimiter,
  referralInviteRecipientRateLimiter,
  async (req, res) => {
    if (req.body?.recipientConsent !== true) {
      return res
        .status(400)
        .json({ error: "recipient_consent_required" });
    }
    const parsed = ReferralInviteSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_input" });
    }

    let invite = null;
    const requestId = getRequestId(req);

    try {
      const user = await db("users")
        .select("id", "email", "cash_app_tag")
        .where({ id: req.user.sub })
        .first();
      if (!user) return res.status(404).json({ error: "user_not_found" });
      if (!(await hasReferralProgramEligibility(user.id))) {
        return res.status(403).json({
          error: "tabforge_pro_required",
          requiredProductSlug: REFERRAL_REQUIRED_PRODUCT_SLUG,
        });
      }

      const recipientEmail = parsed.data.toEmail.toLowerCase().trim();
      if (recipientEmail === String(user.email || "").toLowerCase().trim()) {
        return res.status(400).json({ error: "self_referral_not_allowed" });
      }
      const [senderSuppressed, globallySuppressed] = await Promise.all([
        isSuppressed({
          userId: user.id,
          channel: "email",
          destination: recipientEmail,
        }),
        isReferralDestinationSuppressed(recipientEmail),
      ]);
      if (senderSuppressed || globallySuppressed) {
        return res.status(409).json({ error: "recipient_suppressed" });
      }

      const productSlug = normalizeProductSlug(parsed.data.productSlug);
      const bypassLimits = isUnlimitedReferralTestEmail(user.email);
      const prepared = await prepareReferralInvite({
        user,
        recipientEmail,
        productSlug,
        recipientConsentAttested:
          parsed.data.recipientConsent,
        bypassLimits,
      });
      if (prepared.retryAfterSeconds) {
        res.set(
          "Retry-After",
          String(prepared.retryAfterSeconds)
        );
        return res.status(prepared.statusCode || 409).json({
          error: prepared.error || "invite_recently_sent",
          retryAfterSeconds: prepared.retryAfterSeconds,
        });
      }
      if (prepared.error) {
        return res.status(prepared.statusCode || 409).json({
          error: prepared.error,
        });
      }

      const productName = productSlug === "tabforge" ? "TabForge" : productSlug;
      invite = prepared.invite;

      const params = new URLSearchParams();
      params.set("invite", invite.token);
      params.set("next", "/store/index.html");
      params.set("product", productSlug);
      const referralUrl = `${publicSiteBase()}/signup.html?${params.toString()}`;
      const unsubscribeUrl =
        `${env.publicBaseUrl.replace(/\/+$/, "")}/v1/unsubscribe` +
        `?token=${encodeURIComponent(prepared.unsubscribeToken)}`;

      const sendResult = await sendReferralInviteEmail({
        to: recipientEmail,
        fromEmail: user.email,
        referralUrl,
        productName,
        requestId,
        referralEventId: invite.event.id,
        unsubscribeUrl,
      });
      await markReferralInviteEmailAccepted({
        referralEventId: invite.event.id,
        sendResult,
      }).catch((metadataError) => {
        // The signed webhook carries this event ID and can still reconcile
        // delivery. Do not encourage a duplicate send after provider acceptance.
        log("error", "referral_email_acceptance_state_update_failed", {
          requestId,
          referralEventId: invite.event.id,
          code: metadataError?.code,
        });
      });

      return res.json({
        ok: true,
        referralUrl,
        recipientEmail,
        emailMode: sendResult?.mode || "sendgrid",
        emailStatus: sendResult?.status || "accepted",
      });
    } catch (err) {
      if (err?.code === "SELF_REFERRAL") {
        return res.status(400).json({ error: "self_referral_not_allowed" });
      }
      if (invite?.event?.id && err instanceof EmailSendError) {
        await markReferralInviteEmailFailed({
          referralEventId: invite.event.id,
          error: err,
        }).catch((metadataError) => {
          log("error", "referral_email_failure_state_update_failed", {
            requestId,
            referralEventId: invite.event.id,
            code: metadataError?.code,
          });
        });
      }
      if (err instanceof EmailSendError) {
        const deliveryUnknown = err.code === "network_error";
        const retryAfterSeconds = Math.ceil(
          REFERRAL_INVITE_AMBIGUITY_COOLDOWN_MS / 1000
        );
        log("error", "referral_email_send_failed", {
          requestId,
          referralEventId: invite?.event?.id || null,
          recipient: sanitizeEmail(parsed.data.toEmail),
          code: err.code,
        });
        res.set("Retry-After", String(retryAfterSeconds));
        return res.status(502).json({
          error: "referral_email_failed",
          canRetry: !deliveryUnknown,
          deliveryUnknown,
          retryAfterSeconds,
        });
      }
      return res.status(500).json({ error: "server_error" });
    }
  }
);

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
    const knownErrors = new Set([
      "cash_app_tag_in_use",
      "cash_app_tag_locked_for_approved_payout",
    ]);
    const code = String(err?.code || err?.message || "");
    if (knownErrors.has(code)) {
      return res.status(err?.statusCode || 409).json({ error: code });
    }
    if (code === "23505") {
      return res.status(409).json({ error: "cash_app_tag_in_use" });
    }
    if (code === "42P01") {
      return res.status(503).json({ error: "cash_app_storage_unavailable" });
    }
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
