// Postgres storage for the My Home Builder portal (mhb_* tables, see
// 20260925_create_myhomebuilder_portal.js). Records keep their full JSON in a
// `data` column; the columns beside it exist for lookups and constraints.
import { createHash } from "node:crypto";
import { ADMIN_CODE_TTL_SECONDS } from "./security.js";
import { billingNumber } from "./billing.js";

export const DEFAULT_CLIENT_SLUG = "muskegon-addition";
export const DEFAULT_PROJECT_PATH = "/clients/muskegon-addition";
const QUERY_TIMEOUT_MS = 5000;
// A send claimed longer ago than this was interrupted and may be claimed again.
const STALE_SEND_SECONDS = 120;

export function createStore(db) {
  return { db, files: true };
}

function data(row) {
  if (!row) return null;
  return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
}

function hashKey(value) {
  return createHash("sha256").update(value).digest("hex");
}

function defaultClient(slug) {
  return {
    slug,
    name: "Muskegon Addition",
    projectPath: DEFAULT_PROJECT_PATH,
    managedBySecret: true,
    active: true,
    createdAt: "2026-08-03T00:00:00.000Z"
  };
}

let lastCleanup = 0;
async function cleanup(store) {
  if (Date.now() - lastCleanup < 60000) return;
  lastCleanup = Date.now();
  try {
    await store.db("mhb_rate_limits").where("window_started", "<", store.db.raw("now() - interval '1 day'")).del().timeout(QUERY_TIMEOUT_MS);
    await store.db("mhb_admin_challenges").where("expires_at", "<", store.db.fn.now()).del().timeout(QUERY_TIMEOUT_MS);
  } catch (error) {
    lastCleanup = 0;
    throw error;
  }
}

// ---------- Clients ----------

export async function getClient(store, slug, defaultSlug = DEFAULT_CLIENT_SLUG) {
  const stored = store ? data(await store.db("mhb_clients").where({ slug }).first().timeout(QUERY_TIMEOUT_MS)) : null;
  if (stored) return { ...(slug === defaultSlug ? defaultClient(slug) : {}), ...stored };
  return slug === defaultSlug ? defaultClient(slug) : null;
}

export async function listClients(store, defaultSlug = DEFAULT_CLIENT_SLUG) {
  const clients = new Map([[defaultSlug, defaultClient(defaultSlug)]]);
  if (!store) return [...clients.values()];
  for (const row of await store.db("mhb_clients").select("slug", "data").timeout(QUERY_TIMEOUT_MS)) {
    clients.set(row.slug, { ...(clients.get(row.slug) || {}), ...data(row) });
  }
  return [...clients.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function putClient(store, client) {
  await store.db("mhb_clients")
    .insert({ slug: client.slug, data: JSON.stringify(client) })
    .onConflict("slug")
    .merge({ data: JSON.stringify(client), updated_at: store.db.fn.now() })
    .timeout(QUERY_TIMEOUT_MS);
}

// ---------- Quotes and invoices ----------

export async function listBilling(store, slug) {
  const rows = await store.db("mhb_billing").where({ client_slug: slug }).orderBy("created_at", "desc").select("data").timeout(QUERY_TIMEOUT_MS);
  return rows.map(data);
}

export async function getBilling(store, slug, id) {
  return data(await store.db("mhb_billing").where({ id: String(id), client_slug: slug }).first().timeout(QUERY_TIMEOUT_MS));
}

export async function putBilling(store, item) {
  const row = {
    id: item.id,
    client_slug: item.clientSlug,
    kind: item.kind,
    number: item.number,
    share_token: item.shareToken || null,
    data: JSON.stringify(item),
    created_at: item.createdAt
  };
  await store.db("mhb_billing")
    .insert(row)
    .onConflict("id")
    .merge({ share_token: row.share_token, data: row.data, updated_at: store.db.fn.now() })
    .timeout(QUERY_TIMEOUT_MS);
}

// Invoice numbers (and, separately, quote numbers) run 1, 2, 3 … across every client portal,
// so each is unique to the business.
export async function nextBillingNumber(store, kind) {
  const result = await store.db.raw(
    `INSERT INTO mhb_counters (name, value) VALUES (?, 1)
     ON CONFLICT (name) DO UPDATE SET value = mhb_counters.value + 1 RETURNING value`,
    [kind]
  ).timeout(QUERY_TIMEOUT_MS);
  return billingNumber(Number(result.rows[0].value));
}

// The share token is saved with the quote or invoice itself (unique column), so there is nothing extra to store.
export async function putShareLink() {}

export async function getShareLink(store, token) {
  const row = await store.db("mhb_billing").where({ share_token: token }).first("client_slug", "id").timeout(QUERY_TIMEOUT_MS);
  return row ? { clientSlug: row.client_slug, id: row.id } : null;
}

// ---------- Templates ----------

export async function listTemplates(store) {
  const rows = await store.db("mhb_templates").select("data").timeout(QUERY_TIMEOUT_MS);
  return rows.map(data).sort((left, right) => left.name.localeCompare(right.name));
}

export async function getTemplate(store, id) {
  return data(await store.db("mhb_templates").where({ id: String(id) }).first().timeout(QUERY_TIMEOUT_MS));
}

export async function putTemplate(store, template) {
  await store.db("mhb_templates")
    .insert({ id: template.id, data: JSON.stringify(template) })
    .onConflict("id")
    .merge({ data: JSON.stringify(template), updated_at: store.db.fn.now() })
    .timeout(QUERY_TIMEOUT_MS);
}

export async function deleteTemplate(store, id) {
  await store.db("mhb_templates").where({ id: String(id) }).del().timeout(QUERY_TIMEOUT_MS);
}

// ---------- Documents and files ----------

export async function listDocuments(store, slug) {
  const rows = await store.db("mhb_documents").where({ client_slug: slug }).orderBy("created_at", "desc").select("data").timeout(QUERY_TIMEOUT_MS);
  return rows.map(data);
}

export async function getDocument(store, slug, id) {
  return data(await store.db("mhb_documents").where({ id: String(id), client_slug: slug }).first().timeout(QUERY_TIMEOUT_MS));
}

export async function putDocument(store, document) {
  await store.db("mhb_documents")
    .insert({ id: document.id, client_slug: document.clientSlug, data: JSON.stringify(document), created_at: document.createdAt })
    .onConflict("id")
    .merge({ data: JSON.stringify(document) })
    .timeout(QUERY_TIMEOUT_MS);
}

export async function putFile(store, key, body, contentType) {
  const bytes = Buffer.from(body instanceof Uint8Array ? body : new Uint8Array(body));
  await store.db("mhb_files")
    .insert({ key, content_type: contentType, size: bytes.byteLength, bytes })
    .onConflict("key")
    .merge({ content_type: contentType, size: bytes.byteLength, bytes })
    .timeout(15000);
}

// Returns the shape the portal code reads: body, size, content type and arrayBuffer().
export async function getFile(store, key) {
  const row = await store.db("mhb_files").where({ key }).first("content_type", "size", "bytes").timeout(15000);
  if (!row) return null;
  const bytes = new Uint8Array(row.bytes);
  return {
    body: bytes,
    size: bytes.byteLength,
    httpMetadata: { contentType: row.content_type },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

// ---------- Automatic email log ----------

// Claims an automatic email before it is sent. Returns { claimed: true } for the one caller that
// should send it; everyone else gets the existing record (status "sent", or "sending" while
// another request is sending it). An interrupted send can be claimed again after two minutes.
export async function claimSentEmail(store, key, recipient) {
  const result = await store.db.raw(
    `INSERT INTO mhb_sent_emails (key, recipient, status, claimed_at) VALUES (?, ?, 'sending', now())
     ON CONFLICT (key) DO UPDATE SET recipient = excluded.recipient, claimed_at = now()
       WHERE mhb_sent_emails.status = 'sending' AND mhb_sent_emails.claimed_at < now() - (?::integer * interval '1 second')
     RETURNING key`,
    [key, recipient, STALE_SEND_SECONDS]
  ).timeout(QUERY_TIMEOUT_MS);
  if (result.rows.length) return { claimed: true };
  const row = await store.db("mhb_sent_emails").where({ key }).first().timeout(QUERY_TIMEOUT_MS);
  return { claimed: false, status: row?.status || "sending", record: row ? sentRecord(row) : null };
}

export async function completeSentEmail(store, key, messageId) {
  const [row] = await store.db("mhb_sent_emails")
    .where({ key })
    .update({ status: "sent", message_id: messageId || null, sent_at: store.db.fn.now() })
    .returning(["recipient", "sent_at", "message_id"])
    .timeout(QUERY_TIMEOUT_MS);
  return sentRecord(row);
}

export async function releaseSentEmail(store, key) {
  await store.db("mhb_sent_emails").where({ key, status: "sending" }).del().timeout(QUERY_TIMEOUT_MS);
}

function sentRecord(row) {
  if (!row) return null;
  const sentAt = row.sent_at instanceof Date ? row.sent_at.toISOString() : row.sent_at;
  return { to: row.recipient, sentAt, messageId: row.message_id || "" };
}

// Only messages that actually went out; a claim still being sent is not reported as sent.
export async function getSentEmail(store, key) {
  const row = await store.db("mhb_sent_emails").where({ key, status: "sent" }).first().timeout(QUERY_TIMEOUT_MS);
  return sentRecord(row);
}

// Records a send made on request (for example "Resend receipt"), replacing the earlier record.
export async function putSentEmail(store, key, record) {
  await store.db("mhb_sent_emails")
    .insert({ key, recipient: record.to, status: "sent", message_id: record.messageId || null, claimed_at: store.db.fn.now(), sent_at: record.sentAt })
    .onConflict("key")
    .merge({ recipient: record.to, status: "sent", message_id: record.messageId || null, sent_at: record.sentAt })
    .timeout(QUERY_TIMEOUT_MS);
}

// ---------- Admin verification codes and rate limits ----------

export async function putAdminChallenge(store, id, codeHash) {
  await cleanup(store);
  await store.db("mhb_admin_challenges")
    .insert({ id, code_hash: codeHash, attempts: 0, expires_at: store.db.raw(`now() + interval '${ADMIN_CODE_TTL_SECONDS} seconds'`) })
    .timeout(QUERY_TIMEOUT_MS);
}

export async function getAdminChallenge(store, id) {
  const row = await store.db("mhb_admin_challenges").where({ id }).where("expires_at", ">", store.db.fn.now()).first().timeout(QUERY_TIMEOUT_MS);
  return row ? { hash: row.code_hash, attempts: row.attempts } : null;
}

// Counts an attempt atomically, so parallel guesses cannot share one count.
export async function recordAdminAttempt(store, id) {
  const [row] = await store.db("mhb_admin_challenges").where({ id }).increment("attempts", 1).returning("attempts").timeout(QUERY_TIMEOUT_MS);
  return Number(row?.attempts ?? Number.MAX_SAFE_INTEGER);
}

export async function deleteAdminChallenge(store, id) {
  await store.db("mhb_admin_challenges").where({ id }).del().timeout(QUERY_TIMEOUT_MS);
}

// Adds one hit to a fixed window and returns the hits in the current window.
export async function hitRateLimit(store, key, windowSeconds) {
  const result = await store.db.raw(
    `INSERT INTO mhb_rate_limits (key_hash, attempts, window_started) VALUES (?, 1, now())
     ON CONFLICT (key_hash) DO UPDATE SET
       attempts = CASE WHEN mhb_rate_limits.window_started < now() - (?::integer * interval '1 second')
         THEN 1 ELSE mhb_rate_limits.attempts + 1 END,
       window_started = CASE WHEN mhb_rate_limits.window_started < now() - (?::integer * interval '1 second')
         THEN now() ELSE mhb_rate_limits.window_started END
     RETURNING attempts`,
    [hashKey(key), windowSeconds, windowSeconds]
  ).timeout(QUERY_TIMEOUT_MS);
  return Number(result.rows[0].attempts);
}

// Admin code requests: 3 per address and 12 overall per code lifetime.
export async function allowAdminRequest(store, ip) {
  if ((await hitRateLimit(store, `mhb:admin-request:ip:${ip}`, ADMIN_CODE_TTL_SECONDS)) > 3) return false;
  return (await hitRateLimit(store, "mhb:admin-request:global", ADMIN_CODE_TTL_SECONDS)) <= 12;
}
