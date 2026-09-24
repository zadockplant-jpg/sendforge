/**
 * Product installers, under the name the customer should see.
 *
 * The files live on GitHub releases (sendforge-downloads). GitHub rewrites
 * spaces in an asset name to dots, so a direct link saves
 * "Install.Rose.Colored.Glasses.exe". This route streams the same file with
 * the real name in Content-Disposition. Range requests pass through, so a
 * browser can resume an interrupted download.
 *
 * The release tag is fixed per product and each new build replaces the asset,
 * so these links never change between versions.
 */

import { Readable } from "node:stream";
import { Router } from "express";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { log, getRequestId } from "../utils/logger.js";

export const downloadsRouter = Router();

export const DOWNLOADS = Object.freeze({
  "rose-colored-glasses": Object.freeze({
    filename: "Install Rose Colored Glasses.exe",
    source:
      process.env.DOWNLOAD_SOURCE_ROSE_COLORED_GLASSES ||
      "https://github.com/zadockplant-jpg/sendforge-downloads/releases/download/rose-colored-glasses/Install.Rose.Colored.Glasses.exe",
  }),
  forgedrop: Object.freeze({
    filename: "Install ForgeDrop.exe",
    source:
      process.env.DOWNLOAD_SOURCE_FORGEDROP ||
      "https://github.com/zadockplant-jpg/sendforge-downloads/releases/download/forgedrop/Install.ForgeDrop.exe",
  }),
});

const downloadLimiter = createRateLimiter({
  name: "downloads",
  windowMs: 60 * 1000,
  max: 20,
  message: "too_many_downloads",
});

// RFC 6266: a quoted ASCII name for every browser, plus the UTF-8 form.
export function contentDisposition(filename) {
  const ascii = String(filename).replace(/["\\\r\n]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const PASSED_THROUGH = ["content-length", "content-range", "accept-ranges", "last-modified", "etag"];

downloadsRouter.get("/:slug", downloadLimiter, async (req, res) => {
  const entry = DOWNLOADS[String(req.params.slug || "").toLowerCase()];
  if (!entry) return res.status(404).json({ error: "unknown_download" });

  const headers = {};
  if (req.headers.range) headers.Range = String(req.headers.range);

  let upstream;
  try {
    upstream = await fetch(entry.source, { headers, redirect: "follow" });
  } catch (error) {
    log("error", "download_upstream_unreachable", {
      requestId: getRequestId(req),
      slug: req.params.slug,
      message: String(error?.message || error),
    });
    return res.status(502).json({ error: "download_unavailable" });
  }

  if (!upstream.ok || !upstream.body) {
    log("error", "download_upstream_failed", {
      requestId: getRequestId(req),
      slug: req.params.slug,
      status: upstream.status,
    });
    return res.status(upstream.status === 416 ? 416 : 502).json({ error: "download_unavailable" });
  }

  res.status(upstream.status);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", contentDisposition(entry.filename));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const name of PASSED_THROUGH) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }

  const body = Readable.fromWeb(upstream.body);
  req.on("close", () => body.destroy());
  body.on("error", () => res.destroy());
  body.pipe(res);
});
