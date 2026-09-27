/**
 * GET /v1/downloads/forgedrop-release/:version: the ForgeDrop installer for
 * a licensed desktop.
 *
 * The owner is closing ForgeDrop's downloads to anyone who has not bought it
 * (2026-09-27), and the public release files on GitHub go private after
 * that. Installed copies still have to update, so ForgeDrop 1.6.3's updater
 * asks here first, sending its offline licence (X-ForgeDrop-License, the same
 * sign-in the phone link and Cloud pickup use), and falls back to the url in
 * the signed update notice. The notice keeps naming the public file while
 * older copies, which know nothing of this, still need it.
 *
 * Whatever is served, the desktop holds it to the signed notice's size and
 * SHA-256 before running it (ForgeDrop's core/update.py), so this route only
 * has to hand over the bytes of the release it is asked for.
 */

import { Readable } from "node:stream";
import express from "express";
import { licensedProduct } from "../../services/licensedProducts.js";
import { createDesktopAuth } from "../forgedrop-link/auth.js";
import { createDeviceDirectory } from "../forgedrop-link/devices.js";

/** A plain release version, nothing that could walk a path. */
export const RELEASE_VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;

/** Where build/publish_update.py puts each release's installer. */
export const RELEASE_BASE =
  "https://github.com/zadockplant-jpg/sendforge-downloads/releases/download";

export function releaseSource(version) {
  return `${RELEASE_BASE}/forgedrop-v${version}/Install.ForgeDrop.exe`;
}

/** The public file, until the website's fetchReleaseAsset (with the token) replaces it. */
async function fetchPublic(url) {
  return fetch(url, { redirect: "follow", headers: { "User-Agent": "SendForge" } });
}

export function createForgeDropReleaseRouter({
  db,
  hasProductEntitlement,
  signingKey,
  fetchAsset = fetchPublic,
  now = Date.now,
  licenceCacheMs = 60_000,
  log = () => {},
}) {
  const product = licensedProduct("forgedrop");
  if (!product) throw new Error("forgedrop is not a licensed product");
  const router = express.Router();

  // Express 4 does not catch a rejected promise: every async handler goes
  // through here.
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  const desktopAuth = wrap(
    createDesktopAuth({
      signingKey,
      product: product.slug,
      devices: createDeviceDirectory(db, product.slug),
      hasEntitlement: (userId) => hasProductEntitlement(userId, product.entitlementSlug || product.slug),
      now,
      ttlMs: licenceCacheMs,
      log,
      unavailableError: "release_unavailable",
      logPrefix: "forgedrop_release",
    })
  );

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get(
    "/:version",
    desktopAuth,
    wrap(async (req, res) => {
      const version = String(req.params.version || "");
      if (!RELEASE_VERSION.test(version)) return res.status(404).json({ error: "not_found" });
      let upstream;
      try {
        upstream = await fetchAsset(releaseSource(version));
      } catch (error) {
        log("error", "forgedrop_release_fetch_failed", { version, message: String(error?.message || error) });
        return res.status(502).json({ error: "release_unreachable" });
      }
      if (!upstream || upstream.status === 404) return res.status(404).json({ error: "not_found" });
      if (!upstream.ok || !upstream.body) {
        log("error", "forgedrop_release_fetch_failed", { version, status: upstream.status });
        return res.status(502).json({ error: "release_unreachable" });
      }
      res.status(200);
      res.set("Content-Type", "application/octet-stream");
      res.set("Content-Disposition", 'attachment; filename="Install ForgeDrop.exe"');
      const length = upstream.headers.get("content-length");
      if (length && /^[0-9]+$/.test(length)) res.set("Content-Length", length);
      const body = Readable.fromWeb(upstream.body);
      body.on("error", () => res.destroy());
      body.pipe(res);
      return undefined;
    })
  );

  router.use((_req, res) => res.status(404).json({ error: "not_found" }));
  // eslint-disable-next-line no-unused-vars
  router.use((error, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
    log("error", "forgedrop_release_request_failed", { message: String(error?.message || error) });
    return res.status(500).json({ error: "server_error" });
  });
  return router;
}
