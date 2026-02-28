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
 * - we keep normalized object field "phone" as E.164 to remain compatible with dedupeContacts()
 */
function normalizePhoneToE164(raw) {
  if (typeof raw !== "string") return null;

  let s = raw.trim();
  if (!s) return null;

  // Remove common separators but keep leading +
  s = s.replace(/[()\-\.\s]/g, "");

  // Convert 00 prefix to +
  if (s.startsWith("00")) s = "+" + s.slice(2);

  // If it has letters, discard (avoid garbage)
  if (/[a-zA-Z]/.test(s)) return null;

  // If it’s all digits, treat as national (US default)
  // Examples:
  //  - 10 digits -> US
  //  - 11 digits starting with 1 -> US
  //  - anything else -> attempt parse with US then fallback null
  const isDigitsOnly = /^[0-9]+$/.test(s);

  try {
    if (s.startsWith("+")) {
      const p = parsePhoneNumberFromString(s);
      if (p && p.isValid()) return p.number; // E.164
      return null;
    }

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

      // last-ditch: try parsing as US
      const p = parsePhoneNumberFromString(s, "US");
      if (p && p.isValid()) return p.number;
      return null;
    }

    // Non-digit national format: still try US (best-effort)
    const p = parsePhoneNumberFromString(s, "US");
    if (p && p.isValid()) return p.number;
    return null;
  } catch {
    return null;
  }
}

export async function importContacts({ userId, method, contacts }) {
  if (!userId) throw new Error("missing_user");

  const normalized = (contacts || []).map(normalize).filter(Boolean);

  const { unique, duplicates } = dedupeContacts(normalized);

  let inserted = 0;

  // Insert best-effort; count actual inserts (not just attempts)
  for (const c of unique) {
    const rows = await db("contacts")
      .insert({
        user_id: userId,
        name: c.name,
        // ✅ store E.164
        phone_e164: c.phone, // "phone" is E.164 in normalized object
        email: c.email,
        organization: c.organization || null,
        source: method,
        created_at: new Date(),
      })
      .onConflict(["user_id", "phone_e164", "email"])
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

  const name = typeof c.name === "string" ? c.name.trim() : "";
  const organization = typeof c.organization === "string" ? c.organization.trim() : "";

  const rawPhone = typeof c.phone === "string" ? c.phone.trim() : "";
  const rawEmail = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";

  const phoneE164 = rawPhone ? normalizePhoneToE164(rawPhone) : null;
  const email = rawEmail || null;

  // If both missing after normalization, skip
  if (!phoneE164 && !email) return null;

  return {
    name,
    organization: organization || null,
    // ✅ keep property name "phone" for dedupe compatibility, but value is E.164
    phone: phoneE164,
    email,
  };
}