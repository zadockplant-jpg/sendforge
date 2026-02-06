import { dedupeDestinations as dedupeContacts } from "./dedupe.service.js";
import { auditLog } from "./audit.service.js";
import { db } from "../config/db.js";

export async function importContacts({ userId, method, contacts }) {
  const normalized = contacts.map(normalize).filter(Boolean);

  const { unique, duplicates } = dedupeContacts(normalized);

  let inserted = 0;

  for (const c of unique) {
    await db("contacts")
      .insert({
        user_id: userId,
        name: c.name,
        phone: c.phone,
        email: c.email,
        source: method,
        created_at: new Date(),
      })
      .onConflict(["user_id", "phone", "email"])
      .ignore();
    inserted++;
  }

  await auditLog(userId, "contacts_import", {
    method,
    inserted,
    duplicates: duplicates.length,
  });

return {
  unique,                 // <-- ADD THIS BACK
  duplicates,             // <-- array, not count
  added: inserted,
  invalid: contacts.length - normalized.length,
};

}

function normalize(c) {
  if (!c) return null;

  const phone = c.phone?.trim();
  const email = c.email?.trim();

  if (!phone && !email) return null;

  return {
    name: c.name?.trim() || "",
    phone,
    email,
  };
}
