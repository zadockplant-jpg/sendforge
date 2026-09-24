/**
 * ForgeDrop phone link, mounted by app.js at /v1/forgedrop/link.
 *
 * app.js imports this file statically, and anything that throws while a
 * static import loads stops the whole API from starting, not just this
 * feature. So this file imports only what app.js already depends on, and
 * loads the module's own code (router, store, auth) behind a catch. If that
 * fails, every link route answers 503 link_unavailable, which both clients
 * already treat as "try again later", and the rest of the API starts as
 * normal. The failure is logged as forgedrop_link_unavailable.
 */

import express from "express";
import { db } from "../../config/db.js";
import { env } from "../../config/env.js";
import { requireAuth } from "../../middleware/auth.js";
import { hasProductEntitlement } from "../../services/entitlement.service.js";
import { log } from "../../utils/logger.js";

export function unavailableRouter() {
  const router = express.Router();
  router.use((_req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(503).json({ error: "link_unavailable" });
  });
  return router;
}

/** Build the router with `load`, or stand the 503 router in for it. */
export async function loadForgeDropLink(load, { logger = log } = {}) {
  try {
    const router = await load();
    if (typeof router !== "function") throw new Error("the phone link did not build a router");
    return router;
  } catch (error) {
    try {
      logger("error", "forgedrop_link_unavailable", {
        message: String(error?.stack || error?.message || error).slice(0, 1000),
      });
    } catch {
      // Logging must not be the thing that stops the API.
    }
    return unavailableRouter();
  }
}

export const forgedropLinkRouter = await loadForgeDropLink(async () => {
  const { createForgeDropLinkRouter } = await import("./router.js");
  return createForgeDropLinkRouter({
    db,
    requireAuth,
    hasProductEntitlement,
    // Read per request, so the key is never parsed at import time.
    signingKey: () => env.licenseSigningKey,
    log,
  });
});
