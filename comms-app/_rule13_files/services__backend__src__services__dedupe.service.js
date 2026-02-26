
// Keep your existing export
export function dedupeDestinations(list = []) {
  const seen = new Set();
  const unique = [];
  const duplicates = [];

  for (const c of list) {
    const key = `${c.phone || ""}|${c.email || ""}`;

    if (seen.has(key)) {
      duplicates.push(c);
    } else {
      seen.add(key);
      unique.push(c);
    }
  }

  return { unique, duplicates };
}


// ✅ Add this NEW export (used by contactImport.service.js)
export function dedupeContacts(contacts) {
  const seen = new Set();
  const unique = [];
  const duplicates = [];

  for (const c of contacts || []) {
    const phone = (c?.phone || "").trim();
    const email = (c?.email || "").trim().toLowerCase();

    // key matches your DB conflict intent: user_id + phone + email
    // if one is missing, still dedupe on whatever exists
    const key = `${phone}|${email}`;
    if (key === "|" || key === "") continue;

    if (seen.has(key)) {
      duplicates.push(c);
      continue;
    }
    seen.add(key);
    unique.push(c);
  }

  return { unique, duplicates };
}
