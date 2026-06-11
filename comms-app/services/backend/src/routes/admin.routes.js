import { Router } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import { createRateLimiter, rateLimitByIpAndBodyEmail, rateLimitByUserOrIp } from "../middleware/rateLimit.js";
import { requireAdminAuth, requireAdminWritesEnabled } from "../middleware/adminAuth.js";
import { sendAdminMfaCodeEmail } from "../services/email.service.js";
import { writeAdminAudit } from "../services/adminAudit.service.js";
import { grantProductEntitlement, revokeProductEntitlement } from "../services/entitlement.service.js";
import { cashAppTagKey, normalizeCashAppTag } from "../services/referrals/referral.service.js";
import { getRequestId, log, sanitizeEmail } from "../utils/logger.js";

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
const ReferralProgramSchema = z.object({ productSlug: z.string().min(1), requiredPurchases: z.number().int().min(1).max(1000).optional(), rewardAmountCents: z.number().int().min(0).optional(), rewardType: z.string().min(1).max(80).optional(), refundHoldDays: z.number().int().min(0).max(365).optional(), status: z.enum(["active", "inactive", "draft"]).optional(), tiers: z.array(ReferralTierSchema).max(12).optional(), metadata: z.record(z.any()).optional() });
const RewardStatusSchema = z.object({ status: z.enum(["pending", "approved", "paid", "rejected"]), adminNote: z.string().max(2000).optional().nullable(), note: z.string().max(2000).optional().nullable(), cashappHandle: z.string().max(100).optional().nullable(), payoutReference: z.string().max(200).optional().nullable() });

const loginLimiter = createRateLimiter({ name: "admin-login", windowMs: 60 * 1000, max: 5, keyGenerator: rateLimitByIpAndBodyEmail, message: "too_many_admin_login_attempts" });
const verifyLimiter = createRateLimiter({ name: "admin-mfa", windowMs: 5 * 60 * 1000, max: 8, keyGenerator: rateLimitByIpAndBodyEmail, message: "too_many_admin_mfa_attempts" });
const writeLimiter = createRateLimiter({ name: "admin-write", windowMs: 60 * 1000, max: 60, keyGenerator: rateLimitByUserOrIp, message: "too_many_admin_writes" });

function normalizeEmail(email) { return String(email || "").trim().toLowerCase(); }
function normalizeSlug(slug) { return String(slug || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""); }
function allowedAdminEmails() { return String(process.env.ADMIN_ALLOWED_EMAILS || process.env.ADMIN_EMAIL || "zadockplant@gmail.com").split(",").map(normalizeEmail).filter(Boolean); }
function isAllowedAdmin(email) { return allowedAdminEmails().includes(normalizeEmail(email)); }
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function makeReferralCode(email = "") { const base = String(email).split("@")[0].replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase() || "FORGE"; return `${base}${crypto.randomInt(1000, 9999)}`; }
function adminTokenFor(user) { return jwt.sign({ sub: user.id, email: user.email, admin: true, role: "owner" }, env.jwtSecret, { audience: "sendforge-admin", issuer: "sendforge-api" }); }

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

adminRouter.get("/me", (req, res) => res.json({ admin: { email: req.admin.email, role: req.admin.role || "owner" }, writesEnabled: String(process.env.ADMIN_WRITES_ENABLED || "true").toLowerCase() !== "false" }));

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
  const [codes, events, programs, rewards] = await Promise.all([
    db("referral_codes").orderBy("created_at", "desc").limit(250),
    db("referral_events").orderBy("created_at", "desc").limit(250),
    db("referral_programs").orderBy("product_slug", "asc"),
    db("reward_queue").orderBy("created_at", "desc").limit(250),
  ]);
  res.json({ items: events, codes, events, programs, rewards });
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
  res.json({ items: rows });
});

adminRouter.post("/referrals/programs", writeLimiter, async (req, res) => {
  const parsed = ReferralProgramSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  const p = parsed.data;
  const tiers = Array.isArray(p.tiers) && p.tiers.length
    ? p.tiers
    : [
        { requiredPurchases: p.requiredPurchases || 5, rewardAmountCents: p.rewardAmountCents ?? 1000 },
        { requiredPurchases: 15, rewardAmountCents: 2000 },
        { requiredPurchases: 50, rewardAmountCents: 7500 },
      ];
  const primaryTier = tiers[0];
  const metadata = { ...(p.metadata || {}), tiers };
  const rows = await db("referral_programs").insert({ id: crypto.randomUUID(), product_slug: normalizeSlug(p.productSlug), required_purchases: primaryTier.requiredPurchases, reward_amount_cents: primaryTier.rewardAmountCents, reward_type: p.rewardType || "cashapp_manual", refund_hold_days: p.refundHoldDays ?? 0, status: p.status || "active", metadata, updated_at: db.fn.now() }).onConflict("product_slug").merge({ required_purchases: primaryTier.requiredPurchases, reward_amount_cents: primaryTier.rewardAmountCents, reward_type: p.rewardType || "cashapp_manual", refund_hold_days: p.refundHoldDays ?? 0, status: p.status || "active", metadata, updated_at: db.fn.now() }).returning("*");
  await writeAdminAudit(req, { action: "referral_program.upsert", resourceType: "referral_program", resourceId: normalizeSlug(p.productSlug), afterValue: rows[0] });
  res.json({ item: rows[0] });
});

adminRouter.get("/rewards", async (_req, res) => {
  const rows = await db("reward_queue").orderBy("created_at", "desc").limit(500);
  res.json({ items: rows });
});

async function updateRewardStatus(req, res) {
  const parsed = RewardStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });

  const existing = await db("reward_queue").where({ id: req.params.id }).first();
  if (!existing) return res.status(404).json({ error: "reward_not_found" });

  const target = parsed.data.status;
  if (target === existing.status) {
    return res.json({ item: existing, unchanged: true });
  }

  const allowedTransitions = {
    pending: new Set(["approved", "paid", "rejected"]),
    approved: new Set(["pending", "paid", "rejected"]),
    rejected: new Set(["pending"]),
    paid: new Set(),
  };

  if (target !== existing.status && !allowedTransitions[existing.status]?.has(target)) {
    return res.status(409).json({ error: "invalid_reward_transition", from: existing.status, to: target });
  }

  const adminNote = parsed.data.adminNote ?? parsed.data.note ?? existing.admin_note;
  if (target === "rejected" && !String(adminNote || "").trim()) {
    return res.status(400).json({ error: "rejection_note_required" });
  }

  let cashAppHandle = normalizeCashAppTag(parsed.data.cashappHandle ?? existing.cashapp_handle);
  if (!cashAppHandle && existing.user_id) {
    const owner = await db("users").select("cash_app_tag").where({ id: existing.user_id }).first();
    cashAppHandle = normalizeCashAppTag(owner?.cash_app_tag);
  }

  if (target === "approved" || target === "paid") {
    if (!cashAppHandle) return res.status(409).json({ error: "cash_app_tag_required" });
    const claim = await db("cash_app_tag_claims")
      .where({ user_id: existing.user_id, normalized_tag: cashAppTagKey(cashAppHandle), status: "active" })
      .first();
    if (!claim) return res.status(409).json({ error: "cash_app_tag_not_owned_by_reward_user" });
  }

  const payoutReference = String(parsed.data.payoutReference || "").trim()
    || (target === "paid" ? `manual:${existing.id}` : "");

  const update = {
    status: target,
    admin_note: adminNote,
    cashapp_handle: cashAppHandle,
    updated_at: db.fn.now(),
  };

  if (target === "approved") {
    update.approved_by = req.admin.sub;
    update.approved_at = db.fn.now();
    update.paid_by = null;
    update.paid_at = null;
    update.payout_reference = null;
  } else if (target === "paid") {
    if (!existing.approved_at) {
      update.approved_by = req.admin.sub;
      update.approved_at = db.fn.now();
    }
    update.paid_by = req.admin.sub;
    update.paid_at = db.fn.now();
    update.payout_reference = payoutReference;
  } else if (target === "pending") {
    update.approved_by = null;
    update.approved_at = null;
    update.paid_by = null;
    update.paid_at = null;
    update.payout_reference = null;
  }

  try {
    const rows = await db("reward_queue").where({ id: existing.id }).update(update).returning("*");
    await writeAdminAudit(req, { action: `reward.${target}`, resourceType: "reward_queue", resourceId: existing.id, beforeValue: existing, afterValue: rows[0] });
    return res.json({ item: rows[0] });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ error: "payout_reference_already_used" });
    }
    log("error", "admin_reward_update_failed", {
      requestId: getRequestId(req),
      rewardId: existing.id,
      target,
      code: err?.code,
      message: String(err?.message || err),
    });
    return res.status(500).json({ error: "server_error" });
  }
}

adminRouter.patch("/rewards/:id", writeLimiter, updateRewardStatus);
adminRouter.put("/rewards/:id", writeLimiter, updateRewardStatus);

adminRouter.get("/attribution/clicks", async (_req, res) => {
  const rows = await db("attribution_clicks").orderBy("created_at", "desc").limit(500);
  res.json({ items: rows });
});
