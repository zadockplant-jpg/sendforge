// Where documents show in a client portal. The admin picks a section when sharing a document (from
// the client's portal or the admin Documents page); a client's own uploads have their own section.
// Documents saved before sections were added show under "Other documents", or the client's
// uploads when the client uploaded them.

export const DOCUMENT_SECTIONS = [
  ["contracts", "Contracts and agreements"],
  ["change-orders", "Change orders"],
  ["plans", "Plans and drawings"],
  ["permits", "Permits and inspections"],
  ["selections", "Selections"],
  ["warranties", "Warranties and manuals"],
  ["other", "Other documents"]
];
export const CLIENT_UPLOADS = "uploads";

const NAMES = new Map(DOCUMENT_SECTIONS);

// A section the admin may choose; anything else is Other documents.
export function parseSection(value) {
  const key = String(value || "").trim();
  return NAMES.has(key) ? key : "other";
}

export function sectionOf(document) {
  if (document.section === CLIENT_UPLOADS || NAMES.has(document.section)) return document.section;
  return document.uploadedBy === "admin" ? "other" : CLIENT_UPLOADS;
}

export function sectionName(key, viewer = "client") {
  if (key === CLIENT_UPLOADS) return viewer === "client" ? "Uploaded by you" : "Uploaded by the client";
  return NAMES.get(key) || "Other documents";
}

// Documents grouped by section, in the order above with the client's uploads last; empty
// sections are left out. Each group keeps the documents' order (newest first).
export function groupBySection(documents) {
  const order = [...DOCUMENT_SECTIONS.map(([key]) => key), CLIENT_UPLOADS];
  const groups = new Map(order.map((key) => [key, []]));
  for (const document of documents) groups.get(sectionOf(document)).push(document);
  return order.filter((key) => groups.get(key).length).map((key) => [key, groups.get(key)]);
}

// Still waiting for a signature from the client or the builder.
export function awaitingSignature(document) {
  const signed = (party) => document.signatures?.some((entry) => entry.party === party);
  return (document.requiresClientSignature && !signed("client")) || (document.requiresAdminSignature && !signed("admin"));
}
