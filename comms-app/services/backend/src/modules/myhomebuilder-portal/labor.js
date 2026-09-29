// Labor: employees (W-2) and subcontractors (1099), their crew portal sign-in, the hours and
// invoices they send, and the employer details printed on their paperwork. Tables from
// 20261004_myhomebuilder_portal_labor.js; crew.js serves the pages, books.js posts the costs.
//
// A worker's hours or invoice is "submitted", then the admin approves it to a job ("approved",
// posted as job cost owed to them) or returns it with a note ("returned"), and marks it paid
// ("paid", which clears what was owed). Returned work can be sent again.
import { constantTimeMatches, hmacSign, readCookie, sha256Hex } from "./security.js";
import { PAYMENT_METHODS } from "./billing.js";

const QUERY_TIMEOUT_MS = 5000;
export const CREW_COOKIE = "__Secure-mhb_crew_session";
export const CREW_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const RESET_TTL_SECONDS = 2 * 60 * 60;

export const WORKER_KINDS = { employee: "Employee (W-2)", subcontractor: "Subcontractor (1099)" };
export const LABOR_STATUS = { submitted: "Waiting for approval", approved: "Approved", paid: "Paid", returned: "Returned", waiver: "Needs your lien waiver" };
// How labor is paid: payroll for employees' hours, or the same ways invoices are paid.
export const LABOR_PAYMENT_METHODS = { payroll: "Payroll", ...PAYMENT_METHODS };

// Documents shared with a worker live under this portal id (documents.js sections for crew).
export const crewSlug = (workerId) => `crew:${workerId}`;
export const CREW_SECTIONS = [
  ["agreements", "Agreements"],
  ["onboarding", "Onboarding"],
  ["insurance", "Insurance"],
  ["other", "Other documents"]
];

export const DEFAULT_EMPLOYER = {
  legalName: "My Home Builder LLC",
  ein: "",
  street: "6749 Fulton St E, Ste A #2333",
  city: "Ada",
  state: "MI",
  zip: "49301",
  contactName: "",
  contactPhone: ""
};

function data(row) {
  if (!row) return null;
  return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
}

// ---------- Workers ----------

export async function listWorkers(store) {
  const rows = await store.db("mhb_workers").select("data").timeout(QUERY_TIMEOUT_MS);
  return rows.map(data).sort((left, right) => Number(right.active !== false) - Number(left.active !== false) || left.name.localeCompare(right.name));
}

export async function getWorker(store, id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,32}$/u.test(id)) return null;
  return data(await store.db("mhb_workers").where({ id }).first().timeout(QUERY_TIMEOUT_MS));
}

export async function findWorkerByEmail(store, email) {
  return data(await store.db("mhb_workers").where({ email: String(email || "").trim().toLowerCase() }).first().timeout(QUERY_TIMEOUT_MS));
}

export async function putWorker(store, worker) {
  const row = { id: worker.id, email: worker.email.toLowerCase(), kind: worker.kind, data: JSON.stringify(worker) };
  await store.db("mhb_workers").insert(row).onConflict("id").merge({ email: row.email, kind: row.kind, data: row.data, updated_at: store.db.fn.now() }).timeout(QUERY_TIMEOUT_MS);
}

export function firstName(worker) {
  return String(worker.name || "").trim().split(/\s+/u)[0] || "there";
}

// ---------- Hours and invoices ----------

export async function listLabor(store, { workerId = null, statuses = null, limit = 500 } = {}) {
  const query = store.db("mhb_labor").orderBy([{ column: "work_date", order: "desc" }, { column: "created_at", order: "desc" }]).limit(limit);
  if (workerId) query.where({ worker_id: workerId });
  if (statuses) query.whereIn("status", statuses);
  return (await query.select("data").timeout(QUERY_TIMEOUT_MS)).map(data);
}

export async function getLabor(store, id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,32}$/u.test(id)) return null;
  return data(await store.db("mhb_labor").where({ id }).first().timeout(QUERY_TIMEOUT_MS));
}

export async function putLabor(store, entry) {
  const row = {
    id: entry.id,
    worker_id: entry.workerId,
    kind: entry.kind,
    status: entry.status,
    client_slug: entry.clientSlug || null,
    work_date: entry.workDate,
    amount_cents: entry.amountCents || 0,
    data: JSON.stringify(entry)
  };
  await store.db("mhb_labor").insert(row).onConflict("id").merge({ ...row, updated_at: store.db.fn.now() }).timeout(QUERY_TIMEOUT_MS);
}

// Hours typed as "8", "7.5" or "7:30" become hundredths of an hour; up to 24 in a day.
export function parseHours(value) {
  const text = String(value || "").trim();
  let hundredths = null;
  const clock = text.match(/^(\d{1,2}):([0-5]\d)$/u);
  const decimal = text.match(/^(\d{1,2})(?:\.(\d{1,2}))?$/u);
  if (clock) hundredths = Number(clock[1]) * 100 + Math.round((Number(clock[2]) / 60) * 100);
  else if (decimal) hundredths = Number(decimal[1]) * 100 + Number((decimal[2] || "").padEnd(2, "0"));
  return hundredths && hundredths > 0 && hundredths <= 2400 ? hundredths : null;
}

export function hoursText(hundredths) {
  const hours = Number(hundredths) / 100;
  return `${hours.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${hours === 1 ? "hour" : "hours"}`;
}

// What hours cost at a rate: hundredths of an hour times cents per hour, rounded to the cent.
export function hoursCost(hundredths, rateCents) {
  return Math.round((Number(hundredths) * Number(rateCents)) / 100);
}

export function laborLabel(entry, worker) {
  const who = worker?.name || entry.workerName || "A worker";
  return entry.kind === "hours" ? `${who} · ${hoursText(entry.hours)} on ${entry.workDate}` : `${who} · invoice ${entry.invoiceNumber || ""}`.trim();
}

// ---------- Employer details ----------

export async function getSetting(store, key) {
  return data(await store.db("mhb_settings").where({ key }).first().timeout(QUERY_TIMEOUT_MS));
}

export async function putSetting(store, key, value) {
  await store.db("mhb_settings").insert({ key, data: JSON.stringify(value) }).onConflict("key").merge({ data: JSON.stringify(value), updated_at: store.db.fn.now() }).timeout(QUERY_TIMEOUT_MS);
}

export async function getEmployer(store) {
  return { ...DEFAULT_EMPLOYER, ...((await getSetting(store, "employer")) || {}) };
}

// ---------- Crew sign-in ----------

function cookieLine(value, maxAge) {
  return `${CREW_COOKIE}=${value}; Max-Age=${maxAge}; Path=/clients; HttpOnly; Secure; SameSite=Lax`;
}

// The session names the worker and their session version: a password change, deactivation or
// "sign out everywhere" raises the version, which ends every earlier session.
export async function createCrewSession(secret, worker) {
  const expiry = Math.floor(Date.now() / 1000) + CREW_SESSION_TTL_SECONDS;
  const version = worker.sessionVersion || 1;
  const signature = await hmacSign(secret, `mhb-crew:v1:${worker.id}:${version}:${expiry}`);
  return cookieLine(`${worker.id}.${version}.${expiry}.${signature}`, CREW_SESSION_TTL_SECONDS);
}

export function expiredCrewSession() {
  return `${CREW_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/clients; HttpOnly; Secure; SameSite=Lax`;
}

export async function readCrewSession(request, secret) {
  const parts = readCookie(request, CREW_COOKIE).split(".");
  if (parts.length !== 4) return null;
  const [workerId, versionText, expiryText, signature] = parts;
  const version = Number(versionText);
  const expiry = Number(expiryText);
  if (!/^[A-Za-z0-9_-]{8,32}$/u.test(workerId) || !Number.isSafeInteger(version) || !Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) return null;
  const expected = await hmacSign(secret, `mhb-crew:v1:${workerId}:${version}:${expiry}`);
  return (await constantTimeMatches(signature, expected)) ? { workerId, version } : null;
}

// An invite or reset link carries a random token; only its hash is kept, with an expiry.
export async function linkToken(token) {
  return sha256Hex(`mhb-crew-link:${token}`);
}
