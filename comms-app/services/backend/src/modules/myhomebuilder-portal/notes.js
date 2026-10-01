// Important notes: what the admin and the team leaders (crew marked Team leader in Labor) leave
// each other. Anyone on the board adds a note and moves it to In progress, Completed or Contingent;
// each change keeps who made it and when. Table from 20261008_myhomebuilder_portal_notes_schedule.js.

const QUERY_TIMEOUT_MS = 5000;

export const NOTE_STATUS = { open: "Open", "in-progress": "In progress", completed: "Completed", contingent: "Contingent" };
export const NOTE_STEPS = ["in-progress", "completed", "contingent"];
export const MAX_NOTE = 1000;

function data(row) {
  if (!row) return null;
  return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
}

// Not completed first (newest first), then completed (most recently completed first).
export async function listNotes(store, { completedLimit = 50 } = {}) {
  const active = (await store.db("mhb_notes").whereNot({ status: "completed" }).orderBy("created_at", "desc").select("data").timeout(QUERY_TIMEOUT_MS)).map(data);
  const completed = (await store.db("mhb_notes").where({ status: "completed" }).orderBy("updated_at", "desc").limit(completedLimit).select("data").timeout(QUERY_TIMEOUT_MS)).map(data);
  const completedTotal = Number((await store.db("mhb_notes").where({ status: "completed" }).count({ n: "*" }).first().timeout(QUERY_TIMEOUT_MS)).n);
  return { active, completed, completedTotal };
}

export async function getNote(store, id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,32}$/u.test(id)) return null;
  return data(await store.db("mhb_notes").where({ id }).first().timeout(QUERY_TIMEOUT_MS));
}

export async function putNote(store, note) {
  const row = { id: note.id, status: note.status, data: JSON.stringify(note) };
  await store.db("mhb_notes").insert(row).onConflict("id").merge({ ...row, updated_at: store.db.fn.now() }).timeout(QUERY_TIMEOUT_MS);
}

export async function deleteNote(store, id) {
  await store.db("mhb_notes").where({ id }).del().timeout(QUERY_TIMEOUT_MS);
}

// Choosing a note's current step again moves it back to Open.
export function nextStatus(note, chosen) {
  if (!NOTE_STEPS.includes(chosen)) return null;
  return note.status === chosen ? "open" : chosen;
}
