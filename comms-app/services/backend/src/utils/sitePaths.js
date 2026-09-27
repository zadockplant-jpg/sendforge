// Where an emailed link may send someone back to on the website.
//
// A verification link carries the page its reader was headed for (a
// program's checkout, say) so that verifying carries straight on there. Only
// a path on the site itself is accepted; anything else, including another
// origin, a protocol-relative "//host" or a backslash trick, becomes the
// fallback, so a link can never be made to forward someone off the site.

import { env } from "../config/env.js";

const MAX_PATH_LENGTH = 300;

export function safeSitePath(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (!text || text.length > MAX_PATH_LENGTH) return fallback;
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\")) return fallback;
  try {
    const base = new URL(env.publicSiteUrl);
    const resolved = new URL(text, base);
    if (resolved.origin !== base.origin) return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}

export function siteUrl(path) {
  return new URL(path, env.publicSiteUrl).toString();
}
