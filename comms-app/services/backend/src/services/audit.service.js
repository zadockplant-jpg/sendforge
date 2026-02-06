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
export async function auditLog(userId, eventType, payload = {}) {
  try {
    // reuse message_events table if it exists
    await db("message_events").insert({
      id: crypto.randomUUID(),
      user_id: userId,
      blast_id: null,
      blast_recipient_id: null,
      event_type: eventType,
      payload: JSON.stringify(payload),
    });
  } catch (e) {
    // don't block imports if audit storage isn't ready
    console.warn("auditLog skipped:", e?.message || e);
  }
}
