// The job schedule: crews (employees and subcontractors from Labor) scheduled to jobs (client
// portals) from a start date to an end date, with a time and notes. An entry without a job is a
// note for those days. Table from 20261008_myhomebuilder_portal_notes_schedule.js.

const QUERY_TIMEOUT_MS = 5000;

function data(row) {
  if (!row) return null;
  return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
}

function toEntry(row) {
  const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
  return { ...data(row), id: row.id, startsOn: day(row.starts_on), endsOn: day(row.ends_on), clientSlug: row.client_slug || "" };
}

function entryQuery(store) {
  return store.db("mhb_schedule").select("id", "client_slug", "data", store.db.raw("to_char(starts_on, 'YYYY-MM-DD') AS starts_on"), store.db.raw("to_char(ends_on, 'YYYY-MM-DD') AS ends_on"));
}

// Entries touching the days from `from` to `to` (YYYY-MM-DD, inclusive), earliest first.
export async function listSchedule(store, { from, to }) {
  const rows = await entryQuery(store).where("starts_on", "<=", to).andWhere("ends_on", ">=", from).orderBy([{ column: "starts_on" }, { column: "created_at" }]).timeout(QUERY_TIMEOUT_MS);
  return rows.map(toEntry);
}

export async function getScheduleEntry(store, id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,32}$/u.test(id)) return null;
  const row = await entryQuery(store).where({ id }).first().timeout(QUERY_TIMEOUT_MS);
  return row ? toEntry(row) : null;
}

export async function putScheduleEntry(store, entry) {
  const { id, startsOn, endsOn, clientSlug, ...rest } = entry;
  const row = { id, starts_on: startsOn, ends_on: endsOn, client_slug: clientSlug || null, data: JSON.stringify(rest) };
  await store.db("mhb_schedule").insert(row).onConflict("id").merge({ ...row, updated_at: store.db.fn.now() }).timeout(QUERY_TIMEOUT_MS);
}

export async function deleteScheduleEntry(store, id) {
  await store.db("mhb_schedule").where({ id }).del().timeout(QUERY_TIMEOUT_MS);
}

// ---------- Dates ----------

export function addDaysTo(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weekday(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

// The month a page shows (YYYY-MM), from the query or today's.
export function monthOf(value, today) {
  return /^\d{4}-(0[1-9]|1[0-2])$/u.test(String(value || "")) ? value : today.slice(0, 7);
}

export function shiftMonth(month, by) {
  const [year, number] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, number - 1 + by, 1));
  return date.toISOString().slice(0, 7);
}

// The weeks (Sunday to Saturday) covering a month: rows of seven YYYY-MM-DD days.
export function monthWeeks(month) {
  const first = `${month}-01`;
  const start = addDaysTo(first, -weekday(first));
  const last = addDaysTo(`${shiftMonth(month, 1)}-01`, -1);
  const end = addDaysTo(last, 6 - weekday(last));
  const weeks = [];
  for (let day = start; day <= end; day = addDaysTo(day, 7)) weeks.push(Array.from({ length: 7 }, (_, index) => addDaysTo(day, index)));
  return weeks;
}

export function monthName(month) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
