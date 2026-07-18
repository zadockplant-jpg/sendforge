import crypto from "crypto";
import { db } from "../config/db.js";
import { TABFORGE_SYNC_ENTITLEMENT_ALIASES } from "./tabforgeBilling.service.js";

export const TABFORGE_CLOUD_ENTITLEMENTS =
  TABFORGE_SYNC_ENTITLEMENT_ALIASES;

const ACCOUNT_PRODUCT_ALIASES = Object.freeze({
  tabforge: "tabforge",
  "tabforge-pro": "tabforge",
  "tabforge-subscription": "tabforge-subscription",
  "tabforge-collections": "tabforge-subscription",
  "tabforge-collections-subscription": "tabforge-subscription",
  "tabforge-sync-collections": "tabforge-subscription",
});

function ym(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function normalizeProductSlug(slug) {
  return String(slug || "")
    .trim()
    .toLowerCase();
}

function getLimitsForPlan(plan) {
  const p = String(plan || "free");
  const env = process.env;

  const pick = (k, d) => {
    const v = env[k];
    if (v === undefined || v === "") return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };

  if (p === "pro") {
    return {
      sms: pick("LIMIT_PRO_SMS", 12000),
      email: pick("LIMIT_PRO_EMAIL", 25000),
    };
  }

  if (p === "starter") {
    return {
      sms: pick("LIMIT_STARTER_SMS", 3000),
      email: pick("LIMIT_STARTER_EMAIL", 5000),
    };
  }

  return {
    sms: pick("LIMIT_FREE_SMS", 0),
    email: pick("LIMIT_FREE_EMAIL", 50),
  };
}

export async function getActivePlan(userId) {
  const sub = await db("subscriptions")
    .where({ user_id: userId })
    .whereIn("status", ["active", "trialing"])
    .orderBy("updated_at", "desc")
    .first();

  const plan = sub?.plan || "free";
  return {
    plan,
    limits: getLimitsForPlan(plan),
    subscription: sub || null,
  };
}

export async function listProductEntitlements(userId, opts = {}) {
  const activeOnly = opts.activeOnly !== false;

  const query = db("product_entitlements")
    .where({ user_id: userId })
    .orderBy("created_at", "desc");

  if (activeOnly) {
    query.andWhere({ status: "active" });
    query.andWhere((qb) => {
      qb.whereNull("expires_at").orWhere("expires_at", ">", db.fn.now());
    });
  }

  return query;
}

export function currentAccountProductEntitlements(rows) {
  const current = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const sourceSlug = normalizeProductSlug(row?.product_slug);
    const productSlug = ACCOUNT_PRODUCT_ALIASES[sourceSlug];
    if (!productSlug || current.has(productSlug)) continue;
    current.set(productSlug, { ...row, product_slug: productSlug });
  }
  return [...current.values()];
}

export async function hasProductEntitlement(userId, productSlug) {
  const slug = normalizeProductSlug(productSlug);
  if (!slug) return false;

  const row = await db("product_entitlements")
    .where({
      user_id: userId,
      product_slug: slug,
      status: "active",
    })
    .andWhere((qb) => {
      qb.whereNull("expires_at").orWhere("expires_at", ">", db.fn.now());
    })
    .first();

  return Boolean(row);
}

export async function hasAnyProductEntitlement(userId, productSlugs) {
  const slugs = [...new Set((productSlugs || []).map(normalizeProductSlug).filter(Boolean))];
  if (!userId || !slugs.length) return false;

  const row = await db("product_entitlements")
    .where({
      user_id: userId,
      status: "active",
    })
    .whereIn("product_slug", slugs)
    .andWhere((qb) => {
      qb.whereNull("expires_at").orWhere("expires_at", ">", db.fn.now());
    })
    .first();

  return Boolean(row);
}

export async function grantProductEntitlement({
  userId,
  productSlug,
  source = "manual",
  sourceRef = null,
  status = "active",
  expiresAt = null,
  metadata = {},
}) {
  const slug = normalizeProductSlug(productSlug);
  if (!userId || !slug) {
    throw new Error("grantProductEntitlement requires userId and productSlug");
  }

  const payload = {
    id: crypto.randomUUID(),
    user_id: userId,
    product_slug: slug,
    source: String(source || "manual"),
    source_ref: sourceRef ? String(sourceRef) : null,
    status: String(status || "active"),
    granted_at: db.fn.now(),
    expires_at: expiresAt || null,
    metadata: metadata || {},
    updated_at: db.fn.now(),
  };

  const merged = {
    source: payload.source,
    source_ref: payload.source_ref,
    status: payload.status,
    granted_at: db.fn.now(),
    expires_at: payload.expires_at,
    metadata: payload.metadata,
    updated_at: db.fn.now(),
  };

  const rows = await db("product_entitlements")
    .insert(payload)
    .onConflict(["user_id", "product_slug"])
    .merge(merged)
    .returning("*");

  return rows[0] || null;
}

export async function revokeProductEntitlement(userId, productSlug, metadata = {}) {
  const slug = normalizeProductSlug(productSlug);
  if (!userId || !slug) {
    throw new Error("revokeProductEntitlement requires userId and productSlug");
  }

  const rows = await db("product_entitlements")
    .where({
      user_id: userId,
      product_slug: slug,
    })
    .update({
      status: "revoked",
      metadata: metadata || {},
      updated_at: db.fn.now(),
    })
    .returning("*");

  return rows[0] || null;
}

export async function getUsage(userId, channel, period = ym()) {
  const row = await db("usage_counters")
    .where({ user_id: userId, channel, period })
    .first();

  return row?.count || 0;
}

export async function incrementUsage(userId, channel, by = 1, period = ym()) {
  await db("usage_counters")
    .insert({
      id: crypto.randomUUID(),
      user_id: userId,
      channel,
      period,
      count: by,
      updated_at: db.fn.now(),
    })
    .onConflict(["user_id", "period", "channel"])
    .merge({
      count: db.raw("usage_counters.count + ?", [by]),
      updated_at: db.fn.now(),
    });
}
