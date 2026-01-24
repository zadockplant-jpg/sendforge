import crypto from "crypto";
import { db } from "../config/db.js";

export async function logMessageEvent({ userId, blastId, blastRecipientId, eventType, payload = {} }) {
  await db("message_events").insert({
    id: crypto.randomUUID(),
    user_id: userId,
    blast_id: blastId,
    blast_recipient_id: blastRecipientId,
    event_type: eventType,
    payload: JSON.stringify(payload),
  });
}
