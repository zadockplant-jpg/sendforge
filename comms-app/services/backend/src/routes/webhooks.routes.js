import { Router } from "express";
import { db } from "../config/db.js";
import { verifyTwilioSignature } from "../middleware/twilioSignature.js";
import { verifySendgridSignature } from "../middleware/sendgridSignature.js";
import {
  addReferralDestinationSuppression,
  addSuppression,
} from "../services/suppression.service.js";
import { logMessageEvent } from "../services/audit.service.js";
import { upsertThread, insertMessage } from "../services/thread.service.js";
import {
  applyReferralInviteSendgridEvent,
  isUuidValue,
  sendgridCustomArg,
} from "../services/emailDelivery.service.js";
import { log, sanitizeEmail } from "../utils/logger.js";

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

    try {
      for (const ev of events) {
        const email = String(ev.email || "").trim().toLowerCase();
        const event = String(ev.event || "").toLowerCase();
        const sgid = String(ev.sg_message_id || "");
        const messageKind = sendgridCustomArg(ev, "sf_message_kind");

        const referralResult = await applyReferralInviteSendgridEvent(ev);
        if (referralResult.handled) {
          log("info", "referral_sendgrid_event", {
            referralEventId: referralResult.referralEventId,
            event,
            status: referralResult.status || null,
            duplicate: Boolean(referralResult.duplicate),
            recipient: sanitizeEmail(
              referralResult.recipientEmail || email
            ),
          });
          if (referralResult.shouldSuppress) {
            if (referralResult.referrerUserId) {
              await addSuppression({
                userId: referralResult.referrerUserId,
                channel: "email",
                destination:
                  referralResult.recipientEmail || email,
                reason: event,
              });
            }
            if (referralResult.shouldSuppressGlobally) {
              await addReferralDestinationSuppression({
                destination:
                  referralResult.recipientEmail || email,
                reason: event,
              });
            }
          }
          continue;
        }

        if (messageKind) {
          log("info", "transactional_sendgrid_event", {
            messageKind,
            messageRef:
              sendgridCustomArg(ev, "sf_message_ref") || null,
            event,
            recipient: sanitizeEmail(email),
          });
          continue;
        }

        const blastRecipientId = sendgridCustomArg(
          ev,
          "sf_blast_recipient_id"
        );
        let br = null;
        if (blastRecipientId && isUuidValue(blastRecipientId)) {
          br = await db("blast_recipients")
            .where({ id: blastRecipientId })
            .first();
        }
        if (!br && sgid) {
          br = await db("blast_recipients")
            .where({ provider_message_id: sgid })
            .first();
        }

        // Never guess by recipient address: one address can have several
        // active sends, and a webhook must update only its exact message.
        if (!br) continue;

        await logMessageEvent({
          userId: br.user_id,
          blastId: br.blast_id,
          blastRecipientId: br.id,
          eventType: "provider_update",
          payload: {
            provider: "sendgrid",
            event,
            sg_event_id: ev.sg_event_id,
          },
        });

        const nextStatus =
          event === "delivered"
            ? "sent"
            : [
                "bounce",
                "dropped",
                "spamreport",
                "unsubscribe",
                "group_unsubscribe",
              ].includes(event)
              ? "failed"
              : br.status;
        if (nextStatus !== br.status) {
          await db("blast_recipients")
            .where({ id: br.id })
            .update({
              status: nextStatus,
              updated_at: db.fn.now(),
            });
        }

        if (
          [
            "bounce",
            "dropped",
            "spamreport",
            "unsubscribe",
            "group_unsubscribe",
          ].includes(event)
        ) {
          await addSuppression({
            userId: br.user_id,
            channel: "email",
            destination: br.destination,
            reason: event,
          });
        }
      }
    } catch (err) {
      log("error", "sendgrid_webhook_processing_failed", {
        code: err?.code,
        message: String(err?.message || err).slice(0, 300),
      });
      // SendGrid retries non-2xx webhook responses.
      return res.status(500).json({ error: "webhook_processing_failed" });
    }

    return res.json({ ok: true });
  }
);
