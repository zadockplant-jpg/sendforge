import { Router } from "express";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { chargeIntlNow } from "../services/stripe_charge.service.js";
import { requireAuth } from "../middleware/auth.js";

export const blastsSendRouter = Router();

/**
 * POST /v1/blasts/send
 * Body: { recipients: [...], body: "...", quote: {...} }
 */
blastsSendRouter.post("/", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  const { recipients, body, quote } = req.body || {};

  if (!userId) {
    return res.status(401).json({ error: "missing_token" });
  }

  if (!Array.isArray(recipients) || !body) {
    return res.status(400).json({ error: "recipients, body required" });
  }

  const user = await db("users").where({ id: userId }).first();
  if (!user) return res.status(404).json({ error: "user not found" });

  if (user.intl_blocked_reason) {
    return res
      .status(402)
      .json({ error: "intl_blocked", reason: user.intl_blocked_reason });
  }

  if (
    quote?.requiresImmediateCharge === true &&
    Number(quote?.estimatedIntlCents || 0) > 0
  ) {
    try {
      await chargeIntlNow({
        userId,
        amountCents: Number(quote.estimatedIntlCents),
        reason: String(quote.reason || "intl"),
      });

      await db("users")
        .where({ id: userId })
        .update({
          intl_spend_since_charge_cents: db.raw(
            "intl_spend_since_charge_cents + ?",
            [Number(quote.estimatedIntlCents)]
          ),
          intl_spend_cycle_cents: db.raw(
            "intl_spend_cycle_cents + ?",
            [Number(quote.estimatedIntlCents)]
          ),
        });
    } catch (e) {
      await db("users")
        .where({ id: userId })
        .update({ intl_blocked_reason: "payment_failed" });

      return res
        .status(402)
        .json({ error: "payment_failed", detail: String(e?.message || e) });
    }
  }

  return res.json({ ok: true, queued: recipients.length });
});