/**
 * ForgeDrop Cloud pickup, mounted by app.js at /v1/forgedrop/pickup.
 *
 * As with the link (../forgedrop-link/index.js): app.js imports this file
 * statically, and anything that throws while a static import loads stops the
 * whole API from starting. So this file imports only what app.js already
 * depends on and loads the module's own code behind a catch. If that fails,
 * or R2's settings (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_BUCKET) are missing, every pickup route answers 503 pickup_unavailable
 * and the rest of the API starts as normal.
 */

import express from "express";
import { db } from "../../config/db.js";
import { env } from "../../config/env.js";
import { sendForgeDropPickupWaitingEmail } from "../../services/email.service.js";
import { hasProductEntitlement, listProductEntitlements } from "../../services/entitlement.service.js";
import { log } from "../../utils/logger.js";

export function unavailableRouter() {
  const router = express.Router();
  router.use((_req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(503).json({ error: "pickup_unavailable" });
  });
  return router;
}

/** Build the router with `load`, or stand the 503 router in for it. */
export async function loadForgeDropPickup(load, { logger = log } = {}) {
  try {
    const router = await load();
    if (typeof router !== "function") throw new Error("cloud pickup did not build a router");
    return router;
  } catch (error) {
    try {
      logger("error", "forgedrop_pickup_unavailable", {
        message: String(error?.stack || error?.message || error).slice(0, 1000),
      });
    } catch {
      // Logging must not be the thing that stops the API.
    }
    return unavailableRouter();
  }
}

export const forgedropPickupRouter = await loadForgeDropPickup(async () => {
  const { createForgeDropPickupRouter } = await import("./router.js");
  return createForgeDropPickupRouter({
    db,
    hasProductEntitlement,
    listProductEntitlements,
    // Read per request, so the key is never parsed at import time.
    signingKey: () => env.licenseSigningKey,
    r2Env: process.env,
    sendWaitingEmail: sendForgeDropPickupWaitingEmail,
    log,
  });
});
