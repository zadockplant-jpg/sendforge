import { Router } from "express";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter, rateLimitByUserOrIp } from "../middleware/rateLimit.js";
import {
  hasProductEntitlement,
  TABFORGE_CLOUD_ENTITLEMENTS,
} from "../services/entitlement.service.js";
import {
  isActiveTabForgeSubscriptionStatus,
  tabForgePastDueSince,
  TABFORGE_SYNC_PLAN_ALIASES,
} from "../services/tabforgeBilling.service.js";

export const tabforgeCloudRouter = Router();

const TABFORGE_CLOUD_OWNER_EMAIL = String(
  process.env.TABFORGE_CLOUD_OWNER_EMAIL ||
    process.env.ADMIN_LIVE_TEST_OWNER_EMAIL ||
    "zadockplant@gmail.com"
)
  .trim()
  .toLowerCase();

const STORAGE_LIMIT_BYTES = 20_000_000_000;
const DEVICE_LIMIT = 5;

const tabforgeCloudAccessLimiter = createRateLimiter({
  name: "tabforge-cloud-access",
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: rateLimitByUserOrIp,
  message: "too_many_tabforge_cloud_access_checks",
});

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function cloudAccessMode(userId, email) {
  if (normalizeEmail(email) === TABFORGE_CLOUD_OWNER_EMAIL) return "sync";

  const syncEntitlements = await db("product_entitlements")
    .where({ user_id: userId, status: "active" })
    .whereIn("product_slug", TABFORGE_CLOUD_ENTITLEMENTS)
    .andWhere((query) => {
      query.whereNull("expires_at").orWhere("expires_at", ">", db.fn.now());
    })
    .orderBy("created_at", "desc");

  for (const entitlement of syncEntitlements) {
    const sourceRef = String(entitlement.source_ref || "");
    const stripeBacked =
      entitlement.source === "stripe_subscription" ||
      sourceRef.startsWith("subscription:");
    if (!stripeBacked) return "sync";

    const subscriptionId =
      String(entitlement.metadata?.subscription_id || "") ||
      sourceRef.match(/^subscription:([^:]+):/)?.[1] ||
      "";
    const subscriptionQuery = db("subscriptions").where({
      user_id: userId,
      provider: "stripe",
    });
    if (subscriptionId) {
      subscriptionQuery.andWhere({
        provider_subscription_id: subscriptionId,
      });
    } else {
      subscriptionQuery
        .whereIn("plan", TABFORGE_SYNC_PLAN_ALIASES)
        .orderByRaw(
          "case when status in ('active', 'trialing', 'past_due') then 0 else 1 end"
        )
        .orderBy("updated_at", "desc");
    }
    const subscription = await subscriptionQuery.first();
    const active = Boolean(
      subscription &&
        isActiveTabForgeSubscriptionStatus(subscription.status, {
          pastDueSince: tabForgePastDueSince(subscription),
        })
    );
    if (active) return "sync";

    // Reconcile an expired grace window even if Stripe sends no event exactly
    // seven days after payment failure. A later paid webhook re-grants access.
    await db("product_entitlements")
      .where({ id: entitlement.id, status: "active" })
      .update({
        status: "revoked",
        metadata: db.raw(
          "coalesce(metadata, '{}'::jsonb) || ?::jsonb",
          [
            JSON.stringify({
              private_sync_reconciled_at: new Date().toISOString(),
              subscription_status: subscription?.status || "missing",
              reason: "subscription_inactive_or_grace_expired",
            }),
          ]
        ),
        updated_at: db.fn.now(),
      });
  }
  if (await hasProductEntitlement(userId, "tabforge")) return "backup";
  return "none";
}

/**
 * GET /v1/tabforge/cloud/access
 *
 * Metadata-only control-plane endpoint used by the Cloudflare Worker. It never
 * receives or returns TabForge notes, images, shortcuts, or layout payloads.
 */
tabforgeCloudRouter.get("/access", requireAuth, tabforgeCloudAccessLimiter, async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const user = await db("users")
      .select("id", "email")
      .where({ id: req.user.sub })
      .first();

    if (!user) {
      return res.status(404).json({ error: "user_not_found" });
    }

    const accessMode = await cloudAccessMode(user.id, user.email);
    if (accessMode === "none") {
      return res.status(402).json({
        error: "tabforge_pro_required",
        message: "TabForge Pro is required for private layout recovery backups.",
      });
    }

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: normalizeEmail(user.email),
      },
      cloud: {
        enabled: true,
        accessMode,
        provider: "cloudflare-r2",
        storageLimitBytes: STORAGE_LIMIT_BYTES,
        deviceLimit: DEVICE_LIMIT,
        capabilities: {
          layoutRecoveryBackup: true,
          liveLayoutSync: accessMode === "sync",
          shortcutSync: accessMode === "sync",
          cloudNotes: accessMode === "sync",
        },
        contentStoredInRender: false,
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});
