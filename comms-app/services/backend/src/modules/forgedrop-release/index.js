/**
 * The ForgeDrop installer for licensed desktops, mounted by app.js at
 * /v1/downloads/forgedrop-release, ahead of the downloads router (router.js
 * says why it exists).
 *
 * As with the link and Cloud pickup: app.js imports this file statically,
 * and anything that throws while a static import loads stops the whole API
 * from starting. So this file imports only what app.js already depends on
 * and loads the module's own code behind a catch; if that fails, the route
 * answers 503 release_unavailable, and the updater falls back to the url in
 * its signed notice.
 */

import express from "express";
import { db } from "../../config/db.js";
import { env } from "../../config/env.js";
import { hasProductEntitlement } from "../../services/entitlement.service.js";
import { log } from "../../utils/logger.js";

export function unavailableRouter() {
  const router = express.Router();
  router.use((_req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(503).json({ error: "release_unavailable" });
  });
  return router;
}

/** Build the router with `load`, or stand the 503 router in for it. */
export async function loadForgeDropRelease(load, { logger = log } = {}) {
  try {
    const router = await load();
    if (typeof router !== "function") throw new Error("the release route did not build a router");
    return router;
  } catch (error) {
    try {
      logger("error", "forgedrop_release_unavailable", {
        message: String(error?.stack || error?.message || error).slice(0, 1000),
      });
    } catch {
      // Logging must not be the thing that stops the API.
    }
    return unavailableRouter();
  }
}

export const forgedropReleaseRouter = await loadForgeDropRelease(async () => {
  const { createForgeDropReleaseRouter } = await import("./router.js");
  return createForgeDropReleaseRouter({
    db,
    hasProductEntitlement,
    signingKey: () => env.licenseSigningKey,
    log,
  });
});
