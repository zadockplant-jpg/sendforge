import crypto from "crypto";
import { db } from "../config/db.js";

export async function logMessageEvent({
  userId,
  blastId,
  blastRecipientId,
  eventType,
  payload = {},
}) {
  await db("message_events").insert({
    id: crypto.randomUUID(),
    user_id: userId,
    blast_id: blastId,
    blast_recipient_id: blastRecipientId,
    event_type: eventType,
    payload: JSON.stringify(payload),
  });
}

// NEW: explicit audit primitive used by contact import
export async function auditLog(userId, action, metadata = {}) {
  await db("audit_log").insert({
    id: crypto.randomUUID(),
    user_id: userId,
    action,
    metadata: JSON.stringify(metadata),
    created_at: new Date(),
  });
}
