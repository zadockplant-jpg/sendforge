import { Router } from "express";
import { db } from "../config/db.js";
import { verifyTwilioSignature } from "../middleware/twilioSignature.js";
import { verifySendgridSignature } from "../middleware/sendgridSignature.js";
import { addSuppression } from "../services/suppression.service.js";
import { logMessageEvent } from "../services/audit.service.js";
import { upsertThread, insertMessage } from "../services/thread.service.js";

export const webhooksRouter = Router();

/**
 * TWILIO STATUS CALLBACK
 * POST /v1/webhooks/twilio/status
 */
webhooksRouter.post(
  "/twilio/status",
  verifyTwilioSignature,
  async (req, res) => {
    const sid = String(req.body.MessageSid || req.body.SmsSid || "");
    const status = String(req.body.MessageStatus || req.body.SmsStatus || "");

    if (sid) {
      const br = await db("blast_recipients")
        .where({ provider_message_id: sid })
        .first();

      if (br) {
        await logMessageEvent({
          userId: br.user_id,
          blastId: br.blast_id,
          blastRecipientId: br.id,
          eventType: "provider_update",
          payload: { provider: "twilio", status, raw: req.body },
        });

        const normalized =
          status === "delivered"
            ? "sent"
            : status === "failed" || status === "undelivered"
            ? "failed"
            : br.status;

        if (normalized !== br.status) {
          await db("blast_recipients")
            .where({ id: br.id })
            .update({
              status: normalized,
              updated_at: db.fn.now(),
            });
        }
      }
    }

    res.json({ ok: true });
  }
);

/**
 * TWILIO INBOUND SMS (STOP / REPLIES)
 * POST /v1/webhooks/twilio/inbound
 */
webhooksRouter.post(
  "/twilio/inbound",
  verifyTwilioSignature,
  async (req, res) => {
    const from = String(req.body.From || "").trim();
    const to = String(req.body.To || "").trim();
    const bodyRaw = String(req.body.Body || "").trim();
    const bodyLower = bodyRaw.toLowerCase();

    // Find all users who own this contact
    const contactOwners = await db("contacts")
      .select("user_id")
      .where({ phone_e164: from })
      .distinct();

    // Handle STOP / UNSUBSCRIBE
    if (["stop", "unsubscribe", "cancel", "end", "quit"].includes(bodyLower)) {
      for (const o of contactOwners) {
        await addSuppression({
          userId: o.user_id,
          channel: "sms",
          destination: from,
          reason: "stop",
        });
      }
    }

    // ✅ NEW: store inbound message into threads
    if (from && bodyRaw) {
      for (const o of contactOwners) {
        const thread = await upsertThread({
          userId: o.user_id,
          channel: "sms",
          peer: from,
          title: from,
        });

        await insertMessage({
          userId: o.user_id,
          threadId: thread.id,
          direction: "inbound",
          channel: "sms",
          from,
          to,
          body: bodyRaw,
          provider: "twilio",
          providerMessageId: String(
            req.body.MessageSid || req.body.SmsSid || ""
          ),
        });
      }
    }

    res
      .type("text/xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`
      );
  }
);

/**
 * SENDGRID EVENT WEBHOOK
 * POST /v1/webhooks/sendgrid/events
 */
webhooksRouter.post(
  "/sendgrid/events",
  verifySendgridSignature,
  async (req, res) => {
    const events = Array.isArray(req.body) ? req.body : [];

    for (const ev of events) {
      const email = String(ev.email || "").trim().toLowerCase();
      const event = String(ev.event || "");
      const sgid = String(ev.sg_message_id || "");

      let br = null;

      if (sgid) {
        br = await db("blast_recipients")
          .where({ provider_message_id: sgid })
          .first();
      }

      if (!br && email) {
        br = await db("blast_recipients")
          .where({ destination: email })
          .orderBy("created_at", "desc")
          .first();
      }

      if (!br) continue;

      await logMessageEvent({
        userId: br.user_id,
        blastId: br.blast_id,
        blastRecipientId: br.id,
        eventType: "provider_update",
        payload: { provider: "sendgrid", event, raw: ev },
      });

      if (
        event === "bounce" ||
        event === "dropped" ||
        event === "spamreport"
      ) {
        await addSuppression({
          userId: br.user_id,
          channel: "email",
          destination: br.destination,
          reason: event,
        });
      }
    }

    res.json({ ok: true });
  }
);
