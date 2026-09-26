/**
 * Desktop sign-in for the phone link: the offline licence the app already
 * holds, sent as `X-ForgeDrop-License: FD1.<payload>.<sig>`.
 *
 * The signature proves the token is ours; it cannot say whether the machine
 * still holds a slot or the account still owns ForgeDrop, so those are read
 * from the database. A desktop long-polls around the clock while the link is
 * on, so the answer is kept per token for 60 s. Freeing a slot on the account
 * page therefore cuts that desktop's link within a minute.
 *
 * Only tokens whose signature verified are cached, so a stranger cannot fill
 * the cache with junk, and a database error is never cached.
 *
 * Cloud pickup (../forgedrop-pickup) signs desktops in with this too.
 */

import { publicKeyHexFromSeed, verifyLicenseToken } from "../../services/licenseToken.service.js";
import { canonicalUuid } from "./shapes.js";

export const LICENCE_HEADER = "x-forgedrop-license";
const MAX_TOKEN_CHARS = 4096;

export function hasLicenceHeader(req) {
  return req.headers[LICENCE_HEADER] !== undefined;
}

export function createDesktopAuth({
  signingKey,
  product,
  devices,
  hasEntitlement,
  now = Date.now,
  ttlMs,
  maxEntries = 10_000,
  log = () => {},
  // Cloud pickup signs desktops in the same way, and answers its own 503.
  unavailableError = "link_unavailable",
  logPrefix = "forgedrop_link",
}) {
  /** token -> { expiresAt, verdict: Promise<{ ok, userId, deviceId } | { status, error }> } */
  const verdicts = new Map();
  let key = { seed: undefined, hex: null };

  /** Null when no key is configured, or the one configured is not a seed. */
  function publicKeyHex() {
    const seed = String(signingKey() || "").trim();
    if (seed !== key.seed) {
      let hex = null;
      if (seed) {
        try {
          hex = publicKeyHexFromSeed(seed);
        } catch (error) {
          log("error", `${logPrefix}_signing_key_invalid`, { message: String(error?.message || error) });
        }
      }
      key = { seed, hex };
    }
    return key.hex;
  }

  function claimsOf(token, publicKey, at) {
    let payload;
    try {
      payload = verifyLicenseToken(token, { publicKeyHex: publicKey });
    } catch {
      return null;
    }
    // verifyLicenseToken proves only that we signed it. One key signs every
    // licensed product, so the product check is what keeps a Rose Colored
    // Glasses licence out of here.
    if (!payload || typeof payload !== "object" || payload.product !== product) return null;
    const userId = canonicalUuid(payload.uid);
    const deviceId = canonicalUuid(payload.did);
    if (!userId || !deviceId) return null;
    // Licences are perpetual today (exp null); honour one if it ever appears.
    if (typeof payload.exp === "number" && payload.exp * 1000 <= at) return null;
    return { userId, deviceId };
  }

  async function judge({ userId, deviceId }) {
    if (!(await devices.findActive(userId, deviceId))) {
      return { ok: false, status: 403, error: "device_inactive" };
    }
    if (!(await hasEntitlement(userId))) {
      return { ok: false, status: 403, error: "entitlement_required" };
    }
    return { ok: true, userId, deviceId };
  }

  function remember(token, entry, at) {
    if (verdicts.size >= maxEntries) {
      for (const [cached, value] of verdicts) if (value.expiresAt <= at) verdicts.delete(cached);
      while (verdicts.size >= maxEntries) verdicts.delete(verdicts.keys().next().value);
    }
    verdicts.set(token, entry);
  }

  return async function desktopAuth(req, res, next) {
    const publicKey = publicKeyHex();
    if (!publicKey) return res.status(503).json({ error: unavailableError });

    const token = String(req.headers[LICENCE_HEADER] || "").trim();
    if (!token || token.length > MAX_TOKEN_CHARS) {
      return res.status(401).json({ error: "licence_invalid" });
    }

    const at = now();
    let entry = verdicts.get(token);
    if (!entry || entry.expiresAt <= at) {
      const claims = claimsOf(token, publicKey, at);
      if (!claims) return res.status(401).json({ error: "licence_invalid" });
      // The promise is cached, not its result, so a burst of requests on one
      // new token shares a single lookup.
      entry = { expiresAt: at + ttlMs, verdict: judge(claims) };
      remember(token, entry, at);
    }

    let verdict;
    try {
      verdict = await entry.verdict;
    } catch (error) {
      if (verdicts.get(token) === entry) verdicts.delete(token);
      log("error", `${logPrefix}_licence_check_failed`, { message: String(error?.message || error) });
      return res.status(503).json({ error: unavailableError });
    }
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

    req.link = {
      kind: "desktop",
      userId: verdict.userId,
      deviceId: verdict.deviceId,
      address: `desktop:${verdict.deviceId}`,
    };
    return next();
  };
}
