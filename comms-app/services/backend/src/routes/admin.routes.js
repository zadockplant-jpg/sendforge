import { Router } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { z } from "zod";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import { createRateLimiter, rateLimitByIpAndBodyEmail, rateLimitByUserOrIp } from "../middleware/rateLimit.js";
import { isSendForgeAdmin, requireAdminAuth, requireAdminWritesEnabled } from "../middleware/adminAuth.js";
import { sendAdminMfaCodeEmail } from "../services/email.service.js";
import { writeAdminAudit } from "../services/adminAudit.service.js";
import { grantProductEntitlement, revokeProductEntitlement } from "../services/entitlement.service.js";
import {
  cashAppTagKey,
  commissionPlanForReferralCode,
  ensureReferralCodeForUser,
  hasReferralProgramEligibility,
  isCloudPickupShareReward,
  normalizeCashAppTag,
  rewardPayoutEligibility,
} from "../services/referrals/referral.service.js";
import {
  PERK_ENTITLEMENT_SLUGS,
  PERK_ENTITLEMENT_SOURCE,
  batchPayoutReference,
  commissionSummary,
  groupPerkAccounts,
  perSaleCommission,
  perkEntitlementMetadata,
  programMetadataFromInput,
} from "../services/adminReferralControls.service.js";
import { adminLiveTestingRouter } from "./admin.liveTesting.routes.js";
import { adminAccountsRouter } from "./admin.accounts.routes.js";
import { listCompCodes, upsertCompCode } from "../services/compCodes.service.js";
import { liveTestingEnabledFor, liveTestingOwnerEmail } from "../services/adminLiveTesting.service.js";
import { getRequestId, log, sanitizeEmail } from "../utils/logger.js";
import { issueAdminAccessToken } from "../services/auth.service.js";

export const adminRouter = Router();

const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
const VerifySchema = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) });
const ProductSchema = z.object({
  slug: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  productLine: z.string().min(1).max(120).optional(),
  productType: z.string().min(1).max(80).optional(),
  description: z.string().max(2000).optional().nullable(),
  priceCents: z.number().int().min(0).optional(),
  currency: z.string().min(3).max(8).optional(),
  stripePriceId: z.string().max(200).optional().nullable(),
  entitlementSlug: z.string().max(200).optional().nullable(),
  status: z.enum(["draft", "active", "inactive", "archived"]).optional(),
  sortOrder: z.number().int().optional(),
  metadata: z.record(z.any()).optional(),
});
const ProductUpdateSchema = ProductSchema.omit({ slug: true }).partial();
const EntitlementSchema = z.object({ email: z.string().email(), productSlug: z.string().min(1), metadata: z.record(z.any()).optional() });
const ReferralCodeSchema = z.object({ email: z.string().email().optional().nullable(), code: z.string().min(3).max(40).optional(), cashappHandle: z.string().max(100).optional().nullable(), metadata: z.record(z.any()).optional() });
const ReferralTierSchema = z.object({ requiredPurchases: z.number().int().min(1).max(1000), rewardAmountCents: z.number().int().min(0) });
const RecurringTierSchema = z.object({ startAfterPurchases: z.number().int().min(1).max(1000), everyPurchases: z.number().int().min(1).max(1000), rewardAmountCents: z.number().int().min(1) });
const ReferralProgramSchema = z.object({ productSlug: z.string().min(1), requiredPurchases: z.number().int().min(1).max(1000).optional(), rewardAmountCents: z.number().int().min(0).optional(), rewardType: z.string().min(1).max(80).optional(), refundHoldDays: z.number().int().min(0).max(365).optional(), status: z.enum(["active", "inactive", "draft"]).optional(), tiers: z.array(ReferralTierSchema).max(12).optional(), recurringTier: RecurringTierSchema.nullable().optional(), perSaleRewardCents: z.number().int().min(1).optional(), metadata: z.record(z.any()).optional() });
const RewardBatchSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200), status: z.enum(["pending", "approved", "paid", "rejected"]), adminNote: z.string().max(2000).optional().nullable(), batchReference: z.string().max(120).optional().nullable() });
const PerkSchema = z.object({ email: z.string().email(), note: z.string().max(500).optional().nullable() });
const CompCodeSchema = z.object({ code: z.string().min(3).max(40), note: z.string().max(500).optional().nullable(), maxRedemptions: z.number().int().min(1).max(100000).optional().nullable(), perSaleRewardCents: z.number().int().min(0).max(100000).optional().nullable(), forgedropPerSaleRewardCents: z.number().int().min(0).max(100000).optional().nullable(), status: z.enum(["active", "inactive"]).optional() });
const CompCodeUpdateSchema = CompCodeSchema.omit({ code: true }).partial();
const RewardStatusSchema = z.object({ status: z.enum(["pending", "approved", "paid", "rejected"]), adminNote: z.string().max(2000).optional().nullable(), note: z.string().max(2000).optional().nullable(), cashappHandle: z.string().max(100).optional().nullable(), payoutReference: z.string().max(200).optional().nullable() });

const loginLimiter = createRateLimiter({ name: "admin-login", windowMs: 60 * 1000, max: 5, keyGenerator: rateLimitByIpAndBodyEmail, message: "too_many_admin_login_attempts" });
const verifyLimiter = createRateLimiter({ name: "admin-mfa", windowMs: 5 * 60 * 1000, max: 8, keyGenerator: rateLimitByIpAndBodyEmail, message: "too_many_admin_mfa_attempts" });
const writeLimiter = createRateLimiter({ name: "admin-write", windowMs: 60 * 1000, max: 60, keyGenerator: rateLimitByUserOrIp, message: "too_many_admin_writes" });

function normalizeEmail(email) { return String(email || "").trim().toLowerCase(); }
function normalizeSlug(slug) { return String(slug || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""); }
function referralPayoutHoldDays(productSlug, explicitValue = null) {
  const value = Number(explicitValue);
  if (Number.isInteger(value) && value >= 0 && value <= 365) return value;
  const envValue = Number(process.env.REFERRAL_PAYOUT_HOLD_DAYS || 10);
  if (Number.isInteger(envValue) && envValue >= 0 && envValue <= 365) return envValue;
  return normalizeSlug(productSlug) === "tabforge" ? 10 : 10;
}
function addDays(dateValue, days) {
  const date = dateValue ? new Date(dateValue) : new Date();
  const base = Number.isFinite(date.getTime()) ? date : new Date();
  return new Date(base.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}
function rewardMetadata(row) { return row?.metadata && typeof row.metadata === "object" ? row.metadata : {}; }
function isAdminLiveTestReward(row) { return Boolean(rewardMetadata(row).admin_live_test); }
function rewardPayoutHoldInfo(row, programMap = new Map()) {
  const meta = rewardMetadata(row);
  const program = programMap.get(normalizeSlug(row?.product_slug));
  const holdDays = Number(meta.payout_hold_days ?? program?.refund_hold_days ?? referralPayoutHoldDays(row?.product_slug));
  const readyFromMeta = meta.payout_ready_at ? new Date(meta.payout_ready_at) : null;
  const readyAt = Number.isFinite(readyFromMeta?.getTime())
    ? readyFromMeta
    : addDays(row?.created_at || new Date(), holdDays);
  const complete = isAdminLiveTestReward(row) || readyAt.getTime() <= Date.now();
  return {
    payout_hold_days: holdDays,
    payout_ready_at: readyAt.toISOString(),
    payout_hold_complete: complete,
  };
}
function enrichReward(row, programMap = new Map()) {
  return { ...row, ...rewardPayoutHoldInfo(row, programMap) };
}
function rewardRequiredPurchases(row, program = null) {
  const metadata = rewardMetadata(row);
  const explicit = Number(metadata.tier_required_purchases || 0);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;

  for (const value of [metadata.tier_key, row?.reward_key]) {
    const match = String(value || "").match(/:(\d+)$/);
    const parsed = Number(match?.[1] || 0);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }

  const fallback = Number(program?.required_purchases || 0);
  return Number.isInteger(fallback) && fallback > 0 ? fallback : 0;
}
function rewardStatusError(statusCode, error, extra = {}) {
  const err = new Error(error);
  err.statusCode = statusCode;
  err.responseBody = { error, ...extra };
  return err;
}
function isAllowedAdmin(email) { return isSendForgeAdmin(email); }
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function makeReferralCode(email = "") { const base = String(email).split("@")[0].replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase() || "FORGE"; return `${base}${crypto.randomInt(1000, 9999)}`; }
function adminTokenFor(user) { return issueAdminAccessToken({ id: user.id, email: user.email, authVersion: user.auth_version || 0 }); }

async function findUserByEmail(email) { return db("users").where({ email: normalizeEmail(email) }).first(); }
async function requireTargetUserByEmail(email) { const user = await findUserByEmail(email); if (!user) { const err = new Error("user_not_found"); err.statusCode = 404; throw err; } return user; }

adminRouter.post("/auth/login", loginLimiter, async (req, res) => {
  const requestId = getRequestId(req);
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  if (!env.jwtSecret) return res.status(500).json({ error: "server_misconfigured" });

  const email = normalizeEmail(parsed.data.email);
  if (!isAllowedAdmin(email)) return res.status(403).json({ error: "admin_not_allowed" });

  try {
    const user = await db("users").where({ email }).first();
    if (!user) return res.status(401).json({ error: "bad_credentials" });
    const ok = await bcrypt.compare(parsed.data.password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "bad_credentials" });
    if (!user.email_verified) return res.status(403).json({ error: "email_not_verified" });

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const challengeId = crypto.randomUUID();
    await db("admin_mfa_codes").insert({ id: challengeId, user_id: user.id, email, code_hash: sha256(code), purpose: "admin_login", expires_at: new Date(Date.now() + 5 * 60 * 1000), metadata: { requestId } });
    await sendAdminMfaCodeEmail({ to: process.env.ADMIN_MFA_EMAIL || email, code, requestId });
    await writeAdminAudit(req, { action: "admin.mfa_requested", resourceType: "admin_user", resourceId: user.id, afterValue: { email }, metadata: { requestId } });
    return res.json({ ok: true, challengeId, expiresInSeconds: 300 });
  } catch (err) {
    log("error", "admin_login_error", { requestId, email: sanitizeEmail(email), message: String(err?.message || err), code: err?.code });
    return res.status(500).json({ error: "server_error" });
  }
});

adminRouter.post("/auth/verify", verifyLimiter, async (req, res) => {
  const requestId = getRequestId(req);
  const parsed = VerifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });

  try {
    const row = await db("admin_mfa_codes").where({ id: parsed.data.challengeId, purpose: "admin_login" }).first();
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return res.status(401).json({ error: "invalid_or_expired_code" });
    if (Number(row.attempts || 0) >= 5) return res.status(423).json({ error: "mfa_locked" });
    if (row.code_hash !== sha256(parsed.data.code)) {
      await db("admin_mfa_codes").where({ id: row.id }).increment("attempts", 1);
      return res.status(401).json({ error: "invalid_code" });
    }

    const user = await db("users").where({ id: row.user_id }).first();
    if (!user || !isAllowedAdmin(user.email)) return res.status(403).json({ error: "admin_not_allowed" });
    await db("admin_mfa_codes").where({ id: row.id }).update({ used_at: db.fn.now(), attempts: db.raw("attempts + 1") });
    await writeAdminAudit(req, { action: "admin.login", resourceType: "admin_user", resourceId: user.id, afterValue: { email: user.email }, metadata: { requestId } });
    return res.json({ ok: true, token: adminTokenFor(user), admin: { email: user.email, role: "owner" } });
  } catch (err) {
    log("error", "admin_mfa_error", { requestId, message: String(err?.message || err), code: err?.code });
    return res.status(500).json({ error: "server_error" });
  }
});

adminRouter.use(requireAdminAuth);
adminRouter.use(requireAdminWritesEnabled);

adminRouter.get("/me", (req, res) => res.json({
  admin: { email: req.admin.email, role: req.admin.role || "owner" },
  writesEnabled: String(process.env.ADMIN_WRITES_ENABLED || "true").toLowerCase() !== "false",
  liveTesting: {
    enabled: liveTestingEnabledFor(req.admin.email),
    targetEmail: liveTestingEnabledFor(req.admin.email) ? liveTestingOwnerEmail() : null,
  },
}));

adminRouter.use("/testing/live", adminLiveTestingRouter);
adminRouter.use("/accounts", adminAccountsRouter);

adminRouter.get("/audit-log", async (req, res) => {
  const rows = await db("admin_audit_log").orderBy("created_at", "desc").limit(Math.min(Number(req.query.limit || 100), 500));
  res.json({ items: rows });
});

adminRouter.get("/products", async (_req, res) => {
  const rows = await db("admin_products").whereNull("deleted_at").orderBy([{ column: "sort_order", order: "asc" }, { column: "name", order: "asc" }]);
  res.json({ items: rows });
});

adminRouter.post("/products", writeLimiter, async (req, res) => {
  const parsed = ProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  const p = parsed.data;
  const slug = normalizeSlug(p.slug);
  const payload = { id: crypto.randomUUID(), slug, name: p.name.trim(), product_line: normalizeSlug(p.productLine || slug), product_type: p.productType || "software", description: p.description || null, price_cents: p.priceCents ?? 0, currency: (p.currency || "usd").toLowerCase(), stripe_price_id: p.stripePriceId || null, entitlement_slug: p.entitlementSlug || slug, status: p.status || "draft", sort_order: p.sortOrder ?? 1000, metadata: p.metadata || {}, updated_at: db.fn.now() };
  const rows = await db("admin_products").insert(payload).onConflict("slug").merge({ ...payload, id: db.raw("admin_products.id"), updated_at: db.fn.now(), deleted_at: null }).returning("*");
  await writeAdminAudit(req, { action: "product.upsert", resourceType: "admin_product", resourceId: slug, afterValue: rows[0] });
  res.json({ item: rows[0] });
});

adminRouter.patch("/products/:slug", writeLimiter, async (req, res) => {
  const existing = await db("admin_products").where({ slug: normalizeSlug(req.params.slug) }).whereNull("deleted_at").first();
  if (!existing) return res.status(404).json({ error: "product_not_found" });
  const parsed = ProductUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  const p = parsed.data;
  const update = { updated_at: db.fn.now() };
  if (p.name !== undefined) update.name = p.name;
  if (p.productLine !== undefined) update.product_line = normalizeSlug(p.productLine);
  if (p.productType !== undefined) update.product_type = p.productType;
  if (p.description !== undefined) update.description = p.description;
  if (p.priceCents !== undefined) update.price_cents = p.priceCents;
  if (p.currency !== undefined) update.currency = p.currency.toLowerCase();
  if (p.stripePriceId !== undefined) update.stripe_price_id = p.stripePriceId;
  if (p.entitlementSlug !== undefined) update.entitlement_slug = p.entitlementSlug;
  if (p.status !== undefined) update.status = p.status;
  if (p.sortOrder !== undefined) update.sort_order = p.sortOrder;
  if (p.metadata !== undefined) update.metadata = p.metadata;
  const rows = await db("admin_products").where({ id: existing.id }).update(update).returning("*");
  await writeAdminAudit(req, { action: "product.update", resourceType: "admin_product", resourceId: existing.slug, beforeValue: existing, afterValue: rows[0] });
  res.json({ item: rows[0] });
});

adminRouter.delete("/products/:slug", writeLimiter, async (req, res) => {
  const existing = await db("admin_products").where({ slug: normalizeSlug(req.params.slug) }).whereNull("deleted_at").first();
  if (!existing) return res.status(404).json({ error: "product_not_found" });
  const rows = await db("admin_products").where({ id: existing.id }).update({ status: "archived", deleted_at: db.fn.now(), updated_at: db.fn.now() }).returning("*");
  await writeAdminAudit(req, { action: "product.soft_delete", resourceType: "admin_product", resourceId: existing.slug, beforeValue: existing, afterValue: rows[0] });
  res.json({ item: rows[0] });
});

adminRouter.get("/users/search", async (req, res) => {
  const email = normalizeEmail(req.query.email);
  if (!email) return res.status(400).json({ error: "email_required" });
  const user = await db("users").where({ email }).first();
  if (!user) return res.status(404).json({ error: "user_not_found" });
  const entitlements = await db("product_entitlements").where({ user_id: user.id }).orderBy("created_at", "desc");
  res.json({ user: { id: user.id, email: user.email, emailVerified: Boolean(user.email_verified), stripeCustomerId: user.stripe_customer_id || null, cashAppTag: user.cash_app_tag || null, referredByUserId: user.referred_by_user_id || null, referralCodeId: user.referral_code_id || null }, entitlements });
});

adminRouter.post("/entitlements/grant", writeLimiter, async (req, res) => {
  const parsed = EntitlementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  const user = await requireTargetUserByEmail(parsed.data.email);
  const before = await db("product_entitlements").where({ user_id: user.id, product_slug: normalizeSlug(parsed.data.productSlug) }).first();
  const item = await grantProductEntitlement({ userId: user.id, productSlug: parsed.data.productSlug, source: "admin", sourceRef: req.admin.email, metadata: parsed.data.metadata || {} });
  await writeAdminAudit(req, { action: "entitlement.grant", resourceType: "product_entitlement", resourceId: item?.id || parsed.data.productSlug, beforeValue: before || null, afterValue: item });
  res.json({ item });
});

adminRouter.post("/entitlements/revoke", writeLimiter, async (req, res) => {
  const parsed = EntitlementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  const user = await requireTargetUserByEmail(parsed.data.email);
  const before = await db("product_entitlements").where({ user_id: user.id, product_slug: normalizeSlug(parsed.data.productSlug) }).first();
  const item = await revokeProductEntitlement(user.id, parsed.data.productSlug, { ...(parsed.data.metadata || {}), revoked_by: req.admin.email });
  await writeAdminAudit(req, { action: "entitlement.revoke", resourceType: "product_entitlement", resourceId: item?.id || parsed.data.productSlug, beforeValue: before || null, afterValue: item });
  res.json({ item });
});

adminRouter.get("/referrals", async (_req, res) => {
  const [codes, rawEvents, programs, rawRewards] = await Promise.all([
    db("referral_codes").orderBy("created_at", "desc").limit(500),
    db("referral_events as e")
      .leftJoin("users as referrer", "e.referrer_user_id", "referrer.id")
      .leftJoin("users as referred", "e.referred_user_id", "referred.id")
      .leftJoin("referral_codes as code", "e.referral_code_id", "code.id")
      .select(
        "e.*",
        "referrer.email as referrer_email",
        "referrer.cash_app_tag as referrer_cash_app_tag",
        "referred.email as referred_email",
        "code.code as referral_code",
        "code.email as referral_code_email",
        "code.cashapp_handle as referral_code_cashapp_handle"
      )
      .orderBy("e.created_at", "desc")
      .limit(500),
    db("referral_programs").orderBy("product_slug", "asc"),
    db("reward_queue as r")
      .leftJoin("users as owner", "r.user_id", "owner.id")
      .leftJoin("referral_codes as reward_code", "r.referral_code_id", "reward_code.id")
      .select(
        "r.*",
        "owner.email as account_email",
        "owner.cash_app_tag as account_cash_app_tag",
        "reward_code.code as referral_code",
        "reward_code.email as referral_code_email",
        "reward_code.cashapp_handle as referral_code_cashapp_handle"
      )
      .orderBy("r.created_at", "desc")
      .limit(500),
  ]);

  const programMap = new Map(programs.map((program) => [normalizeSlug(program.product_slug), program]));
  const rewards = rawRewards.map((row) => ({
    ...enrichReward(row, programMap),
    referralCode: row.referral_code || null,
    referralCodeEmail: row.referral_code_email || null,
  }));
  const events = rawEvents.map((event) => {
    const meta = rewardMetadata(event);
    return {
      ...event,
      referrerEmail: event.referrer_email || event.referral_code_email || null,
      cashAppTag: event.referrer_cash_app_tag || event.referral_code_cashapp_handle || null,
      referredEmail: event.referred_email || meta.referred_email || meta.recipient_email || null,
    };
  });

  const catalogMap = new Map();
  function ensureCatalogRow(key, seed = {}) {
    const safeKey = key || seed.referrerEmail || seed.cashAppTag || "unknown";
    if (!catalogMap.has(safeKey)) {
      catalogMap.set(safeKey, {
        referrerEmail: seed.referrerEmail || null,
        cashAppTag: seed.cashAppTag || null,
        referralCode: seed.referralCode || null,
        invites: 0,
        verifiedSignups: 0,
        qualifiedPurchases: 0,
        refundedPurchases: 0,
        pendingRewardCents: 0,
        approvedRewardCents: 0,
        paidRewardCents: 0,
        rejectedRewardCents: 0,
        lastActivityAt: null,
      });
    }
    return catalogMap.get(safeKey);
  }

  for (const event of events) {
    const key = event.referrer_user_id || event.referrerEmail || event.cashAppTag || event.referral_code_id;
    const row = ensureCatalogRow(key, {
      referrerEmail: event.referrerEmail,
      cashAppTag: event.cashAppTag,
      referralCode: event.referral_code,
    });
    row.referrerEmail ||= event.referrerEmail || null;
    row.cashAppTag ||= event.cashAppTag || null;
    row.referralCode ||= event.referral_code || null;
    if (event.event_type === "invite") row.invites += 1;
    if (event.event_type === "signup" && event.status === "verified") row.verifiedSignups += 1;
    if (event.event_type === "purchase" && event.status === "verified") row.qualifiedPurchases += 1;
    if (event.event_type === "purchase" && event.status === "refunded") row.refundedPurchases += 1;
    row.lastActivityAt = row.lastActivityAt && row.lastActivityAt > event.created_at ? row.lastActivityAt : event.created_at;
  }

  for (const reward of rewards) {
    const key = reward.user_id || reward.email || reward.cashapp_handle;
    const row = ensureCatalogRow(key, {
      referrerEmail: reward.email || reward.account_email || reward.referralCodeEmail || null,
      cashAppTag: reward.cashapp_handle || reward.account_cash_app_tag || reward.referral_code_cashapp_handle || null,
      referralCode: reward.referral_code || reward.referralCode || null,
    });
    row.referrerEmail ||= reward.email || reward.account_email || reward.referralCodeEmail || null;
    row.cashAppTag ||= reward.cashapp_handle || reward.account_cash_app_tag || reward.referral_code_cashapp_handle || null;
    row.referralCode ||= reward.referral_code || reward.referralCode || null;
    const cents = Number(reward.reward_amount_cents || 0);
    if (reward.status === "pending") row.pendingRewardCents += cents;
    if (reward.status === "approved") row.approvedRewardCents += cents;
    if (reward.status === "paid") row.paidRewardCents += cents;
    if (reward.status === "rejected") row.rejectedRewardCents += cents;
    row.lastActivityAt = row.lastActivityAt && row.lastActivityAt > reward.created_at ? row.lastActivityAt : reward.created_at;
  }

  const catalog = Array.from(catalogMap.values()).sort((a, b) => String(b.lastActivityAt || "").localeCompare(String(a.lastActivityAt || "")));
  // Which plan each referrer is on: the milestone programme unless their
  // code carries per-sale terms (a comp-code affiliate).
  const planByEmail = new Map();
  for (const codeRow of codes) {
    const plan = commissionPlanForReferralCode(codeRow);
    if (plan && codeRow.email) planByEmail.set(normalizeEmail(codeRow.email), plan);
  }
  for (const row of catalog) row.plan = planByEmail.get(normalizeEmail(row.referrerEmail)) || { mode: "milestones" };
  res.json({ items: events, codes, events, programs, rewards, catalog });
});

adminRouter.get("/referrals/codes", async (_req, res) => {
  const rows = await db("referral_codes").orderBy("created_at", "desc").limit(500);
  res.json({ items: rows });
});

adminRouter.post("/referrals/codes", writeLimiter, async (req, res) => {
  const parsed = ReferralCodeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  const email = parsed.data.email ? normalizeEmail(parsed.data.email) : null;
  const user = email ? await findUserByEmail(email) : null;
  const code = normalizeSlug(parsed.data.code || makeReferralCode(email || "creator")).toUpperCase();
  const rows = await db("referral_codes").insert({ id: crypto.randomUUID(), user_id: user?.id || null, email, code, cashapp_handle: parsed.data.cashappHandle || null, metadata: parsed.data.metadata || {}, updated_at: db.fn.now() }).onConflict("code").merge({ user_id: user?.id || null, email, cashapp_handle: parsed.data.cashappHandle || null, metadata: parsed.data.metadata || {}, status: "active", updated_at: db.fn.now() }).returning("*");
  await writeAdminAudit(req, { action: "referral_code.upsert", resourceType: "referral_code", resourceId: code, afterValue: rows[0] });
  res.json({ item: rows[0] });
});

adminRouter.get("/referrals/programs", async (_req, res) => {
  const rows = await db("referral_programs").orderBy("product_slug", "asc");
  res.json({ items: rows.map((row) => ({ ...row, commission: commissionSummary(row) })) });
});

adminRouter.post("/referrals/programs", writeLimiter, async (req, res) => {
  const parsed = ReferralProgramSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  const p = parsed.data;
  // "$X per sale" is one intent that becomes a first-purchase milestone plus
  // the same amount on every purchase after it; explicit tiers and an
  // optional recurring rule cover the milestone programme.
  const perSale = p.perSaleRewardCents ? perSaleCommission(p.perSaleRewardCents) : null;
  const tiers = perSale
    ? perSale.tiers
    : Array.isArray(p.tiers) && p.tiers.length
      ? p.tiers
      : [
          { requiredPurchases: p.requiredPurchases || 5, rewardAmountCents: p.rewardAmountCents ?? 1700 },
          { requiredPurchases: 15, rewardAmountCents: 3500 },
          { requiredPurchases: 25, rewardAmountCents: 4000 },
          { requiredPurchases: 50, rewardAmountCents: 15000 },
        ];
  const recurringTier = perSale ? perSale.recurringTier : p.recurringTier;
  const primaryTier = tiers[0];
  const holdDays = referralPayoutHoldDays(p.productSlug, p.refundHoldDays);
  const existingProgram = await db("referral_programs").where({ product_slug: normalizeSlug(p.productSlug) }).first();
  const metadata = programMetadataFromInput({
    existingMetadata: existingProgram?.metadata,
    tiers,
    recurringTier,
    holdDays,
    qualification: (p.metadata || {}).qualification,
    extra: p.metadata || {},
  });
  const rows = await db("referral_programs").insert({ id: crypto.randomUUID(), product_slug: normalizeSlug(p.productSlug), required_purchases: primaryTier.requiredPurchases, reward_amount_cents: primaryTier.rewardAmountCents, reward_type: p.rewardType || "cashapp_manual", refund_hold_days: holdDays, status: p.status || "active", metadata, updated_at: db.fn.now() }).onConflict("product_slug").merge({ required_purchases: primaryTier.requiredPurchases, reward_amount_cents: primaryTier.rewardAmountCents, reward_type: p.rewardType || "cashapp_manual", refund_hold_days: holdDays, status: p.status || "active", metadata, updated_at: db.fn.now() }).returning("*");
  await writeAdminAudit(req, { action: "referral_program.upsert", resourceType: "referral_program", resourceId: normalizeSlug(p.productSlug), beforeValue: existingProgram || null, afterValue: rows[0] });
  res.json({ item: rows[0], commission: commissionSummary(rows[0]) });
});

adminRouter.get("/rewards", async (_req, res) => {
  const [rows, programs] = await Promise.all([
    db("reward_queue as r")
      .leftJoin("users as owner", "r.user_id", "owner.id")
      .leftJoin("referral_codes as reward_code", "r.referral_code_id", "reward_code.id")
      .select(
        "r.*",
        "owner.email as account_email",
        "owner.cash_app_tag as account_cash_app_tag",
        "reward_code.code as referral_code",
        "reward_code.email as referral_code_email",
        "reward_code.cashapp_handle as referral_code_cashapp_handle"
      )
      .orderBy("r.created_at", "desc")
      .limit(500),
    db("referral_programs"),
  ]);
  const programMap = new Map(programs.map((program) => [normalizeSlug(program.product_slug), program]));
  res.json({ items: rows.map((row) => enrichReward(row, programMap)) });
});

// The status change itself, shared by the single-row route and the batch
// route. It throws rewardStatusError for every rule it enforces, so both
// callers report the same codes.
async function applyRewardStatusChange(req, rewardId, data) {
  const target = data.status;
  const allowedTransitions = {
    pending: new Set(["approved", "paid", "rejected"]),
    approved: new Set(["pending", "paid", "rejected"]),
    rejected: new Set(["pending"]),
    paid: new Set(),
  };

  return db.transaction(async (trx) => {
      // Read enough identity to lock qualifying purchase rows before the reward
      // row. Refund/dispute handling uses the same event-then-reward order.
      const snapshot = await trx("reward_queue")
        .where({ id: rewardId })
        .first();
      if (!snapshot) {
        throw rewardStatusError(404, "reward_not_found");
      }
      if (snapshot.metadata?.admin_live_test === true) {
        throw rewardStatusError(409, "use_live_test_lab_for_test_reward");
      }

      let verifiedPurchases = [];
      if (target === "approved" || target === "paid") {
        verifiedPurchases = await trx("referral_events")
          .select("referred_user_id")
          .where({
            referrer_user_id: snapshot.user_id,
            product_slug: snapshot.product_slug,
            event_type: "purchase",
            status: "verified",
          })
          .whereRaw(
            "metadata->>'initial_net_paid_cents' ~ '^[1-9][0-9]*$'"
          )
          .forUpdate();
      }

      const existing = await trx("reward_queue")
        .where({ id: snapshot.id })
        .forUpdate()
        .first();
      if (!existing) {
        throw rewardStatusError(404, "reward_not_found");
      }
      if (existing.metadata?.admin_live_test === true) {
        throw rewardStatusError(409, "use_live_test_lab_for_test_reward");
      }
      if (target === existing.status) {
        return { item: existing, unchanged: true };
      }
      if (!allowedTransitions[existing.status]?.has(target)) {
        throw rewardStatusError(409, "invalid_reward_transition", {
          from: existing.status,
          to: target,
        });
      }

      const adminNote =
        data.adminNote ??
        data.note ??
        existing.admin_note;
      if (target === "rejected" && !String(adminNote || "").trim()) {
        throw rewardStatusError(400, "rejection_note_required");
      }

      let cashAppHandle = normalizeCashAppTag(
        data.cashappHandle ?? existing.cashapp_handle
      );
      if (!cashAppHandle && existing.user_id) {
        const owner = await trx("users")
          .select("cash_app_tag")
          .where({ id: existing.user_id })
          .first();
        cashAppHandle = normalizeCashAppTag(owner?.cash_app_tag);
      }

      if (target === "approved" || target === "paid") {
        if (
          !(await rewardPayoutEligibility(
            existing.user_id,
            existing.product_slug,
            trx
          ))
        ) {
          throw rewardStatusError(
            409,
            "referrer_tabforge_pro_required"
          );
        }
        if (!cashAppHandle) {
          throw rewardStatusError(409, "cash_app_tag_required");
        }
        const claim = await trx("cash_app_tag_claims")
          .where({
            user_id: existing.user_id,
            normalized_tag: cashAppTagKey(cashAppHandle),
            status: "active",
          })
          .first();
        if (!claim) {
          throw rewardStatusError(
            409,
            "cash_app_tag_not_owned_by_reward_user"
          );
        }

        const program = await trx("referral_programs")
          .where({ product_slug: existing.product_slug })
          .first();
        const holdInfo = rewardPayoutHoldInfo(
          existing,
          new Map([[normalizeSlug(existing.product_slug), program]])
        );
        if (!holdInfo.payout_hold_complete) {
          throw rewardStatusError(409, "payout_hold_not_complete", {
            message: `Payout is still in the ${holdInfo.payout_hold_days}-day verification window.`,
            payoutReadyAt: holdInfo.payout_ready_at,
            payoutHoldDays: holdInfo.payout_hold_days,
          });
        }

        const verifiedCount = new Set(
          verifiedPurchases
            .map((row) => row.referred_user_id)
            .filter(Boolean)
        ).size;
        const requiredPurchases = rewardRequiredPurchases(
          existing,
          program
        );
        // A Cloud pickup share was earned by one paid invoice, not by a count
        // of referred customers; the payout gate above is its qualification.
        if (
          !isCloudPickupShareReward(existing) &&
          (!requiredPurchases || verifiedCount < requiredPurchases)
        ) {
          throw rewardStatusError(
            409,
            "referral_qualification_no_longer_met",
            { verifiedCount, requiredPurchases }
          );
        }
      }

      const payoutReference =
        String(data.payoutReference || "").trim() ||
        (target === "paid" ? `manual:${existing.id}` : "");
      const update = {
        status: target,
        admin_note: adminNote,
        cashapp_handle: cashAppHandle,
        updated_at: trx.fn.now(),
      };

      if (target === "approved") {
        update.approved_by = req.admin.sub;
        update.approved_at = trx.fn.now();
        update.paid_by = null;
        update.paid_at = null;
        update.payout_reference = null;
      } else if (target === "paid") {
        if (!existing.approved_at) {
          update.approved_by = req.admin.sub;
          update.approved_at = trx.fn.now();
        }
        update.paid_by = req.admin.sub;
        update.paid_at = trx.fn.now();
        update.payout_reference = payoutReference;
      } else if (target === "pending") {
        update.approved_by = null;
        update.approved_at = null;
        update.paid_by = null;
        update.paid_at = null;
        update.payout_reference = null;
      }

      const rows = await trx("reward_queue")
        .where({ id: existing.id })
        .update(update)
        .returning("*");
      await writeAdminAudit(
        req,
        {
          action: `reward.${target}`,
          resourceType: "reward_queue",
          resourceId: existing.id,
          beforeValue: existing,
          afterValue: rows[0],
        },
        trx
      );
      return { item: rows[0] };
  });
}

function rewardStatusErrorPayload(err) {
  if (err?.statusCode && err?.responseBody) return { statusCode: err.statusCode, body: err.responseBody };
  if (err?.code === "23505") return { statusCode: 409, body: { error: "payout_reference_already_used" } };
  return null;
}

async function updateRewardStatus(req, res) {
  const parsed = RewardStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  try {
    return res.json(await applyRewardStatusChange(req, req.params.id, parsed.data));
  } catch (err) {
    const known = rewardStatusErrorPayload(err);
    if (known) return res.status(known.statusCode).json(known.body);
    log("error", "admin_reward_update_failed", {
      requestId: getRequestId(req),
      rewardId: req.params.id,
      target: parsed.data.status,
      code: err?.code,
      message: String(err?.message || err),
    });
    return res.status(500).json({ error: "server_error" });
  }
}



adminRouter.patch("/rewards/:id", writeLimiter, updateRewardStatus);
adminRouter.put("/rewards/:id", writeLimiter, updateRewardStatus);

// One Cash App run, one call: mark a batch of payouts paid (or approve or
// reject several) without clicking through rows. Each reward is applied on
// its own so one failure never blocks the rest, and the response names
// which ids changed and which did not, with the single-row error codes.
adminRouter.post("/rewards/batch", writeLimiter, async (req, res) => {
  const parsed = RewardBatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  const { ids, status, adminNote, batchReference } = parsed.data;
  const results = [];
  for (const id of [...new Set(ids)]) {
    try {
      const result = await applyRewardStatusChange(req, id, {
        status,
        adminNote: adminNote ?? undefined,
        payoutReference: status === "paid" ? batchPayoutReference(batchReference, id) : undefined,
      });
      results.push({ id, ok: true, unchanged: Boolean(result.unchanged), item: result.item });
    } catch (err) {
      const known = rewardStatusErrorPayload(err);
      if (!known) {
        log("error", "admin_reward_batch_item_failed", { requestId: getRequestId(req), rewardId: id, target: status, code: err?.code, message: String(err?.message || err) });
      }
      results.push({ id, ok: false, error: known?.body?.error || "server_error", detail: known?.body || null });
    }
  }
  const changed = results.filter((row) => row.ok && !row.unchanged).map((row) => row.id);
  const failed = results.filter((row) => !row.ok).map((row) => row.id);
  await writeAdminAudit(req, { action: `reward.batch.${status}`, resourceType: "reward_queue", resourceId: batchReference || null, afterValue: { ids, changed, failed }, metadata: { batchReference: batchReference || null } });
  res.json({ status, batchReference: batchReference || null, changed: changed.length, failed: failed.length, results });
});

// Perk accounts: TabForge Pro and Private Sync without a purchase. They are
// ordinary entitlements with a perk marker, so referral eligibility, sync
// access and the account page all see a normal owner. The person must have
// created a SendForge account first; the grant is by email.
adminRouter.get("/perks", async (_req, res) => {
  const rows = await db("product_entitlements as e")
    .leftJoin("users as u", "e.user_id", "u.id")
    .select("e.*", "u.email as email")
    .where((builder) => {
      builder.where("e.source", PERK_ENTITLEMENT_SOURCE).orWhereRaw("e.metadata->>'perk' = 'true'");
    })
    .orderBy("e.granted_at", "desc")
    .limit(2000);
  const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
  const codes = userIds.length
    ? await db("referral_codes").whereIn("user_id", userIds).where({ status: "active" }).orderBy("created_at", "asc")
    : [];
  const codeByUser = new Map();
  for (const code of codes) if (!codeByUser.has(code.user_id)) codeByUser.set(code.user_id, code.code);
  res.json({ items: groupPerkAccounts(rows.map((row) => ({ ...row, referral_code: codeByUser.get(row.user_id) || null }))) });
});

adminRouter.post("/perks/grant", writeLimiter, async (req, res) => {
  const parsed = PerkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  try {
    const user = await requireTargetUserByEmail(parsed.data.email);
    const metadata = perkEntitlementMetadata({ adminEmail: req.admin.email, note: parsed.data.note });
    const items = [];
    for (const slug of PERK_ENTITLEMENT_SLUGS) {
      items.push(await grantProductEntitlement({ userId: user.id, productSlug: slug, source: PERK_ENTITLEMENT_SOURCE, sourceRef: req.admin.email, metadata }));
    }
    const referralCode = await ensureReferralCodeForUser(user);
    await writeAdminAudit(req, { action: "perk.grant", resourceType: "user", resourceId: user.id, afterValue: { email: user.email, products: [...PERK_ENTITLEMENT_SLUGS], note: metadata.note } });
    return res.json({
      account: {
        userId: user.id,
        email: user.email,
        products: items.map((item) => item?.product_slug).filter(Boolean),
        referralCode: referralCode?.code || null,
        note: metadata.note,
        grantedBy: metadata.granted_by,
        grantedAt: metadata.granted_at,
        active: true,
      },
    });
  } catch (err) {
    if (err?.statusCode === 404) return res.status(404).json({ error: "user_not_found", message: "No SendForge account uses that email yet. Have them create one first." });
    log("error", "admin_perk_grant_failed", { requestId: getRequestId(req), email: sanitizeEmail(parsed.data.email), message: String(err?.message || err) });
    return res.status(500).json({ error: "server_error" });
  }
});

// Comp codes: a code that gives Pro and Private Sync at signup or from the
// account page. Listed with redemption counts and the signup link to put in
// an ad; paused by setting status inactive.
adminRouter.get("/comp-codes", async (_req, res) => {
  res.json({ items: await listCompCodes() });
});

async function saveCompCode(req, res, input) {
  try {
    const row = await upsertCompCode({ ...input, createdBy: req.admin.email });
    await writeAdminAudit(req, { action: "comp_code.upsert", resourceType: "referral_code", resourceId: row.code, afterValue: row });
    const items = await listCompCodes();
    return res.json({ item: items.find((item) => item.code === row.code) || row });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    log("error", "admin_comp_code_save_failed", { requestId: getRequestId(req), message: String(err?.message || err) });
    return res.status(500).json({ error: "server_error" });
  }
}

adminRouter.post("/comp-codes", writeLimiter, async (req, res) => {
  const parsed = CompCodeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  return saveCompCode(req, res, parsed.data);
});

adminRouter.patch("/comp-codes/:code", writeLimiter, async (req, res) => {
  const parsed = CompCodeUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  return saveCompCode(req, res, { ...parsed.data, code: req.params.code });
});

adminRouter.post("/perks/revoke", writeLimiter, async (req, res) => {
  const parsed = PerkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  try {
    const user = await requireTargetUserByEmail(parsed.data.email);
    const metadata = { perk: true, revoked_by: req.admin.email, revoked_at: new Date().toISOString(), note: String(parsed.data.note || "").trim() || null };
    const items = [];
    for (const slug of PERK_ENTITLEMENT_SLUGS) {
      const existing = await db("product_entitlements").where({ user_id: user.id, product_slug: slug }).first();
      if (existing && (existing.source === PERK_ENTITLEMENT_SOURCE || existing.metadata?.perk === true)) {
        items.push(await revokeProductEntitlement(user.id, slug, metadata));
      }
    }
    await writeAdminAudit(req, { action: "perk.revoke", resourceType: "user", resourceId: user.id, afterValue: { email: user.email, products: items.map((item) => item?.product_slug).filter(Boolean), note: metadata.note } });
    return res.json({ account: { userId: user.id, email: user.email, products: items.map((item) => item?.product_slug).filter(Boolean), active: false } });
  } catch (err) {
    if (err?.statusCode === 404) return res.status(404).json({ error: "user_not_found" });
    log("error", "admin_perk_revoke_failed", { requestId: getRequestId(req), email: sanitizeEmail(parsed.data.email), message: String(err?.message || err) });
    return res.status(500).json({ error: "server_error" });
  }
});

adminRouter.get("/attribution/clicks", async (_req, res) => {
  const rows = await db("attribution_clicks").orderBy("created_at", "desc").limit(500);
  res.json({ items: rows });
});
