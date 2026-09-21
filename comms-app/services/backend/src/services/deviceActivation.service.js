/**
 * Activation slots: how many machines a licence may run on, and which.
 *
 * The rule the product sells is "up to 5 devices". Enforcing that correctly is
 * the whole job here, and the one subtle part is the counting.
 */

import crypto from "crypto";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import {
  formatActivationCode,
  generateActivationCode,
  normalizeActivationCode,
  signLicenseToken,
} from "./licenseToken.service.js";

export const DEFAULT_DEVICE_LIMIT = 5;

function normalizeSlug(slug) {
  return String(slug || "").trim().toLowerCase();
}

/**
 * Postgres hashes the (user, product) pair into one advisory lock, held for
 * the life of the transaction.
 *
 * Without it the slot check is a classic read-then-write race: five installs
 * fired at once each COUNT 4, each decide there is room, and each INSERT. The
 * unique index on (user_id, product_slug, device_id) does not help, because
 * every one of them is a *different* device. The account ends up with 9
 * devices on a 5-device licence and nothing in the schema objects.
 */
async function withActivationLock(trx, userId, productSlug, fn) {
  await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [
    `device-activation:${userId}:${productSlug}`,
  ]);
  return fn();
}

export async function getOrCreateActivationCode(userId, productSlug) {
  const slug = normalizeSlug(productSlug);
  const existing = await db("product_activation_codes")
    .where({ user_id: userId, product_slug: slug })
    .first();
  if (existing) return existing;

  const code = generateActivationCode();
  const row = {
    id: crypto.randomUUID(),
    user_id: userId,
    product_slug: slug,
    code,
    code_normalized: normalizeActivationCode(code),
  };

  // Two tabs hitting the account page at once both try to mint. The unique
  // index on (user_id, product_slug) settles it; the loser reads the winner's.
  const inserted = await db("product_activation_codes")
    .insert(row)
    .onConflict(["user_id", "product_slug"])
    .ignore()
    .returning("*");

  if (inserted[0]) return inserted[0];
  return db("product_activation_codes")
    .where({ user_id: userId, product_slug: slug })
    .first();
}

export async function rotateActivationCode(userId, productSlug) {
  const slug = normalizeSlug(productSlug);
  const code = generateActivationCode();

  const rows = await db("product_activation_codes")
    .where({ user_id: userId, product_slug: slug })
    .update({
      code,
      code_normalized: normalizeActivationCode(code),
      rotated_at: db.fn.now(),
    })
    .returning("*");

  if (rows[0]) return rows[0];
  return getOrCreateActivationCode(userId, productSlug);
}

export async function findByActivationCode(code) {
  const normalized = normalizeActivationCode(code);
  if (!normalized) return null;
  return db("product_activation_codes").where({ code_normalized: normalized }).first();
}

export async function listDevices(userId, productSlug, { activeOnly = true } = {}) {
  const query = db("device_activations")
    .where({ user_id: userId, product_slug: normalizeSlug(productSlug) })
    .orderBy("created_at", "asc");
  if (activeOnly) query.andWhere({ status: "active" });
  return query;
}

export function presentDevice(row) {
  return {
    deviceId: row.device_id,
    deviceName: row.device_name,
    platform: row.platform,
    appVersion: row.app_version,
    identityFingerprint: row.identity_fingerprint,
    activatedAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class DeviceLimitReached extends Error {
  constructor(devices, limit) {
    super("device_limit_reached");
    this.code = "device_limit_reached";
    this.devices = devices;
    this.limit = limit;
  }
}

/**
 * Claim a slot and mint the offline licence.
 *
 * Re-activating a device already on the account (a reinstall, or the user
 * simply running activation twice) re-signs without consuming a second slot.
 * That idempotency is load-bearing: without it, reinstalling Windows five
 * times exhausts a licence the owner never shared.
 */
export async function activateDevice({
  userId,
  productSlug,
  deviceId = null,
  deviceName = null,
  platform = null,
  appVersion = null,
  identityFingerprint = null,
  deviceLimit = DEFAULT_DEVICE_LIMIT,
}) {
  const slug = normalizeSlug(productSlug);

  return db.transaction(async (trx) =>
    withActivationLock(trx, userId, slug, async () => {
      const existing = deviceId
        ? await trx("device_activations")
            .where({ user_id: userId, product_slug: slug, device_id: deviceId })
            .first()
        : null;

      const active = await trx("device_activations")
        .where({ user_id: userId, product_slug: slug, status: "active" })
        .select("*");

      const isReturning = existing && existing.status === "active";
      if (!isReturning && active.length >= deviceLimit) {
        throw new DeviceLimitReached(active.map(presentDevice), deviceLimit);
      }

      const resolvedDeviceId = existing?.device_id || deviceId || crypto.randomUUID();
      const issuedAt = new Date();

      const token = signLicenseToken(
        {
          v: 1,
          product: slug,
          uid: userId,
          did: resolvedDeviceId,
          name: deviceName || null,
          iat: Math.floor(issuedAt.getTime() / 1000),
          exp: null, // perpetual, matching expires_at NULL in product_entitlements
          lim: deviceLimit,
        },
        { signingKey: env.licenseSigningKey, kid: env.licenseSigningKid }
      );

      const payload = {
        id: existing?.id || crypto.randomUUID(),
        user_id: userId,
        product_slug: slug,
        device_id: resolvedDeviceId,
        device_name: deviceName,
        platform,
        app_version: appVersion,
        identity_fingerprint: identityFingerprint,
        license_kid: env.licenseSigningKid,
        license_issued_at: issuedAt,
        last_seen_at: issuedAt,
        status: "active",
        deactivated_at: null,
        updated_at: db.fn.now(),
      };

      await trx("device_activations")
        .insert(payload)
        .onConflict(["user_id", "product_slug", "device_id"])
        .merge({
          device_name: payload.device_name,
          platform: payload.platform,
          app_version: payload.app_version,
          identity_fingerprint: payload.identity_fingerprint,
          license_kid: payload.license_kid,
          license_issued_at: payload.license_issued_at,
          last_seen_at: payload.last_seen_at,
          status: "active",
          deactivated_at: null,
          updated_at: db.fn.now(),
        });

      const used = isReturning ? active.length : active.length + 1;
      return {
        token,
        deviceId: resolvedDeviceId,
        kid: env.licenseSigningKid,
        issuedAt,
        reactivated: Boolean(isReturning),
        devices: { used, limit: deviceLimit },
      };
    })
  );
}

/**
 * Frees a slot. It does NOT reach the installed copy - that machine holds a
 * signed licence it can verify without us, which is the price of working
 * offline forever. Say "frees a slot" in the UI, never "revoke access".
 */
export async function deactivateDevice(userId, productSlug, deviceId) {
  const slug = normalizeSlug(productSlug);
  const rows = await db("device_activations")
    .where({
      user_id: userId,
      product_slug: slug,
      device_id: deviceId,
      status: "active",
    })
    .update({
      status: "deactivated",
      deactivated_at: db.fn.now(),
      updated_at: db.fn.now(),
    })
    .returning("*");

  return rows[0] || null;
}

export async function describeActivation(userId, productSlug, deviceLimit = DEFAULT_DEVICE_LIMIT) {
  const slug = normalizeSlug(productSlug);
  const [codeRow, devices] = await Promise.all([
    getOrCreateActivationCode(userId, slug),
    listDevices(userId, slug),
  ]);

  return {
    productSlug: slug,
    activationCode: codeRow ? formatActivationCode(codeRow.code_normalized) : null,
    devices: devices.map(presentDevice),
    limit: deviceLimit,
    used: devices.length,
  };
}
