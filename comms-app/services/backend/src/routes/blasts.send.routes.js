import { Router } from "express";
import { db } from "../config/db.js";
import { chargeInternationalNow } from "../services/stripeUsageCharge.service.js";

// TODO: replace with your real queue enqueue
import { enqueueBlast } from "../services/queue.service.js";

export const blastsSendRouter = Router();

/**
 * POST /v1/blasts/send
 * Body: { userId, recipients: [...], body: "...", quote: { ... } }
 *
 * Simple MVP: client provides quote result; server recomputes quote later if you want.
 */
blastsSendRouter.post("/", async (req, res) => {
  const { userId, recipients, body, quote } = req.body || {};
  if (!userId || !Array.isArray(recipients) || !body) {
    return res.status(400).json({ error: "userId, recipients, body required" });
  }

  const user = await db("users").where({ id: userId }).first();
  if (!user) return res.status(404).json({ error: "user not found" });

  // Hard block if payment failed previously
  if (user.intl_blocked_reason) {
    return res.status(402).json({ error: "intl_blocked", reason: user.intl_blocked_reason });
  }

  // If the quote requires immediate charge, charge now BEFORE enqueue
  if (quote?.requiresImmediateCharge && quote?.estimatedIntlCents > 0) {
    try {
      await chargeInternationalNow({
        userId,
        amountCents: quote.estimatedIntlCents,
        description: `Intl SMS precharge (${quote.reason})`,
      });
      // IMPORTANT: do not reset since_charge here. Reset only on HARDCAP payment webhook if you want that behavior.
      // For your stated behavior, reset on "hardcap" successful payments only.
    } catch (e) {
      // Mark blocked to prevent repeated abuse
      await db("users").where({ id: userId }).update({ intl_blocked_reason: "payment_failed" });
      return res.status(402).json({ error: "payment_failed", detail: String(e?.message || e) });
    }
  }

  const blastId = await enqueueBlast({ userId, recipients, body });

  return res.json({ ok: true, blastId });
});
