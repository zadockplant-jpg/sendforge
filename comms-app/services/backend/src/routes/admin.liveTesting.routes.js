import { Router } from "express";
import { z } from "zod";

import { writeAdminAudit } from "../services/adminAudit.service.js";
import {
  applyLiveTestState,
  getLiveTestState,
  liveTestingConfirmation,
  liveTestingEnabledFor,
  liveTestingOwnerEmail,
  resetLiveTestState,
  setOwnerAccountEntitlement,
  stepLiveTestState,
  updateLiveTestRewardStatus,
} from "../services/adminLiveTesting.service.js";
import { getRequestId, log } from "../utils/logger.js";

export const adminLiveTestingRouter = Router();

const ConfirmSchema = z.object({
  confirm: z.string(),
});

const ApplySchema = ConfirmSchema.extend({
  invites: z.number().int().min(0).max(10000),
  verifiedAccounts: z.number().int().min(0).max(10000),
  qualifiedPurchases: z.number().int().min(0).max(10000),
  refundedPurchases: z.number().int().min(0).max(10000),
  cashAppTag: z.string().max(100).optional().nullable(),
  proEntitlement: z.boolean().optional(),
});

const StepSchema = ConfirmSchema.extend({
  action: z.enum(["invite", "verify", "purchase", "refund"]),
  quantity: z.number().int().min(-10000).max(10000).default(1),
});

const RewardSchema = ConfirmSchema.extend({
  status: z.enum(["pending", "approved", "paid", "rejected"]),
  note: z.string().max(1000).optional().nullable(),
});

const EntitlementSchema = ConfirmSchema.extend({
  productSlug: z.string().min(2).max(100),
  enabled: z.boolean().optional().default(true),
});

const ResetSchema = ConfirmSchema.extend({
  restoreCashAppTag: z.boolean().optional().default(true),
});

function requireOwner(req, res, next) {
  if (!liveTestingEnabledFor(req.admin?.email)) {
    return res.status(404).json({ error: "not_found" });
  }
  return next();
}

function confirmMatches(value) {
  return String(value || "") === liveTestingConfirmation();
}

function sendError(req, res, name, err) {
  log("error", name, {
    requestId: getRequestId(req),
    code: err?.code,
    message: String(err?.message || err),
  });
  return res.status(err?.statusCode || 500).json({
    error: err?.code || "server_error",
    message: String(err?.message || err),
  });
}

adminLiveTestingRouter.use(requireOwner);

adminLiveTestingRouter.get("/", async (req, res) => {
  try {
    const state = await getLiveTestState();
    return res.json({
      ...state,
      confirmation: liveTestingConfirmation(),
      targetEmail: liveTestingOwnerEmail(),
    });
  } catch (err) {
    return sendError(req, res, "admin_live_testing_load_failed", err);
  }
});

adminLiveTestingRouter.put("/state", async (req, res) => {
  const parsed = ApplySchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
  if (!confirmMatches(parsed.data.confirm)) return res.status(403).json({ error: "live_test_confirmation_required" });

  try {
    const before = await getLiveTestState();
    const state = await applyLiveTestState(parsed.data);
    await writeAdminAudit(req, {
      action: "testing.live_state_apply",
      resourceType: "admin_live_test_session",
      resourceId: state.session.id,
      beforeValue: before,
      afterValue: state,
      metadata: { liveAccount: true, testOnly: true, targetEmail: state.ownerEmail },
    });
    return res.json(state);
  } catch (err) {
    return sendError(req, res, "admin_live_testing_apply_failed", err);
  }
});

adminLiveTestingRouter.post("/step", async (req, res) => {
  const parsed = StepSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
  if (!confirmMatches(parsed.data.confirm)) return res.status(403).json({ error: "live_test_confirmation_required" });

  try {
    const state = await stepLiveTestState(parsed.data);
    await writeAdminAudit(req, {
      action: `testing.live_step_${parsed.data.action}`,
      resourceType: "admin_live_test_session",
      resourceId: state.session.id,
      afterValue: state,
      metadata: { liveAccount: true, testOnly: true, quantity: parsed.data.quantity },
    });
    return res.json(state);
  } catch (err) {
    return sendError(req, res, "admin_live_testing_step_failed", err);
  }
});

adminLiveTestingRouter.post("/rewards/:id/status", async (req, res) => {
  const parsed = RewardSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
  if (!confirmMatches(parsed.data.confirm)) return res.status(403).json({ error: "live_test_confirmation_required" });

  try {
    const state = await updateLiveTestRewardStatus({
      rewardId: req.params.id,
      status: parsed.data.status,
      note: parsed.data.note,
    });
    await writeAdminAudit(req, {
      action: `testing.live_reward_${parsed.data.status}`,
      resourceType: "reward_queue",
      resourceId: req.params.id,
      afterValue: state,
      metadata: { liveAccount: true, testOnly: true, noExternalPayout: true },
    });
    return res.json(state);
  } catch (err) {
    return sendError(req, res, "admin_live_testing_reward_failed", err);
  }
});

adminLiveTestingRouter.post("/entitlements", async (req, res) => {
  const parsed = EntitlementSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
  if (!confirmMatches(parsed.data.confirm)) return res.status(403).json({ error: "live_test_confirmation_required" });

  try {
    const state = await setOwnerAccountEntitlement({
      productSlug: parsed.data.productSlug,
      enabled: parsed.data.enabled,
    });
    await writeAdminAudit(req, {
      action: parsed.data.enabled ? "owner.entitlement_grant" : "owner.entitlement_revoke",
      resourceType: "product_entitlements",
      resourceId: parsed.data.productSlug,
      afterValue: state,
      metadata: {
        liveAccount: true,
        testOnly: false,
        ownerOnly: true,
        targetEmail: state.ownerEmail,
        productSlug: parsed.data.productSlug,
      },
    });
    return res.json(state);
  } catch (err) {
    return sendError(req, res, "admin_live_testing_entitlement_failed", err);
  }
});

adminLiveTestingRouter.post("/reset", async (req, res) => {
  const parsed = ResetSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
  if (!confirmMatches(parsed.data.confirm)) return res.status(403).json({ error: "live_test_confirmation_required" });

  try {
    const state = await resetLiveTestState({ restoreCashAppTag: parsed.data.restoreCashAppTag });
    await writeAdminAudit(req, {
      action: "testing.live_reset",
      resourceType: "admin_live_test_session",
      resourceId: state.session.id,
      afterValue: state,
      metadata: { liveAccount: true, testOnly: true },
    });
    return res.json(state);
  } catch (err) {
    return sendError(req, res, "admin_live_testing_reset_failed", err);
  }
});
