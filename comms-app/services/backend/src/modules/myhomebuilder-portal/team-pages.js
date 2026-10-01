// Pages for running the team: the Schedule (a month calendar of crews scheduled to jobs, with
// notes) and Important notes (the board the admin and team leaders share), with their parts in
// the crew portal. team.js decides what each shows.
import { dateText, escapeAttribute, pageShell } from "./pages.js";
import { escapeHtml } from "./format.js";
import { MAX_NOTE, NOTE_STATUS, NOTE_STEPS } from "./notes.js";
import { monthName, shiftMonth } from "./schedule.js";
import { WORKER_KINDS, firstName } from "./labor.js";

const BILLING_SCRIPT = "/clients/portal/billing.js";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TRASH_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.5h13"/><path d="M8 5.5V3.8h4v1.7"/><path d="M5.2 5.5l.8 11h8l.8-11"/><path d="M8.4 8.6v5.2M11.6 8.6v5.2"/></g></svg>';
const momentFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/Detroit", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function moment(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : momentFormat.format(date);
}

function notice(status) {
  if (!status) return "";
  return `<p class="${status.tone === "error" ? "portal-error" : "portal-notice"}" role="status">${escapeHtml(status.text)}</p>`;
}

function adminShell(content, { title, scripts = [BILLING_SCRIPT] }) {
  return pageShell(content, { admin: true, bodyClass: "portal-page portal-admin", title, scripts });
}

// ---------- Important notes ----------

function noteCard(note, { base, canDelete }) {
  const last = (note.history || []).at(-1);
  const steps = NOTE_STEPS.map((step) => {
    const current = note.status === step;
    return `<form method="post" action="${base}/${encodeURIComponent(note.id)}/status">
              <input type="hidden" name="status" value="${step}">
              <button class="note-step note-step-${step}${current ? " is-current" : ""}" type="submit" aria-pressed="${current}">${NOTE_STATUS[step]}</button>
            </form>`;
  }).join("");
  return `<article class="note-card note-${note.status}" id="note-${escapeAttribute(note.id)}">
          <p class="note-text">${escapeHtml(note.text).replaceAll("\n", "<br>")}</p>
          <p class="note-meta">${escapeHtml(note.author?.name || "Admin")} · ${escapeHtml(moment(note.createdAt))}${last ? ` · ${escapeHtml(NOTE_STATUS[last.status] || last.status)} by ${escapeHtml(last.by)}, ${escapeHtml(moment(last.at))}` : ""}</p>
          <div class="note-steps">
            ${steps}
            ${canDelete ? `<form method="post" action="${base}/${encodeURIComponent(note.id)}/delete" data-confirm="Delete this note? This can't be undone.">
              <button class="billing-trash" type="submit" aria-label="Delete this note" title="Delete">${TRASH_ICON}</button>
            </form>` : ""}
          </div>
        </article>`;
}

// The board: add a note, the notes still going (newest first), then completed ones folded away.
export function notesBoard({ notes, base, canDelete }) {
  const active = notes.active.length
    ? notes.active.map((note) => noteCard(note, { base, canDelete })).join("")
    : '<p class="portal-empty">No open notes.</p>';
  const completed = notes.completed.length
    ? `<details class="notes-completed">
          <summary>Completed (${notes.completedTotal})</summary>
          ${notes.completed.map((note) => noteCard(note, { base, canDelete })).join("")}
        </details>`
    : "";
  return `<form class="portal-form note-add" method="post" action="${base}">
          <label for="note-text">New note
            <textarea id="note-text" name="text" rows="3" maxlength="${MAX_NOTE}" required placeholder="What the team needs to know"></textarea>
          </label>
          <button class="button button-solid" type="submit">Add note</button>
        </form>
        <div class="notes-list">${active}</div>
        ${completed}`;
}

export function adminNotesPage({ notes, status = null }) {
  return adminShell(`<div class="site-width portal-shell">
      <section class="admin-intro">
        <p class="portal-kicker">Admin panel</p>
        <h1 class="portal-heading">Important notes.</h1>
        <p class="portal-lead">Notes between you and the team leaders. Mark each In progress, Completed or Contingent; choosing its mark again sets it back to open. Team leaders see this board in their crew portal.</p>
        ${notice(status)}
      </section>
      <section class="notes-board" aria-label="Important notes">
        ${notesBoard({ notes, base: "/clients/admin/notes", canDelete: true })}
      </section>
    </div>`, { title: "Important notes" });
}

// ---------- The schedule ----------

// A job goes by its label: a project inside a client portal has the portal's name first.
function jobName(clients, slug) {
  if (!slug) return "";
  const client = clients.find((entry) => entry.slug === slug);
  return client ? client.label || client.name : slug;
}

function crewNames(entry, workers) {
  return (entry.crew || []).map((id) => workers.find((worker) => worker.id === id)).filter(Boolean);
}

// The form for one entry: a popup on the calendar, and the page to add or change one.
export function scheduleFields({ entry = null, clients, workers, action, date = "", submit }) {
  const value = entry || { startsOn: date, endsOn: "", clientSlug: "", crew: [], time: "", notes: "" };
  const crew = new Set(value.crew || []);
  const people = workers.filter((worker) => worker.active !== false || crew.has(worker.id));
  return `<form class="admin-stack-form schedule-form" method="post" action="${escapeAttribute(action)}">
            <label for="schedule-job">Job
              <select id="schedule-job" name="job">
                <option value=""${value.clientSlug ? "" : " selected"}>No job (a note for the day)</option>
                ${clients.filter((client) => !client.archivedAt || client.slug === value.clientSlug).map((client) => `<option value="${escapeAttribute(client.slug)}"${client.slug === value.clientSlug ? " selected" : ""}>${escapeHtml(client.label || client.name)}</option>`).join("")}
              </select>
            </label>
            <div class="schedule-when">
              <label for="schedule-starts">Starts
                <input id="schedule-starts" name="startsOn" type="date" required value="${escapeAttribute(value.startsOn || "")}" data-schedule-date>
              </label>
              <label for="schedule-ends">Ends (optional)
                <input id="schedule-ends" name="endsOn" type="date" value="${escapeAttribute(value.endsOn && value.endsOn !== value.startsOn ? value.endsOn : "")}">
              </label>
              <label for="schedule-time">Time (optional)
                <input id="schedule-time" name="time" type="text" maxlength="40" value="${escapeAttribute(value.time || "")}" placeholder="7:30 AM">
              </label>
            </div>
            <fieldset class="schedule-crew">
              <legend>Crew</legend>
              ${people.length
                ? people.map((worker) => `<label class="portal-check" for="crew-${escapeAttribute(worker.id)}"><input id="crew-${escapeAttribute(worker.id)}" name="crew" type="checkbox" value="${escapeAttribute(worker.id)}"${crew.has(worker.id) ? " checked" : ""}><span>${escapeHtml(worker.name)}<small>${escapeHtml([WORKER_KINDS[worker.kind]?.replace(/ \(.*\)$/u, ""), worker.trade].filter(Boolean).join(" · "))}</small></span></label>`).join("")
                : '<p class="admin-meta">Add employees and subcontractors in Labor to schedule them.</p>'}
            </fieldset>
            <label for="schedule-notes">Notes
              <textarea id="schedule-notes" name="notes" rows="4" maxlength="1000" placeholder="What to bring, where to meet, what comes first">${escapeHtml(value.notes || "")}</textarea>
            </label>
            <button class="button button-solid" type="submit">${escapeHtml(submit)}</button>
          </form>`;
}

function entryBlock(entry, { clients, workers, doubled }) {
  const job = jobName(clients, entry.clientSlug);
  const crew = crewNames(entry, workers);
  return `<a class="cal-entry${job ? "" : " is-note"}" href="/clients/admin/schedule/${encodeURIComponent(entry.id)}">
              <strong>${escapeHtml(job || "Note")}</strong>
              ${entry.time ? `<span class="cal-time">${escapeHtml(entry.time)}</span>` : ""}
              ${crew.length ? `<span class="cal-crew">${crew.map((worker) => `<span class="cal-person${doubled.has(worker.id) ? " is-doubled" : ""}"${doubled.has(worker.id) ? ' title="Also scheduled elsewhere this day"' : ""}>${escapeHtml(firstName(worker))}</span>`).join("")}</span>` : ""}
              ${entry.notes ? `<span class="cal-notes">${escapeHtml(entry.notes.length > 90 ? `${entry.notes.slice(0, 88)}…` : entry.notes)}</span>` : ""}
            </a>`;
}

export function adminSchedulePage({ month, weeks, entries, clients, workers, today, status = null }) {
  const rows = weeks.map((week) => `<tr>${week.map((day) => {
    const onDay = entries.filter((entry) => entry.startsOn <= day && entry.endsOn >= day);
    // Someone on two jobs the same day is marked on both.
    const seen = new Map();
    for (const entry of onDay) for (const id of entry.crew || []) seen.set(id, (seen.get(id) || 0) + 1);
    const doubled = new Set([...seen].filter(([, count]) => count > 1).map(([id]) => id));
    const classes = ["cal-day", day.slice(0, 7) === month ? "" : "is-other", day === today ? "is-today" : "", onDay.length ? "" : "is-empty"].filter(Boolean).join(" ");
    return `<td class="${classes}">
            <div class="cal-day-head">
              <span class="cal-date"><span class="cal-weekday">${WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]} </span>${Number(day.slice(8))}</span>
              <a class="cal-add" href="/clients/admin/schedule/new?date=${day}" data-schedule-add data-date="${day}" aria-label="Add to ${escapeAttribute(dateText(day))}" title="Add">+</a>
            </div>
            ${onDay.map((entry) => entryBlock(entry, { clients, workers, doubled })).join("")}
          </td>`;
  }).join("")}</tr>`).join("");
  return adminShell(`<div class="site-width portal-shell">
      <section class="admin-intro">
        <p class="portal-kicker">Admin panel</p>
        <h1 class="portal-heading">Schedule.</h1>
        <p class="portal-lead">Crews scheduled to jobs. Click a day's + to add to it, and an entry to change it. Each person sees their own schedule in the crew portal.</p>
        ${notice(status)}
      </section>
      <div class="cal-head">
        <a class="portal-secondary-link" href="/clients/admin/schedule?month=${shiftMonth(month, -1)}">← ${escapeHtml(monthName(shiftMonth(month, -1)).split(" ")[0])}</a>
        <h2>${escapeHtml(monthName(month))}</h2>
        <a class="portal-secondary-link" href="/clients/admin/schedule?month=${shiftMonth(month, 1)}">${escapeHtml(monthName(shiftMonth(month, 1)).split(" ")[0])} →</a>
        <a class="portal-secondary-link" href="/clients/admin/schedule">Today</a>
        <a class="button button-solid" href="/clients/admin/schedule/new?date=${today}" data-schedule-add data-date="${today}">Add to the schedule</a>
      </div>
      <table class="cal-grid">
        <thead><tr>${WEEKDAYS.map((name) => `<th scope="col">${name}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <dialog class="admin-dialog schedule-dialog" id="schedule-dialog" aria-labelledby="schedule-dialog-title">
        <div class="admin-dialog-head">
          <h2 id="schedule-dialog-title">Add to the schedule</h2>
          <button class="admin-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
        </div>
        ${scheduleFields({ clients, workers, action: "/clients/admin/schedule", date: today, submit: "Add to the schedule" })}
      </dialog>
    </div>`, { title: "Schedule" });
}

export function scheduleEntryPage({ entry = null, clients, workers, date = "", status = null }) {
  const month = (entry?.startsOn || date).slice(0, 7);
  return adminShell(`<div class="site-width portal-shell portal-detail">
      <p class="portal-kicker"><a class="portal-inline-link" href="/clients/admin/schedule?month=${escapeAttribute(month)}">Schedule</a></p>
      <h1 class="portal-heading portal-heading-sm">${entry ? "Change the schedule." : "Add to the schedule."}</h1>
      ${notice(status)}
      <section class="admin-card admin-card-narrow">
        ${scheduleFields({ entry, clients, workers, action: entry ? `/clients/admin/schedule/${encodeURIComponent(entry.id)}` : "/clients/admin/schedule", date, submit: entry ? "Save changes" : "Add to the schedule" })}
        ${entry ? `<form class="admin-danger" method="post" action="/clients/admin/schedule/${encodeURIComponent(entry.id)}/delete" data-confirm="Remove this from the schedule? This can't be undone.">
          <button class="portal-logout-button" type="submit">Remove from the schedule</button>
        </form>` : ""}
      </section>
    </div>`, { title: entry ? "Change the schedule" : "Add to the schedule" });
}

// ---------- In the crew portal ----------

// A crew member's upcoming days: when, which job and where, the time and the notes.
export function crewScheduleSection({ entries, clients }) {
  if (!entries.length) return "";
  const rows = entries.map((entry) => {
    const client = clients.find((candidate) => candidate.slug === entry.clientSlug);
    const when = entry.endsOn && entry.endsOn !== entry.startsOn ? `${dateText(entry.startsOn)} to ${dateText(entry.endsOn)}` : dateText(entry.startsOn);
    return `<tr>
          <td data-label="When">${when}${entry.time ? `<small>${escapeHtml(entry.time)}</small>` : ""}</td>
          <td data-label="Job">${escapeHtml(client?.label || client?.name || (entry.clientSlug ? entry.clientSlug : "Note"))}${client?.siteAddress ? `<small>${escapeHtml(client.siteAddress)}</small>` : ""}</td>
          <td data-label="Notes">${entry.notes ? escapeHtml(entry.notes).replaceAll("\n", "<br>") : ""}</td>
        </tr>`;
  }).join("");
  return `<section class="portal-section" aria-labelledby="schedule-heading">
        <h2 id="schedule-heading">Your schedule</h2>
        <table class="portal-table crew-schedule">
          <thead><tr><th scope="col">When</th><th scope="col">Job</th><th scope="col">Notes</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

export function crewNotesSection({ notes }) {
  return `<section class="portal-section notes-board" aria-labelledby="crew-notes-heading">
        <h2 id="crew-notes-heading">Important notes</h2>
        <p class="portal-lead">Notes between My Home Builder and the team leaders. Mark each In progress, Completed or Contingent.</p>
        ${notesBoard({ notes, base: "/clients/crew/notes", canDelete: false })}
      </section>`;
}
