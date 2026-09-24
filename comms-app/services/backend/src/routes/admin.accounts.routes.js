/**
 * /v1/admin/accounts - the owner's per-email view and edits.
 * Mounted behind requireAdminAuth, so only the SendForge administrator gets
 * here. Every change is written to the admin audit log.
 */

import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { createRateLimiter, rateLimitByUserOrIp } from "../middleware/rateLimit.js";
import { writeAdminAudit } from "../services/adminAudit.service.js";
import {
  inviteEmail,
  lookupAccount,
  setAccountReferral,
  setProductGift,
} from "../services/adminAccounts.service.js";
import { getRequestId, log, sanitizeEmail } from "../utils/logger.js";

export const adminAccountsRouter = Router();

const writeLimiter = createRateLimiter({
  name: "admin-accounts-write",
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: rateLimitByUserOrIp,
  message: "too_many_admin_writes",
});

const Cents = z.number().int().min(0).max(100000);
const FlatRates = z.record(Cents.nullable());

const ProductSchema = z.object({
  email: z.string().email(),
  productSlug: z.string().min(1).max(80),
  grant: z.boolean(),
  devices: z.number().int().min(1).max(1000).optional(),
  note: z.string().max(500).optional().nullable(),
});

const ReferralSchema = z.object({
  email: z.string().email(),
  code: z.string().min(3).max(40).optional(),
  affiliate: z.boolean().optional(),
  tabforgePerSaleCents: Cents.nullable().optional(),
  flatRates: FlatRates.optional(),
});

const InviteSchema = z.object({
  email: z.string().email(),
  grants: z.array(z.string().min(1).max(80)).max(10).default([]),
  rcgDevices: z.number().int().min(1).max(1000).optional(),
  affiliate: z.boolean().optional(),
  tabforgePerSaleCents: Cents.nullable().optional(),
  flatRates: FlatRates.optional(),
  note: z.string().max(500).optional().nullable(),
});

function siteLink(path) {
  return new URL(path, env.publicSiteUrl || "https://sendforge.app").toString();
}

function withSiteLinks(view) {
  if (!view || !Array.isArray(view.invites)) return view;
  return { ...view, invites: view.invites.map((invite) => ({ ...invite, url: siteLink(invite.link) })) };
}

function fail(req, res, err, action) {
  if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
  log("error", "admin_accounts_failed", {
    requestId: getRequestId(req),
    action,
    email: sanitizeEmail(req.body?.email || req.query?.email),
    message: String(err?.message || err),
  });
  return res.status(500).json({ error: "server_error" });
}

adminAccountsRouter.get("/lookup", async (req, res) => {
  try {
    return res.json(withSiteLinks(await lookupAccount(req.query.email)));
  } catch (err) {
    return fail(req, res, err, "lookup");
  }
});

adminAccountsRouter.post("/products", writeLimiter, async (req, res) => {
  const parsed = ProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  try {
    const view = await setProductGift({ ...parsed.data, adminEmail: req.admin.email });
    await writeAdminAudit(req, {
      action: parsed.data.grant ? "account.product.gift" : "account.product.take_back",
      resourceType: "user",
      resourceId: view.user?.id || parsed.data.email,
      afterValue: { email: parsed.data.email, productSlug: parsed.data.productSlug, devices: parsed.data.devices ?? null, note: parsed.data.note || null },
    });
    return res.json(view);
  } catch (err) {
    return fail(req, res, err, "product");
  }
});

adminAccountsRouter.post("/referral", writeLimiter, async (req, res) => {
  const parsed = ReferralSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  try {
    const view = await setAccountReferral(parsed.data);
    await writeAdminAudit(req, {
      action: "account.referral.update",
      resourceType: "user",
      resourceId: view.user?.id || parsed.data.email,
      afterValue: parsed.data,
    });
    return res.json(view);
  } catch (err) {
    return fail(req, res, err, "referral");
  }
});

adminAccountsRouter.post("/invite", writeLimiter, async (req, res) => {
  const parsed = InviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  try {
    const result = await inviteEmail({ ...parsed.data, createdBy: req.admin.email });
    await writeAdminAudit(req, {
      action: "account.invite.create",
      resourceType: "referral_code",
      resourceId: result.code,
      afterValue: { ...parsed.data, code: result.code },
    });
    return res.json({ ...result, url: siteLink(result.link), lookup: withSiteLinks(result.lookup) });
  } catch (err) {
    return fail(req, res, err, "invite");
  }
});
