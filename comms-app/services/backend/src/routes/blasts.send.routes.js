import { Router } from "express";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { chargeIntlNow } from "../services/stripe_charge.service.js";
import { resolveRecipients } from "../services/recipientsResolve.service.js";

export const blastsSendRouter = Router();

/**
 * POST /v1/blasts/send
 * Auth: Bearer JWT required
 *
 * Body:
 * {
 *   groupIds: [],
 *   contactIds: [],
 *   channels: ["sms","email"],
 *   body: "...",
 *   quote: {...}
 * }
 */
blastsSendRouter.post("/", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "missing_token" });

  const { groupIds, contactIds, channels, body, quote } = req.body || {};

  const ch = Array.isArray(channels) ? channels.map(String) : ["sms"];
  const msgBody = String(body || "").trim();
  if (!msgBody) return res.status(400).json({ error: "body required" });

  const user = await db("users").where({ id: userId }).first();
  if (!user) return res.status(404).json({ error: "user not found" });

  if (user.intl_blocked_reason) {
    return res.status(402).json({ error: "intl_blocked", reason: user.intl_blocked_reason });
  }

  const resolved = await resolveRecipients({
    userId,
    groupIds,
    contactIds,
  });

  const smsRecipients = resolved.sms;
  const emailRecipients = resolved.email;

  const wantsSms = ch.includes("sms");
  const wantsEmail = ch.includes("email");

  const totalQueued =
    (wantsSms ? smsRecipients.length : 0) + (wantsEmail ? emailRecipients.length : 0);

  if (totalQueued === 0) {
    return res.status(400).json({ error: "No recipients (missing destinations for selected channels)" });
  }

  // If intl requires immediate charge, do it BEFORE sending
  if (quote?.requiresImmediateCharge === true && Number(quote?.estimatedIntlCents || 0) > 0) {
    try {
      await chargeIntlNow({
        userId,
        amountCents: Number(quote.estimatedIntlCents),
        reason: String(quote.reason || "intl"),
      });

      await db("users")
        .where({ id: userId })
        .update({
          intl_spend_since_charge_cents: db.raw("intl_spend_since_charge_cents + ?", [Number(quote.estimatedIntlCents)]),
          intl_spend_cycle_cents: db.raw("intl_spend_cycle_cents + ?", [Number(quote.estimatedIntlCents)]),
        });
    } catch (e) {
      await db("users").where({ id: userId }).update({ intl_blocked_reason: "payment_failed" });
      return res.status(402).json({ error: "payment_failed", detail: String(e?.message || e) });
    }
  }

  // MVP: mock queue (real enqueue later)
  const blastId = cryptoRandomId();

  return res.json({
    ok: true,
    blastId,
    queued: totalQueued,
    queuedSms: wantsSms ? smsRecipients.length : 0,
    queuedEmail: wantsEmail ? emailRecipients.length : 0,
  });
});

function cryptoRandomId() {
  // avoid importing crypto in case this file is executed in constrained envs
  return `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}