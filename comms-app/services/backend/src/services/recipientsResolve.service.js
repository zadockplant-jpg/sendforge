import { db } from "../config/db.js";

/**
 * Resolve recipients based on groupIds/contactIds for THIS user.
 * Returns:
 * {
 *   sms: string[] (phone_e164),
 *   email: string[] (lowercased)
 * }
 */
export async function resolveRecipients({
  userId,
  groupIds = [],
  contactIds = [],
}) {
  const gIds = Array.isArray(groupIds) ? groupIds.map(String) : [];
  const cIds = Array.isArray(contactIds) ? contactIds.map(String) : [];

  // group member contacts
  let groupMemberIds = [];
  if (gIds.length) {
    const rows = await db("group_members")
      .select("contact_id")
      .whereIn("group_id", gIds);
    groupMemberIds = rows.map((r) => r.contact_id);
  }

  const merged = Array.from(new Set([...cIds, ...groupMemberIds])).filter(Boolean);

  if (!merged.length) {
    return { sms: [], email: [] };
  }

  const contacts = await db("contacts")
    .select("phone_e164", "email")
    .where({ user_id: userId })
    .whereIn("id", merged);

  const sms = [];
  const email = [];

  for (const c of contacts) {
    if (c.phone_e164) sms.push(String(c.phone_e164));
    if (c.email) email.push(String(c.email).toLowerCase());
  }

  return { sms, email };
}