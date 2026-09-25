import { timingSafeEqual } from "node:crypto";

export const CLIENT_COOKIE = "__Secure-mhb_client_session";
export const ADMIN_COOKIE = "__Secure-mhb_admin_session";
export const CLIENT_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const ADMIN_SESSION_TTL_SECONDS = 2 * 60 * 60;
export const ADMIN_CODE_TTL_SECONDS = 10 * 60;
export const ADMIN_CODE_MAX_ATTEMPTS = 5;

const textEncoder = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;

export function responseHeaders(contentType = "text/html; charset=utf-8", { scripts = false } = {}) {
  const script = scripts ? "script-src 'self'; " : "";
  return new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Security-Policy": `default-src 'none'; style-src 'self'; img-src 'self' data:; ${script}form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'; connect-src 'none'; object-src 'none'`,
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Vary": "Cookie",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive"
  });
}

export function toBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(text) {
  const normalized = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Compares SHA-256 digests so the comparison takes the same time whatever the input lengths.
export async function constantTimeMatches(provided, expected) {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", textEncoder.encode(String(provided ?? ""))),
    crypto.subtle.digest("SHA-256", textEncoder.encode(String(expected ?? "")))
  ]);
  return timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash));
}

async function hmacKey(secret, usages) {
  return crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

export async function hmacSign(secret, payload) {
  const key = await hmacKey(secret, ["sign"]);
  return toBase64Url(await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload)));
}

export async function hmacHex(secret, payload) {
  const key = await hmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomId(bytes = 12) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toBase64Url(buffer);
}

export function randomCode() {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return String(buffer[0] % 1000000).padStart(6, "0");
}

export async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(bits)}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const [scheme, iterationsText, saltText, hashText] = stored.split("$");
  const iterations = Number(iterationsText);
  if (scheme !== "pbkdf2" || !Number.isSafeInteger(iterations) || !saltText || !hashText) return false;
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(saltText), iterations }, key, 256);
  return constantTimeMatches(toBase64Url(bits), hashText);
}

export function readCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return part.slice(separator + 1).trim();
  }
  return "";
}

function cookieLine(name, value, maxAge) {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/clients; HttpOnly; Secure; SameSite=Lax`;
}

function expiredCookieLine(name) {
  return `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/clients; HttpOnly; Secure; SameSite=Lax`;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export function isValidSlug(value) {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

export async function createClientSession(secret, slug) {
  const expiry = Math.floor(Date.now() / 1000) + CLIENT_SESSION_TTL_SECONDS;
  const signature = await hmacSign(secret, `mhb-client-portal:v2:${slug}:${expiry}`);
  return cookieLine(CLIENT_COOKIE, `${slug}.${expiry}.${signature}`, CLIENT_SESSION_TTL_SECONDS);
}

export function expiredClientSession() {
  return expiredCookieLine(CLIENT_COOKIE);
}

export async function readClientSession(request, secret, defaultSlug) {
  const token = readCookie(request, CLIENT_COOKIE);
  const parts = token.split(".");
  const now = Math.floor(Date.now() / 1000);

  if (parts.length === 3) {
    const [slug, expiryText, signature] = parts;
    const expiry = Number(expiryText);
    if (!isValidSlug(slug) || !Number.isSafeInteger(expiry) || expiry <= now || !signature) return null;
    const expected = await hmacSign(secret, `mhb-client-portal:v2:${slug}:${expiry}`);
    return (await constantTimeMatches(signature, expected)) ? { slug } : null;
  }

  if (parts.length === 2) {
    const [expiryText, signature] = parts;
    const expiry = Number(expiryText);
    if (!Number.isSafeInteger(expiry) || expiry <= now || !signature) return null;
    const expected = await hmacSign(secret, `mhb-client-portal:v1:${expiry}`);
    return (await constantTimeMatches(signature, expected)) ? { slug: defaultSlug } : null;
  }

  return null;
}

export async function createAdminSession(secret) {
  const expiry = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS;
  const signature = await hmacSign(secret, `mhb-admin:v1:${expiry}`);
  return cookieLine(ADMIN_COOKIE, `${expiry}.${signature}`, ADMIN_SESSION_TTL_SECONDS);
}

export function expiredAdminSession() {
  return expiredCookieLine(ADMIN_COOKIE);
}

export async function hasAdminSession(request, secret) {
  const token = readCookie(request, ADMIN_COOKIE);
  const separator = token.indexOf(".");
  if (separator < 1) return false;
  const expiry = Number(token.slice(0, separator));
  const signature = token.slice(separator + 1);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiry) || expiry <= now || !signature) return false;
  const expected = await hmacSign(secret, `mhb-admin:v1:${expiry}`);
  return constantTimeMatches(signature, expected);
}

export async function readBoundedForm(request, maxBytes = 4096) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  if (!request.body) return new URLSearchParams();

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let bodyText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel("Form body is too large");
      return null;
    }
    bodyText += decoder.decode(value, { stream: true });
  }

  bodyText += decoder.decode();
  return new URLSearchParams(bodyText);
}

// The Express layer already caps the body size; a declared length is checked when present.
export async function readBoundedMultipart(request, maxBytes) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return null;
  const declared = Number(request.headers.get("Content-Length") || "0");
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) return null;
  try {
    return await request.formData();
  } catch {
    return null;
  }
}
