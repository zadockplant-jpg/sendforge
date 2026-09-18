// Comp codes: a code typed into the referral box (or carried on a signup
// link) that gives the account TabForge Pro and Private Sync without a
// purchase. They live in referral_codes with metadata.kind = "comp" and no
// owner, so the referral resolver ignores them for attribution while the
// admin catalogue still lists them. Redemption is the pair of entitlements
// purchase fulfilment would have granted, marked with the code.

import crypto from "crypto";
import { db } from "../config/db.js";
import { log } from "../utils/logger.js";
import { grantProductEntitlement } from "./entitlement.service.js";
import { ensureReferralCodeForUser } from "./referrals/referral.service.js";
import { PERK_ENTITLEMENT_SLUGS } from "./adminReferralControls.service.js";

export const COMP_CODE_KIND = "comp";
export const COMP_CODE_SOURCE = "comp_code";
export const COMP_GRANT_SLUGS = PERK_ENTITLEMENT_SLUGS;
export const COMP_GRANT_LABELS = Object.freeze(["TabForge Pro", "Private Sync"]);

// Seeded on every boot if missing, so the code exists as soon as the
// service deploys; the owner dashboard can pause it or add others.
export const DEFAULT_COMP_CODES = Object.freeze([
  { code: "SENDIT2026", note: "Launch comp: TabForge Pro and Private Sync included at signup.", maxRedemptions: null },
]);

export function normalizeCompCode(value) {
  return String(value || "")
    .trim()
    .replace(/^#/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
}

export function isCompCodeRow(row) {
  return Boolean(row) && row?.metadata?.kind === COMP_CODE_KIND;
}

export function compCodeAvailability(row, redeemedCount = 0) {
  if (!isCompCodeRow(row)) return { available: false, reason: "unknown_code", remaining: null };
  if (String(row.status || "") !== "active") return { available: false, reason: "code_inactive", remaining: null };
  const expiresAt = row.metadata?.expires_at ? new Date(row.metadata.expires_at) : null;
  if (expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
    return { available: false, reason: "code_expired", remaining: null };
  }
  const max = Number(row.metadata?.max_redemptions);
  const limit = Number.isInteger(max) && max > 0 ? max : null;
  const remaining = limit === null ? null : Math.max(0, limit - Number(redeemedCount || 0));
  if (remaining === 0) return { available: false, reason: "code_exhausted", remaining };
  return { available: true, reason: null, remaining };
}

export function compCodePublicView(row, availability) {
  return {
    code: row.code,
    valid: Boolean(availability?.available),
    reason: availability?.reason || null,
    grants: [...COMP_GRANT_LABELS],
    note: row.metadata?.note || null,
  };
}

export function compCodeSignupLink(code) {
  return `/signup.html?ref=${encodeURIComponent(normalizeCompCode(code))}`;
}

export async function findCompCode(code, trx = db) {
  const normalized = normalizeCompCode(code);
  if (!normalized) return null;
  const row = await trx("referral_codes").where({ code: normalized }).first();
  return isCompCodeRow(row) ? row : null;
}

export async function countCompRedemptions(code, trx = db) {
  const row = await trx("product_entitlements")
    .where({ source: COMP_CODE_SOURCE, product_slug: "tabforge" })
    .whereRaw("metadata->>'comp_code' = ?", [normalizeCompCode(code)])
    .count({ count: "id" })
    .first();
  return Number(row?.count || 0);
}

export async function compCodeStatus(code, trx = db) {
  const row = await findCompCode(code, trx);
  if (!row) return { row: null, availability: { available: false, reason: "unknown_code", remaining: null }, redeemed: 0 };
  const redeemed = await countCompRedemptions(row.code, trx);
  return { row, availability: compCodeAvailability(row, redeemed), redeemed };
}

// Signup keeps the code on the account until the email is verified; a real
// referrer, when one resolved, keeps the field instead.
export async function noteCompCodeForUser({ trx = db, userId, code }) {
  if (!userId) return false;
  const row = await findCompCode(code, trx);
  if (!row) return false;
  const user = await trx("users").where({ id: userId }).first();
  if (!user || user.referred_by_user_id) return false;
  await trx("users").where({ id: userId }).update({ referred_by_input: row.code });
  return true;
}

export async function redeemCompCodeForUser({ userId, code, via = "account", trx = db }) {
  const { row, availability } = await compCodeStatus(code, trx);
  if (!row) return { granted: false, reason: "unknown_code" };
  const user = await trx("users").where({ id: userId }).first();
  if (!user) return { granted: false, reason: "user_not_found" };
  const owned = await trx("product_entitlements")
    .where({ user_id: userId, product_slug: "tabforge", status: "active" })
    .andWhere((qb) => { qb.whereNull("expires_at").orWhere("expires_at", ">", trx.fn.now()); })
    .first();
  if (owned) {
    const sameCode = owned.source === COMP_CODE_SOURCE && owned.metadata?.comp_code === row.code;
    return { granted: false, reason: sameCode ? "already_redeemed" : "already_owns_pro" };
  }
  if (!availability.available) return { granted: false, reason: availability.reason };

  const metadata = { comp: true, comp_code: row.code, redeemed_at: new Date().toISOString(), via, note: row.metadata?.note || null };
  const products = [];
  for (const slug of COMP_GRANT_SLUGS) {
    const item = await grantProductEntitlement({ userId, productSlug: slug, source: COMP_CODE_SOURCE, sourceRef: row.code, metadata });
    products.push(item?.product_slug || slug);
  }
  await ensureReferralCodeForUser(user, trx);
  log("info", "comp_code_redeemed", { userId, code: row.code, via });
  return { granted: true, code: row.code, products };
}

export async function redeemPendingCompCodeForVerifiedUser(userId) {
  const user = await db("users").where({ id: userId }).first();
  if (!user?.email_verified) return { granted: false, reason: "email_not_verified" };
  if (user.referred_by_user_id) return { granted: false, reason: "referred_signup" };
  const code = normalizeCompCode(user.referred_by_input);
  if (!code) return { granted: false, reason: "no_code" };
  return redeemCompCodeForUser({ userId, code, via: "signup" });
}

export async function ensureDefaultCompCodes(trx = db) {
  for (const def of DEFAULT_COMP_CODES) {
    try {
      const existing = await trx("referral_codes").where({ code: def.code }).first();
      if (existing) continue;
      await trx("referral_codes").insert({
        id: crypto.randomUUID(),
        user_id: null,
        email: null,
        code: def.code,
        cashapp_handle: null,
        status: "active",
        metadata: { kind: COMP_CODE_KIND, note: def.note, max_redemptions: def.maxRedemptions ?? null, created_by: "seed" },
        updated_at: trx.fn.now(),
      });
      log("info", "comp_code_seeded", { code: def.code });
    } catch (err) {
      log("warn", "comp_code_seed_failed", { code: def.code, message: String(err?.message || err) });
    }
  }
}

export async function listCompCodes(trx = db) {
  const rows = await trx("referral_codes").whereRaw("metadata->>'kind' = ?", [COMP_CODE_KIND]).orderBy("created_at", "desc");
  const items = [];
  for (const row of rows) {
    const redeemed = await countCompRedemptions(row.code, trx);
    const availability = compCodeAvailability(row, redeemed);
    items.push({
      id: row.id,
      code: row.code,
      status: row.status,
      note: row.metadata?.note || null,
      maxRedemptions: row.metadata?.max_redemptions ?? null,
      redeemed,
      remaining: availability.remaining,
      available: availability.available,
      reason: availability.reason,
      createdBy: row.metadata?.created_by || null,
      createdAt: row.created_at,
      link: compCodeSignupLink(row.code),
    });
  }
  return items;
}

export async function upsertCompCode({ code, note, maxRedemptions, status, createdBy } = {}, trx = db) {
  const normalized = normalizeCompCode(code);
  if (!normalized || normalized.length < 3) throw Object.assign(new Error("invalid_comp_code"), { statusCode: 400 });
  const existing = await trx("referral_codes").where({ code: normalized }).first();
  if (existing && !isCompCodeRow(existing)) throw Object.assign(new Error("code_belongs_to_referrer"), { statusCode: 409 });
  const limit = Number(maxRedemptions);
  const metadata = {
    ...(existing?.metadata || {}),
    kind: COMP_CODE_KIND,
    note: note === undefined ? (existing?.metadata?.note || null) : (String(note || "").trim() || null),
    max_redemptions: maxRedemptions === undefined
      ? (existing?.metadata?.max_redemptions ?? null)
      : (Number.isInteger(limit) && limit > 0 ? limit : null),
    created_by: existing?.metadata?.created_by || createdBy || null,
  };
  const payload = { status: status || existing?.status || "active", metadata, updated_at: trx.fn.now() };
  if (existing) {
    const [row] = await trx("referral_codes").where({ id: existing.id }).update(payload).returning("*");
    return row;
  }
  const [row] = await trx("referral_codes")
    .insert({ id: crypto.randomUUID(), user_id: null, email: null, code: normalized, cashapp_handle: null, ...payload })
    .returning("*");
  return row;
}
