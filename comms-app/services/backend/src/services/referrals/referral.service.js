import crypto from "crypto";
import { db } from "../../config/db.js";

const DEFAULT_PURCHASE_TIERS = [
  { requiredPurchases: 5, rewardAmountCents: 1000 },
  { requiredPurchases: 15, rewardAmountCents: 2000 },
  { requiredPurchases: 50, rewardAmountCents: 7500 },
];

const TABFORGE_PURCHASE_TIERS = [
  { requiredPurchases: 5, rewardAmountCents: 1000 },
  { requiredPurchases: 15, rewardAmountCents: 2000 },
  { requiredPurchases: 50, rewardAmountCents: 7500 },
];

const INVITE_TTL_DAYS = 30;

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

export function cashAppTagKey(value) {
  const normalized = normalizeCashAppTag(value);
  return normalized ? normalized.replace(/^\$+/, "").toLowerCase() : null;
}

function referralServiceError(code, statusCode = 409) {
  const err = new Error(code);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

export function normalizeProductSlug(value) {
  return String(value || "").trim().toLowerCase();
}

function hashInviteToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function invitePurchaseRef(token) {
  return `invite:${hashInviteToken(token)}`;
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

export async function createReferralInvite({
  referrerUser,
  referralCode,
  recipientEmail,
  productSlug = "tabforge",
  trx = db,
}) {
  const recipient = normalizeEmail(recipientEmail);
  const slug = normalizeProductSlug(productSlug) || "tabforge";
  if (!referrerUser?.id || !recipient || !referralCode?.id) {
    throw new Error("invalid_referral_invite_input");
  }
  if (normalizeEmail(referrerUser.email) === recipient) {
    const err = new Error("self_referral_not_allowed");
    err.code = "SELF_REFERRAL";
    throw err;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const [event] = await trx("referral_events")
    .insert({
      id: crypto.randomUUID(),
      referral_code_id: referralCode.id,
      referrer_user_id: referrerUser.id,
      referred_user_id: null,
      product_slug: slug,
      purchase_ref: invitePurchaseRef(token),
      event_type: "invite",
      status: "sent",
      metadata: {
        recipient_email: recipient,
        expires_at: expiresAt.toISOString(),
      },
      updated_at: trx.fn.now(),
    })
    .returning("*");

  return { token, event, recipientEmail: recipient, expiresAt };
}

export async function resolveReferralInviteToken(token, trx = db) {
  const raw = normalizeReferralValue(token);
  if (!raw) return null;

  const event = await trx("referral_events")
    .where({
      purchase_ref: invitePurchaseRef(raw),
      event_type: "invite",
    })
    .first();

  if (!event || ["cancelled", "expired"].includes(event.status)) return null;

  const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const expiresAt = metadata.expires_at ? new Date(metadata.expires_at) : null;
  if (expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
    await trx("referral_events")
      .where({ id: event.id })
      .update({ status: "expired", updated_at: trx.fn.now() });
    return null;
  }

  const referralCode = event.referral_code_id
    ? await trx("referral_codes").where({ id: event.referral_code_id, status: "active" }).first()
    : null;
  const referrerUser = event.referrer_user_id
    ? await trx("users").where({ id: event.referrer_user_id }).first()
    : null;

  if (!referralCode || !referrerUser) return null;

  return {
    event,
    referralCode,
    referrerUser,
    recipientEmail: normalizeEmail(metadata.recipient_email),
    productSlug: normalizeProductSlug(event.product_slug) || "tabforge",
  };
}

export async function claimReferralInviteToken({ token, recipientEmail, referredUserId, trx = db }) {
  const resolved = await resolveReferralInviteToken(token, trx);
  if (!resolved) {
    const err = new Error("invalid_or_expired_invite");
    err.code = "INVALID_INVITE";
    throw err;
  }

  const normalizedRecipient = normalizeEmail(recipientEmail);
  if (!normalizedRecipient || normalizedRecipient !== resolved.recipientEmail) {
    const err = new Error("invite_email_mismatch");
    err.code = "INVITE_EMAIL_MISMATCH";
    throw err;
  }
  if (normalizeEmail(resolved.referrerUser.email) === normalizedRecipient) {
    const err = new Error("self_referral_not_allowed");
    err.code = "SELF_REFERRAL";
    throw err;
  }
  if (resolved.event.referred_user_id && resolved.event.referred_user_id !== referredUserId) {
    const err = new Error("invite_already_claimed");
    err.code = "INVITE_ALREADY_CLAIMED";
    throw err;
  }

  const metadata = resolved.event.metadata && typeof resolved.event.metadata === "object"
    ? resolved.event.metadata
    : {};
  await trx("referral_events")
    .where({ id: resolved.event.id })
    .update({
      referred_user_id: referredUserId,
      status: "claimed",
      metadata: {
        ...metadata,
        claimed_at: new Date().toISOString(),
        claimed_user_id: referredUserId,
      },
      updated_at: trx.fn.now(),
    });

  return resolved;
}

export async function applySignupReferral({ trx = db, newUserId, newUserEmail, referralIdentifier, cashAppTag }) {
  const updates = {};
  const normalizedCashApp = normalizeCashAppTag(cashAppTag);

  const newEmail = normalizeEmail(newUserEmail);
  const resolved = await resolveReferralIdentifier(referralIdentifier, trx);

  if (
    resolved?.referrerUser?.id &&
    resolved.referrerUser.id !== newUserId &&
    normalizeEmail(resolved.referrerUser.email) !== newEmail
  ) {
    updates.referred_by_user_id = resolved.referrerUser.id;
    updates.referral_code_id = resolved.referralCode?.id || null;
    updates.referred_by_input = normalizeReferralValue(referralIdentifier);
  }

  if (Object.keys(updates).length) {
    await trx("users").where({ id: newUserId }).update(updates);
  }

  if (normalizedCashApp) {
    await persistUserCashAppTag({
      trx,
      userId: newUserId,
      cashAppTag: normalizedCashApp,
      enforceApprovedLock: false,
    });
  }

  const user = await trx("users").where({ id: newUserId }).first();
  await ensureReferralCodeForUser(user, trx);

  return { user, referralApplied: Boolean(updates.referred_by_user_id), cashAppTag: normalizedCashApp };
}

async function hasTableSafe(knex, tableName) {
  try {
    return await knex.schema.hasTable(tableName);
  } catch {
    return false;
  }
}

async function findCurrentCashAppOwner(knex, normalizedKey, excludeUserId) {
  if (!normalizedKey) return null;

  return knex("users")
    .select("id", "email", "cash_app_tag")
    .whereNot({ id: excludeUserId })
    .whereNotNull("cash_app_tag")
    .whereRaw("lower(regexp_replace(cash_app_tag, '^\\$+', '')) = ?", [normalizedKey])
    .first();
}

async function persistUserCashAppTag({ trx, userId, cashAppTag, enforceApprovedLock = true }) {
  const normalized = normalizeCashAppTag(cashAppTag);
  const normalizedKey = cashAppTagKey(normalized);

  const user = await trx("users")
    .where({ id: userId })
    .forUpdate()
    .first();
  if (!user) return null;

  const currentKey = cashAppTagKey(user.cash_app_tag);
  const rewardQueueExists = await hasTableSafe(trx, "reward_queue");
  const referralCodesExists = await hasTableSafe(trx, "referral_codes");
  const claimsTableExists = await hasTableSafe(trx, "cash_app_tag_claims");

  const approvedReward = enforceApprovedLock && rewardQueueExists
    ? await trx("reward_queue")
        .where({ user_id: user.id, status: "approved" })
        .first()
    : null;

  if (approvedReward && currentKey && currentKey !== normalizedKey) {
    throw referralServiceError("cash_app_tag_locked_for_approved_payout");
  }

  // Always enforce current-account uniqueness, even if the claims migration has not
  // finished yet. The claims table adds permanent historical reservation after deploy.
  if (normalizedKey) {
    const currentOwner = await findCurrentCashAppOwner(trx, normalizedKey, user.id);
    if (currentOwner) {
      throw referralServiceError("cash_app_tag_in_use");
    }
  }

  if (claimsTableExists) {
    const activeClaim = await trx("cash_app_tag_claims")
      .where({ user_id: user.id, status: "active" })
      .forUpdate()
      .first();

    if (normalizedKey) {
      const claimed = await trx("cash_app_tag_claims")
        .where({ normalized_tag: normalizedKey })
        .forUpdate()
        .first();

      if (claimed && claimed.user_id !== user.id) {
        throw referralServiceError("cash_app_tag_in_use");
      }

      if (activeClaim && activeClaim.normalized_tag !== normalizedKey) {
        await trx("cash_app_tag_claims")
          .where({ id: activeClaim.id })
          .update({
            status: "retired",
            retired_at: trx.fn.now(),
            updated_at: trx.fn.now(),
          });
      }

      if (claimed) {
        await trx("cash_app_tag_claims")
          .where({ id: claimed.id })
          .update({
            display_tag: normalized,
            status: "active",
            retired_at: null,
            updated_at: trx.fn.now(),
          });
      } else {
        try {
          await trx("cash_app_tag_claims").insert({
            id: crypto.randomUUID(),
            user_id: user.id,
            normalized_tag: normalizedKey,
            display_tag: normalized,
            status: "active",
            claimed_at: trx.fn.now(),
            created_at: trx.fn.now(),
            updated_at: trx.fn.now(),
          });
        } catch (err) {
          if (String(err?.code || "") === "23505") {
            throw referralServiceError("cash_app_tag_in_use");
          }
          throw err;
        }
      }
    } else if (activeClaim) {
      await trx("cash_app_tag_claims")
        .where({ id: activeClaim.id })
        .update({
          status: "retired",
          retired_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        });
    }
  }

  // The original users table does not have updated_at.
  const [updatedUser] = await trx("users")
    .where({ id: user.id })
    .update({ cash_app_tag: normalized })
    .returning("*");

  if (referralCodesExists) {
    await trx("referral_codes")
      .where({ user_id: user.id })
      .update({ cashapp_handle: normalized, updated_at: trx.fn.now() });
  }

  if (rewardQueueExists) {
    await trx("reward_queue")
      .where({ user_id: user.id })
      .whereIn("status", ["pending", "approved"])
      .update({ cashapp_handle: normalized, updated_at: trx.fn.now() });
  }

  return updatedUser;
}

export async function updateUserCashAppTag({ userId, cashAppTag }) {
  return db.transaction((trx) => persistUserCashAppTag({ trx, userId, cashAppTag }));
}

function normalizeTier(raw) {
  const requiredPurchases = Number(
    raw?.requiredPurchases ?? raw?.required_purchases ?? raw?.requiredReferrals ?? raw?.count ?? 0
  );
  const rewardAmountCents = Number(
    raw?.rewardAmountCents ?? raw?.reward_amount_cents ?? raw?.amountCents ?? 0
  );
  if (!Number.isInteger(requiredPurchases) || requiredPurchases <= 0) return null;
  if (!Number.isInteger(rewardAmountCents) || rewardAmountCents < 0) return null;
  return { requiredPurchases, rewardAmountCents };
}

export function referralProgramQualification(program) {
  const metadata = program?.metadata && typeof program.metadata === "object" ? program.metadata : {};
  return metadata.qualification === "verified_signup" ? "verified_signup" : "verified_purchase";
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

  const slug = normalizeProductSlug(program?.product_slug);
  const defaults = slug === "tabforge" ? TABFORGE_PURCHASE_TIERS : DEFAULT_PURCHASE_TIERS;

  return (tiers.length ? tiers : defaults)
    .sort((a, b) => a.requiredPurchases - b.requiredPurchases);
}

export async function getReferralProgram(productSlug, trx = db) {
  const slug = normalizeProductSlug(productSlug);
  let program = await trx("referral_programs")
    .where({ product_slug: slug, status: "active" })
    .first();

  if (!program) {
    const isTabForge = slug === "tabforge";
    const tiers = isTabForge ? TABFORGE_PURCHASE_TIERS : DEFAULT_PURCHASE_TIERS;
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
          qualification: "verified_purchase",
          tiers,
          description: isTabForge
            ? "The referrer may participate without purchasing. Only completed TabForge Pro purchases made through the referral link count: $10 at 5, $20 at 15, and $75 at 50."
            : "Default manual Cash App purchase referral tiers.",
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

async function queueRewardsForVerifiedCount({
  trx,
  referrer,
  referralCode,
  program,
  productSlug,
  verifiedCount,
  qualification,
  qualificationRef,
}) {
  const rewards = [];
  const tiers = tiersFromProgram(program);

  for (const tier of tiers) {
    if (verifiedCount < tier.requiredPurchases) continue;

    const tierKey = `${qualification}:${tier.requiredPurchases}`;
    let existingReward = await trx("reward_queue")
      .where({ user_id: referrer.id, product_slug: productSlug })
      .whereRaw("metadata->>'tier_key' = ?", [tierKey])
      .first();

    if (!existingReward && qualification === "verified_purchase") {
      existingReward = await trx("reward_queue")
        .where({ user_id: referrer.id, product_slug: productSlug })
        .whereRaw("metadata->>'tier_required_purchases' = ?", [String(tier.requiredPurchases)])
        .first();
    }

    if (existingReward) continue;

    const inserted = await trx("reward_queue")
      .insert({
        id: crypto.randomUUID(),
        referral_code_id: referralCode?.id || null,
        user_id: referrer.id,
        email: normalizeEmail(referrer.email),
        product_slug: productSlug,
        reward_key: tierKey,
        reward_amount_cents: tier.rewardAmountCents,
        reward_type: program.reward_type || "cashapp_manual",
        cashapp_handle: normalizeCashAppTag(referrer.cash_app_tag || referralCode?.cashapp_handle),
        status: "pending",
        metadata: {
          tier_key: tierKey,
          qualification,
          qualification_ref: qualificationRef,
          tier_required_purchases: tier.requiredPurchases,
          verified_purchase_count: verifiedCount,
        },
        updated_at: trx.fn.now(),
      })
      .onConflict(["user_id", "product_slug", "reward_key"])
      .ignore()
      .returning("*");

    if (inserted[0]) rewards.push(inserted[0]);
  }

  return rewards;
}

async function queuePurchaseRewardsForReferrer({ trx, referrer, referralCode, productSlug, qualificationRef }) {
  const verifiedCountResult = await trx("referral_events")
    .where({
      referrer_user_id: referrer.id,
      product_slug: productSlug,
      event_type: "purchase",
      status: "verified",
    })
    .countDistinct({ count: "referred_user_id" })
    .first();
  const verifiedCount = Number(verifiedCountResult?.count || 0);

  const program = await getReferralProgram(productSlug, trx);
  const qualification = referralProgramQualification(program);
  const rewards = qualification === "verified_purchase"
    ? await queueRewardsForVerifiedCount({
        trx,
        referrer,
        referralCode,
        program,
        productSlug,
        verifiedCount,
        qualification,
        qualificationRef,
      })
    : [];

  return { verifiedCount, rewards };
}

export async function recordVerifiedReferralSignup({ referredUserId, productSlug = "tabforge" }) {
  const slug = normalizeProductSlug(productSlug) || "tabforge";
  if (!referredUserId) return { recorded: false, reason: "missing_input" };

  return db.transaction(async (trx) => {
    const referredUser = await trx("users").where({ id: referredUserId }).first();
    if (!referredUser?.email_verified) return { recorded: false, reason: "email_not_verified" };
    if (!referredUser.referred_by_user_id) return { recorded: false, reason: "no_referrer" };
    if (referredUser.referred_by_user_id === referredUser.id) {
      return { recorded: false, reason: "self_referral" };
    }

    const referrer = await trx("users").where({ id: referredUser.referred_by_user_id }).first();
    if (!referrer) return { recorded: false, reason: "referrer_missing" };

    const referralCode = referredUser.referral_code_id
      ? await trx("referral_codes").where({ id: referredUser.referral_code_id }).first()
      : await ensureReferralCodeForUser(referrer, trx);

    let signupEvent = await trx("referral_events")
      .where({
        referred_user_id: referredUser.id,
        product_slug: slug,
        event_type: "signup",
      })
      .first();

    let recorded = false;
    if (!signupEvent) {
      [signupEvent] = await trx("referral_events")
        .insert({
          id: crypto.randomUUID(),
          referral_code_id: referralCode?.id || null,
          referrer_user_id: referrer.id,
          referred_user_id: referredUser.id,
          product_slug: slug,
          purchase_ref: `verified-signup:${referredUser.id}`,
          event_type: "signup",
          status: "verified",
          metadata: {
            qualification: "verified_account_only",
            counts_toward_payout: false,
            referred_email: normalizeEmail(referredUser.email),
          },
          updated_at: trx.fn.now(),
        })
        .returning("*");
      recorded = true;
    } else if (signupEvent.status !== "verified") {
      [signupEvent] = await trx("referral_events")
        .where({ id: signupEvent.id })
        .update({
          status: "verified",
          metadata: {
            ...(signupEvent.metadata || {}),
            counts_toward_payout: false,
          },
          updated_at: trx.fn.now(),
        })
        .returning("*");
      recorded = true;
    }

    const pendingPurchases = await trx("referral_events")
      .where({
        referred_user_id: referredUser.id,
        product_slug: slug,
        event_type: "purchase",
        status: "pending",
      });

    if (pendingPurchases.length) {
      await trx("referral_events")
        .whereIn("id", pendingPurchases.map((row) => row.id))
        .update({ status: "verified", updated_at: trx.fn.now() });
    }

    const qualificationRef = pendingPurchases[pendingPurchases.length - 1]?.purchase_ref || signupEvent.purchase_ref;
    const { verifiedCount, rewards } = await queuePurchaseRewardsForReferrer({
      trx,
      referrer,
      referralCode,
      productSlug: slug,
      qualificationRef,
    });

    return {
      recorded,
      event: signupEvent,
      rewards,
      verifiedCount,
      promotedPurchases: pendingPurchases.length,
    };
  });
}

export async function recordReferralPurchase({ referredUserId, productSlug, purchaseRef, metadata = {} }) {
  const slug = normalizeProductSlug(productSlug);
  const ref = normalizeReferralValue(purchaseRef);
  if (!referredUserId || !slug || !ref) return { recorded: false, reason: "missing_input" };

  return db.transaction(async (trx) => {
    const referredUser = await trx("users").where({ id: referredUserId }).first();
    if (!referredUser?.referred_by_user_id) return { recorded: false, reason: "no_referrer" };
    if (referredUser.referred_by_user_id === referredUser.id) {
      return { recorded: false, reason: "self_referral" };
    }

    const referrer = await trx("users").where({ id: referredUser.referred_by_user_id }).first();
    if (!referrer) return { recorded: false, reason: "referrer_missing" };

    const referralCode = referredUser.referral_code_id
      ? await trx("referral_codes").where({ id: referredUser.referral_code_id }).first()
      : await ensureReferralCodeForUser(referrer, trx);

    const existingQuery = trx("referral_events")
      .where({
        referred_user_id: referredUser.id,
        product_slug: slug,
        event_type: "purchase",
      });
    if (slug !== "tabforge") existingQuery.andWhere({ purchase_ref: ref });
    const existing = await existingQuery.first();

    if (existing) {
      return {
        recorded: false,
        reason: slug === "tabforge" ? "duplicate_referred_customer" : "duplicate_purchase",
        event: existing,
      };
    }

    const purchaseStatus = referredUser.email_verified ? "verified" : "pending";
    const [event] = await trx("referral_events")
      .insert({
        id: crypto.randomUUID(),
        referral_code_id: referralCode?.id || null,
        referrer_user_id: referrer.id,
        referred_user_id: referredUser.id,
        product_slug: slug,
        purchase_ref: ref,
        event_type: "purchase",
        status: purchaseStatus,
        metadata: {
          ...metadata,
          qualification: "verified_purchase",
          purchaser_email_verified: Boolean(referredUser.email_verified),
        },
        updated_at: trx.fn.now(),
      })
      .returning("*");

    if (purchaseStatus !== "verified") {
      return {
        recorded: true,
        event,
        rewards: [],
        verifiedCount: 0,
        reason: "awaiting_email_verification",
      };
    }

    const { verifiedCount, rewards } = await queuePurchaseRewardsForReferrer({
      trx,
      referrer,
      referralCode,
      productSlug: slug,
      qualificationRef: ref,
    });

    return { recorded: true, event, rewards, verifiedCount };
  });
}
