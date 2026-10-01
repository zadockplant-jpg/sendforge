// Routes for running the team: the Schedule (/clients/admin/schedule) and Important notes
// (/clients/admin/notes, and /clients/crew/notes for team leaders). handler.js and crew.js pass
// `kit`, their response helpers.
import { randomId, readBoundedForm } from "./security.js";
import { isValidDate, todayInMichigan } from "./billing.js";
import { listClients } from "./store.js";
import { record } from "./books.js";
import { listWorkers } from "./labor.js";
import { MAX_NOTE, NOTE_STATUS, deleteNote, getNote, listNotes, nextStatus, putNote } from "./notes.js";
import { addDaysTo, deleteScheduleEntry, getScheduleEntry, listSchedule, monthOf, monthWeeks, putScheduleEntry } from "./schedule.js";
import { adminNotesPage, adminSchedulePage, scheduleEntryPage } from "./team-pages.js";

const MAX_FORM_BYTES = 16 * 1024;
const ID = "([A-Za-z0-9_-]{8,32})";

export const TEAM_NOTICES = {
  "note-added": { text: "Note added." },
  "note-updated": { text: "Note updated." },
  "note-deleted": { text: "Note deleted." },
  "note-invalid": { text: `Write the note, up to ${MAX_NOTE.toLocaleString("en-US")} characters.`, tone: "error" },
  "schedule-added": { text: "Added to the schedule." },
  "schedule-saved": { text: "Schedule saved." },
  "schedule-deleted": { text: "Removed from the schedule." },
  "schedule-date-invalid": { text: "Enter the start date, and an end date on or after it within a year.", tone: "error" },
  "schedule-empty": { text: "Choose a job or a crew, or write a note.", tone: "error" },
  "schedule-invalid": { text: "Please check the form and try again.", tone: "error" }
};

function noticeFrom(url) {
  return TEAM_NOTICES[url.searchParams.get("notice")] || null;
}

// ---------- Important notes ----------

// Adds a note from the admin or a team leader; returns the notice code.
export async function addNote(store, { text, author, ip }) {
  const body = String(text || "").trim().replaceAll(/\r\n?/gu, "\n");
  if (!body || body.length > MAX_NOTE) return "note-invalid";
  const now = new Date().toISOString();
  await putNote(store, { id: randomId(12), text: body, status: "open", author, createdAt: now, updatedAt: now, history: [] });
  await record(store, { actor: author.kind, ip, action: "note.added", summary: `${author.name} added an important note: ${body.length > 120 ? `${body.slice(0, 117)}...` : body}`, data: author.workerId ? { workerId: author.workerId } : {} });
  return "note-added";
}

// Moves a note to In progress, Completed or Contingent (or back to open when chosen again).
export async function changeNote(store, id, chosen, { by, actor, ip }) {
  const note = await getNote(store, id);
  if (!note) return null;
  const status = nextStatus(note, chosen);
  if (!status) return "note-invalid";
  const at = new Date().toISOString();
  await putNote(store, { ...note, status, updatedAt: at, history: [...(note.history || []), { status, by, at }] });
  await record(store, { actor, ip, action: "note.status", summary: `${by} marked an important note ${NOTE_STATUS[status]}: ${note.text.length > 80 ? `${note.text.slice(0, 77)}...` : note.text}` });
  return "note-updated";
}

async function handleNotes(context, store, pathname, url) {
  const { kit } = context;
  const method = context.request.method;
  const ip = kit.requestIp(context.request);
  if (pathname === "/clients/admin/notes") {
    if (method === "GET" || method === "HEAD") return kit.scriptedHtmlResponse(adminNotesPage({ notes: await listNotes(store), status: noticeFrom(url) }));
    if (method !== "POST") return kit.methodNotAllowedResponse(["GET", "HEAD", "POST"]);
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const result = await addNote(store, { text: form?.get("text"), author: { kind: "admin", name: "Admin" }, ip });
    return kit.redirectResponse(`/clients/admin/notes?notice=${result}`);
  }
  const match = pathname.match(new RegExp(`^/clients/admin/notes/${ID}/(status|delete)$`, "u"));
  if (!match) return kit.notFound();
  if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
  if (match[2] === "delete") {
    const note = await getNote(store, match[1]);
    if (!note) return kit.notFound();
    await deleteNote(store, note.id);
    await record(store, { actor: "admin", ip, action: "note.deleted", summary: `Deleted the important note: ${note.text.length > 120 ? `${note.text.slice(0, 117)}...` : note.text}` });
    return kit.redirectResponse("/clients/admin/notes?notice=note-deleted");
  }
  const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
  const result = await changeNote(store, match[1], String(form?.get("status") || ""), { by: "Admin", actor: "admin", ip });
  if (!result) return kit.notFound();
  return kit.redirectResponse(`/clients/admin/notes?notice=${result}#note-${match[1]}`);
}

// ---------- The schedule ----------

// Reads the schedule form; returns { entry fields } or { error } (a notice code).
function readEntry(form, { clients, workers }) {
  const job = String(form?.get("job") || "");
  const startsOn = String(form?.get("startsOn") || "").trim();
  const endsTyped = String(form?.get("endsOn") || "").trim();
  const endsOn = endsTyped || startsOn;
  const time = String(form?.get("time") || "").trim().replaceAll(/\s+/gu, " ");
  const notes = String(form?.get("notes") || "").trim().replaceAll(/\r\n?/gu, "\n");
  const known = new Set(workers.map((worker) => worker.id));
  const crew = [...new Set((form?.getAll("crew") || []).map(String))].filter((id) => known.has(id));
  if (!form) return { error: "schedule-invalid" };
  if (job && !clients.some((client) => client.slug === job)) return { error: "schedule-invalid" };
  if (!isValidDate(startsOn) || !isValidDate(endsOn) || endsOn < startsOn || endsOn > addDaysTo(startsOn, 366)) return { error: "schedule-date-invalid" };
  if (time.length > 40 || notes.length > 1000) return { error: "schedule-invalid" };
  if (!job && !crew.length && !notes) return { error: "schedule-empty" };
  return { fields: { clientSlug: job, startsOn, endsOn, time, crew, notes } };
}

function summaryOf(entry, clients, workers) {
  const job = entry.clientSlug ? clients.find((client) => client.slug === entry.clientSlug)?.name || entry.clientSlug : "a note";
  const crew = entry.crew.map((id) => workers.find((worker) => worker.id === id)?.name).filter(Boolean);
  return `${job}, ${entry.startsOn}${entry.endsOn !== entry.startsOn ? ` to ${entry.endsOn}` : ""}${crew.length ? ` (${crew.join(", ")})` : ""}`;
}

async function handleSchedule(context, store, pathname, url) {
  const { kit } = context;
  const method = context.request.method;
  const isRead = method === "GET" || method === "HEAD";
  const ip = kit.requestIp(context.request);
  const [clients, workers] = await Promise.all([listClients(store), listWorkers(store)]);
  const today = todayInMichigan();
  const monthPath = (day) => `/clients/admin/schedule?month=${day.slice(0, 7)}`;

  if (pathname === "/clients/admin/schedule") {
    if (isRead) {
      const month = monthOf(url.searchParams.get("month"), today);
      const weeks = monthWeeks(month);
      const entries = await listSchedule(store, { from: weeks[0][0], to: weeks.at(-1)[6] });
      return kit.scriptedHtmlResponse(adminSchedulePage({ month, weeks, entries, clients, workers, today, status: noticeFrom(url) }));
    }
    if (method !== "POST") return kit.methodNotAllowedResponse(["GET", "HEAD", "POST"]);
    const read = readEntry(await readBoundedForm(context.request, MAX_FORM_BYTES), { clients, workers });
    if (read.error) return kit.redirectResponse(`/clients/admin/schedule?notice=${read.error}`);
    const entry = { id: randomId(12), ...read.fields, createdAt: new Date().toISOString() };
    await putScheduleEntry(store, entry);
    await record(store, { actor: "admin", ip, action: "schedule.added", clientSlug: entry.clientSlug || null, summary: `Scheduled ${summaryOf(entry, clients, workers)}`, data: { scheduleId: entry.id } });
    return kit.redirectResponse(`${monthPath(entry.startsOn)}&notice=schedule-added`);
  }

  if (pathname === "/clients/admin/schedule/new") {
    if (!isRead) return kit.methodNotAllowedResponse(["GET", "HEAD"]);
    const date = isValidDate(url.searchParams.get("date") || "") ? url.searchParams.get("date") : today;
    return kit.scriptedHtmlResponse(scheduleEntryPage({ clients, workers, date, status: noticeFrom(url) }));
  }

  const match = pathname.match(new RegExp(`^/clients/admin/schedule/${ID}(?:/(delete))?$`, "u"));
  if (!match) return kit.notFound();
  const entry = await getScheduleEntry(store, match[1]);
  if (!entry) return kit.notFound();
  if (match[2] === "delete") {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    await deleteScheduleEntry(store, entry.id);
    await record(store, { actor: "admin", ip, action: "schedule.deleted", clientSlug: entry.clientSlug || null, summary: `Removed from the schedule: ${summaryOf(entry, clients, workers)}`, data: { scheduleId: entry.id } });
    return kit.redirectResponse(`${monthPath(entry.startsOn)}&notice=schedule-deleted`);
  }
  if (isRead) return kit.scriptedHtmlResponse(scheduleEntryPage({ entry, clients, workers, status: noticeFrom(url) }));
  if (method !== "POST") return kit.methodNotAllowedResponse(["GET", "HEAD", "POST"]);
  const read = readEntry(await readBoundedForm(context.request, MAX_FORM_BYTES), { clients, workers });
  if (read.error) return kit.redirectResponse(`/clients/admin/schedule/${encodeURIComponent(entry.id)}?notice=${read.error}`);
  const saved = { ...entry, ...read.fields, updatedAt: new Date().toISOString() };
  await putScheduleEntry(store, saved);
  await record(store, { actor: "admin", ip, action: "schedule.changed", clientSlug: saved.clientSlug || null, summary: `Changed the schedule: ${summaryOf(saved, clients, workers)}`, data: { scheduleId: saved.id } });
  return kit.redirectResponse(`${monthPath(saved.startsOn)}&notice=schedule-saved`);
}

// A crew member's upcoming schedule (the crew portal): today through the next 45 days.
export async function upcomingFor(store, workerId) {
  const today = todayInMichigan();
  const entries = await listSchedule(store, { from: today, to: addDaysTo(today, 45) });
  return entries.filter((entry) => (entry.crew || []).includes(workerId));
}

// Only reached with an admin session (handler.js checks it).
export async function handleAdminTeam(context, store, pathname, url) {
  if (pathname === "/clients/admin/notes" || pathname.startsWith("/clients/admin/notes/")) return handleNotes(context, store, pathname, url);
  return handleSchedule(context, store, pathname, url);
}
