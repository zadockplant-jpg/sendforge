// comms-app/services/backend/src/services/contactImport.service.js
import { parsePhoneNumberFromString } from "libphonenumber-js";

import { dedupeContacts } from "./dedupe.service.js";
import { auditLog } from "./audit.service.js";
import { db } from "../config/db.js";

/**
 * Normalize phone input to E.164 at ingestion.
 *
 * Goals:
 * - US numbers no longer flagged intl incorrectly (default region US when no +country code)
 * - Preserve existing import behavior (best-effort; invalids filtered)
 * - Do NOT touch tier logic
 *
 * Storage:
 * - contacts.phone_e164 receives normalized E.164
 * - normalized object field "phone" remains E.164 to stay compatible with dedupeContacts()
 */
function normalizePhoneToE164(raw) {
  if (typeof raw !== "string") return null;

  let s = raw.trim();
  if (!s) return null;

  // Remove separators (keep leading +)
  s = s.replace(/[()\-\.\s]/g, "");

  // Convert 00 prefix to +
  if (s.startsWith("00")) s = "+" + s.slice(2);

  // discard obvious garbage
  if (/[a-zA-Z]/.test(s)) return null;

  const isDigitsOnly = /^[0-9]+$/.test(s);

  try {
    if (s.startsWith("+")) {
      const p = parsePhoneNumberFromString(s);
      if (p && p.isValid()) return p.number;
      return null;
    }

    // Default US if no country code
    if (isDigitsOnly) {
      if (s.length === 10) {
        const p = parsePhoneNumberFromString(s, "US");
        if (p && p.isValid()) return p.number;
        return null;
      }
      if (s.length === 11 && s.startsWith("1")) {
        const p = parsePhoneNumberFromString(s.slice(1), "US");
        if (p && p.isValid()) return p.number;
        return null;
      }

      const p = parsePhoneNumberFromString(s, "US");
      if (p && p.isValid()) return p.number;
      return null;
    }

    const p = parsePhoneNumberFromString(s, "US");
    if (p && p.isValid()) return p.number;
    return null;
  } catch {
    return null;
  }
}

async function insertOneContactOptionA({ userId, method, c }) {
  // Option A:
  // - if phone_e164 exists: conflict on (user_id, phone_e164)
  // - else conflict on (user_id, email)
  // This matches your Render DB indexes exactly and avoids composite NULL weirdness.
  const baseRow = {
    user_id: userId,
    name: c.name,
    phone_e164: c.phone || null, // E.164
    email: c.email || null,
    organization: c.organization || null,
    source: method,
    created_at: new Date(),
  };

  if (baseRow.phone_e164) {
    const rows = await db("contacts")
      .insert(baseRow)
      .onConflict(["user_id", "phone_e164"])
      .ignore()
      .returning(["id"]);
    return Array.isArray(rows) && rows.length > 0;
  }

  if (baseRow.email) {
    const rows = await db("contacts")
      .insert(baseRow)
      .onConflict(["user_id", "email"])
      .ignore()
      .returning(["id"]);
    return Array.isArray(rows) && rows.length > 0;
  }

  // should not happen (normalize filters these out)
  return false;
}

export async function importContacts({ userId, method, contacts }) {
  if (!userId) throw new Error("missing_user");

  const normalized = (contacts || []).map(normalize).filter(Boolean);

  const { unique, duplicates } = dedupeContacts(normalized);

  let inserted = 0;

  for (const c of unique) {
    const didInsert = await insertOneContactOptionA({ userId, method, c });
    if (didInsert) inserted++;
  }

  // Audit should never block success
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
  };
}

function normalize(c) {
  if (!c) return null;

  const name = typeof c.name === "string" ? c.name.trim() : "";
  const organization =
    typeof c.organization === "string" ? c.organization.trim() : "";

  const rawPhone = typeof c.phone === "string" ? c.phone.trim() : "";
  const rawEmail =
    typeof c.email === "string" ? c.email.trim().toLowerCase() : "";

  const phoneE164 = rawPhone ? normalizePhoneToE164(rawPhone) : null;
  const email = rawEmail || null;

  // Require at least one channel
  if (!phoneE164 && !email) return null;

  return {
    name: name || "Unknown",
    organization: organization || null,
    // Keep field name "phone" (dedupe expects it), but value is E.164
    phone: phoneE164,
    email,
  };
}