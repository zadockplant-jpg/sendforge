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
import {
  PER_SALE_RATE_PRODUCTS,
  ensureAffiliateReferralCode,
  ensureReferralCodeForUser,
  setReferralTerms,
} from "./referrals/referral.service.js";
import { PERK_ENTITLEMENT_SLUGS } from "./adminReferralControls.service.js";
import { setPerkSeats } from "./productSeats.service.js";

export const COMP_CODE_KIND = "comp";
export const COMP_CODE_SOURCE = "comp_code";
export const COMP_GRANT_SLUGS = PERK_ENTITLEMENT_SLUGS;
export const COMP_GRANT_LABELS = Object.freeze(["TabForge Pro", "Private Sync"]);

// Everything the owner can give away from the admin dashboard, by the
// entitlement slug purchase fulfilment would grant.
export const GRANTABLE_PRODUCTS = Object.freeze({
  tabforge: "TabForge Pro",
  "tabforge-subscription": "TabForge Private Sync",
  "rose-colored-glasses": "Rose Colored Glasses",
  forgedrop: "ForgeDrop",
});

/**
 * What a code grants. A personal invite made from the admin dashboard lists
 * its own products; every older comp code grants Pro and Private Sync.
 */
export function compCodeGrants(row) {
  const listed = row?.metadata?.grants;
  if (!Array.isArray(listed)) return [...COMP_GRANT_SLUGS];
  return [...new Set(listed.map((slug) => String(slug || "").trim().toLowerCase()))].filter(
    (slug) => GRANTABLE_PRODUCTS[slug]
  );
}

export function isPersonalInvite(row) {
  return Array.isArray(row?.metadata?.grants);
}

// Nothing is seeded any more. There used to be one shared launch code with no
// redemption limit, which is fine on a landing page and wrong in an email: a
// single uncapped code sent to a list is a code that ends up on coupon sites
// handing out free licences. Codes are now issued one per person, by the
// outreach tool, and each is spent by the first account that redeems it.
export const DEFAULT_COMP_CODES = Object.freeze([]);

// A comp code belongs to the one account that redeems it. Anything created
// without an explicit limit gets this one.
export const DEFAULT_COMP_MAX_REDEMPTIONS = 1;

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
  // An absent or unusable limit means one redemption, not unlimited. A code
  // that escapes into the wild should stop working after the first account
  // claims it, and defaulting the other way makes a leak expensive.
  const max = Number(row.metadata?.max_redemptions);
  const limit = Number.isInteger(max) && max > 0 ? max : DEFAULT_COMP_MAX_REDEMPTIONS;
  const remaining = Math.max(0, limit - Number(redeemedCount || 0));
  if (remaining === 0) return { available: false, reason: "code_exhausted", remaining };
  return { available: true, reason: null, remaining };
}

// The affiliate terms a comp code hands to the account that redeems it.
export function compCodeCommission(row) {
  const plan = row?.metadata?.commission;
  if (!plan || typeof plan !== "object" || plan.mode !== "per_sale") return null;
  const cents = Number(plan.rewardAmountCents);
  return Number.isInteger(cents) && cents > 0 ? { mode: "per_sale", rewardAmountCents: cents } : null;
}

// The per-sale rates a comp code hands out on products other than TabForge,
// such as ForgeDrop's affiliate level, keyed by product.
export function compCodePerSaleRates(row) {
  const rates = row?.metadata?.flat_rates;
  if (!rates || typeof rates !== "object") return {};
  const out = {};
  for (const slug of PER_SALE_RATE_PRODUCTS) {
    const cents = Number(rates[slug]);
    if (rates[slug] !== null && rates[slug] !== undefined && Number.isInteger(cents) && cents >= 0) out[slug] = cents;
  }
  return out;
}

export function compCodePublicView(row, availability) {
  return {
    code: row.code,
    valid: Boolean(availability?.available),
    reason: availability?.reason || null,
    grants: isPersonalInvite(row)
      ? compCodeGrants(row).map((slug) => GRANTABLE_PRODUCTS[slug])
      : [...COMP_GRANT_LABELS],
    note: row.metadata?.note || null,
    commission: compCodeCommission(row),
    perSaleRates: compCodePerSaleRates(row),
  };
}

// Copy the code's terms onto the account's own referral code, which is
// where the reward engine reads a per-referrer plan from: the per-sale
// TabForge rate, and the per-sale rate on each other product it names.
export async function applyCompCodeCommission({ trx = db, userId, compRow }) {
  const plan = compCodeCommission(compRow);
  const rates = compCodePerSaleRates(compRow);
  if ((!plan && !Object.keys(rates).length) || !userId) return null;
  const code = await trx("referral_codes").where({ user_id: userId, status: "active" }).orderBy("created_at", "asc").first();
  if (!code) return null;
  const metadata = { ...(code.metadata || {}) };
  if (plan) metadata.commission = { ...plan, source: "comp_code", code: compRow.code, applied_at: new Date().toISOString() };
  if (Object.keys(rates).length) metadata.flat_rates = { ...(metadata.flat_rates || {}), ...rates };
  await trx("referral_codes").where({ id: code.id }).update({ metadata, updated_at: trx.fn.now() });
  return plan
    ? { ...plan, perSaleRates: rates, referralCode: code.code }
    : { mode: "per_sale_products", perSaleRates: rates, referralCode: code.code };
}

export function compCodeSignupLink(code, email = null) {
  const params = new URLSearchParams({ ref: normalizeCompCode(code) });
  if (email) params.set("email", String(email).trim().toLowerCase());
  return `/signup.html?${params.toString()}`;
}

export async function findCompCode(code, trx = db) {
  const normalized = normalizeCompCode(code);
  if (!normalized) return null;
  const row = await trx("referral_codes").where({ code: normalized }).first();
  return isCompCodeRow(row) ? row : null;
}

export async function countCompRedemptions(code, trx = db) {
  const normalized = normalizeCompCode(code);
  const row = await trx("referral_codes").where({ code: normalized }).first();
  // A personal invite is spent once it is redeemed, even one that grants no
  // product (an affiliate-only invite), so it is counted by its own mark.
  if (isPersonalInvite(row)) return row.metadata?.redeemed_by ? 1 : 0;
  const counted = await trx("product_entitlements")
    .where({ source: COMP_CODE_SOURCE, product_slug: "tabforge" })
    .whereRaw("metadata->>'comp_code' = ?", [normalized])
    .count({ count: "id" })
    .first();
  return Number(counted?.count || 0);
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

/**
 * A personal invite: the products, devices and referral terms the owner chose
 * for one email address, applied when that address's account is verified.
 */
async function redeemPersonalInvite({ user, row, availability, via, trx }) {
  const invitedEmail = String(row.metadata?.email || "").trim().toLowerCase();
  if (invitedEmail && invitedEmail !== String(user.email || "").trim().toLowerCase()) {
    return { granted: false, reason: "code_for_another_email" };
  }
  if (row.metadata?.redeemed_by === user.id) return { granted: false, reason: "already_redeemed" };
  if (!availability.available) return { granted: false, reason: availability.reason };

  const grants = compCodeGrants(row);
  const metadata = { comp: true, perk: true, comp_code: row.code, redeemed_at: new Date().toISOString(), via, note: row.metadata?.note || null, granted_by: row.metadata?.created_by || null };
  const products = [];
  for (const slug of grants) {
    const owned = await trx("product_entitlements")
      .where({ user_id: user.id, product_slug: slug, status: "active" })
      .first();
    if (!owned) await grantProductEntitlement({ userId: user.id, productSlug: slug, source: COMP_CODE_SOURCE, sourceRef: row.code, metadata });
    products.push(slug);
  }

  const devices = Number(row.metadata?.rcg_devices || 0);
  if (grants.includes("rose-colored-glasses") && devices > 0) {
    await setPerkSeats({ userId: user.id, productSlug: "rose-colored-glasses", seats: devices, grantedBy: row.metadata?.created_by || null, source: COMP_CODE_SOURCE, note: `invite ${row.code}` }, trx);
  }

  const terms = row.metadata?.referral_terms || {};
  const hasTerms = terms.tabforgePerSaleCents != null || (terms.flatRates && Object.keys(terms.flatRates).length);
  let code = hasTerms || row.metadata?.affiliate
    ? await ensureAffiliateReferralCode(user, { source: "invite" }, trx)
    : await ensureReferralCodeForUser(user, trx);
  if (code && hasTerms) code = await setReferralTerms(code, terms, trx);

  await trx("referral_codes")
    .where({ id: row.id })
    .update({ metadata: { ...(row.metadata || {}), redeemed_by: user.id, redeemed_at: new Date().toISOString() }, updated_at: trx.fn.now() });

  log("info", "personal_invite_redeemed", { userId: user.id, code: row.code, via, products });
  return { granted: true, code: row.code, products, referralCode: code?.code || null };
}

export async function redeemCompCodeForUser({ userId, code, via = "account", trx = db }) {
  const { row, availability } = await compCodeStatus(code, trx);
  if (!row) return { granted: false, reason: "unknown_code" };
  const user = await trx("users").where({ id: userId }).first();
  if (!user) return { granted: false, reason: "user_not_found" };
  if (isPersonalInvite(row)) return redeemPersonalInvite({ user, row, availability, via, trx });
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
  const plan = await applyCompCodeCommission({ trx, userId, compRow: row });
  log("info", "comp_code_redeemed", { userId, code: row.code, via, plan: plan?.mode || null });
  return { granted: true, code: row.code, products, plan };
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
      if (existing) {
        // A code seeded before it carried terms picks them up here.
        if (def.commission && !existing.metadata?.commission) {
          await trx("referral_codes").where({ id: existing.id }).update({ metadata: { ...(existing.metadata || {}), commission: def.commission }, updated_at: trx.fn.now() });
          log("info", "comp_code_terms_backfilled", { code: def.code });
        }
        continue;
      }
      await trx("referral_codes").insert({
        id: crypto.randomUUID(),
        user_id: null,
        email: null,
        code: def.code,
        cashapp_handle: null,
        status: "active",
        metadata: { kind: COMP_CODE_KIND, note: def.note, max_redemptions: def.maxRedemptions ?? null, commission: def.commission || null, created_by: "seed" },
        updated_at: trx.fn.now(),
      });
      log("info", "comp_code_seeded", { code: def.code });
    } catch (err) {
      log("warn", "comp_code_seed_failed", { code: def.code, message: String(err?.message || err) });
    }
  }
  await retireLegacyCompCodes(trx);
}

// Codes that used to be seeded and are no longer offered. Deactivated on boot
// rather than deleted, so the accounts that already redeemed one keep their
// entitlements and the record of where they came from survives.
export const RETIRED_COMP_CODES = Object.freeze(["SENDIT2026"]);

export async function retireLegacyCompCodes(trx = db) {
  for (const code of RETIRED_COMP_CODES) {
    try {
      const row = await findCompCode(code, trx);
      if (!row || String(row.status || "") !== "active") continue;
      await trx("referral_codes")
        .where({ id: row.id })
        .update({
          status: "inactive",
          metadata: {
            ...(row.metadata || {}),
            retired_at: new Date().toISOString(),
            retired_reason: "shared_launch_code_withdrawn",
          },
          updated_at: trx.fn.now(),
        });
      log("info", "comp_code_retired", { code: row.code });
    } catch (err) {
      log("warn", "comp_code_retire_failed", { code, message: String(err?.message || err) });
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
      link: compCodeSignupLink(row.code, row.metadata?.email || null),
      perSaleRewardCents: compCodeCommission(row)?.rewardAmountCents ?? null,
      forgedropPerSaleRewardCents: compCodePerSaleRates(row).forgedrop ?? null,
      email: row.metadata?.email || null,
      grants: isPersonalInvite(row) ? compCodeGrants(row) : [...COMP_GRANT_SLUGS],
      invite: isPersonalInvite(row),
    });
  }
  return items;
}

/**
 * A personal invite for one email address that has no account yet. The link
 * signs them up with the address filled in; verifying it applies everything
 * here. Spent by that one account.
 */
export async function createPersonalInvite(
  { email, grants = [], rcgDevices = 0, tabforgePerSaleCents = null, flatRates = {}, affiliate = false, note = null, createdBy = null } = {},
  trx = db
) {
  const address = String(email || "").trim().toLowerCase();
  if (!address.includes("@")) throw Object.assign(new Error("invalid_email"), { statusCode: 400 });
  const products = [...new Set((grants || []).map((slug) => String(slug || "").trim().toLowerCase()))].filter(
    (slug) => GRANTABLE_PRODUCTS[slug]
  );

  let code = "";
  for (let i = 0; i < 8 && !code; i += 1) {
    const candidate = `INVITE-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    if (!(await trx("referral_codes").where({ code: candidate }).first())) code = candidate;
  }
  if (!code) throw Object.assign(new Error("code_generation_failed"), { statusCode: 500 });

  const terms = {};
  if (Number.isInteger(Number(tabforgePerSaleCents)) && Number(tabforgePerSaleCents) > 0) {
    terms.tabforgePerSaleCents = Number(tabforgePerSaleCents);
  }
  const rates = {};
  for (const [slug, value] of Object.entries(flatRates || {})) {
    const cents = Number(value);
    if (value !== null && value !== "" && Number.isInteger(cents) && cents >= 0) rates[slug] = cents;
  }
  if (Object.keys(rates).length) terms.flatRates = rates;

  const [row] = await trx("referral_codes")
    .insert({
      id: crypto.randomUUID(),
      user_id: null,
      email: null,
      code,
      cashapp_handle: null,
      status: "active",
      metadata: {
        kind: COMP_CODE_KIND,
        email: address,
        grants: products,
        rcg_devices: products.includes("rose-colored-glasses") ? Math.max(1, Math.min(1000, Number(rcgDevices) || 1)) : 0,
        referral_terms: terms,
        affiliate: Boolean(affiliate),
        max_redemptions: 1,
        note: String(note || "").trim() || null,
        created_by: createdBy,
      },
      updated_at: trx.fn.now(),
    })
    .returning("*");
  return { row, link: compCodeSignupLink(row.code, address) };
}

export async function listInvitesForEmail(email, trx = db) {
  const address = String(email || "").trim().toLowerCase();
  const rows = await trx("referral_codes")
    .whereRaw("metadata->>'kind' = ?", [COMP_CODE_KIND])
    .whereRaw("lower(metadata->>'email') = ?", [address])
    .orderBy("created_at", "desc");
  return rows.map((row) => ({
    code: row.code,
    status: row.status,
    redeemed: Boolean(row.metadata?.redeemed_by),
    grants: compCodeGrants(row),
    rcgDevices: row.metadata?.rcg_devices || 0,
    referralTerms: row.metadata?.referral_terms || {},
    affiliate: Boolean(row.metadata?.affiliate),
    note: row.metadata?.note || null,
    createdAt: row.created_at,
    link: compCodeSignupLink(row.code, address),
  }));
}

export async function upsertCompCode({ code, note, maxRedemptions, status, createdBy, perSaleRewardCents, forgedropPerSaleRewardCents } = {}, trx = db) {
  const normalized = normalizeCompCode(code);
  if (!normalized || normalized.length < 3) throw Object.assign(new Error("invalid_comp_code"), { statusCode: 400 });
  const existing = await trx("referral_codes").where({ code: normalized }).first();
  if (existing && !isCompCodeRow(existing)) throw Object.assign(new Error("code_belongs_to_referrer"), { statusCode: 409 });
  const limit = Number(maxRedemptions);
  const metadata = {
    ...(existing?.metadata || {}),
    kind: COMP_CODE_KIND,
    note: note === undefined ? (existing?.metadata?.note || null) : (String(note || "").trim() || null),
    // One account per code unless an admin deliberately raises it. Creating a
    // code without saying how many times it may be used must not produce an
    // uncapped one.
    max_redemptions: maxRedemptions === undefined
      ? (existing?.metadata?.max_redemptions ?? DEFAULT_COMP_MAX_REDEMPTIONS)
      : (Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_COMP_MAX_REDEMPTIONS),
    created_by: existing?.metadata?.created_by || createdBy || null,
  };
  if (perSaleRewardCents !== undefined) {
    const cents = Number(perSaleRewardCents);
    metadata.commission = Number.isInteger(cents) && cents > 0 ? { mode: "per_sale", rewardAmountCents: cents } : null;
  }
  // ForgeDrop's affiliate level on this code: a flat amount per ForgeDrop
  // sale, applied to the account that redeems it. Null takes it off.
  if (forgedropPerSaleRewardCents !== undefined) {
    const cents = Number(forgedropPerSaleRewardCents);
    const rates = { ...(metadata.flat_rates || {}) };
    if (forgedropPerSaleRewardCents !== null && Number.isInteger(cents) && cents > 0) rates.forgedrop = cents;
    else delete rates.forgedrop;
    if (Object.keys(rates).length) metadata.flat_rates = rates;
    else delete metadata.flat_rates;
  }
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
