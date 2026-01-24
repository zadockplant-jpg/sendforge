import { db } from "../config/db.js";

function ym(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
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
  // Pick most recent active/trialing
  const sub = await db("subscriptions")
    .where({ user_id: userId })
    .whereIn("status", ["active", "trialing"])
    .orderBy("updated_at", "desc")
    .first();

  const plan = sub?.plan || "free";
  return { plan, limits: getLimitsForPlan(plan), subscription: sub || null };
}

export async function getUsage(userId, channel, period = ym()) {
  const row = await db("usage_counters").where({ user_id: userId, channel, period }).first();
  return row?.count || 0;
}

export async function incrementUsage(userId, channel, by = 1, period = ym()) {
  // Upsert
  await db("usage_counters")
    .insert({
      id: crypto.randomUUID?.() || undefined,
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
