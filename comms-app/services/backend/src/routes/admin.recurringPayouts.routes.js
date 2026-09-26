/**
 * /v1/admin/recurring-payouts - the owner's monthly affiliate payouts for the
 * subscription shares (TabForge Private Sync, ForgeDrop Cloud pickup):
 * programme rates and switches, per-affiliate rates, the minimum payout and
 * payout day, monthly statements to approve, pay and reject, and what the
 * live subscriptions will pay each month.
 *
 * Mounted behind requireAdminAuth and requireAdminWritesEnabled in
 * admin.routes.js, so only the SendForge administrator gets here and writes
 * stop when admin writes are switched off. Every change is written to the
 * admin audit log in the same transaction as the change, so a change that
 * cannot be audited does not happen.
 *
 * admin.routes.js hands in its own reward status change (the rules behind
 * PATCH /rewards/:id) and its review-period check, so a statement's invoices
 * are approved, paid and rejected by exactly the rules a single reward is.
 */

import { Router } from "express";
import { z } from "zod";
import { db } from "../config/db.js";
import { writeAdminAudit } from "../services/adminAudit.service.js";
import {
  MAX_MINIMUM_PAYOUT_CENTS,
  MAX_SHARE_RATE_BPS,
  STATEMENT_STATUSES,
  affiliateRates,
  approveStatement,
  clearShareOverride,
  findAffiliate,
  listShareOverrides,
  listStatements,
  loadShareSettings,
  payStatement,
  recurringOverview,
  rejectStatement,
  setShareOverride,
  shareProgram,
  updatePayoutSettings,
  updateProgramShare,
} from "../services/referrals/recurringPayouts.service.js";
import { getRequestId, log } from "../utils/logger.js";

const RateBps = z.number().int().min(0).max(MAX_SHARE_RATE_BPS);
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const ProgramSchema = z
  .object({ rateBps: RateBps.optional(), enabled: z.boolean().optional() })
  .refine((body) => body.rateBps !== undefined || body.enabled !== undefined);
const PayoutSettingsSchema = z
  .object({
    minimumPayoutCents: z.number().int().min(0).max(MAX_MINIMUM_PAYOUT_CENTS).optional(),
    payoutDay: z.number().int().min(1).max(28).optional(),
  })
  .refine((body) => body.minimumPayoutCents !== undefined || body.payoutDay !== undefined);
const OverrideSchema = z.object({
  userId: z.string().uuid(),
  programSlug: z.string().min(1).max(80),
  rateBps: RateBps,
  note: z.string().max(500).optional().nullable(),
});
const StatementParams = z.object({ month: Month, userId: z.string().uuid() });
const ListQuery = z.object({
  month: Month.optional(),
  status: z.enum(STATEMENT_STATUSES).optional(),
});
const PaySchema = z.object({ payoutReference: z.string().trim().min(1).max(120) });
const RejectSchema = z.object({ note: z.string().trim().min(1).max(2000) });

export function createAdminRecurringPayoutsRouter({
  applyRewardStatusChange,
  rewardStatusErrorPayload,
  holdInfoWith,
  writeLimiter = (_req, _res, next) => next(),
} = {}) {
  if (typeof applyRewardStatusChange !== "function" || typeof rewardStatusErrorPayload !== "function" || typeof holdInfoWith !== "function") {
    throw new Error("the recurring payouts router needs the reward status rules");
  }
  const router = Router();

  function fail(req, res, err, action) {
    if (err?.statusCode && err?.responseBody) return res.status(err.statusCode).json(err.responseBody);
    const known = rewardStatusErrorPayload(err);
    if (known) return res.status(known.statusCode).json(known.body);
    log("error", "admin_recurring_payouts_failed", {
      requestId: getRequestId(req),
      action,
      code: err?.code,
      message: String(err?.message || err),
    });
    return res.status(500).json({ error: "server_error" });
  }

  // Express 4 does not catch a rejected promise from a handler.
  const handle = (action, fn) => async (req, res) => {
    try {
      return await fn(req, res);
    } catch (err) {
      return fail(req, res, err, action);
    }
  };

  const adminId = (req) => req.admin?.sub || null;

  router.get("/settings", handle("settings", async (_req, res) => {
    const settings = await loadShareSettings();
    res.json({ ...settings, overrides: await listShareOverrides() });
  }));

  router.patch("/programs/:slug", writeLimiter, handle("program", async (req, res) => {
    const parsed = ProgramSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    if (!shareProgram(req.params.slug)) return res.status(404).json({ error: "unknown_share_program" });
    const result = await db.transaction(async (trx) => {
      const change = await updateProgramShare(trx, req.params.slug, parsed.data, adminId(req));
      if (change.changed) {
        await writeAdminAudit(req, {
          action: "recurring_payout.program.update",
          resourceType: "subscription_share_program",
          resourceId: shareProgram(req.params.slug).slug,
          beforeValue: change.before,
          afterValue: change.after,
        }, trx);
      }
      return change;
    });
    res.json({ changed: result.changed, ...(await loadShareSettings()) });
  }));

  router.put("/payout-settings", writeLimiter, handle("payout_settings", async (req, res) => {
    const parsed = PayoutSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    const result = await db.transaction(async (trx) => {
      const change = await updatePayoutSettings(trx, parsed.data, adminId(req));
      if (change.changed) {
        await writeAdminAudit(req, {
          action: "recurring_payout.settings.update",
          resourceType: "affiliate_payout_settings",
          resourceId: "default",
          beforeValue: change.before,
          afterValue: change.after,
        }, trx);
      }
      return change;
    });
    res.json({ changed: result.changed, ...(await loadShareSettings()) });
  }));

  router.get("/affiliates/find", handle("find_affiliate", async (req, res) => {
    const query = String(req.query.q || "").trim().slice(0, 320);
    if (!query) return res.status(400).json({ error: "query_required" });
    res.json(await findAffiliate(query));
  }));

  router.put("/overrides", writeLimiter, handle("set_override", async (req, res) => {
    const parsed = OverrideSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    const result = await db.transaction(async (trx) => {
      const change = await setShareOverride(trx, parsed.data, adminId(req));
      if (change.changed) {
        await writeAdminAudit(req, {
          action: "recurring_payout.override.set",
          resourceType: "subscription_share_override",
          resourceId: `${parsed.data.userId}:${change.after.program_slug}`,
          beforeValue: change.before,
          afterValue: change.after,
        }, trx);
      }
      return change;
    });
    res.json({ changed: result.changed, ...(await affiliateRates(parsed.data.userId)), overrides: await listShareOverrides() });
  }));

  router.delete("/overrides/:userId/:programSlug", writeLimiter, handle("clear_override", async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.userId).success) return res.status(400).json({ error: "invalid_input" });
    const result = await db.transaction(async (trx) => {
      const change = await clearShareOverride(trx, req.params);
      if (change.changed) {
        await writeAdminAudit(req, {
          action: "recurring_payout.override.clear",
          resourceType: "subscription_share_override",
          resourceId: `${req.params.userId}:${change.before.program_slug}`,
          beforeValue: change.before,
          afterValue: null,
        }, trx);
      }
      return change;
    });
    res.json({ changed: result.changed, ...(await affiliateRates(req.params.userId)), overrides: await listShareOverrides() });
  }));

  router.get("/statements", handle("list_statements", async (req, res) => {
    const parsed = ListQuery.safeParse({
      month: req.query.month ? String(req.query.month) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
    });
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    res.json(await listStatements({ ...parsed.data, holdInfoWith }));
  }));

  // One statement action: the change and its audit row in one transaction,
  // then the statement as it now stands.
  function statementAction(kind, schema, run) {
    return handle(`statement_${kind}`, async (req, res) => {
      const params = StatementParams.safeParse(req.params);
      if (!params.success) return res.status(400).json({ error: "invalid_input" });
      const body = schema ? schema.safeParse(req.body || {}) : { success: true, data: {} };
      if (!body.success) {
        const missing = kind === "paid" ? "payout_reference_required" : kind === "rejected" ? "rejection_note_required" : "invalid_input";
        return res.status(400).json({ error: missing });
      }
      const { month, userId } = params.data;
      const result = await db.transaction(async (trx) => {
        const ctx = { req, trx, now: new Date(), applyRewardStatusChange, rewardStatusErrorPayload, holdInfoWith };
        const outcome = await run(ctx, { month, userId, ...body.data });
        const { before, ...after } = outcome;
        await writeAdminAudit(req, {
          action: `recurring_payout.statement.${kind}`,
          resourceType: "affiliate_payout_statement",
          resourceId: outcome.record.id,
          beforeValue: {
            status: before.status,
            owedCents: before.owedCents,
            payableCents: before.payableCents,
            invoiceCount: before.invoiceCount,
            record: before.record,
          },
          afterValue: after,
          metadata: { month, userId, payoutReference: outcome.record.payout_reference || null },
        }, trx);
        return after;
      });
      const current = await listStatements({ userId, month, holdInfoWith });
      res.json({ ...result, statement: current.statements[0] || null });
    });
  }

  router.post("/statements/:month/:userId/approve", writeLimiter, statementAction("approved", null, approveStatement));
  router.post("/statements/:month/:userId/pay", writeLimiter, statementAction("paid", PaySchema, payStatement));
  router.post("/statements/:month/:userId/reject", writeLimiter, statementAction("rejected", RejectSchema, rejectStatement));

  router.get("/overview", handle("overview", async (_req, res) => {
    res.json(await recurringOverview());
  }));

  return router;
}
