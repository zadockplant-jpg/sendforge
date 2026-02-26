import { dedupeContacts } from "./dedupe.service.js";
import { auditLog } from "./audit.service.js";
import { db } from "../config/db.js";

let _contactsCols = null;

async function getContactsColumns() {
  if (_contactsCols) return _contactsCols;

  const r = await db.raw(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts'
    `
  );

  _contactsCols = new Set((r?.rows || []).map((x) => x.column_name));
  return _contactsCols;
}

function normalizePhoneToE164Likely(phoneRaw) {
  if (!phoneRaw) return null;
  const s = String(phoneRaw).trim();

  // already E164-ish
  if (s.startsWith("+") && s.length >= 8) return s;

  // strip non-digits
  const digits = s.replace(/\D/g, "");

  // US/CA 10-digit -> +1
  if (digits.length === 10) return `+1${digits}`;

  // 11-digit starting with 1 -> + +digits
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  // fallback: not sure
  return null;
}

function normalize(c) {
  if (!c) return null;

  const name = String(c.name ?? "").trim();
  const email = String(c.email ?? "").trim();
  const org = String(c.organization ?? "").trim();

  const phoneRaw = c.phone ?? null;
  const phoneE164 = normalizePhoneToE164Likely(phoneRaw);

  // Keep if it has at least name OR some contact method
  if (!name && !phoneE164 && !email) return null;

  return {
    name: name || "Unknown",
    email: email || null,
    organization: org || null,
    phone_e164: phoneE164,
    phone_raw: phoneRaw ? String(phoneRaw).trim() : null,
  };
}

export async function importContacts({ userId, method, contacts }) {
  const normalized = (contacts || []).map(normalize).filter(Boolean);
  const { unique, duplicates } = dedupeContacts(normalized);

  const cols = await getContactsColumns();

  let inserted = 0;

  for (const c of unique) {
    const row = {
      user_id: userId,
      name: c.name,
      created_at: new Date(),
      source: method,
    };

    // Only set columns if they exist
    if (cols.has("email")) row.email = c.email;
    if (cols.has("organization")) row.organization = c.organization;

    // Prefer phone_e164, but don’t assume schema
    if (cols.has("phone_e164")) row.phone_e164 = c.phone_e164;
    else if (cols.has("phone")) row.phone = c.phone_e164 ?? c.phone_raw;

    // optional raw field
    if (cols.has("phone_raw")) row.phone_raw = c.phone_raw;

    // Conflict keys vary across schemas; safest is "do nothing" on duplicate unique constraint
    // If your DB has (user_id, name) unique for contacts, this will still behave.
    await db("contacts").insert(row).onConflict().ignore();
    inserted++;
  }

  await auditLog(userId, "contacts_import", {
    method,
    inserted,
    duplicates: duplicates.length,
    invalid: (contacts?.length || 0) - normalized.length,
  });

  return {
    added: inserted,
    duplicates: duplicates.length,
    invalid: (contacts?.length || 0) - normalized.length,
  };
}