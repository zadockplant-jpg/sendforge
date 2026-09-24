/**
 * ForgeDrop phone link: the signaling relay (ForgeDrop/docs/phone-link.md).
 *
 * A phone's browser and a ForgeDrop desktop use this only to swap WebRTC
 * offers and answers; the data channel then runs directly across the local
 * network and never touches this server. What passes through here is SDP,
 * held in memory for at most a minute.
 *
 *   POST /desktop/poll     desktop  long-poll for messages, and be online
 *   POST /desktop/offline  desktop  stop being online, now
 *   GET  /desktops         phone    the account's ForgeDrop machines
 *   POST /phone/poll       phone    long-poll for messages, and be present
 *   POST /signal           either   send an offer, answer or bye
 *
 * A desktop signs in with its offline licence (auth.js), a phone with the
 * customer's Bearer token. Either way the account must own ForgeDrop.
 */

import express from "express";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { licensedProduct } from "../../services/licensedProducts.js";
import { createDesktopAuth, hasLicenceHeader } from "./auth.js";
import { createDeviceDirectory } from "./devices.js";
import {
  canonicalUuid,
  cleanText,
  isClientId,
  isPlainObject,
  isSession,
  LINK_LIMITS,
  parseAddress,
  parseWait,
  SENDABLE_TYPES,
} from "./shapes.js";
import { createLinkStore } from "./store.js";

export { LINK_LIMITS };

/** A body only counts once it has bytes in it; an empty POST is fine. */
function sentBody(req) {
  const length = Number(req.headers["content-length"]);
  return req.headers["transfer-encoding"] !== undefined || (Number.isFinite(length) && length > 0);
}

export function createForgeDropLinkRouter({
  db,
  requireAuth,
  hasProductEntitlement,
  signingKey,
  now = Date.now,
  store: givenStore = null,
  rate = {},
  rateLimitPrefix = "forgedrop-link",
  log = () => {},
}) {
  const product = licensedProduct("forgedrop");
  if (!product) throw new Error("forgedrop is not a licensed product");

  const store =
    givenStore ||
    createLinkStore({
      now,
      onError: (error) =>
        log("error", "forgedrop_link_reply_failed", { message: String(error?.message || error).slice(0, 200) }),
    });
  const limits = { ...LINK_LIMITS.rate, ...rate };
  const devices = createDeviceDirectory(db, product.slug);
  const owns = (userId) => hasProductEntitlement(userId, product.entitlementSlug || product.slug);
  const router = express.Router();

  // Express 4 does not catch a rejected promise, and on Node 20 an unhandled
  // rejection ends the process: every async handler goes through here.
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  const unavailable = (res, what, error) => {
    log("error", what, { message: String(error?.message || error).slice(0, 200) });
    return res.status(503).json({ error: "link_unavailable" });
  };

  const desktopAuth = wrap(
    createDesktopAuth({
      signingKey,
      product: product.slug,
      devices,
      hasEntitlement: owns,
      now,
      ttlMs: LINK_LIMITS.licenceCacheMs,
      log,
    })
  );

  // The existing customer sign-in, unchanged, then the phone's identity. The
  // account id is spelled the way the licence's uid is, so a phone and its
  // account's desktops always meet under the same key.
  const phoneAuth = (req, res, next) =>
    Promise.resolve(
      requireAuth(req, res, (error) => {
        if (error) return next(error);
        const sub = String(req.user.sub);
        req.link = { kind: "phone", userId: canonicalUuid(sub) || sub };
        return next();
      })
    ).catch(next);

  // Ownership for phones is read on every request. It runs after the rate
  // limiter so a busy client costs a counter, not a query.
  const requireForgeDrop = wrap(async (req, res, next) => {
    if (req.link.kind !== "phone") return next();
    let owned;
    try {
      owned = await owns(req.link.userId);
    } catch (error) {
      return unavailable(res, "forgedrop_link_entitlement_check_failed", error);
    }
    if (!owned) return res.status(403).json({ error: "entitlement_required" });
    return next();
  });

  const limiter = (name, max, keyGenerator) =>
    createRateLimiter({
      name: `${rateLimitPrefix}-${name}`,
      windowMs: 60 * 1000,
      max,
      keyGenerator,
      message: "rate_limited",
    });
  const signalLimiter = limiter("signal", limits.signalPerMinute, (req) => req.link.userId);
  const desktopPollLimiter = limiter(
    "desktop-poll",
    limits.pollPerMinute,
    (req) => `${req.link.userId}:${req.link.address}`
  );
  // Keyed on the clientId as sent, before it is validated, so the limit
  // applies ahead of the ownership query. The limiter hashes it.
  const phonePollLimiter = limiter(
    "phone-poll",
    limits.pollPerMinute,
    (req) => `${req.link.userId}:phone:${String(req.body?.clientId ?? "")}`
  );
  const desktopsLimiter = limiter("desktops", limits.desktopsPerMinute, (req) => req.link.userId);

  function longPoll(res, userId, address, waitSeconds, info) {
    if (res.destroyed) return;
    const release = store.poll(userId, address, {
      info,
      waitMs: Math.round(waitSeconds * 1000),
      isAlive: () => !res.writableEnded && !res.destroyed,
      respond: (messages) => res.status(200).json({ messages }),
    });
    // The response's close, not the request's: on Node 20 a request emits
    // 'close' as soon as its body has been read, with the client still
    // connected. The response closes when it is sent or when the client
    // hangs up; after a send, releasing is a no-op.
    res.once("close", release);
  }

  router.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      // Lets the browser app read how long to back off after a 429.
      "Access-Control-Expose-Headers": "Retry-After",
    });
    next();
  });

  // JSON only. Without this, a client that forgets its Content-Type (Python's
  // urllib sends form encoding by default) would have its body eaten by the
  // app-wide form parser and fail in confusing ways further down.
  router.use((req, res, next) => {
    if (sentBody(req) && !req.is("application/json")) {
      return res.status(415).json({ error: "json_required" });
    }
    return next();
  });
  router.use(express.json({ limit: LINK_LIMITS.bodyBytes, strict: true }));

  // ------------------------------------------------------------- desktop

  router.post("/desktop/poll", desktopAuth, desktopPollLimiter, (req, res) => {
    const body = req.body || {};
    const waitSeconds = parseWait(body.wait);
    if (waitSeconds === null) return res.status(400).json({ error: "bad_wait" });
    return longPoll(res, req.link.userId, req.link.address, waitSeconds, {
      name: cleanText(body.name, 64),
      fingerprint: cleanText(body.fingerprint, 32),
      appVersion: cleanText(body.appVersion, 32),
    });
  });

  router.post("/desktop/offline", desktopAuth, (req, res) => {
    store.drop(req.link.userId, req.link.address);
    res.status(204).end();
  });

  // --------------------------------------------------------------- phone

  router.get(
    "/desktops",
    phoneAuth,
    desktopsLimiter,
    requireForgeDrop,
    wrap(async (req, res) => {
      const userId = req.link.userId;
      let rows;
      try {
        rows = await devices.listActive(userId);
      } catch (error) {
        return unavailable(res, "forgedrop_link_device_list_failed", error);
      }

      const desktops = rows.map((row) => {
        const deviceId = canonicalUuid(String(row.device_id)) || String(row.device_id);
        const live = store.presence(userId, `desktop:${deviceId}`);
        return {
          deviceId,
          name: live?.name ?? row.device_name ?? null,
          fingerprint: live?.fingerprint ?? row.identity_fingerprint ?? null,
          appVersion: live?.appVersion ?? row.app_version ?? null,
          platform: row.platform ?? null,
          online: Boolean(live),
        };
      });
      desktops.sort(
        (a, b) =>
          Number(b.online) - Number(a.online) ||
          Number(a.name === null) - Number(b.name === null) ||
          String(a.name ?? "").localeCompare(String(b.name ?? ""), "en", { sensitivity: "base" }) ||
          a.deviceId.localeCompare(b.deviceId)
      );
      return res.json({ desktops });
    })
  );

  router.post("/phone/poll", phoneAuth, phonePollLimiter, requireForgeDrop, (req, res) => {
    const body = req.body || {};
    if (!isClientId(body.clientId)) return res.status(400).json({ error: "bad_client_id" });
    const waitSeconds = parseWait(body.wait);
    if (waitSeconds === null) return res.status(400).json({ error: "bad_wait" });
    return longPoll(res, req.link.userId, `phone:${body.clientId}`, waitSeconds, null);
  });

  // -------------------------------------------------------------- either

  router.post(
    "/signal",
    (req, res, next) => (hasLicenceHeader(req) ? desktopAuth : phoneAuth)(req, res, next),
    signalLimiter,
    requireForgeDrop,
    wrap(async (req, res) => {
      const body = req.body || {};
      const sender = req.link;
      const userId = sender.userId;

      const to = parseAddress(body.to);
      if (!to || to.kind === sender.kind) return res.status(400).json({ error: "bad_recipient" });

      let from = sender.address;
      if (sender.kind === "phone") {
        const claimed = parseAddress(body.from);
        if (!claimed || claimed.kind !== "phone") return res.status(400).json({ error: "bad_sender" });
        from = claimed.address;
      }

      if (!isSession(body.session)) return res.status(400).json({ error: "bad_session" });
      if (!SENDABLE_TYPES[sender.kind].has(body.type)) return res.status(400).json({ error: "bad_type" });

      const data = body.data === undefined ? {} : body.data;
      if (!isPlainObject(data)) return res.status(400).json({ error: "bad_data" });
      if (Buffer.byteLength(JSON.stringify(data), "utf8") > LINK_LIMITS.dataBytes) {
        return res.status(413).json({ error: "data_too_large" });
      }

      // Addresses live under the sender's own account, so another account's
      // desktop or phone is simply not there to find.
      if (to.kind === "desktop") {
        if (!store.isPresent(userId, to.address)) return res.status(404).json({ error: "desktop_offline" });
        let active;
        try {
          active = await devices.findActive(userId, to.id);
        } catch (error) {
          return unavailable(res, "forgedrop_link_device_check_failed", error);
        }
        // Online but no longer holding a slot: freed on the account page
        // within the last minute, while its licence check was still cached.
        if (!active) return res.status(404).json({ error: "desktop_offline" });
      } else if (!store.isPresent(userId, to.address)) {
        return res.status(404).json({ error: "phone_gone" });
      }

      store.deliver(userId, to.address, {
        from,
        session: body.session,
        type: body.type,
        data,
        sentAt: new Date(now()).toISOString(),
      });
      // A phone that just spoke is there. Its answer can then arrive before
      // its first poll does without being turned away as phone_gone.
      if (sender.kind === "phone") store.touch(userId, from);
      return res.status(202).json({ ok: true });
    })
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
    log("error", "forgedrop_link_request_failed", { message: String(error?.message || error).slice(0, 200) });
    return res.status(500).json({ error: "server_error" });
  });

  return router;
}
