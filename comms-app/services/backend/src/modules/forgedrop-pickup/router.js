/**
 * ForgeDrop Cloud pickup (ForgeDrop/docs/pickup.md), mounted by app.js at
 * /v1/forgedrop/pickup: files a sender's computer sealed and left in
 * Cloudflare R2 for a computer that was away, or for someone without
 * ForgeDrop, deleted as soon as they are picked up or after 7 days. The one
 * paid part of ForgeDrop.
 *
 *   POST /               sender     leave files: an id and upload links
 *   POST /:id/done       sender     the upload is finished: check it, and
 *                                   email the recipient's account
 *   POST /:id/cancel     sender     take it back, deleted at once
 *   GET  /waiting        recipient  what was left for this computer
 *   GET  /:id            recipient  download links, good for an hour
 *   POST /:id/picked-up  recipient  collected: deleted at once
 *
 * Every route is for a desktop signed in with its offline licence, as on the
 * link (../forgedrop-link/auth.js). Leaving files also takes a plan
 * (plans.js); receiving takes only ForgeDrop. The bytes go straight between
 * the desktop and R2 on presigned links: this server never holds one, and
 * could not read one if it did.
 *
 * Without R2's settings every route answers 503 pickup_unavailable, which
 * the desktop shows as "try again later".
 */

import express from "express";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { licensedProduct } from "../../services/licensedProducts.js";
import { createDesktopAuth } from "../forgedrop-link/auth.js";
import { createDeviceDirectory } from "../forgedrop-link/devices.js";
import { canonicalUuid } from "../forgedrop-link/shapes.js";
import { tierFromEntitlements } from "./plans.js";
import { createR2Client, r2ConfigProblems, readR2Config } from "./r2.js";
import { createPickupService } from "./service.js";
import { PICKUP_LIMITS, Refusal } from "./shapes.js";
import { createPickupStore } from "./store.js";

export { PICKUP_LIMITS };

const describe = (error) => String(error?.message || error).slice(0, 300);

/** A body only counts once it has bytes in it; an empty POST is fine. */
function sentBody(req) {
  const length = Number(req.headers["content-length"]);
  return req.headers["transfer-encoding"] !== undefined || (Number.isFinite(length) && length > 0);
}

function noStore(_req, res, next) {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Expose-Headers": "Retry-After",
  });
  next();
}

/** Every route answers 503 pickup_unavailable. */
export function unconfiguredRouter() {
  const router = express.Router();
  router.use(noStore);
  router.use((_req, res) => res.status(503).json({ error: "pickup_unavailable" }));
  router.stop = () => {};
  return router;
}

export function createForgeDropPickupRouter({
  db,
  hasProductEntitlement,
  listProductEntitlements,
  signingKey,
  // R2's settings: given outright, or read from R2_* in `r2Env`.
  r2Config = undefined,
  r2Env = process.env,
  // A client standing in for R2, for tests that want one.
  r2: givenR2 = null,
  sendWaitingEmail = async () => {},
  now = Date.now,
  fetch: fetchImpl = globalThis.fetch,
  limits: givenLimits = {},
  rate = {},
  rateLimitPrefix = "forgedrop-pickup",
  // 0 leaves the sweep to whoever holds the router (tests call it).
  sweepEveryMs = undefined,
  log = () => {},
}) {
  const config = r2Config === undefined ? readR2Config(r2Env) : r2Config;
  if (!givenR2 && !config) {
    log("warn", "forgedrop_pickup_unavailable", {
      reason: "r2_not_configured",
      problems: r2ConfigProblems(r2Config === undefined ? r2Env : {}),
    });
    return unconfiguredRouter();
  }

  const product = licensedProduct("forgedrop");
  if (!product) throw new Error("forgedrop is not a licensed product");

  const limits = { ...PICKUP_LIMITS, ...givenLimits };
  const rates = { ...PICKUP_LIMITS.rate, ...rate };
  const r2 = givenR2 || createR2Client({ ...config, fetch: fetchImpl, now });
  const store = createPickupStore(db, { productSlug: product.slug });
  const service = createPickupService({
    db,
    r2,
    store,
    tierOf: async (userId) => tierFromEntitlements(await listProductEntitlements(userId)),
    sendWaitingEmail,
    now,
    log,
    limits,
  });

  const router = express.Router();

  // Express 4 does not catch a rejected promise, and on Node 20 an unhandled
  // rejection ends the process: every async handler goes through here.
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  const desktopAuth = wrap(
    createDesktopAuth({
      signingKey,
      product: product.slug,
      devices: createDeviceDirectory(db, product.slug),
      hasEntitlement: (userId) => hasProductEntitlement(userId, product.entitlementSlug || product.slug),
      now,
      ttlMs: limits.licenceCacheMs,
      log,
      unavailableError: "pickup_unavailable",
      logPrefix: "forgedrop_pickup",
    })
  );

  const limiter = (name, max) =>
    createRateLimiter({
      name: `${rateLimitPrefix}-${name}`,
      windowMs: 60 * 1000,
      max,
      keyGenerator: (req) => req.link.userId,
      message: "rate_limited",
    });
  const requestLimiter = limiter("requests", rates.requestsPerMinute);
  const createLimiter = limiter("create", rates.createPerMinute);

  /**
   * Run a service call and answer: its body with `status`, nothing (204) for
   * undefined, a refusal as { error, ...extra }. Anything else is the
   * database or R2 in trouble: 503, which the desktop reads as "later".
   */
  const answer = (status, call) =>
    wrap(async (req, res) => {
      let result;
      try {
        result = await call(req);
      } catch (error) {
        if (error instanceof Refusal) return res.status(error.status).json({ error: error.code, ...error.extra });
        log("error", "forgedrop_pickup_failed", {
          route: `${req.method} ${req.route?.path || ""}`,
          message: describe(error),
        });
        return res.status(503).json({ error: "pickup_unavailable" });
      }
      if (result === undefined) return res.status(204).end();
      return res.status(status).json(result);
    });

  /** The :id, or 404 for anything that is not a uuid. */
  const pickupId = (req) => {
    const id = canonicalUuid(req.params.id);
    if (!id) throw new Refusal(404, "not_found");
    return id;
  };

  router.use(noStore);

  // JSON only. Without this, a body without its Content-Type would be eaten
  // by the app-wide form parser and fail in confusing ways further down.
  router.use((req, res, next) => {
    if (sentBody(req) && !req.is("application/json")) {
      return res.status(415).json({ error: "json_required" });
    }
    return next();
  });
  router.use(express.json({ limit: limits.bodyBytes, strict: true }));

  const caller = (req) => req.link;

  router.post(
    "/",
    desktopAuth,
    requestLimiter,
    createLimiter,
    answer(201, (req) => service.create(caller(req), req.body))
  );
  router.get(
    "/waiting",
    desktopAuth,
    requestLimiter,
    answer(200, (req) => service.waiting(caller(req)))
  );
  router.get(
    "/:id",
    desktopAuth,
    requestLimiter,
    answer(200, (req) => service.downloads(caller(req), pickupId(req)))
  );
  router.post(
    "/:id/done",
    desktopAuth,
    requestLimiter,
    answer(200, (req) => service.done(caller(req), pickupId(req), req.body))
  );
  router.post(
    "/:id/picked-up",
    desktopAuth,
    requestLimiter,
    answer(204, (req) => service.pickedUp(caller(req), pickupId(req)))
  );
  router.post(
    "/:id/cancel",
    desktopAuth,
    requestLimiter,
    answer(204, (req) => service.cancel(caller(req), pickupId(req)))
  );

  router.use((_req, res) => res.status(404).json({ error: "not_found" }));

  // eslint-disable-next-line no-unused-vars
  router.use((error, _req, res, _next) => {
    if (res.headersSent) return undefined;
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large" });
    if (error?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
    if (error?.type === "charset.unsupported" || error?.type === "encoding.unsupported") {
      return res.status(415).json({ error: "json_required" });
    }
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ error: "bad_request" });
    }
    log("error", "forgedrop_pickup_request_failed", { message: describe(error) });
    return res.status(500).json({ error: "server_error" });
  });

  // The sweep: expired pickups, abandoned uploads, deletions to retry.
  const every = sweepEveryMs ?? limits.sweepEveryMs;
  const sweeper =
    every > 0
      ? setInterval(() => {
          service.sweep().catch((error) => log("error", "forgedrop_pickup_sweep_failed", { message: describe(error) }));
        }, every)
      : null;
  sweeper?.unref?.();

  router.service = service;
  router.stop = () => {
    if (sweeper) clearInterval(sweeper);
  };
  return router;
}
