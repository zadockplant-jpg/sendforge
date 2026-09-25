// My Home Builder client portal: the pages under myhomebuilderllc.com/clients, their data,
// Stripe invoice payments and SendGrid email. The site's Cloudflare Pages Function forwards
// /clients/* here with a shared secret (like JayJe's account proxy); Stripe calls the webhook
// directly. Off until MHB_PORTAL_ENABLED=true. See myhomebuilder-portal.md.
import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { db } from "../../config/db.js";
import { adminWritesEnabled } from "../../middleware/adminAuth.js";
import { handlePortalRequest } from "./handler.js";
import { messagePage } from "./pages.js";
import { responseHeaders } from "./security.js";
import { createStore, hitRateLimit } from "./store.js";

const MAX_BODY_BYTES = 21 * 1024 * 1024;
const MAX_WEBHOOK_BYTES = 256 * 1024;
// Per visitor address, per minute. Logins and admin codes get the tighter limit.
const POST_LIMIT = 120;
const SIGN_IN_LIMIT = 20;
const SIGN_IN_PATHS = new Set(["/clients/login", "/clients/admin/verify"]);
const ADMIN_SESSION_PATHS = new Set(["/clients/admin/request", "/clients/admin/verify", "/clients/admin/logout"]);
const DROPPED_HEADERS = new Set(["connection", "content-length", "expect", "host", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

const store = createStore(db);
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function secureEqual(left, right) {
  const hash = (value) => createHash("sha256").update(String(value || "")).digest();
  return timingSafeEqual(hash(left), hash(right));
}

export function siteUrl(env = process.env) {
  return (env.MHB_SITE_URL || "https://myhomebuilderllc.com").replace(/\/+$/u, "");
}

function allowedOrigins(env = process.env) {
  return (env.MHB_ALLOWED_ORIGINS || "https://myhomebuilderllc.com,https://www.myhomebuilderllc.com").split(",").map((origin) => origin.trim()).filter(Boolean);
}

// The portal code reads its settings under these names.
export function portalEnv(env = process.env) {
  return {
    CLIENT_PORTAL_PASSWORD: env.MHB_CLIENT_PORTAL_PASSWORD || "",
    CLIENT_PORTAL_SESSION_SECRET: env.MHB_SESSION_SECRET || "",
    STRIPE_SECRET_KEY: String(env.MHB_STRIPE_SECRET_KEY || "").trim(),
    STRIPE_WEBHOOK_SECRET: String(env.MHB_STRIPE_WEBHOOK_SECRET || "").trim(),
    // The same SendGrid key as the rest of the backend; myhomebuilderllc.com is its own authenticated sender.
    SENDGRID_API_KEY: String(env.SENDGRID_API_KEY || "").trim(),
    EMAIL_FROM: env.MHB_EMAIL_FROM || "",
    EMAIL_CLIENT_FROM: env.MHB_EMAIL_CLIENT_FROM || "",
    EMAIL_REPLY_TO: env.MHB_EMAIL_REPLY_TO || "",
    ADMIN_EMAIL: env.MHB_ADMIN_EMAIL || ""
  };
}

function webRequest(req, url, body, clientIp) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROPPED_HEADERS.has(name) || name.startsWith("x-mhb-")) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
  }
  if (clientIp) headers.set("CF-Connecting-IP", clientIp);
  const init = { method: req.method, headers };
  if (!["GET", "HEAD"].includes(req.method) && Buffer.isBuffer(body) && body.length) {
    init.body = body;
    headers.set("Content-Length", String(body.length));
  }
  return new Request(url, init);
}

async function send(res, response) {
  res.status(response.status);
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader("Set-Cookie", cookies);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

function page(res, status, heading, lead) {
  const headers = responseHeaders();
  for (const [name, value] of headers) res.setHeader(name, value);
  res.status(status).send(messagePage({ heading, lead }));
}

export const myhomebuilderPortalRouter = express.Router();

myhomebuilderPortalRouter.use((_req, res, next) => {
  if (process.env.MHB_PORTAL_ENABLED !== "true") return page(res, 503, "Temporarily unavailable.", "The client portal is being configured. Please try again shortly.");
  next();
});

// Stripe signs this request itself; it does not come through the site's Function.
myhomebuilderPortalRouter.post(
  "/stripe/webhook",
  express.raw({ type: () => true, limit: MAX_WEBHOOK_BYTES }),
  wrap(async (req, res) => {
    const request = webRequest(req, `${siteUrl()}/clients/stripe/webhook`, req.body);
    await send(res, await handlePortalRequest({ request, env: portalEnv() }));
  })
);

// Everything else must come from the site's Function, which alone holds the shared secret and
// passes the visitor's address.
myhomebuilderPortalRouter.use((req, res, next) => {
  const secret = process.env.MHB_PROXY_SECRET || "";
  const ip = req.get("X-MHB-Client-Ip") || "";
  if (secret.length < 32 || !secureEqual(req.get("X-MHB-Proxy-Key"), secret) || !allowedOrigins().includes(req.get("X-MHB-Origin")) || !isIP(ip)) {
    return res.status(403).type("text/plain").send("Forbidden");
  }
  if (!req.path.startsWith("/clients")) return page(res, 404, "Page not found.", '<a href="/clients">Return to the client portal.</a>');
  next();
});

myhomebuilderPortalRouter.use(
  wrap(async (req, res, next) => {
    if (req.method !== "POST") return next();
    const ip = req.get("X-MHB-Client-Ip");
    const signIn = SIGN_IN_PATHS.has(req.path);
    const hits = await hitRateLimit(store, `mhb:${signIn ? "sign-in" : "post"}:${ip}`, 60);
    if (hits > (signIn ? SIGN_IN_LIMIT : POST_LIMIT)) return page(res, 429, "Too many requests.", "Please wait a minute and try again.");
    // The backend-wide admin write switch also pauses changes made in this admin panel.
    if (req.path.startsWith("/clients/admin/") && !ADMIN_SESSION_PATHS.has(req.path) && !adminWritesEnabled()) {
      return page(res, 423, "Admin changes are paused.", "Changes are temporarily turned off. Please try again later.");
    }
    next();
  })
);

myhomebuilderPortalRouter.use(
  express.raw({ type: () => true, limit: MAX_BODY_BYTES }),
  wrap(async (req, res) => {
    const origin = req.get("X-MHB-Origin");
    const request = webRequest(req, `${origin}${req.url}`, req.body, req.get("X-MHB-Client-Ip"));
    await send(res, await handlePortalRequest({ request, env: portalEnv() }));
  })
);

myhomebuilderPortalRouter.use((error, _req, res, _next) => {
  if (error?.type === "entity.too.large") return page(res, 413, "That file is too large.", "Use a file under 20 MB.");
  console.error("[myhomebuilder-portal] request failed", error?.code || error?.type || error?.name || "internal");
  return page(res, 503, "Temporarily unavailable.", 'Please try again shortly or <a href="/#contact">contact us through the main website</a>.');
});
