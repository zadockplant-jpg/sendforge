import crypto from "crypto";
import { db } from "../../config/db.js";
import { log } from "../../utils/logger.js";

// Every product pays its referrers on the same milestones: the 5th, 15th,
// 25th and 50th referred customer, then every 25th after that. Only the
// amounts differ from product to product.
export const REFERRAL_MILESTONES = Object.freeze([5, 15, 25, 50]);
const RECURRING_START_AFTER = 50;
const RECURRING_EVERY = 25;

function milestoneTiers(amountsCents) {
  return REFERRAL_MILESTONES.map((requiredPurchases, index) => ({
    requiredPurchases,
    rewardAmountCents: amountsCents[index],
  }));
}

function recurringTier(rewardAmountCents) {
  return { startAfterPurchases: RECURRING_START_AFTER, everyPurchases: RECURRING_EVERY, rewardAmountCents };
}

// The public referral programme of each product.
//
// Rose Colored Glasses pays $1 per referral, settled at the milestones rather
// than one dollar at a time: $5 for the first 5, $10 for the next 10, $10 for
// the 10 after that, $25 for the next 25, and $25 for every 25 beyond. Paid
// out, it is always exactly $1 per referred customer.
export const PRODUCT_REFERRAL_PROGRAMS = Object.freeze({
  tabforge: Object.freeze({
    label: "TabForge Pro",
    tiers: milestoneTiers([1700, 3500, 4000, 15000]),
    recurringTier: recurringTier(15000),
  }),
  "rose-colored-glasses": Object.freeze({
    label: "Rose Colored Glasses",
    perReferralCents: 100,
    tiers: milestoneTiers([500, 1000, 1000, 2500]),
    recurringTier: recurringTier(2500),
  }),
  forgedrop: Object.freeze({
    label: "ForgeDrop",
    tiers: milestoneTiers([2500, 5000, 6000, 17500]),
    recurringTier: recurringTier(17500),
  }),
});

export const MILESTONE_REFERRAL_PRODUCTS = Object.freeze(Object.keys(PRODUCT_REFERRAL_PROGRAMS));

export function isMilestoneReferralProduct(productSlug) {
  return Boolean(PRODUCT_REFERRAL_PROGRAMS[normalizeProductSlug(productSlug)]);
}

const TABFORGE_PURCHASE_TIERS = PRODUCT_REFERRAL_PROGRAMS.tabforge.tiers;
const TABFORGE_RECURRING_PURCHASE_TIER = PRODUCT_REFERRAL_PROGRAMS.tabforge.recurringTier;
// A product without a programme of its own keeps the TabForge amounts.
const DEFAULT_PURCHASE_TIERS = TABFORGE_PURCHASE_TIERS;

export function defaultProgramTiers(productSlug) {
  return (PRODUCT_REFERRAL_PROGRAMS[normalizeProductSlug(productSlug)] || PRODUCT_REFERRAL_PROGRAMS.tabforge).tiers;
}

export function defaultProgramRecurringTier(productSlug) {
  return PRODUCT_REFERRAL_PROGRAMS[normalizeProductSlug(productSlug)]?.recurringTier || null;
}

const INVITE_TTL_DAYS = 30;

// Private Sync pays the referrer a share of every renewal, for as long as the
// person they referred keeps paying.
//
// One level, and only one. The share goes to the account directly above the
// subscriber and stops there. We never walk further up the chain, so a
// referrer's own referrer is paid nothing on this invoice. That is a product
// decision, not an oversight: a second level turns a referral scheme into a
// structure people have to be told is not one, and it is not worth the
// explaining.
export const SYNC_SHARE_RATE = 0.05;
export const SYNC_SHARE_PRODUCT_SLUG = "tabforge-subscription";

export function syncShareCents(netPaidCents) {
  const paid = Number(netPaidCents);
  if (!Number.isFinite(paid) || paid <= 0) return 0;
  // Rounded to the nearest cent, but a paid invoice never earns nothing: at
  // the $5 price this is 25 cents, and it should not silently become zero if
  // the price is ever lowered.
  return Math.max(1, Math.round(paid * SYNC_SHARE_RATE));
}

export const REFERRAL_REQUIRED_PRODUCT_SLUG = "tabforge";
const REFERRAL_ELIGIBLE_ENTITLEMENT_SLUGS = [
  REFERRAL_REQUIRED_PRODUCT_SLUG,
  "tabforge-pro",
];

// Products whose per-person rate can be set on a referral code: a flat amount
// on every sale, in place of the milestones. The rate lives in the code's
// metadata.flat_rates; zero means the person earns nothing on that product.
// (TabForge keeps its own per-sale field, metadata.commission.)
export const PER_SALE_RATE_PRODUCTS = Object.freeze(["rose-colored-glasses", "forgedrop"]);

// The affiliate level. An affiliate is paid a flat amount on every sale of
// these products, unless the owner set a different rate on their code.
// TabForge's affiliate rate is the one their comp code or the owner set.
export const AFFILIATE_PER_SALE_CENTS = Object.freeze({ forgedrop: 1000 });

// Rose Colored Glasses rewards queued before it moved onto milestones: one
// flat dollar per customer. They still stand, and a refund still cancels them.
const LEGACY_FLAT_REFERRAL_PRODUCTS = Object.freeze(["rose-colored-glasses"]);

// Owning any product with a referral programme is enough to hold a referral
// code. It is the same code on every product - one link per person - but it
// earns only on products whose own gate the referrer passes: the TabForge
// tiers still check TabForge Pro on every payout, so owning Rose Colored
// Glasses alone never pays on a TabForge sale.
const REFERRAL_CODE_ENTITLEMENT_SLUGS = [
  ...new Set([...REFERRAL_ELIGIBLE_ENTITLEMENT_SLUGS, ...MILESTONE_REFERRAL_PRODUCTS]),
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

export async function hasReferralProgramEligibility(
  userId,
  productSlug = REFERRAL_REQUIRED_PRODUCT_SLUG,
  trx = db
) {
  const slug = normalizeProductSlug(productSlug);
  if (!userId || slug !== REFERRAL_REQUIRED_PRODUCT_SLUG) return false;

  const entitlement = await trx("product_entitlements")
    .where({
      user_id: userId,
      status: "active",
    })
    .whereIn("product_slug", REFERRAL_ELIGIBLE_ENTITLEMENT_SLUGS)
    .andWhere((query) => {
      query.whereNull("expires_at").orWhere("expires_at", ">", trx.fn.now());
    })
    .first();

  return Boolean(entitlement);
}

/**
 * Whether this account gets a referral code at all: it owns TabForge Pro or a
 * product with a flat referral reward, or the owner made it an affiliate from
 * the admin dashboard. Which sales it earns on is decided per payout, not here.
 */
export async function canHoldReferralCode(userId, trx = db) {
  if (!userId) return false;
  const entitlement = await trx("product_entitlements")
    .where({ user_id: userId, status: "active" })
    .whereIn("product_slug", REFERRAL_CODE_ENTITLEMENT_SLUGS)
    .andWhere((query) => {
      query.whereNull("expires_at").orWhere("expires_at", ">", trx.fn.now());
    })
    .first();
  if (entitlement) return true;
  const affiliate = await trx("referral_codes")
    .where({ user_id: userId, status: "active" })
    .whereRaw("metadata->>'affiliate' = 'true'")
    .first();
  return Boolean(affiliate);
}

/**
 * Whether a referral code is on affiliate terms: the owner made it an
 * affiliate, or a comp code or the owner gave it a per-sale TabForge rate.
 */
export function isAffiliateReferralCode(referralCode) {
  return referralCode?.metadata?.affiliate === true || Boolean(commissionPlanForReferralCode(referralCode));
}

/**
 * The rate the owner set on this code for a product, or null when none is set.
 */
export function customPerSaleCentsForCode(referralCode, productSlug) {
  const slug = normalizeProductSlug(productSlug);
  if (!PER_SALE_RATE_PRODUCTS.includes(slug)) return null;
  const rates = referralCode?.metadata?.flat_rates;
  const custom = rates && typeof rates === "object" ? rates[slug] : undefined;
  const cents = Number(custom);
  return custom !== null && custom !== undefined && custom !== "" && Number.isInteger(cents) && cents >= 0 ? cents : null;
}

/**
 * What this referrer is paid on every sale of a product, or null when they
 * are paid on the product's milestones. The owner's own rate wins; otherwise
 * an affiliate gets the affiliate level for the product. Zero means the
 * person earns nothing on that product.
 */
export function perSaleCentsForCode(referralCode, productSlug) {
  const slug = normalizeProductSlug(productSlug);
  if (slug === REFERRAL_REQUIRED_PRODUCT_SLUG) {
    return commissionPlanForReferralCode(referralCode)?.rewardAmountCents ?? null;
  }
  const custom = customPerSaleCentsForCode(referralCode, slug);
  if (custom !== null) return custom;
  if (AFFILIATE_PER_SALE_CENTS[slug] && isAffiliateReferralCode(referralCode)) {
    return AFFILIATE_PER_SALE_CENTS[slug];
  }
  return null;
}

/**
 * Whether this account earns referral rewards on a product at all. TabForge,
 * and the Private Sync share that rides on it, need TabForge Pro. Every other
 * product with a programme needs the referrer to hold a referral code: to own
 * one of our products, or to be an affiliate.
 */
export async function productReferralEligibility(userId, productSlug, trx = db) {
  const slug = normalizeProductSlug(productSlug);
  if (!userId) return false;
  if (slug === REFERRAL_REQUIRED_PRODUCT_SLUG || slug === SYNC_SHARE_PRODUCT_SLUG) {
    return hasReferralProgramEligibility(userId, REFERRAL_REQUIRED_PRODUCT_SLUG, trx);
  }
  if (isMilestoneReferralProduct(slug)) return canHoldReferralCode(userId, trx);
  return false;
}

/**
 * Whether a queued reward may be approved and paid, by the product it was
 * earned on: the referrer must still pass that product's gate.
 */
export async function rewardPayoutEligibility(userId, productSlug, trx = db) {
  return productReferralEligibility(userId, productSlug, trx);
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
  if (!(await canHoldReferralCode(user.id, trx))) {
    return null;
  }

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

/**
 * The referral code the owner hands someone from the admin dashboard, whether
 * or not they own a product: an affiliate or a friend. Marked `affiliate`, so
 * canHoldReferralCode lets it be used, and never a second code for one person.
 */
export async function ensureAffiliateReferralCode(user, { source = "admin" } = {}, trx = db) {
  if (!user?.id || !user?.email) return null;
  const existing = await trx("referral_codes")
    .where({ user_id: user.id, status: "active" })
    .orderBy("created_at", "asc")
    .first();
  if (existing) {
    if (existing.metadata?.affiliate === true) return existing;
    const [row] = await trx("referral_codes")
      .where({ id: existing.id })
      .update({ metadata: { ...(existing.metadata || {}), affiliate: true }, updated_at: trx.fn.now() })
      .returning("*");
    return row;
  }
  const code = await createUniqueReferralCode(trx, user.email);
  const [row] = await trx("referral_codes")
    .insert({
      id: crypto.randomUUID(),
      user_id: user.id,
      email: normalizeEmail(user.email),
      code,
      cashapp_handle: normalizeCashAppTag(user.cash_app_tag),
      status: "active",
      metadata: { source, affiliate: true },
      updated_at: trx.fn.now(),
    })
    .returning("*");
  return row;
}

/**
 * The per-person referral terms the owner sets: a flat amount per TabForge
 * sale (null returns them to the milestone tiers) and a flat amount per sale
 * of another product (null returns that product to its milestones, or to the
 * affiliate level for an affiliate).
 */
export async function setReferralTerms(codeRow, { tabforgePerSaleCents, flatRates } = {}, trx = db) {
  if (!codeRow?.id) return null;
  const metadata = { ...(codeRow.metadata || {}) };

  if (tabforgePerSaleCents !== undefined) {
    const cents = Number(tabforgePerSaleCents);
    if (tabforgePerSaleCents === null || !Number.isInteger(cents) || cents < 1) {
      delete metadata.commission;
    } else {
      metadata.commission = {
        mode: "per_sale",
        rewardAmountCents: cents,
        source: "admin",
        applied_at: new Date().toISOString(),
      };
    }
  }

  if (flatRates && typeof flatRates === "object") {
    const rates = { ...(metadata.flat_rates || {}) };
    for (const [slug, value] of Object.entries(flatRates)) {
      const key = normalizeProductSlug(slug);
      if (!PER_SALE_RATE_PRODUCTS.includes(key)) continue;
      const cents = Number(value);
      if (value === null || !Number.isInteger(cents) || cents < 0) delete rates[key];
      else rates[key] = cents;
    }
    if (Object.keys(rates).length) metadata.flat_rates = rates;
    else delete metadata.flat_rates;
  }

  const [row] = await trx("referral_codes")
    .where({ id: codeRow.id })
    .update({ metadata, updated_at: trx.fn.now() })
    .returning("*");
  return row;
}

/**
 * Give a referral code a name of the owner's choosing. People already
 * referred keep their link to the referrer, which is stored by id; only
 * links carrying the old code stop resolving.
 */
export async function renameReferralCode(codeRow, newCode, trx = db) {
  const code = String(newCode || "").trim().replace(/^#/, "").toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
    throw referralServiceError("invalid_referral_code", 400);
  }
  if (code === codeRow.code) return codeRow;
  const taken = await trx("referral_codes").where({ code }).first();
  if (taken) throw referralServiceError("referral_code_taken", 409);
  const [row] = await trx("referral_codes")
    .where({ id: codeRow.id })
    .update({
      code,
      metadata: { ...(codeRow.metadata || {}), previous_codes: [...(codeRow.metadata?.previous_codes || []), codeRow.code] },
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
    if (!code) return null;
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
  if (!user || !(await canHoldReferralCode(user.id, trx))) {
    return null;
  }

  return { referrerUser: user, referralCode: code, inputType: "code" };
}

export async function createReferralInvite({
  referrerUser,
  referralCode,
  recipientEmail,
  productSlug = "tabforge",
  recipientConsentAttested = false,
  trx = db,
}) {
  const recipient = normalizeEmail(recipientEmail);
  const slug = normalizeProductSlug(productSlug) || "tabforge";
  if (
    !referrerUser?.id ||
    !recipient ||
    !referralCode?.id ||
    recipientConsentAttested !== true
  ) {
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
      // This is the referral lifecycle state, not proof of email delivery.
      // Provider acceptance and webhook outcomes live in metadata.email_delivery.
      status: "created",
      metadata: {
        recipient_email: recipient,
        expires_at: expiresAt.toISOString(),
        email_delivery: {
          provider: "sendgrid",
          status: "pending",
          created_at: new Date().toISOString(),
        },
        consent: {
          recipient_permission_attested: true,
          attested_by_user_id: referrerUser.id,
          attested_at: new Date().toISOString(),
          source: "referral_invite_api",
        },
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
  if (
    !(await hasReferralProgramEligibility(
      referrerUser.id,
      event.product_slug,
      trx
    ))
  ) {
    return null;
  }

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

async function hasColumnsSafe(knex, tableName, columns) {
  try {
    if (!(await knex.schema.hasTable(tableName))) return false;
    const checks = await Promise.all(columns.map((column) => knex.schema.hasColumn(tableName, column)));
    return checks.every(Boolean);
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
  const claimsTableExists = await hasTableSafe(trx, "cash_app_tag_claims");
  const claimsTableReady = claimsTableExists
    ? await hasColumnsSafe(trx, "cash_app_tag_claims", [
        "id",
        "user_id",
        "normalized_tag",
        "display_tag",
        "status",
        "claimed_at",
        "retired_at",
        "created_at",
        "updated_at",
      ])
    : false;

  if (normalizedKey && claimsTableExists && !claimsTableReady) {
    throw referralServiceError("cash_app_storage_unavailable", 503);
  }

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

  if (claimsTableReady) {
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

  return updatedUser;
}

async function syncCashAppTagToPayoutTables({ userId, cashAppTag }) {
  const tasks = [];

  if (await hasTableSafe(db, "referral_codes")) {
    tasks.push(
      db("referral_codes")
        .where({ user_id: userId })
        .update({ cashapp_handle: cashAppTag, updated_at: db.fn.now() })
    );
  }

  if (await hasTableSafe(db, "reward_queue")) {
    tasks.push(
      db("reward_queue")
        .where({ user_id: userId })
        .whereIn("status", ["pending", "approved"])
        .update({ cashapp_handle: cashAppTag, updated_at: db.fn.now() })
    );
  }

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "rejected") {
      log("warn", "cashapp_tag_secondary_sync_failed", {
        userId,
        message: String(result.reason?.message || result.reason),
        code: result.reason?.code || null,
      });
    }
  }
}

export async function updateUserCashAppTag({ userId, cashAppTag }) {
  const updatedUser = await db.transaction((trx) =>
    persistUserCashAppTag({ trx, userId, cashAppTag })
  );

  if (updatedUser) {
    await syncCashAppTagToPayoutTables({
      userId,
      cashAppTag: updatedUser.cash_app_tag || null,
    });
  }

  return updatedUser;
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
  const defaults = PRODUCT_REFERRAL_PROGRAMS[slug]?.tiers || DEFAULT_PURCHASE_TIERS;

  return [...(tiers.length ? tiers : defaults)]
    .sort((a, b) => a.requiredPurchases - b.requiredPurchases);
}

export function recurringTierFromProgram(program) {
  const slug = normalizeProductSlug(program?.product_slug);
  const meta = program?.metadata && typeof program.metadata === "object" ? program.metadata : {};
  const raw = meta.recurringTier && typeof meta.recurringTier === "object" ? meta.recurringTier : null;
  const fallback = defaultProgramRecurringTier(slug);
  const source = raw || fallback;
  if (!source) return null;

  const startAfterPurchases = Number(source.startAfterPurchases ?? source.start_after_purchases ?? source.afterPurchases ?? 0);
  const everyPurchases = Number(source.everyPurchases ?? source.every_purchases ?? source.intervalPurchases ?? 0);
  const rewardAmountCents = Number(source.rewardAmountCents ?? source.reward_amount_cents ?? 0);
  if (!Number.isInteger(startAfterPurchases) || startAfterPurchases <= 0) return null;
  if (!Number.isInteger(everyPurchases) || everyPurchases <= 0) return null;
  if (!Number.isInteger(rewardAmountCents) || rewardAmountCents <= 0) return null;
  return { startAfterPurchases, everyPurchases, rewardAmountCents };
}

export function tiersForVerifiedCount(program, verifiedCount = 0) {
  const fixedTiers = tiersFromProgram(program);
  const count = Math.max(0, Number(verifiedCount || 0));
  const recurring = recurringTierFromProgram(program);
  const tiers = [...fixedTiers];

  if (recurring && count >= recurring.startAfterPurchases) {
    const maxRequiredPurchases = count + recurring.everyPurchases;
    for (
      let requiredPurchases = recurring.startAfterPurchases + recurring.everyPurchases;
      requiredPurchases <= maxRequiredPurchases;
      requiredPurchases += recurring.everyPurchases
    ) {
      if (!tiers.some((tier) => Number(tier.requiredPurchases) === requiredPurchases)) {
        tiers.push({
          requiredPurchases,
          rewardAmountCents: recurring.rewardAmountCents,
          recurring: true,
        });
      }
    }
  }

  return tiers.sort((a, b) => a.requiredPurchases - b.requiredPurchases);
}

// A per-referrer plan overrides the programme's tiers: a flat amount on every
// qualified sale, which is what an affiliate signs up to. It lives on the
// referrer's referral code, so the programme row stays the default for
// everyone else. This is the TabForge one; perSaleCentsForCode covers every
// product.
export function commissionPlanForReferralCode(referralCode) {
  const meta = referralCode?.metadata && typeof referralCode.metadata === "object" ? referralCode.metadata : {};
  const plan = meta.commission && typeof meta.commission === "object" ? meta.commission : null;
  if (!plan || plan.mode !== "per_sale") return null;
  const cents = Number(plan.rewardAmountCents ?? plan.reward_amount_cents);
  if (!Number.isInteger(cents) || cents < 1) return null;
  return { mode: "per_sale", rewardAmountCents: cents, source: plan.source || null, code: plan.code || null };
}

export function effectiveProgramForReferrer(program, referralCode) {
  if (!program) return program;
  const cents = perSaleCentsForCode(referralCode, program.product_slug);
  if (cents === null) return program;
  return {
    ...program,
    metadata: {
      ...(program.metadata && typeof program.metadata === "object" ? program.metadata : {}),
      plan: "per_sale",
      perSaleRewardCents: cents,
      tiers: [{ requiredPurchases: 1, rewardAmountCents: cents }],
      recurringTier: cents > 0
        ? { startAfterPurchases: 1, everyPurchases: 1, rewardAmountCents: cents }
        : { enabled: false },
    },
  };
}

function dollars(cents) {
  const value = Number(cents || 0) / 100;
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

export function programDescription(productSlug) {
  const slug = normalizeProductSlug(productSlug);
  const program = PRODUCT_REFERRAL_PROGRAMS[slug];
  if (!program) return "Default manual Cash App purchase referral tiers.";
  const steps = program.tiers.map((tier) => `${dollars(tier.rewardAmountCents)} at ${tier.requiredPurchases}`).join(", ");
  const every = `then ${dollars(program.recurringTier.rewardAmountCents)} for each additional ${program.recurringTier.everyPurchases}`;
  if (slug === "tabforge") {
    return `The referrer must own TabForge Pro. Only completed TabForge Pro purchases made through the referral link count: ${steps}, ${every} qualified purchases.`;
  }
  const lead = program.perReferralCents
    ? `${dollars(program.perReferralCents)} per referred customer, paid at the milestones: `
    : "";
  return `${program.label}: ${lead}${steps}, ${every} referred customers who bought it.`;
}

export async function getReferralProgram(productSlug, trx = db) {
  const slug = normalizeProductSlug(productSlug);
  let program = await trx("referral_programs")
    .where({ product_slug: slug, status: "active" })
    .first();

  if (!program) {
    const isTabForge = slug === "tabforge";
    const tiers = defaultProgramTiers(slug);
    const [created] = await trx("referral_programs")
      .insert({
        id: crypto.randomUUID(),
        product_slug: slug,
        required_purchases: tiers[0].requiredPurchases,
        reward_amount_cents: tiers[0].rewardAmountCents,
        reward_type: "cashapp_manual",
        refund_hold_days: 0,
        status: "active",
        metadata: {
          qualification: "verified_purchase",
          tiers,
          recurringTier: defaultProgramRecurringTier(slug),
          referrer_purchase_required: isTabForge,
          required_referrer_product_slug: isTabForge
            ? REFERRAL_REQUIRED_PRODUCT_SLUG
            : null,
          referred_purchase_required: true,
          description: programDescription(slug),
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
  // The referrer's own plan, when they have one, decides the tiers. A per-sale
  // rate of zero is the owner saying this person earns nothing here.
  const effective = effectiveProgramForReferrer(program, referralCode);
  if (effective?.metadata?.plan === "per_sale" && !(Number(effective.metadata.perSaleRewardCents) > 0)) {
    return rewards;
  }
  const tiers = tiersForVerifiedCount(effective, verifiedCount);

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

/**
 * How many customers this referrer brought to a product: distinct accounts
 * with a verified, paid purchase through their link. Rose Colored Glasses
 * customers already paid a flat dollar each before it moved onto milestones
 * are left out, so nobody is paid twice for the same customer.
 */
export async function countQualifiedReferrals(referrerUserId, productSlug, trx = db) {
  if (!referrerUserId) return 0;
  const row = await trx("referral_events")
    .where({
      referrer_user_id: referrerUserId,
      product_slug: normalizeProductSlug(productSlug),
      event_type: "purchase",
      status: "verified",
    })
    .whereRaw("metadata->>'initial_net_paid_cents' ~ '^[1-9][0-9]*$'")
    .whereRaw("coalesce(metadata->>'qualification', '') <> 'flat_referral'")
    .countDistinct({ count: "referred_user_id" })
    .first();
  return Number(row?.count || 0);
}

async function queuePurchaseRewardsForReferrer({ trx, referrer, referralCode, productSlug, qualificationRef }) {
  const eligible = await productReferralEligibility(referrer?.id, productSlug, trx);
  if (!eligible) {
    return { verifiedCount: 0, rewards: [], eligible: false };
  }

  const verifiedCount = await countQualifiedReferrals(referrer.id, productSlug, trx);

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

  return { verifiedCount, rewards, eligible: true };
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
    if (!(await hasReferralProgramEligibility(referrer.id, slug, trx))) {
      return { recorded: false, reason: "referrer_tabforge_pro_required" };
    }

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

/**
 * Verifying an email promotes that customer's already-completed purchases of
 * every product other than TabForge (recordVerifiedReferralSignup handles
 * TabForge, and its signup record) and queues whatever their referrer earned.
 */
export async function recordVerifiedReferralPurchases({ referredUserId }) {
  if (!referredUserId) return { promoted: 0, rewards: [] };
  return db.transaction(async (trx) => {
    const referredUser = await trx("users").where({ id: referredUserId }).first();
    if (!referredUser?.email_verified || !referredUser.referred_by_user_id) return { promoted: 0, rewards: [] };
    if (referredUser.referred_by_user_id === referredUser.id) return { promoted: 0, rewards: [] };
    const referrer = await trx("users").where({ id: referredUser.referred_by_user_id }).first();
    if (!referrer) return { promoted: 0, rewards: [] };
    const referralCode = referredUser.referral_code_id
      ? await trx("referral_codes").where({ id: referredUser.referral_code_id }).first()
      : await ensureReferralCodeForUser(referrer, trx);

    let promoted = 0;
    const rewards = [];
    for (const slug of MILESTONE_REFERRAL_PRODUCTS.filter((item) => item !== "tabforge")) {
      const pending = await trx("referral_events").where({
        referred_user_id: referredUser.id,
        product_slug: slug,
        event_type: "purchase",
        status: "pending",
      });
      if (!pending.length) continue;
      await trx("referral_events")
        .whereIn("id", pending.map((row) => row.id))
        .update({ status: "verified", updated_at: trx.fn.now() });
      promoted += pending.length;
      const queued = await queuePurchaseRewardsForReferrer({
        trx,
        referrer,
        referralCode,
        productSlug: slug,
        qualificationRef: pending[pending.length - 1].purchase_ref,
      });
      rewards.push(...queued.rewards);
    }
    return { promoted, rewards };
  });
}

export async function recordReferralPurchase({ referredUserId, productSlug, purchaseRef, metadata = {} }) {
  const slug = normalizeProductSlug(productSlug);
  const ref = normalizeReferralValue(purchaseRef);
  if (!referredUserId || !slug || !ref) return { recorded: false, reason: "missing_input" };
  // Only a product with a referral programme earns referral credit: TabForge
  // Pro, Rose Colored Glasses and ForgeDrop. Add-ons, pages, collections and
  // skin bundles remain normal purchases but never advance payout tiers.
  if (!isMilestoneReferralProduct(slug)) return { recorded: false, reason: "not_qualifying_product" };
  const initialNetPaidCents = Number(metadata?.initial_net_paid_cents || 0);
  if (!Number.isFinite(initialNetPaidCents) || initialNetPaidCents <= 0) {
    return { recorded: false, reason: "no_positive_initial_payment" };
  }

  return db.transaction(async (trx) => {
    const referredUser = await trx("users").where({ id: referredUserId }).first();
    if (!referredUser?.referred_by_user_id) return { recorded: false, reason: "no_referrer" };
    if (referredUser.referred_by_user_id === referredUser.id) {
      return { recorded: false, reason: "self_referral" };
    }

    const referrer = await trx("users").where({ id: referredUser.referred_by_user_id }).first();
    if (!referrer) return { recorded: false, reason: "referrer_missing" };
    if (!(await productReferralEligibility(referrer.id, slug, trx))) {
      return {
        recorded: false,
        reason: slug === "tabforge" ? "referrer_tabforge_pro_required" : "referrer_not_a_customer",
      };
    }

    const referralCode = referredUser.referral_code_id
      ? await trx("referral_codes").where({ id: referredUser.referral_code_id }).first()
      : await ensureReferralCodeForUser(referrer, trx);

    // One referral per customer per product. A second Rose Colored Glasses
    // device, or anything else the same customer buys later, adds nothing.
    const existing = await trx("referral_events")
      .where({
        referred_user_id: referredUser.id,
        product_slug: slug,
        event_type: "purchase",
      })
      .first();

    if (existing) {
      return { recorded: false, reason: "duplicate_referred_customer", event: existing };
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

export async function recordSyncSubscriptionShare({
  subscriberUserId,
  invoiceRef,
  netPaidCents,
  metadata = {},
}) {
  const ref = normalizeReferralValue(invoiceRef);
  const amountCents = syncShareCents(netPaidCents);
  if (!subscriberUserId || !ref) return { recorded: false, reason: "missing_input" };
  if (amountCents <= 0) return { recorded: false, reason: "no_positive_payment" };

  return db.transaction(async (trx) => {
    const subscriber = await trx("users").where({ id: subscriberUserId }).first();
    if (!subscriber) return { recorded: false, reason: "subscriber_missing" };

    // One level up, and no further. referred_by_user_id is read once and the
    // chain is never walked, so whoever referred the referrer earns nothing
    // from this invoice.
    const referrerId = subscriber.referred_by_user_id;
    if (!referrerId) return { recorded: false, reason: "no_referrer" };
    if (referrerId === subscriber.id) return { recorded: false, reason: "self_referral" };

    const referrer = await trx("users").where({ id: referrerId }).first();
    if (!referrer) return { recorded: false, reason: "referrer_missing" };

    // The same gate the one-off purchase uses. Someone who no longer owns Pro
    // does not keep earning from renewals.
    if (!(await hasReferralProgramEligibility(referrer.id, REFERRAL_REQUIRED_PRODUCT_SLUG, trx))) {
      return { recorded: false, reason: "referrer_tabforge_pro_required" };
    }

    const referralCode = subscriber.referral_code_id
      ? await trx("referral_codes").where({ id: subscriber.referral_code_id }).first()
      : await ensureReferralCodeForUser(referrer, trx);

    // Keyed by the invoice, so Stripe replaying a webhook cannot pay twice.
    const rewardKey = `sync_share:${ref}`;
    const [reward] = await trx("reward_queue")
      .insert({
        id: crypto.randomUUID(),
        referral_code_id: referralCode?.id || null,
        user_id: referrer.id,
        email: normalizeEmail(referrer.email),
        product_slug: SYNC_SHARE_PRODUCT_SLUG,
        reward_key: rewardKey,
        reward_amount_cents: amountCents,
        reward_type: "cashapp_manual",
        cashapp_handle: normalizeCashAppTag(referrer.cash_app_tag || referralCode?.cashapp_handle),
        status: "pending",
        metadata: {
          ...metadata,
          kind: "sync_share",
          level: 1,
          share_rate: SYNC_SHARE_RATE,
          invoice_ref: ref,
          net_paid_cents: Number(netPaidCents) || 0,
          subscriber_user_id: subscriber.id,
          subscriber_email: normalizeEmail(subscriber.email),
        },
        updated_at: trx.fn.now(),
      })
      .onConflict(["user_id", "product_slug", "reward_key"])
      .ignore()
      .returning("*");

    if (!reward) return { recorded: false, reason: "duplicate_invoice" };

    log("info", "sync_share_queued", {
      referrerUserId: referrer.id,
      subscriberUserId: subscriber.id,
      invoiceRef: ref,
      amountCents,
    });
    return { recorded: true, reward, amountCents };
  });
}

/**
 * Each product's referral standing for the account page: how many customers
 * the account brought in, whether it is paid per sale or on milestones, the
 * next milestones, and what it has earned and been paid.
 */
export async function productReferralSummary(userId, referralCode = null, trx = db) {
  const slugs = MILESTONE_REFERRAL_PRODUCTS.filter((slug) => slug !== "tabforge");
  if (!userId) return [];
  const rows = await trx("reward_queue")
    .select("product_slug", "status")
    .sum({ cents: "reward_amount_cents" })
    .count({ count: "id" })
    .where({ user_id: userId })
    .whereIn("product_slug", slugs)
    .groupBy("product_slug", "status");

  const summaries = [];
  for (const slug of slugs) {
    const program = await getReferralProgram(slug, trx);
    const referredCustomers = await countQualifiedReferrals(userId, slug, trx);
    const perSaleCents = perSaleCentsForCode(referralCode, slug);
    const tiers = perSaleCents === null
      ? tiersForVerifiedCount(program, referredCustomers).map((tier) => ({
          requiredPurchases: tier.requiredPurchases,
          rewardAmountCents: tier.rewardAmountCents,
          recurring: Boolean(tier.recurring),
          reached: referredCustomers >= tier.requiredPurchases,
          remaining: Math.max(0, tier.requiredPurchases - referredCustomers),
        }))
      : [];
    const mine = rows.filter((row) => row.product_slug === slug);
    const counted = mine.filter((row) => !["canceled", "rejected"].includes(row.status));
    summaries.push({
      productSlug: slug,
      label: PRODUCT_REFERRAL_PROGRAMS[slug].label,
      mode: perSaleCents === null ? "milestones" : "per_sale",
      perSaleCents,
      perReferralCents: PRODUCT_REFERRAL_PROGRAMS[slug].perReferralCents || null,
      referredCustomers,
      tiers,
      earnedCents: counted.reduce((sum, row) => sum + Number(row.cents || 0), 0),
      paidCents: mine
        .filter((row) => row.status === "paid")
        .reduce((sum, row) => sum + Number(row.cents || 0), 0),
    });
  }
  return summaries;
}

/**
 * A refunded, disputed or failed payment cancels a flat dollar queued for a
 * Rose Colored Glasses customer before it moved onto milestones, as long as
 * that reward has not been paid out yet.
 */
export async function cancelFlatProductReferral({
  paymentIntentId = "",
  reason = "refunded",
  providerEventId = "",
} = {}) {
  const pi = normalizeReferralValue(paymentIntentId);
  if (!pi) return { canceled: 0, reason: "missing_payment_intent" };
  const slugs = [...LEGACY_FLAT_REFERRAL_PRODUCTS];

  return db.transaction(async (trx) => {
    const rewards = await trx("reward_queue")
      .whereIn("product_slug", slugs)
      .whereIn("status", ["pending", "approved"])
      .whereRaw("metadata->>'payment_intent' = ?", [pi])
      .forUpdate();

    for (const reward of rewards) {
      await trx("reward_queue")
        .where({ id: reward.id })
        .update({
          status: "canceled",
          admin_note: "Automatically canceled because the referred purchase was refunded or disputed.",
          metadata: {
            ...(reward.metadata || {}),
            canceled_at: new Date().toISOString(),
            cancellation_reason: reason,
            provider_event_id: providerEventId || null,
          },
          updated_at: trx.fn.now(),
        });
    }

    await trx("referral_events")
      .whereIn("product_slug", slugs)
      .where({ event_type: "purchase" })
      .whereIn("status", ["pending", "verified"])
      .whereRaw("metadata->>'qualification' = 'flat_referral'")
      .whereRaw("metadata->>'payment_intent' = ?", [pi])
      .update({ status: reason, updated_at: trx.fn.now() });

    return { canceled: rewards.length };
  });
}

export async function disqualifyReferralPurchaseForStripe({
  paymentIntentId = "",
  invoiceId = "",
  chargeId = "",
  reason = "refunded",
  providerEventId = "",
} = {}) {
  const identifiers = {
    paymentIntentId: normalizeReferralValue(paymentIntentId),
    invoiceId: normalizeReferralValue(invoiceId),
    chargeId: normalizeReferralValue(chargeId),
  };
  if (!Object.values(identifiers).some(Boolean)) {
    return { updated: 0, reason: "missing_stripe_identifiers" };
  }

  return db.transaction(async (trx) => {
    const query = trx("referral_events")
      .whereIn("product_slug", MILESTONE_REFERRAL_PRODUCTS)
      .where({ event_type: "purchase" })
      .whereRaw("coalesce(metadata->>'qualification', '') <> 'flat_referral'")
      .whereIn("status", ["pending", "verified"])
      .andWhere((builder) => {
        let hasCondition = false;
        if (identifiers.paymentIntentId) {
          builder.whereRaw("metadata->>'payment_intent' = ?", [
            identifiers.paymentIntentId,
          ]);
          hasCondition = true;
        }
        if (identifiers.invoiceId) {
          const method = hasCondition ? "orWhereRaw" : "whereRaw";
          builder[method]("metadata->>'invoice_id' = ?", [
            identifiers.invoiceId,
          ]);
          hasCondition = true;
        }
        if (identifiers.chargeId) {
          const method = hasCondition ? "orWhereRaw" : "whereRaw";
          builder[method]("metadata->>'charge_id' = ?", [
            identifiers.chargeId,
          ]);
        }
      });

    const events = await query.forUpdate();
    if (!events.length) return { updated: 0, reason: "not_found" };

    const status =
      reason === "disputed"
        ? "disputed"
        : reason === "payment_failed"
          ? "payment_failed"
          : "refunded";
    for (const event of events) {
      await trx("referral_events")
        .where({ id: event.id })
        .update({
          status,
          metadata: {
            ...(event.metadata || {}),
            counts_toward_payout: false,
            disqualified_at: new Date().toISOString(),
            disqualification_reason: status,
            provider_event_id: providerEventId || null,
            stripe_charge_id:
              identifiers.chargeId ||
              event.metadata?.stripe_charge_id ||
              null,
          },
          updated_at: trx.fn.now(),
        });
    }

    // Recount each referrer on each product the refunded purchases were for,
    // and cancel any unpaid milestone the new count no longer reaches.
    const affected = new Map();
    for (const event of events) {
      if (!event.referrer_user_id) continue;
      affected.set(`${event.referrer_user_id}:${event.product_slug}`, {
        referrerId: event.referrer_user_id,
        productSlug: event.product_slug,
      });
    }
    for (const { referrerId, productSlug } of affected.values()) {
      const verifiedCount = await countQualifiedReferrals(referrerId, productSlug, trx);
      const unpaidRewards = await trx("reward_queue")
        .where({
          user_id: referrerId,
          product_slug: productSlug,
        })
        .whereRaw("coalesce(metadata->>'kind', '') <> 'flat_referral'")
        .whereIn("status", ["pending", "approved"])
        .forUpdate();
      for (const reward of unpaidRewards) {
        const explicitRequired = Number(
          reward.metadata?.tier_required_purchases || 0
        );
        const rewardKeyRequired = Number(
          String(
            reward.metadata?.tier_key || reward.reward_key || ""
          ).match(/:(\d+)$/)?.[1] || 0
        );
        const required = explicitRequired || rewardKeyRequired;
        if (required > 0 && required <= verifiedCount) continue;
        await trx("reward_queue")
          .where({ id: reward.id })
          .whereIn("status", ["pending", "approved"])
          .update({
            status: "canceled",
            admin_note:
              "Automatically canceled because a qualifying purchase was refunded or disputed.",
            metadata: {
              ...(reward.metadata || {}),
              canceled_at: new Date().toISOString(),
              cancellation_reason: status,
              verified_purchase_count_after: verifiedCount,
              provider_event_id: providerEventId || null,
            },
            updated_at: trx.fn.now(),
          });
      }
    }

    return { updated: events.length, status };
  });
}
