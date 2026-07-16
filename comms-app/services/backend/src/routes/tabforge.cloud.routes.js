import { Router } from "express";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter, rateLimitByUserOrIp } from "../middleware/rateLimit.js";
import {
  hasAnyProductEntitlement,
  TABFORGE_CLOUD_ENTITLEMENTS,
} from "../services/entitlement.service.js";

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

async function hasCloudAccess(userId, email) {
  if (normalizeEmail(email) === TABFORGE_CLOUD_OWNER_EMAIL) return true;
  return hasAnyProductEntitlement(userId, TABFORGE_CLOUD_ENTITLEMENTS);
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

    if (!(await hasCloudAccess(user.id, user.email))) {
      return res.status(402).json({
        error: "tabforge_subscription_required",
        message: "TabForge cloud sync requires the Sync + Collections subscription.",
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
        provider: "cloudflare-r2",
        storageLimitBytes: STORAGE_LIMIT_BYTES,
        deviceLimit: DEVICE_LIMIT,
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
