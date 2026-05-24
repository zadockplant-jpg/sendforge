import crypto from "crypto";
import { db } from "../../config/db.js";

const DEFAULT_TIERS = [
  { requiredPurchases: 5, rewardAmountCents: 1000 },
  { requiredPurchases: 15, rewardAmountCents: 4000 },
  { requiredPurchases: 50, rewardAmountCents: 20000 },
];

export function normalizeReferralValue(value) {
  return String(value || "").trim();
}

export function normalizeEmail(value) {
  return normalizeReferralValue(value).toLowerCase();
}

export function normalizeCashAppTag(value) {
  const raw = normalizeReferralValue(value);
  if (!raw) return null;
  const cleaned = raw.replace(/^\$+/, "").replace(/[^a-zA-Z0-9_.$-]/g, "").slice(0, 80);
  if (!cleaned) return null;
  return cleaned.startsWith("$") ? cleaned : `$${cleaned}`;
}

export function normalizeProductSlug(value) {
  return String(value || "").trim().toLowerCase();
}

export function makeReferralCode(email = "") {
  const base = String(email || "")
    .split("@")[0]
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8)
    .toUpperCase() || "FORGE";
  return `${base}${crypto.randomInt(1000, 9999)}`;
}

async function createUniqueReferralCode(knex, email) {
  for (let i = 0; i < 8; i += 1) {
    const code = makeReferralCode(email);
    const existing = await knex("referral_codes").where({ code }).first();
    if (!existing) return code;
  }
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}

export async function ensureReferralCodeForUser(user, trx = db) {
  if (!user?.id || !user?.email) return null;

  const existing = await trx("referral_codes")
    .where({ user_id: user.id, status: "active" })
    .orderBy("created_at", "asc")
    .first();

  if (existing) return existing;

  const code = await createUniqueReferralCode(trx, user.email);
  const [row] = await trx("referral_codes")
    .insert({
      id: crypto.randomUUID(),
      user_id: user.id,
      email: normalizeEmail(user.email),
      code,
      cashapp_handle: normalizeCashAppTag(user.cash_app_tag),
      status: "active",
      metadata: { source: "auto_user_signup" },
      updated_at: trx.fn.now(),
    })
    .returning("*");

  return row;
}

export async function resolveReferralIdentifier(identifier, trx = db) {
  const raw = normalizeReferralValue(identifier);
  if (!raw) return null;

  if (raw.includes("@")) {
    const email = normalizeEmail(raw);
    const user = await trx("users").where({ email }).first();
    if (!user) return null;
    const code = await ensureReferralCodeForUser(user, trx);
    return { referrerUser: user, referralCode: code, inputType: "email" };
  }

  const codeValue = raw.replace(/^#/, "").toUpperCase();
  const code = await trx("referral_codes")
    .where({ code: codeValue, status: "active" })
    .first();

  if (!code) return null;

  const user = code.user_id
    ? await trx("users").where({ id: code.user_id }).first()
    : null;

  return { referrerUser: user, referralCode: code, inputType: "code" };
}

export async function applySignupReferral({ trx = db, newUserId, newUserEmail, referralIdentifier, cashAppTag }) {
  const updates = {};
  const normalizedCashApp = normalizeCashAppTag(cashAppTag);
  if (normalizedCashApp) updates.cash_app_tag = normalizedCashApp;

  const newEmail = normalizeEmail(newUserEmail);
  const resolved = await resolveReferralIdentifier(referralIdentifier, trx);

  if (resolved?.referrerUser?.id && resolved.referrerUser.id !== newUserId && normalizeEmail(resolved.referrerUser.email) !== newEmail) {
    updates.referred_by_user_id = resolved.referrerUser.id;
    updates.referral_code_id = resolved.referralCode?.id || null;
    updates.referred_by_input = normalizeReferralValue(referralIdentifier);
  }

  if (Object.keys(updates).length) {
    await trx("users").where({ id: newUserId }).update(updates);
  }

  const user = await trx("users").where({ id: newUserId }).first();
  await ensureReferralCodeForUser(user, trx);

  return { user, referralApplied: Boolean(updates.referred_by_user_id), cashAppTag: normalizedCashApp };
}

export async function updateUserCashAppTag({ userId, cashAppTag }) {
  const normalized = normalizeCashAppTag(cashAppTag);
  const [user] = await db("users")
    .where({ id: userId })
    .update({ cash_app_tag: normalized, updated_at: db.fn.now() })
    .returning("*");

  if (user) {
    await db("referral_codes")
      .where({ user_id: user.id })
      .update({ cashapp_handle: normalized, updated_at: db.fn.now() });
  }

  return user;
}

function normalizeTier(raw) {
  const requiredPurchases = Number(raw?.requiredPurchases ?? raw?.required_purchases ?? raw?.count ?? 0);
  const rewardAmountCents = Number(raw?.rewardAmountCents ?? raw?.reward_amount_cents ?? raw?.amountCents ?? 0);
  if (!Number.isInteger(requiredPurchases) || requiredPurchases <= 0) return null;
  if (!Number.isInteger(rewardAmountCents) || rewardAmountCents < 0) return null;
  return { requiredPurchases, rewardAmountCents };
}

export function tiersFromProgram(program) {
  const meta = program?.metadata && typeof program.metadata === "object" ? program.metadata : {};
  const rawTiers = Array.isArray(meta.tiers) ? meta.tiers : [];
  const tiers = rawTiers.map(normalizeTier).filter(Boolean);

  if (!tiers.length && program?.required_purchases) {
    tiers.push({
      requiredPurchases: Number(program.required_purchases),
      rewardAmountCents: Number(program.reward_amount_cents || 0),
    });
  }

  return (tiers.length ? tiers : DEFAULT_TIERS)
    .sort((a, b) => a.requiredPurchases - b.requiredPurchases);
}

export async function getReferralProgram(productSlug, trx = db) {
  const slug = normalizeProductSlug(productSlug);
  let program = await trx("referral_programs")
    .where({ product_slug: slug, status: "active" })
    .first();

  if (!program) {
    const [created] = await trx("referral_programs")
      .insert({
        id: crypto.randomUUID(),
        product_slug: slug,
        required_purchases: 5,
        reward_amount_cents: 1000,
        reward_type: "cashapp_manual",
        refund_hold_days: 0,
        status: "active",
        metadata: {
          tiers: DEFAULT_TIERS,
          description: "Default manual Cash App referral tiers",
        },
        updated_at: trx.fn.now(),
      })
      .onConflict("product_slug")
      .merge({ status: "active", updated_at: trx.fn.now() })
      .returning("*");
    program = created;
  }

  return program;
}

export async function recordReferralPurchase({ referredUserId, productSlug, purchaseRef, metadata = {} }) {
  const slug = normalizeProductSlug(productSlug);
  const ref = normalizeReferralValue(purchaseRef);
  if (!referredUserId || !slug || !ref) return { recorded: false, reason: "missing_input" };

  return db.transaction(async (trx) => {
    const referredUser = await trx("users").where({ id: referredUserId }).first();
    if (!referredUser?.referred_by_user_id) return { recorded: false, reason: "no_referrer" };
    if (referredUser.referred_by_user_id === referredUser.id) return { recorded: false, reason: "self_referral" };

    const referrer = await trx("users").where({ id: referredUser.referred_by_user_id }).first();
    if (!referrer) return { recorded: false, reason: "referrer_missing" };

    const referralCode = referredUser.referral_code_id
      ? await trx("referral_codes").where({ id: referredUser.referral_code_id }).first()
      : await ensureReferralCodeForUser(referrer, trx);

    const existing = await trx("referral_events")
      .where({ referred_user_id: referredUser.id, product_slug: slug, purchase_ref: ref })
      .first();

    if (existing) return { recorded: false, reason: "duplicate_purchase", event: existing };

    const [event] = await trx("referral_events")
      .insert({
        id: crypto.randomUUID(),
        referral_code_id: referralCode?.id || null,
        referrer_user_id: referrer.id,
        referred_user_id: referredUser.id,
        product_slug: slug,
        purchase_ref: ref,
        event_type: "purchase",
        status: "verified",
        metadata,
        updated_at: trx.fn.now(),
      })
      .returning("*");

    const program = await getReferralProgram(slug, trx);
    const tiers = tiersFromProgram(program);
    const verifiedCountResult = await trx("referral_events")
      .where({ referrer_user_id: referrer.id, product_slug: slug, event_type: "purchase", status: "verified" })
      .count({ count: "id" })
      .first();
    const verifiedCount = Number(verifiedCountResult?.count || 0);
    const rewards = [];

    for (const tier of tiers) {
      if (verifiedCount < tier.requiredPurchases) continue;

      const existingReward = await trx("reward_queue")
        .where({ user_id: referrer.id, product_slug: slug })
        .whereRaw("metadata->>'tier_required_purchases' = ?", [String(tier.requiredPurchases)])
        .first();
      if (existingReward) continue;

      const [reward] = await trx("reward_queue")
        .insert({
          id: crypto.randomUUID(),
          referral_code_id: referralCode?.id || null,
          user_id: referrer.id,
          email: normalizeEmail(referrer.email),
          product_slug: slug,
          reward_amount_cents: tier.rewardAmountCents,
          reward_type: program.reward_type || "cashapp_manual",
          cashapp_handle: normalizeCashAppTag(referrer.cash_app_tag || referralCode?.cashapp_handle),
          status: "pending",
          metadata: {
            tier_required_purchases: tier.requiredPurchases,
            verified_purchase_count: verifiedCount,
            purchase_ref: ref,
          },
          updated_at: trx.fn.now(),
        })
        .returning("*");
      rewards.push(reward);
    }

    return { recorded: true, event, rewards, verifiedCount };
  });
}
