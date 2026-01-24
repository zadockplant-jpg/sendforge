// services/backend/src/routes/blasts_send.routes.js
import { Router } from "express";
import { db } from "../config/db.js";
import { chargeIntlNow } from "../services/stripe_charge.service.js";

export const blastsSendRouter = Router();

/**
 * POST /v1/blasts/send
 * Body: { userId, recipients: [...], body: "...", quote: {...} }
 */
if (process.env.DISABLE_TWILIO === "true") {
  console.log("[TWILIO DISABLED] Pretending messages were sent");

  return {
    queued: recipients.length,
    provider: "mock",
  };
}
blastsSendRouter.post("/", async (req, res) => {
  const { userId, recipients, body, quote } = req.body || {};
  if (!userId || !Array.isArray(recipients) || !body) {
    return res.status(400).json({ error: "userId, recipients, body required" });
  }

  const user = await db("users").where({ id: userId }).first();
  if (!user) return res.status(404).json({ error: "user not found" });

  if (user.intl_blocked_reason) {
    return res.status(402).json({ error: "intl_blocked", reason: user.intl_blocked_reason });
  }

  // If intl requires immediate charge, do it BEFORE sending
  if (quote?.requiresImmediateCharge === true && Number(quote?.estimatedIntlCents || 0) > 0) {
    try {
      await chargeIntlNow({
        userId,
        amountCents: Number(quote.estimatedIntlCents),
        reason: String(quote.reason || "intl"),
      });

      // Track spend (since-charge accumulates until a “hardcap” payment succeeds & you reset)
      await db("users").where({ id: userId }).update({
        intl_spend_since_charge_cents: db.raw("intl_spend_since_charge_cents + ?", [Number(quote.estimatedIntlCents)]),
        intl_spend_cycle_cents: db.raw("intl_spend_cycle_cents + ?", [Number(quote.estimatedIntlCents)]),
      });
    } catch (e) {
      await db("users").where({ id: userId }).update({ intl_blocked_reason: "payment_failed" });
      return res.status(402).json({ error: "payment_failed", detail: String(e?.message || e) });
    }
  }

  // TODO: enqueue your blast send here (existing queue logic)
  // For MVP:
  return res.json({ ok: true, queued: recipients.length });
});
