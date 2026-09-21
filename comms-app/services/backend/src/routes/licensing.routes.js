/**
 * Activation for licensed desktop and mobile apps.
 *
 * `POST /activate` is the only endpoint an installed app ever calls, once, and
 * then never again. Everything else here serves the account page.
 */

import { Router } from "express";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter, rateLimitByUserOrIp } from "../middleware/rateLimit.js";
import { hasProductEntitlement } from "../services/entitlement.service.js";
import {
  DEFAULT_DEVICE_LIMIT,
  DeviceLimitReached,
  activateDevice,
  deactivateDevice,
  describeActivation,
  findByActivationCode,
  rotateActivationCode,
} from "../services/deviceActivation.service.js";
import { LICENSED_PRODUCTS, licensedProduct } from "../services/licensedProducts.js";
import { log, getRequestId } from "../utils/logger.js";

export const licensingRouter = Router();

/**
 * Activation is unauthenticated: the app collects a code, not a password. The
 * code is 60 bits, so the limiter is about keeping the endpoint quiet rather
 * than about making guessing infeasible, which it already is.
 */
const activateLimiter = createRateLimiter({
  name: "license-activate",
  windowMs: 60 * 1000,
  max: 10,
  message: "too_many_activation_attempts",
});

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

licensingRouter.post("/activate", activateLimiter, async (req, res) => {
  const { activationCode, deviceId, deviceName, platform, appVersion, identityFingerprint } =
    req.body || {};

  // Deploying without the signing key would otherwise surface to a paying
  // customer as a 500 on the machine they just bought the app for. Fail
  // loudly, in the log, as a condition an operator can act on.
  if (!env.licenseSigningKey) {
    log("error", "license_signing_key_missing", { requestId: getRequestId(req) });
    return res.status(503).json({ error: "licensing_unavailable" });
  }

  const codeRow = await findByActivationCode(activationCode);
  if (!codeRow) {
    return res.status(404).json({ error: "unknown_activation_code" });
  }

  const product = licensedProduct(codeRow.product_slug);
  if (!product) {
    return res.status(404).json({ error: "unknown_product" });
  }

  // The code identifies the account; the entitlement is what actually grants
  // the product. A refunded or revoked purchase must stop activating new
  // machines even though the owner still has the code written down.
  const entitled = await hasProductEntitlement(
    codeRow.user_id,
    product.entitlementSlug || product.slug
  );
  if (!entitled) {
    return res.status(403).json({ error: "entitlement_required" });
  }

  try {
    const result = await activateDevice({
      userId: codeRow.user_id,
      productSlug: product.slug,
      deviceId: clean(deviceId, 64),
      deviceName: clean(deviceName, 80),
      platform: clean(platform, 32),
      appVersion: clean(appVersion, 32),
      identityFingerprint: clean(identityFingerprint, 64),
      deviceLimit: product.deviceLimit || DEFAULT_DEVICE_LIMIT,
    });

    return res.json({
      license: {
        token: result.token,
        deviceId: result.deviceId,
        kid: result.kid,
        issuedAt: result.issuedAt,
      },
      reactivated: result.reactivated,
      devices: result.devices,
    });
  } catch (error) {
    if (error instanceof DeviceLimitReached) {
      // Hand back the list so the app can offer to free a slot in place,
      // rather than sending the user off to a website mid-install.
      return res.status(409).json({
        error: "device_limit_reached",
        limit: error.limit,
        devices: error.devices,
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

licensingRouter.get("/products", (_req, res) => {
  res.json({
    products: LICENSED_PRODUCTS.map((p) => ({
      slug: p.slug,
      displayName: p.displayName,
      deviceLimit: p.deviceLimit,
    })),
  });
});

licensingRouter.get("/devices", requireAuth, deviceAdminLimiter, async (req, res) => {
  const product = licensedProduct(req.query.productSlug);
  if (!product) return res.status(404).json({ error: "unknown_product" });

  const owned = await hasProductEntitlement(
    req.user.sub,
    product.entitlementSlug || product.slug
  );
  if (!owned) return res.status(403).json({ error: "entitlement_required" });

  return res.json(
    await describeActivation(req.user.sub, product.slug, product.deviceLimit)
  );
});

licensingRouter.post(
  "/devices/:deviceId/deactivate",
  requireAuth,
  deviceAdminLimiter,
  async (req, res) => {
    const product = licensedProduct(req.body?.productSlug || req.query.productSlug);
    if (!product) return res.status(404).json({ error: "unknown_product" });

    const row = await deactivateDevice(req.user.sub, product.slug, req.params.deviceId);
    if (!row) return res.status(404).json({ error: "unknown_device" });

    return res.json({
      ok: true,
      ...(await describeActivation(req.user.sub, product.slug, product.deviceLimit)),
    });
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
  return res.json(
    await describeActivation(req.user.sub, product.slug, product.deviceLimit)
  );
});
