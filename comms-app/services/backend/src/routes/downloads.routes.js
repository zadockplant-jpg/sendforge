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
 *
 * Paid installers are for buyers only (the owner, 2026-09-27): the site asks
 * POST /:slug/ticket as a signed-in owner and gets a signed ticket that
 * opens GET /:slug?ticket=... for half an hour. Without one, a browser is
 * sent to the product page, where Download opens the purchase. ForgeDrop's
 * release notice and the free tools stay open to anyone.
 *
 * Once sendforge-downloads is private, GITHUB_DOWNLOADS_TOKEN (read access to
 * that repository's contents) lets fetchReleaseAsset reach the files through
 * GitHub's releases API. Without it the public links are used, as before.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { Router } from "express";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { hasProductEntitlement } from "../services/entitlement.service.js";
import { log, getRequestId } from "../utils/logger.js";

export const DOWNLOADS = Object.freeze({
  "rose-colored-glasses": Object.freeze({
    filename: "Install Rose Colored Glasses.exe",
    source:
      process.env.DOWNLOAD_SOURCE_ROSE_COLORED_GLASSES ||
      "https://github.com/zadockplant-jpg/sendforge-downloads/releases/download/rose-colored-glasses/Install.Rose.Colored.Glasses.exe",
    entitlement: "rose-colored-glasses",
  }),
  forgedrop: Object.freeze({
    filename: "Install ForgeDrop.exe",
    source:
      process.env.DOWNLOAD_SOURCE_FORGEDROP ||
      "https://github.com/zadockplant-jpg/sendforge-downloads/releases/download/forgedrop/Install.ForgeDrop.exe",
    entitlement: "forgedrop",
  }),
  tuneforge: Object.freeze({
    filename: "Install TuneForge.exe",
    source:
      process.env.DOWNLOAD_SOURCE_TUNEFORGE ||
      "https://github.com/zadockplant-jpg/sendforge-downloads/releases/download/tuneforge/Install.TuneForge.exe",
    entitlement: "tuneforge",
  }),
  // ForgeDrop's release notice (forgedrop/core/update.py in the ForgeDrop
  // repo): the app asks here first and GitHub second. The notice is signed
  // with a key this server never holds, so relaying it gives the server no
  // say over what installed copies accept.
  "forgedrop-update": Object.freeze({
    filename: "forgedrop-update.json",
    source:
      process.env.DOWNLOAD_SOURCE_FORGEDROP_UPDATE ||
      "https://github.com/zadockplant-jpg/sendforge-downloads/releases/download/forgedrop/forgedrop-update.json",
  }),
  // A free tool on the Developers page.
  keyfrogger: Object.freeze({
    filename: "KeyFrogger-Setup.exe",
    source:
      process.env.DOWNLOAD_SOURCE_KEYFROGGER ||
      "https://github.com/zadockplant-jpg/sendforge-downloads/releases/download/tools/KeyFrogger-Setup.exe",
  }),
});

// RFC 6266: a quoted ASCII name for every browser, plus the UTF-8 form.
export function contentDisposition(filename) {
  const ascii = String(filename).replace(/["\\\r\n]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// -- tickets -------------------------------------------------------------------

export const DOWNLOAD_TICKET_TTL_SECONDS = 30 * 60;

function ticketMac(body) {
  if (!env.jwtSecret) throw new Error("JWT_SECRET is required to sign download tickets");
  const key = createHmac("sha256", env.jwtSecret).update("sendforge-download-ticket/v1").digest();
  return createHmac("sha256", key).update(body).digest();
}

/** A signed "<claims>.<mac>" that opens one product's installer for half an hour. */
export function issueDownloadTicket({ userId, slug, now = Date.now() }) {
  const expires = Math.floor(now / 1000) + DOWNLOAD_TICKET_TTL_SECONDS;
  const body = Buffer.from(JSON.stringify({ s: slug, u: String(userId), e: expires })).toString("base64url");
  return { ticket: `${body}.${ticketMac(body).toString("base64url")}`, expiresAt: new Date(expires * 1000).toISOString() };
}

/** The ticket's owner, or null for a ticket that is forged, stale or for another product. */
export function readDownloadTicket(ticket, slug, now = Date.now()) {
  const parts = typeof ticket === "string" ? ticket.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const given = Buffer.from(parts[1], "base64url");
  const expected = ticketMac(parts[0]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims?.s !== slug || !Number.isFinite(claims?.e) || claims.e * 1000 <= now) return null;
  return { userId: String(claims.u) };
}

// -- fetching a release asset ----------------------------------------------------

const DEFAULT_REPO = "zadockplant-jpg/sendforge-downloads";
const RELEASE_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\/([^/?#]+)\/([^/?#]+)$/;
const ASSET_ID_TTL_MS = 5 * 60 * 1000;
const assetIds = new Map();

function githubHeaders(token, accept) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "SendForge-Downloads",
  };
}

/** A release asset's id by tag and name, remembered for a few minutes. */
async function assetId({ repo, tag, name }, token, fetchImpl, now) {
  const key = `${repo}@${tag}/${name}`;
  const known = assetIds.get(key);
  if (known && now() - known.at < ASSET_ID_TTL_MS) return known.id;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: githubHeaders(token, "application/vnd.github+json"),
  });
  if (!res.ok) return null;
  const asset = ((await res.json())?.assets || []).find((item) => item?.name === name);
  if (!asset) return null;
  assetIds.set(key, { id: asset.id, at: now() });
  return asset.id;
}

/**
 * One file from a GitHub release, as a fetch Response (status, headers,
 * body stream), Range passed through.
 *
 * `source` is a release download URL, "https://github.com/<owner>/<repo>/
 * releases/download/<tag>/<name>", or { tag, name } in sendforge-downloads.
 * With GITHUB_DOWNLOADS_TOKEN set, the file comes through GitHub's releases
 * API, which works whether the repository is public or private; without it,
 * straight from the public URL. A file that is not there answers 404.
 */
export async function fetchReleaseAsset(source, {
  range = undefined,
  token = process.env.GITHUB_DOWNLOADS_TOKEN,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const headers = range ? { Range: String(range) } : {};
  let where = null;
  if (typeof source === "string") {
    const match = RELEASE_URL.exec(source);
    if (match) where = { repo: match[1], tag: decodeURIComponent(match[2]), name: decodeURIComponent(match[3]) };
  } else if (source?.tag && source?.name) {
    where = { repo: source.repo || DEFAULT_REPO, tag: String(source.tag), name: String(source.name) };
  }

  if (!token || !where) {
    const url = typeof source === "string"
      ? source
      : `https://github.com/${where.repo}/releases/download/${encodeURIComponent(where.tag)}/${encodeURIComponent(where.name)}`;
    return fetchImpl(url, { headers, redirect: "follow" });
  }

  // Twice at most: a build replaces its asset, so a remembered id can go stale.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const id = await assetId(where, token, fetchImpl, now);
    if (!id) break;
    const res = await fetchImpl(`https://api.github.com/repos/${where.repo}/releases/assets/${id}`, {
      headers: { ...githubHeaders(token, "application/octet-stream"), ...headers },
      redirect: "manual",
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    // GitHub hands over a short-lived signed link to its storage, which must
    // not see the token.
    if (location) return fetchImpl(location, { headers, redirect: "follow" });
    if (res.status !== 404) return res;
    assetIds.delete(`${where.repo}@${where.tag}/${where.name}`);
  }
  return new Response(null, { status: 404 });
}

// -- routes -----------------------------------------------------------------------

const PASSED_THROUGH = ["content-length", "content-range", "accept-ranges", "last-modified", "etag"];

export function createDownloadsRouter({
  auth = requireAuth,
  hasEntitlement = hasProductEntitlement,
  fetchAsset = fetchReleaseAsset,
  siteUrl = env.publicSiteUrl,
} = {}) {
  const router = Router();

  const downloadLimiter = createRateLimiter({
    name: "downloads",
    windowMs: 60 * 1000,
    max: 20,
    message: "too_many_downloads",
  });
  const ticketLimiter = createRateLimiter({
    name: "download-tickets",
    windowMs: 60 * 1000,
    max: 30,
    message: "too_many_downloads",
  });

  // A signed-in owner's pass to the installer they bought.
  router.post("/:slug/ticket", ticketLimiter, auth, async (req, res) => {
    const slug = String(req.params.slug || "").toLowerCase();
    const entry = DOWNLOADS[slug];
    if (!entry?.entitlement) return res.status(404).json({ error: "unknown_download" });
    const userId = req.user?.sub;
    let owns = false;
    try {
      owns = Boolean(userId) && (await hasEntitlement(userId, entry.entitlement));
    } catch (error) {
      log("error", "download_ticket_lookup_failed", {
        requestId: getRequestId(req),
        slug,
        message: String(error?.message || error),
      });
      return res.status(503).json({ error: "download_unavailable" });
    }
    if (!owns) return res.status(403).json({ error: "purchase_required" });
    return res.json({ ok: true, ...issueDownloadTicket({ userId, slug }) });
  });

  router.get("/:slug", downloadLimiter, async (req, res) => {
    const slug = String(req.params.slug || "").toLowerCase();
    const entry = DOWNLOADS[slug];
    if (!entry) return res.status(404).json({ error: "unknown_download" });

    if (entry.entitlement && !readDownloadTicket(req.query.ticket, slug)) {
      // Bought on the site first: a browser lands where Download opens the purchase.
      if (req.accepts(["json", "html"]) === "html") {
        return res.redirect(302, `${siteUrl}/products/${slug}/index.html#download`);
      }
      return res.status(403).json({ error: "purchase_required" });
    }

    let upstream;
    try {
      upstream = await fetchAsset(entry.source, { range: req.headers.range });
    } catch (error) {
      log("error", "download_upstream_unreachable", {
        requestId: getRequestId(req),
        slug,
        message: String(error?.message || error),
      });
      return res.status(502).json({ error: "download_unavailable" });
    }

    if (!upstream.ok || !upstream.body) {
      log("error", "download_upstream_failed", {
        requestId: getRequestId(req),
        slug,
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

  return router;
}

export const downloadsRouter = createDownloadsRouter();
