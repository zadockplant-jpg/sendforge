/**
 * Activation for licensed desktop and mobile apps.
 *
 * `POST /activate` is the only endpoint an installed app ever calls, once, and
 * then never again. Everything else here serves the account page and the
 * product pages.
 */

import { Router } from "express";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter, rateLimitByUserOrIp } from "../middleware/rateLimit.js";
import {
  customerTokenMatchesUser,
  getCurrentCustomerAuthState,
  verifyCustomerAccessToken,
} from "../services/auth.service.js";
import { hasProductEntitlement } from "../services/entitlement.service.js";
import {
  DeviceLimitReached,
  activateDevice,
  deactivateDevice,
  describeActivation,
  findByActivationCode,
  recordVerifiedIdentity,
  rotateActivationCode,
} from "../services/deviceActivation.service.js";
import { IdentityProofError, makeChallenge, verifyProof } from "../services/identityProof.service.js";
import { publicKeyHexFromSeed, verifyLicenseToken } from "../services/licenseToken.service.js";
import { LICENSED_PRODUCTS, licensedProduct } from "../services/licensedProducts.js";
import {
  countActiveSeats,
  deviceLimitFor,
  nextDeviceCents,
  seatPricing,
} from "../services/productSeats.service.js";
import { log, getRequestId } from "../utils/logger.js";

export const licensingRouter = Router();

/**
 * Activation is unauthenticated when the app brings a code: the code is 60
 * bits, so the limiter is about keeping the endpoint quiet rather than about
 * making guessing infeasible, which it already is. An app that signs in brings
 * a customer token instead; password guessing happens one step earlier, at
 * /v1/auth/login, which has its own limiter.
 */
const activateLimiter = createRateLimiter({
  name: "license-activate",
  windowMs: 60 * 1000,
  max: 10,
  message: "too_many_activation_attempts",
});

const identityLimiter = createRateLimiter({
  name: "license-identity",
  windowMs: 60 * 1000,
  max: 30,
  message: "too_many_identity_requests",
});

/**
 * The key a device proved it holds, from the fields it sent beside a
 * request, or null. Never throws: a device that sends no proof, an older
 * app, is simply unproven.
 */
function provenIdentity(req, body) {
  const { identityPublicKey, identityChallenge, identityProof } = body || {};
  if (!identityPublicKey && !identityChallenge && !identityProof) return null;
  try {
    return verifyProof(env.licenseSigningKey, {
      publicKeyHex: identityPublicKey,
      challenge: identityChallenge,
      proof: identityProof,
    });
  } catch (error) {
    log("warn", "identity_proof_rejected", {
      requestId: getRequestId(req),
      code: error instanceof IdentityProofError ? error.code : String(error?.message || error),
    });
    return null;
  }
}

const deviceAdminLimiter = createRateLimiter({
  name: "license-devices",
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: rateLimitByUserOrIp,
  message: "too_many_device_requests",
});

function clean(value, max = 120) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

/**
 * The account behind a Bearer token, when the request carries one. The app
 * signs in with the customer's SendForge email and password, so the account
 * that bought the product is the one the machine is tied to, with no code to
 * copy between windows.
 */
async function customerFromBearer(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;

  let payload;
  try {
    payload = verifyCustomerAccessToken(header.slice(7));
  } catch {
    return { error: "invalid_token" };
  }
  const user = await getCurrentCustomerAuthState(payload.sub);
  if (!customerTokenMatchesUser(payload, user)) return { error: "invalid_token" };
  return { userId: user.id };
}

function limitResolver(userId, product) {
  // A seat-based product reads its seats inside the activation lock, so the
  // limit and the device count it is compared against are read together.
  return product.seatBased
    ? (trx) => deviceLimitFor(userId, product, trx)
    : product.deviceLimit;
}

function seatSummary(product, seats) {
  if (!product.seatBased) return {};
  const pricing = seatPricing(product.slug);
  return {
    seatBased: true,
    seats,
    nextDeviceCents: nextDeviceCents(product.slug, seats),
    firstDeviceCents: pricing?.firstDeviceCents ?? null,
    additionalDeviceCents: pricing?.additionalDeviceCents ?? null,
  };
}

async function accountView(userId, product) {
  const limit = await deviceLimitFor(userId, product);
  const seats = product.seatBased ? await countActiveSeats(userId, product.slug) : 0;
  return {
    ...(await describeActivation(userId, product.slug, limit)),
    ...seatSummary(product, seats),
    devicesCanMove: !product.seatBased,
  };
}

licensingRouter.post("/activate", activateLimiter, async (req, res) => {
  const {
    activationCode,
    productSlug,
    deviceId,
    deviceName,
    platform,
    appVersion,
    identityFingerprint,
  } = req.body || {};

  // Deploying without the signing key would otherwise surface to a paying
  // customer as a 500 on the machine they just bought the app for. Fail
  // loudly, in the log, as a condition an operator can act on.
  if (!env.licenseSigningKey) {
    log("error", "license_signing_key_missing", { requestId: getRequestId(req) });
    return res.status(503).json({ error: "licensing_unavailable" });
  }

  let userId;
  let product;
  const signedIn = await customerFromBearer(req);
  if (signedIn?.error) {
    return res.status(401).json({ error: signedIn.error });
  }

  if (signedIn) {
    product = licensedProduct(productSlug);
    if (!product) return res.status(404).json({ error: "unknown_product" });
    userId = signedIn.userId;
  } else {
    const codeRow = await findByActivationCode(activationCode);
    if (!codeRow) {
      return res.status(404).json({ error: "unknown_activation_code" });
    }
    product = licensedProduct(codeRow.product_slug);
    if (!product) {
      return res.status(404).json({ error: "unknown_product" });
    }
    userId = codeRow.user_id;
  }

  // The code or the sign-in identifies the account; the entitlement is what
  // actually grants the product. A refunded or revoked purchase must stop
  // activating new machines even though the owner still has the code.
  const entitled = await hasProductEntitlement(userId, product.entitlementSlug || product.slug);
  if (!entitled) {
    return res.status(403).json({ error: "entitlement_required", productSlug: product.slug });
  }

  // A device that proves its key gets the fingerprint derived from it; one
  // that only states a fingerprint is recorded as unproven, as before.
  const proven = product.slug === "forgedrop" ? provenIdentity(req, req.body) : null;

  try {
    const result = await activateDevice({
      userId,
      productSlug: product.slug,
      deviceId: clean(deviceId, 64),
      deviceName: clean(deviceName, 80),
      platform: clean(platform, 32),
      appVersion: clean(appVersion, 32),
      identityFingerprint: proven ? proven.fingerprint : clean(identityFingerprint, 64),
      identityPublicKey: proven ? proven.publicKeyHex : null,
      deviceLimit: limitResolver(userId, product),
    });

    return res.json({
      license: {
        token: result.token,
        deviceId: result.deviceId,
        kid: result.kid,
        issuedAt: result.issuedAt,
      },
      reactivated: result.reactivated,
      identityVerified: result.identityVerified,
      devices: result.devices,
    });
  } catch (error) {
    if (error instanceof DeviceLimitReached) {
      // Hand back the list so the app can say which machines hold the
      // licence, and for a per-device product what one more device costs.
      const seats = product.seatBased ? await countActiveSeats(userId, product.slug) : 0;
      return res.status(409).json({
        error: "device_limit_reached",
        limit: error.limit,
        devices: error.devices,
        productSlug: product.slug,
        ...seatSummary(product, seats),
      });
    }

    log("error", "license_activation_failed", {
      requestId: getRequestId(req),
      productSlug: product.slug,
      message: String(error?.message || error),
    });
    return res.status(500).json({ error: "activation_failed" });
  }
});

/**
 * A challenge for a ForgeDrop device to prove its identity key against, at
 * activation or later (identityProof.service.js). Needs no account: the
 * challenge proves nothing by itself, and it expires in ten minutes.
 */
licensingRouter.get("/identity-challenge", identityLimiter, (req, res) => {
  try {
    return res.json(makeChallenge(env.licenseSigningKey));
  } catch {
    log("error", "identity_proof_key_missing", { requestId: getRequestId(req) });
    return res.status(503).json({ error: "licensing_unavailable" });
  }
});

/**
 * An already-activated ForgeDrop device proves its key, signing in with the
 * offline licence it holds (the same header the phone link uses).
 */
licensingRouter.post("/identity", identityLimiter, async (req, res) => {
  let publicKey;
  try {
    publicKey = publicKeyHexFromSeed(env.licenseSigningKey);
  } catch {
    return res.status(503).json({ error: "licensing_unavailable" });
  }
  const token = String(req.headers["x-forgedrop-license"] || "").trim();
  const claims = token && token.length <= 4096 ? verifyLicenseToken(token, { publicKeyHex: publicKey }) : null;
  const product = claims ? licensedProduct(claims.product) : null;
  if (!claims || !product || product.slug !== "forgedrop" || !claims.uid || !claims.did) {
    return res.status(401).json({ error: "licence_invalid" });
  }

  let proven;
  try {
    proven = verifyProof(env.licenseSigningKey, {
      publicKeyHex: req.body?.identityPublicKey,
      challenge: req.body?.identityChallenge,
      proof: req.body?.identityProof,
    });
  } catch (error) {
    const code = error instanceof IdentityProofError ? error.code : "identity_proof_invalid";
    return res.status(400).json({ error: code });
  }

  const recorded = await recordVerifiedIdentity({
    userId: claims.uid,
    productSlug: product.slug,
    deviceId: claims.did,
    publicKeyHex: proven.publicKeyHex,
    fingerprint: proven.fingerprint,
  });
  if (!recorded) return res.status(403).json({ error: "device_inactive" });
  return res.json({ identityVerified: true, fingerprint: proven.fingerprint });
});

licensingRouter.get("/products", (_req, res) => {
  res.json({
    products: LICENSED_PRODUCTS.map((p) => ({
      slug: p.slug,
      displayName: p.displayName,
      deviceLimit: p.deviceLimit,
      seatBased: Boolean(p.seatBased),
      ...(p.seatBased ? { pricing: seatPricing(p.slug) } : {}),
    })),
  });
});

/**
 * What the product page needs to price the next device for the signed-in
 * account: $5 for someone who owns none, $4 after that. Answers whether or
 * not the account owns the product yet.
 */
licensingRouter.get("/seats", requireAuth, deviceAdminLimiter, async (req, res) => {
  const product = licensedProduct(req.query.productSlug);
  if (!product || !product.seatBased) return res.status(404).json({ error: "unknown_product" });

  const [owned, seats] = await Promise.all([
    hasProductEntitlement(req.user.sub, product.entitlementSlug || product.slug),
    countActiveSeats(req.user.sub, product.slug),
  ]);
  return res.json({ productSlug: product.slug, owned, ...seatSummary(product, seats) });
});

licensingRouter.get("/devices", requireAuth, deviceAdminLimiter, async (req, res) => {
  const product = licensedProduct(req.query.productSlug);
  if (!product) return res.status(404).json({ error: "unknown_product" });

  const owned = await hasProductEntitlement(
    req.user.sub,
    product.entitlementSlug || product.slug
  );
  if (!owned) return res.status(403).json({ error: "entitlement_required" });

  return res.json(await accountView(req.user.sub, product));
});

licensingRouter.post(
  "/devices/:deviceId/deactivate",
  requireAuth,
  deviceAdminLimiter,
  async (req, res) => {
    const product = licensedProduct(req.body?.productSlug || req.query.productSlug);
    if (!product) return res.status(404).json({ error: "unknown_product" });

    // A per-device purchase is for that device. Freeing its slot would let
    // the licence, which keeps working offline on the old PC, move to a new
    // one - a second device for the price of one. A new PC is a new purchase.
    if (product.seatBased) {
      return res.status(403).json({ error: "device_moves_not_allowed", productSlug: product.slug });
    }

    const row = await deactivateDevice(req.user.sub, product.slug, req.params.deviceId);
    if (!row) return res.status(404).json({ error: "unknown_device" });

    return res.json({ ok: true, ...(await accountView(req.user.sub, product)) });
  }
);

licensingRouter.post("/code/rotate", requireAuth, deviceAdminLimiter, async (req, res) => {
  const product = licensedProduct(req.body?.productSlug);
  if (!product) return res.status(404).json({ error: "unknown_product" });

  const owned = await hasProductEntitlement(
    req.user.sub,
    product.entitlementSlug || product.slug
  );
  if (!owned) return res.status(403).json({ error: "entitlement_required" });

  await rotateActivationCode(req.user.sub, product.slug);
  return res.json(await accountView(req.user.sub, product));
});
