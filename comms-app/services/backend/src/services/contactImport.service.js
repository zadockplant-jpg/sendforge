// comms-app/services/backend/src/services/contactImport.service.js
import { dedupeContacts } from "./dedupe.service.js";
import { auditLog } from "./audit.service.js";
import { db } from "../config/db.js";
import { randomUUID } from "crypto";

export async function importContacts({ userId, method, contacts }) {
  if (!userId) throw new Error("missing_user");

  const normalized = (contacts || []).map(normalize).filter(Boolean);

  const { unique, duplicates } = dedupeContacts(normalized);

  let inserted = 0;

  // Insert best-effort; count actual inserts (not just attempts)
  for (const c of unique) {
    const rows = await db("contacts")
  .insert({
    id: randomUUID(),
    user_id: userId,
    name: c.name,
    phone: c.phone,
    email: c.email,
    source: method,
    created_at: new Date(),
  })
      .onConflict(["user_id", "phone", "email"])
      .ignore()
      .returning(["id"]);

    if (Array.isArray(rows) && rows.length > 0) inserted++;
  }

  // Audit should never block import success
  try {
    await auditLog(userId, "contacts_import", {
      method,
      inserted,
      duplicates: duplicates.length,
      invalid: (contacts?.length || 0) - normalized.length,
    });
  } catch (_) {
    // ignore
  }

  return {
    added: inserted,
    duplicates: duplicates.length,
    invalid: (contacts?.length || 0) - normalized.length,
    // keep these if you want them for debugging/UI (safe-ish)
    unique,
    duplicatesList: duplicates,
  };
}

function normalize(c) {
  if (!c) return null;

  const phone = typeof c.phone === "string" ? c.phone.trim() : "";
  const email = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";

  if (!phone && !email) return null;

  return {
    name: typeof c.name === "string" ? c.name.trim() : "",
    phone: phone || null,
    email: email || null,
  };
}