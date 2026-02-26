import { dedupeContacts } from "./dedupe.service.js";
import { auditLog } from "./audit.service.js";
import { db } from "../config/db.js";

function normalizePhone(phoneRaw) {
  if (!phoneRaw) return null;

  let phone = String(phoneRaw).trim();
  phone = phone.replace(/[^\d+]/g, "");

  if (phone.startsWith("+")) {
    phone = phone.slice(1);
  }

  phone = phone.replace(/\D/g, "");

  if (phone.length === 10) {
    return `+1${phone}`;
  }

  if (phone.length === 11 && phone.startsWith("1")) {
    return `+${phone}`;
  }

  if (phone.length >= 11 && phone.length <= 15) {
    return `+${phone}`;
  }

  return null;
}

function normalize(c) {
  if (!c) return null;

  const phone = normalizePhone(c.phone);
  const email = c.email?.trim() || null;

  if (!phone && !email) return null;

  return {
    name: c.name?.trim() || "Unknown",
    phone,
    email,
  };
}

export async function importContacts({ userId, method, contacts }) {
  const normalized = contacts.map(normalize).filter(Boolean);

  const { unique, duplicates } = dedupeContacts(normalized);

  let inserted = 0;

  for (const c of unique) {
    await db("contacts")
      .insert({
        user_id: userId,
        name: c.name,
        phone_e164: c.phone,
        email: c.email,
        source: method,
        created_at: new Date(),
      })
      .onConflict(["user_id", "phone_e164", "email"])
      .ignore();

    inserted++;
  }

  await auditLog(userId, "contacts_import", {
    method,
    inserted,
    duplicates: duplicates.length,
  });

  return {
    added: inserted,
    duplicates: duplicates.length,
    invalid: contacts.length - normalized.length,
  };
}