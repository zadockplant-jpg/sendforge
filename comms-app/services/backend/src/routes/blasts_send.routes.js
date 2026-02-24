// comms-app/services/backend/src/routes/blasts.send.routes.js
import { Router } from "express";
import crypto from "crypto";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { chargeIntlNow } from "../services/stripe_charge.service.js";

export const blastsSendRouter = Router();

/**
 * POST /v1/blasts/send
 * Auth: Bearer JWT required
 * Body: {
 *   groupIds: ["..."],
 *   channels: ["sms","email"],
 *   body: "...",
 *   quote: {...}  // from /quote
 * }
 *
 * MVP behavior: returns queued counts (does not actually Twilio-send here).
 */
blastsSendRouter.post("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds.map(String) : [];
    const channels = Array.isArray(req.body?.channels) ? req.body.channels.map(String) : [];
    const body = String(req.body?.body ?? "").trim();
    const quote = req.body?.quote || null;

    if (!userId) return res.status(401).json({ error: "missing_token" });
    if (!groupIds.length) return res.status(400).json({ error: "groupIds[] required" });
    if (!channels.length) return res.status(400).json({ error: "channels[] required" });
    if (!body) return res.status(400).json({ error: "body_required" });

    const user = await db("users").where({ id: userId }).first();
    if (!user) return res.status(404).json({ error: "user_not_found" });

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

        await db("users").where({ id: userId }).update({
          intl_spend_since_charge_cents: db.raw("intl_spend_since_charge_cents + ?", [
            Number(quote.estimatedIntlCents),
          ]),
          intl_spend_cycle_cents: db.raw("intl_spend_cycle_cents + ?", [Number(quote.estimatedIntlCents)]),
        });
      } catch (e) {
        await db("users").where({ id: userId }).update({ intl_blocked_reason: "payment_failed" });
        return res.status(402).json({ error: "payment_failed", detail: String(e?.message || e) });
      }
    }

    // Resolve destinations from groups
    const wantsSms = channels.includes("sms");
    const wantsEmail = channels.includes("email");

    const rows = await db.raw(
      `
      WITH RECURSIVE descendants AS (
        SELECT g.id, g.type
        FROM groups g
        WHERE g.user_id = ? AND g.id = ANY(?)

        UNION ALL

        SELECT child.id, child.type
        FROM meta_group_links l
        JOIN groups parent ON parent.id = l.parent_group_id
        JOIN groups child ON child.id = l.child_group_id
        JOIN descendants d ON d.id = parent.id
        WHERE parent.user_id = ?
      ),
      snapshot_groups AS (
        SELECT DISTINCT id
        FROM descendants
        WHERE type = 'snapshot'
      ),
      member_contacts AS (
        SELECT DISTINCT c.id AS contact_id, c.phone_e164, c.email
        FROM group_members gm
        JOIN snapshot_groups sg ON sg.id = gm.group_id
        JOIN contacts c ON c.id = gm.contact_id
        WHERE c.user_id = ?
      )
      SELECT * FROM member_contacts
      `,
      [userId, groupIds, userId, userId],
    );

    const contacts = rows?.rows || [];
    if (!contacts.length) return res.status(400).json({ error: "no_recipients" });

    let smsQueued = 0;
    let emailQueued = 0;

    for (const c of contacts) {
      if (wantsSms && c.phone_e164) smsQueued++;
      if (wantsEmail && c.email) emailQueued++;
    }

    if (wantsSms && smsQueued === 0 && !wantsEmail) {
      return res.status(400).json({ error: "no_sms_recipients" });
    }
    if (wantsEmail && emailQueued === 0 && !wantsSms) {
      return res.status(400).json({ error: "no_email_recipients" });
    }
    if (wantsSms && wantsEmail && smsQueued === 0 && emailQueued === 0) {
      return res.status(400).json({ error: "no_recipients_with_destinations" });
    }

    const blastId = crypto.randomUUID();

    // MVP: we’re not inserting blast rows here yet (your other /v1/blasts endpoints can evolve later).
    // We return a blastId so the UI can create a thread immediately.
    return res.json({
      ok: true,
      blastId,
      queued: smsQueued + emailQueued,
      smsQueued,
      emailQueued,
    });
  } catch (e) {
    return res.status(500).json({ error: "send_failed" });
  }
});