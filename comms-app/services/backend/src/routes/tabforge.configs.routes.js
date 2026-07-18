import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { hasProductEntitlement } from "../services/entitlement.service.js";
import { createRateLimiter, rateLimitByUserOrIp } from "../middleware/rateLimit.js";

export const tabforgeConfigsRouter = Router();

const CLOUD_AUTOSAVE_NAME = "TabForge Cloud Autosave";
const CLOUD_NOTES_AUTOSAVE_NAME = "TabForge Notes Cloud Autosave";
const TABFORGE_CLOUD_AUTOSAVE_NAMES = new Set([CLOUD_AUTOSAVE_NAME, CLOUD_NOTES_AUTOSAVE_NAME]);
const TABFORGE_CLOUD_OWNER_EMAIL = String(
  process.env.TABFORGE_CLOUD_OWNER_EMAIL || process.env.ADMIN_LIVE_TEST_OWNER_EMAIL || "zadockplant@gmail.com"
).trim().toLowerCase();
const TABFORGE_CLOUD_PROVIDER_STATUS = "legacy_render_read_only";

const tabforgeConfigWriteLimiter = createRateLimiter({
  name: "tabforge-config-write",
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: rateLimitByUserOrIp,
  message: "too_many_config_writes",
});

const tabforgeCloudAutosaveWriteLimiter = createRateLimiter({
  name: "tabforge-cloud-autosave-write",
  windowMs: 60 * 60 * 1000,
  max: 240,
  keyGenerator: rateLimitByUserOrIp,
  message: "too_many_cloud_autosave_writes",
});

const SnapshotBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  payload: z.object({}).passthrough(),
});

const SnapshotUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    payload: z.object({}).passthrough().optional(),
  })
  .refine((value) => Boolean(value.name || value.payload), {
    message: "name_or_payload_required",
  });

const TABFORGE_CLOUD_STORAGE_LIMIT_GB = 20;
const TABFORGE_CLOUD_STORAGE_LIMIT_BYTES = TABFORGE_CLOUD_STORAGE_LIMIT_GB * 1024 * 1024 * 1024;
const TABFORGE_SYNC_ENTITLEMENTS = ["tabforge-subscription", "tabforge-collections", "tabforge-collections-subscription", "tabforge-sync-collections"];

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isTabForgeCloudOwnerEmail(email) {
  return normalizeEmail(email) === TABFORGE_CLOUD_OWNER_EMAIL;
}

function isTabForgeCloudOwnerRequest(req) {
  return isTabForgeCloudOwnerEmail(req?.user?.email);
}

function cloudStatusForRequest(req) {
  const owner = isTabForgeCloudOwnerRequest(req);
  return {
    enabled: false,
    ownerOnly: false,
    stubbedForNonOwner: false,
    retired: true,
    legacyReadAvailable: owner,
    providerStatus: TABFORGE_CLOUD_PROVIDER_STATUS,
    cloudStorageLimitGb: 0,
    message: owner
      ? "Legacy Render records are temporarily readable for owner migration; all current content uses Cloudflare."
      : "This legacy Render content route has been retired; current TabForge content uses Cloudflare.",
  };
}

function sendCloudStubbed(res, req, statusCode = 410) {
  return res.status(statusCode).json({
    error: "legacy_render_storage_retired",
    message: "This legacy Render content route has been retired; current TabForge content uses Cloudflare.",
    cloud: cloudStatusForRequest(req),
  });
}

function sanitizeTabForgeCloudPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const cleaned = { ...payload };
  cleaned.cloudStorageLimitGb = TABFORGE_CLOUD_STORAGE_LIMIT_GB;
  if (!("noteDataExcluded" in cleaned)) cleaned.noteDataExcluded = false;
  delete cleaned.user?.token;
  delete cleaned.authToken;
  delete cleaned.token;
  return cleaned;
}

function payloadSizeBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload || {}), "utf8");
}

async function userHasTabForgeSync(userId, email = null) {
  if (isTabForgeCloudOwnerEmail(email)) return true;
  for (const slug of TABFORGE_SYNC_ENTITLEMENTS) {
    if (await hasProductEntitlement(userId, slug)) return true;
  }
  return false;
}

async function getStoredConfigUsageBytes(userId, exceptConfigId = null) {
  const query = db("tabforge_saved_configs")
    .select("id", "payload")
    .where({ user_id: userId });

  if (exceptConfigId) query.whereNot({ id: exceptConfigId });

  const rows = await query;
  return rows.reduce((total, row) => total + payloadSizeBytes(row.payload), 0);
}

async function enforceTabForgeCloudStorage(user, payload, exceptConfigId = null) {
  const userId = typeof user === "object" ? user?.sub : user;
  const email = typeof user === "object" ? user?.email : null;
  if (!(await userHasTabForgeSync(userId, email))) {
    const err = new Error("tabforge_subscription_required");
    err.statusCode = 402;
    throw err;
  }

  const nextUsage = (await getStoredConfigUsageBytes(userId, exceptConfigId)) + payloadSizeBytes(payload);
  if (nextUsage > TABFORGE_CLOUD_STORAGE_LIMIT_BYTES) {
    const err = new Error("tabforge_cloud_storage_limit_exceeded");
    err.statusCode = 413;
    throw err;
  }
}

function normalizeName(name) {
  return String(name || "").trim();
}

function mapRow(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getOwnedConfigOr404(userId, configId) {
  const row = await db("tabforge_saved_configs")
    .where({
      id: configId,
      user_id: userId,
    })
    .first();

  if (!row) {
    const err = new Error("config_not_found");
    err.statusCode = 404;
    throw err;
  }

  return row;
}

tabforgeConfigsRouter.use(requireAuth);
tabforgeConfigsRouter.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return res.status(410).json({
      error: "legacy_render_storage_retired",
      message:
        "This legacy Render storage route is read-only. Current TabForge content sync uses the private Cloudflare data plane.",
    });
  }
  return next();
});
tabforgeConfigsRouter.use((req, res, next) => {
  if (req.method === "POST" && TABFORGE_CLOUD_AUTOSAVE_NAMES.has(normalizeName(req.body?.name))) {
    return tabforgeCloudAutosaveWriteLimiter(req, res, next);
  }
  if (["POST", "PUT", "DELETE"].includes(req.method)) {
    return tabforgeConfigWriteLimiter(req, res, next);
  }
  return next();
});

tabforgeConfigsRouter.get("/", async (req, res) => {
  try {
    if (!isTabForgeCloudOwnerRequest(req)) {
      return res.json({
        items: [],
        storage: {
          limitGb: 0,
          usedBytes: 0,
          stubbed: true,
        },
        cloud: cloudStatusForRequest(req),
      });
    }

    const rows = await db("tabforge_saved_configs")
      .select("id", "name", "created_at", "updated_at")
      .where({ user_id: req.user.sub })
      .orderBy("updated_at", "desc");

    return res.json({
      items: rows.map(mapRow),
      storage: {
        limitGb: TABFORGE_CLOUD_STORAGE_LIMIT_GB,
        usedBytes: await getStoredConfigUsageBytes(req.user.sub),
      },
      cloud: cloudStatusForRequest(req),
    });
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    return res.status(statusCode).json({
      error: err?.message === "tabforge_subscription_required"
        ? "tabforge_subscription_required"
        : (err?.message === "tabforge_cloud_storage_limit_exceeded" ? "tabforge_cloud_storage_limit_exceeded" : (err?.message === "tabforge_cloud_hosting_stubbed" ? "tabforge_cloud_hosting_stubbed" : "server_error")),
      message: err?.message === "tabforge_subscription_required"
        ? "TabForge Private Sync is required for cross-device sync."
        : (err?.message === "tabforge_cloud_storage_limit_exceeded" ? "The TabForge private-sync safety limit was reached." : (err?.message === "tabforge_cloud_hosting_stubbed" ? "This legacy Render storage route has been retired." : String(err?.message || err))),
    });
  }
});

tabforgeConfigsRouter.get("/:id", async (req, res) => {
  try {
    if (!isTabForgeCloudOwnerRequest(req)) return sendCloudStubbed(res, req);
    const row = await getOwnedConfigOr404(req.user.sub, req.params.id);

    return res.json({
      item: {
        ...mapRow(row),
        payload: row.payload,
      },
    });
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    return res.status(statusCode).json({
      error: statusCode === 404
        ? "config_not_found"
        : (err?.message === "tabforge_subscription_required" ? "tabforge_subscription_required" : (err?.message === "tabforge_cloud_storage_limit_exceeded" ? "tabforge_cloud_storage_limit_exceeded" : (err?.message === "tabforge_cloud_hosting_stubbed" ? "tabforge_cloud_hosting_stubbed" : "server_error"))),
      message: statusCode === 404
        ? undefined
        : (err?.message === "tabforge_subscription_required" ? "TabForge Private Sync is required for cross-device sync." : (err?.message === "tabforge_cloud_storage_limit_exceeded" ? "The TabForge private-sync safety limit was reached." : (err?.message === "tabforge_cloud_hosting_stubbed" ? "This legacy Render storage route has been retired." : String(err?.message || err)))),
    });
  }
});

tabforgeConfigsRouter.post("/", async (req, res) => {
  try {
    if (!isTabForgeCloudOwnerRequest(req)) return sendCloudStubbed(res, req);
    const parsed = SnapshotBodySchema.parse(req.body || {});
    const name = normalizeName(parsed.name);

    const existing = await db("tabforge_saved_configs")
      .where({
        user_id: req.user.sub,
        name,
      })
      .first();

    if (existing) {
      if (TABFORGE_CLOUD_AUTOSAVE_NAMES.has(name)) {
        const sanitizedPayload = sanitizeTabForgeCloudPayload(parsed.payload);
        await enforceTabForgeCloudStorage(req.user, sanitizedPayload, existing.id);
        await db("tabforge_saved_configs")
          .where({ id: existing.id, user_id: req.user.sub })
          .update({
            payload: sanitizedPayload,
            updated_at: db.fn.now(),
          });

        const updated = await db("tabforge_saved_configs")
          .where({ id: existing.id, user_id: req.user.sub })
          .first();

        return res.json({
          item: mapRow(updated),
        });
      }

      return res.status(409).json({ error: "config_name_exists" });
    }

    const id = crypto.randomUUID();
    const sanitizedPayload = sanitizeTabForgeCloudPayload(parsed.payload);
    await enforceTabForgeCloudStorage(req.user, sanitizedPayload);

    await db("tabforge_saved_configs").insert({
      id,
      user_id: req.user.sub,
      name,
      payload: sanitizedPayload,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    const inserted = await db("tabforge_saved_configs")
      .where({
        id,
        user_id: req.user.sub,
      })
      .first();

    return res.status(201).json({
      item: mapRow(inserted),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        error: "invalid_request",
        issues: err.issues,
      });
    }

    const statusCode = err?.statusCode || 500;
    return res.status(statusCode).json({
      error: err?.message === "tabforge_subscription_required"
        ? "tabforge_subscription_required"
        : (err?.message === "tabforge_cloud_storage_limit_exceeded" ? "tabforge_cloud_storage_limit_exceeded" : (err?.message === "tabforge_cloud_hosting_stubbed" ? "tabforge_cloud_hosting_stubbed" : "server_error")),
      message: err?.message === "tabforge_subscription_required"
        ? "TabForge Private Sync is required for cross-device sync."
        : (err?.message === "tabforge_cloud_storage_limit_exceeded" ? "The TabForge private-sync safety limit was reached." : (err?.message === "tabforge_cloud_hosting_stubbed" ? "This legacy Render storage route has been retired." : String(err?.message || err))),
    });
  }
});

tabforgeConfigsRouter.put("/:id", async (req, res) => {
  try {
    if (!isTabForgeCloudOwnerRequest(req)) return sendCloudStubbed(res, req);
    const parsed = SnapshotUpdateSchema.parse(req.body || {});
    const current = await getOwnedConfigOr404(req.user.sub, req.params.id);

    const nextName = parsed.name ? normalizeName(parsed.name) : current.name;

    if (nextName !== current.name) {
      const duplicate = await db("tabforge_saved_configs")
        .where({
          user_id: req.user.sub,
          name: nextName,
        })
        .whereNot({ id: current.id })
        .first();

      if (duplicate) {
        return res.status(409).json({ error: "config_name_exists" });
      }
    }

    const updates = {
      name: nextName,
      updated_at: db.fn.now(),
    };

    if (parsed.payload) {
      updates.payload = sanitizeTabForgeCloudPayload(parsed.payload);
      await enforceTabForgeCloudStorage(req.user, updates.payload, current.id);
    }

    await db("tabforge_saved_configs")
      .where({ id: current.id, user_id: req.user.sub })
      .update(updates);

    const updated = await db("tabforge_saved_configs")
      .where({ id: current.id, user_id: req.user.sub })
      .first();

    return res.json({
      item: {
        ...mapRow(updated),
        payload: updated.payload,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        error: "invalid_request",
        issues: err.issues,
      });
    }

    const statusCode = err?.statusCode || 500;
    return res.status(statusCode).json({
      error: statusCode === 404
        ? "config_not_found"
        : (err?.message === "tabforge_subscription_required" ? "tabforge_subscription_required" : (err?.message === "tabforge_cloud_storage_limit_exceeded" ? "tabforge_cloud_storage_limit_exceeded" : (err?.message === "tabforge_cloud_hosting_stubbed" ? "tabforge_cloud_hosting_stubbed" : "server_error"))),
      message: statusCode === 404
        ? undefined
        : (err?.message === "tabforge_subscription_required" ? "TabForge Private Sync is required for cross-device sync." : (err?.message === "tabforge_cloud_storage_limit_exceeded" ? "The TabForge private-sync safety limit was reached." : (err?.message === "tabforge_cloud_hosting_stubbed" ? "This legacy Render storage route has been retired." : String(err?.message || err)))),
    });
  }
});

tabforgeConfigsRouter.delete("/:id", async (req, res) => {
  try {
    if (!isTabForgeCloudOwnerRequest(req)) return sendCloudStubbed(res, req);
    await getOwnedConfigOr404(req.user.sub, req.params.id);

    await db("tabforge_saved_configs")
      .where({
        id: req.params.id,
        user_id: req.user.sub,
      })
      .del();

    return res.status(204).send();
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    return res.status(statusCode).json({
      error: statusCode === 404
        ? "config_not_found"
        : (err?.message === "tabforge_subscription_required" ? "tabforge_subscription_required" : (err?.message === "tabforge_cloud_storage_limit_exceeded" ? "tabforge_cloud_storage_limit_exceeded" : (err?.message === "tabforge_cloud_hosting_stubbed" ? "tabforge_cloud_hosting_stubbed" : "server_error"))),
      message: statusCode === 404
        ? undefined
        : (err?.message === "tabforge_subscription_required" ? "TabForge Private Sync is required for cross-device sync." : (err?.message === "tabforge_cloud_storage_limit_exceeded" ? "The TabForge private-sync safety limit was reached." : (err?.message === "tabforge_cloud_hosting_stubbed" ? "This legacy Render storage route has been retired." : String(err?.message || err)))),
    });
  }
});
