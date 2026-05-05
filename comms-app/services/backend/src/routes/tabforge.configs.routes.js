import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter, rateLimitByUserOrIp } from "../middleware/rateLimit.js";

export const tabforgeConfigsRouter = Router();

const CLOUD_AUTOSAVE_NAME = "TabForge Cloud Autosave";

const tabforgeConfigWriteLimiter = createRateLimiter({
  name: "tabforge-config-write",
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: rateLimitByUserOrIp,
  message: "too_many_config_writes",
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
  if (["POST", "PUT", "DELETE"].includes(req.method)) {
    return tabforgeConfigWriteLimiter(req, res, next);
  }
  return next();
});

tabforgeConfigsRouter.get("/", async (req, res) => {
  try {
    const rows = await db("tabforge_saved_configs")
      .select("id", "name", "created_at", "updated_at")
      .where({ user_id: req.user.sub })
      .orderBy("updated_at", "desc");

    return res.json({
      items: rows.map(mapRow),
    });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});

tabforgeConfigsRouter.get("/:id", async (req, res) => {
  try {
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
      error: statusCode === 404 ? "config_not_found" : "server_error",
      message: statusCode === 404 ? undefined : String(err?.message || err),
    });
  }
});

tabforgeConfigsRouter.post("/", async (req, res) => {
  try {
    const parsed = SnapshotBodySchema.parse(req.body || {});
    const name = normalizeName(parsed.name);

    const existing = await db("tabforge_saved_configs")
      .where({
        user_id: req.user.sub,
        name,
      })
      .first();

    if (existing) {
      if (name === CLOUD_AUTOSAVE_NAME) {
        await db("tabforge_saved_configs")
          .where({ id: existing.id, user_id: req.user.sub })
          .update({
            payload: parsed.payload,
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

    await db("tabforge_saved_configs").insert({
      id,
      user_id: req.user.sub,
      name,
      payload: parsed.payload,
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

    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});

tabforgeConfigsRouter.put("/:id", async (req, res) => {
  try {
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
      updates.payload = parsed.payload;
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
      error: statusCode === 404 ? "config_not_found" : "server_error",
      message: statusCode === 404 ? undefined : String(err?.message || err),
    });
  }
});

tabforgeConfigsRouter.delete("/:id", async (req, res) => {
  try {
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
      error: statusCode === 404 ? "config_not_found" : "server_error",
      message: statusCode === 404 ? undefined : String(err?.message || err),
    });
  }
});