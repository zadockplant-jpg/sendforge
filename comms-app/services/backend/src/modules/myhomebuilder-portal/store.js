// Postgres storage for the My Home Builder portal (mhb_* tables, see
// 20260925_create_myhomebuilder_portal.js). Records keep their full JSON in a
// `data` column; the columns beside it exist for lookups and constraints.
import { createHash } from "node:crypto";
import { ADMIN_CODE_MAX_ATTEMPTS, ADMIN_CODE_TTL_SECONDS } from "./security.js";
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

// Ids are unique across projects. Stripe events find an invoice this way, since an invoice sent
// to another project keeps its id while its Checkout still names the old project.
export async function getBillingById(store, id) {
  return data(await store.db("mhb_billing").where({ id: String(id) }).first().timeout(QUERY_TIMEOUT_MS));
}

// Moves quotes or invoices (already carrying their new clientSlug) out of fromSlug. Their
// sent-email records are keyed by project, so they move too: a receipt already sent is not sent
// again, and the admin page still shows it.
export async function moveBilling(store, items, fromSlug) {
  await store.db.transaction(async (trx) => {
    for (const item of items) {
      await trx("mhb_billing")
        .where({ id: item.id, client_slug: fromSlug })
        .update({ client_slug: item.clientSlug, data: JSON.stringify(item), updated_at: trx.fn.now() })
        .timeout(QUERY_TIMEOUT_MS);
      const from = `${fromSlug}:${item.id}:`;
      await trx.raw(
        "UPDATE mhb_sent_emails SET key = ? || substr(key, ?) WHERE left(key, ?) = ?",
        [`${item.clientSlug}:${item.id}:`, from.length + 1, from.length, from]
      ).timeout(QUERY_TIMEOUT_MS);
    }
  });
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

// Forgets sends, so a later payment of a reopened invoice gets a fresh receipt and notice.
export async function deleteSentEmails(store, keys) {
  if (keys.length) await store.db("mhb_sent_emails").whereIn("key", keys).del().timeout(QUERY_TIMEOUT_MS);
}

// Records a send made on request (for example "Resend receipt"), replacing the earlier record.
export async function putSentEmail(store, key, record) {
  await store.db("mhb_sent_emails")
    .insert({ key, recipient: record.to, status: "sent", message_id: record.messageId || null, claimed_at: store.db.fn.now(), sent_at: record.sentAt })
    .onConflict("key")
    .merge({ recipient: record.to, status: "sent", message_id: record.messageId || null, sent_at: record.sentAt })
    .timeout(QUERY_TIMEOUT_MS);
}

// ---------- Addresses emailed ----------

// Remembers an address the portal emailed (quotes, invoices, receipts), for the admin's pick list.
export async function rememberRecipient(store, address) {
  const display = String(address || "").trim();
  if (!display) return;
  await store.db.raw(
    `INSERT INTO mhb_recipients (email, display, send_count, last_sent_at) VALUES (?, ?, 1, now())
     ON CONFLICT (email) DO UPDATE SET display = excluded.display, send_count = mhb_recipients.send_count + 1, last_sent_at = now()`,
    [display.toLowerCase(), display]
  ).timeout(QUERY_TIMEOUT_MS);
}

// Newest first.
export async function listRecipients(store, limit = 500) {
  const rows = await store.db("mhb_recipients").orderBy("last_sent_at", "desc").limit(limit).select("display", "last_sent_at").timeout(QUERY_TIMEOUT_MS);
  return rows.map((row) => ({ email: row.display, lastSentAt: row.last_sent_at instanceof Date ? row.last_sent_at.toISOString() : row.last_sent_at }));
}

// ---------- Admin verification codes and rate limits ----------

export async function putAdminChallenge(store, id, codeHash) {
  await cleanup(store);
  await store.db("mhb_admin_challenges")
    .insert({ id, code_hash: codeHash, attempts: 0, expires_at: store.db.raw(`now() + interval '${ADMIN_CODE_TTL_SECONDS} seconds'`) })
    .timeout(QUERY_TIMEOUT_MS);
}

// A code can be entered on any device, so an attempt is not tied to one code: each attempt counts
// against every live code, atomically, so parallel guesses cannot share a count and no code is
// tried more than ADMIN_CODE_MAX_ATTEMPTS times. Returns the live codes still within their
// attempts (`live`) and how many this attempt used up (`spent`), which are removed.
export async function claimAdminAttempt(store) {
  const result = await store.db.raw(
    "UPDATE mhb_admin_challenges SET attempts = attempts + 1 WHERE expires_at > now() RETURNING id, code_hash, attempts"
  ).timeout(QUERY_TIMEOUT_MS);
  const rows = result.rows.map((row) => ({ id: row.id, hash: row.code_hash, attempts: Number(row.attempts) }));
  const spent = rows.filter((row) => row.attempts > ADMIN_CODE_MAX_ATTEMPTS).map((row) => row.id);
  if (spent.length) await store.db("mhb_admin_challenges").whereIn("id", spent).del().timeout(QUERY_TIMEOUT_MS);
  return { live: rows.filter((row) => row.attempts <= ADMIN_CODE_MAX_ATTEMPTS), spent: spent.length };
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
