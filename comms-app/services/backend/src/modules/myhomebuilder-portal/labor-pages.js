// Pages for labor: the crew portal (sign-in, paperwork, hours and invoices, lien waivers) and the
// admin Labor pages. crew.js decides what each shows.
import { dateText, escapeAttribute, pageShell } from "./pages.js";
import { escapeHtml, money } from "./format.js";
import { moneyInput } from "./billing.js";
import { FORMS, PAPERWORK } from "./forms.js";
import { WAIVERS, waiverAmount, waiverParagraphs } from "./waivers.js";
import { CREW_SECTIONS, LABOR_PAYMENT_METHODS, LABOR_STATUS, WORKER_KINDS, firstName, hoursCost, hoursText } from "./labor.js";

const SIGN_SCRIPT = "/clients/portal/sign.js";
const BILLING_SCRIPT = "/clients/portal/billing.js";

function notice(value) {
  if (!value) return "";
  return `<p class="${value.tone === "error" ? "portal-error" : "portal-notice"}" role="status">${escapeHtml(value.text)}</p>`;
}

function crewShell(content, { title, scripts = [], signedIn = true }) {
  return pageShell(content, { crew: signedIn, crewSignedOut: !signedIn, title, scripts, bodyClass: "portal-page crew-page", navCurrent: null });
}

function adminShell(content, { title, scripts = [] }) {
  return pageShell(content, { admin: true, bodyClass: "portal-page portal-admin", title, scripts });
}

const statusTone = { submitted: "open", approved: "paid", paid: "paid", returned: "void", waiver: "open" };
function statusBadge(entry) {
  return `<span class="portal-status portal-status-${statusTone[entry.status] || "neutral"}">${escapeHtml(LABOR_STATUS[entry.status] || entry.status)}</span>`;
}

function jobName(clients, slug) {
  if (!slug) return "Shop or not on a job";
  return clients.find((client) => client.slug === slug)?.name || slug;
}

function jobOptions(clients, selected) {
  return [`<option value=""${selected ? "" : " selected"}>Shop or not on a job</option>`,
    ...clients.map((client) => `<option value="${escapeAttribute(client.slug)}"${client.slug === selected ? " selected" : ""}>${escapeHtml(client.name)}</option>`)].join("");
}

function workSummary(entry) {
  if (entry.kind === "hours") return `${hoursText(entry.hours)} on ${dateText(entry.workDate)}`;
  return `Invoice ${entry.invoiceNumber} · ${dateText(entry.workDate)}${entry.final ? " · final for this job" : ""}`;
}

// ---------- Crew: signing in ----------

export function crewLoginPage({ error = "", email = "", sent = false, status = null } = {}) {
  return crewShell(`<div class="site-width portal-shell portal-login-grid">
      <section>
        <p class="portal-kicker">Crew portal</p>
        <h1 class="portal-heading">Crew and subcontractors.</h1>
        <p class="portal-lead">Sign in to send your hours and invoices, and to fill out and sign your paperwork for My Home Builder.</p>
      </section>
      <form class="portal-login-card" action="/clients/crew/login" method="post">
        <h2>Sign in</h2>
        ${error ? `<p class="portal-error" role="alert">${escapeHtml(error)}</p>` : ""}
        ${status ? notice(status) : ""}
        <label for="crew-email">Email
          <input id="crew-email" name="email" type="email" autocomplete="username" maxlength="254" required value="${escapeAttribute(email)}" autofocus>
        </label>
        <label for="crew-password">Password
          <input id="crew-password" name="password" type="password" autocomplete="current-password" maxlength="200" required>
        </label>
        <button class="button button-solid" type="submit">Sign in</button>
      </form>
      <form class="portal-admin-entry" action="/clients/crew/forgot" method="post">
        <span>${sent ? "If that email is on file, a link to choose a new password is on its way." : "Forgot your password?"}</span>
        <div class="portal-admin-entry-actions">
          <input class="crew-forgot-email" name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com" aria-label="Email for the reset link">
          <button class="portal-logout-button" type="submit">Email me a link</button>
        </div>
      </form>
    </div>`, { title: "Crew sign-in", signedIn: false });
}

export function crewPasswordPage({ worker, token, error = "", reset = false }) {
  return crewShell(`<div class="site-width portal-shell portal-login-grid">
      <section>
        <p class="portal-kicker">Crew portal</p>
        <h1 class="portal-heading">${reset ? "Choose a new password." : `Welcome, ${escapeHtml(firstName(worker))}.`}</h1>
        <p class="portal-lead">${reset ? "Choose a new password for the crew portal." : "Choose a password for the My Home Builder crew portal. You sign in with your email and this password."}</p>
      </section>
      <form class="portal-login-card" action="/clients/crew/welcome/${escapeAttribute(token)}" method="post">
        <h2>${escapeHtml(worker.email)}</h2>
        ${error ? `<p class="portal-error" role="alert">${escapeHtml(error)}</p>` : ""}
        <label for="new-password">Password (at least 10 characters)
          <input id="new-password" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="200" required autofocus>
        </label>
        <label for="confirm-password">Type it again
          <input id="confirm-password" name="confirm" type="password" autocomplete="new-password" minlength="10" maxlength="200" required>
        </label>
        <button class="button button-solid" type="submit">Save password</button>
      </form>
    </div>`, { title: "Choose a password", signedIn: false });
}

export function crewLinkExpiredPage() {
  return crewShell(`<div class="site-width portal-shell">
      <p class="portal-kicker">Crew portal</p>
      <h1 class="portal-heading">That link has expired.</h1>
      <p class="portal-lead">Links to choose a password work once and expire. Ask My Home Builder to send a new invite, or use "Forgot your password?" on the <a class="portal-inline-link" href="/clients/crew">crew sign-in page</a>.</p>
    </div>`, { title: "Link expired", signedIn: false });
}

// ---------- Crew: home ----------

function paperworkRows(worker, documents, { secureReady }) {
  const rows = (PAPERWORK[worker.kind] || []).map((key) => {
    const spec = FORMS[key];
    const done = worker.paperwork?.[key];
    const status = done ? `<span class="portal-status portal-status-paid">Signed</span><small>${dateText(done.signedAt)}</small>` : `<span class="portal-status portal-status-open">${spec.optional ? "Optional" : "To do"}</span>`;
    // A W-4, MI-W4, W-9 or direct deposit can be filled out again when something changes; the
    // I-9 is signed once.
    const action = done
      ? `<a class="portal-secondary-link" href="/clients/crew/forms/${key}/pdf">Download</a>${key !== "i9" && secureReady ? `<a class="portal-secondary-link" href="/clients/crew/forms/${key}">Update</a>` : ""}`
      : secureReady ? `<a class="button button-solid button-small" href="/clients/crew/forms/${key}">Fill out and sign</a>` : "<small>Available soon</small>";
    return `<tr><td><strong>${escapeHtml(spec.title)}</strong><small>${escapeHtml(spec.heading)}. ${escapeHtml(spec.summary)}</small></td><td>${status}</td><td class="portal-actions">${action}</td></tr>`;
  });
  if (worker.kind === "subcontractor") {
    const coi = documents.filter((document) => document.section === "insurance" && document.uploadedBy !== "admin");
    rows.push(`<tr><td><strong>Certificate of insurance</strong><small>General liability, and workers' compensation if you have employees.</small></td>
          <td>${coi.length ? `<span class="portal-status portal-status-paid">On file</span><small>${dateText(coi[0].createdAt)}</small>` : '<span class="portal-status portal-status-open">To do</span>'}</td>
          <td class="portal-actions">${coi.length ? `<a class="portal-secondary-link" href="/clients/crew/documents/${encodeURIComponent(coi[0].id)}">Download</a>` : ""}</td></tr>`);
  }
  for (const document of documents.filter((entry) => entry.uploadedBy === "admin")) {
    const signed = document.signatures?.some((entry) => entry.party === "client");
    const needsSign = document.requiresClientSignature && !signed;
    rows.push(`<tr><td><strong>${escapeHtml(document.name)}</strong><small>From My Home Builder · ${dateText(document.createdAt)}</small></td>
          <td><span class="portal-status portal-status-${needsSign ? "open" : signed ? "paid" : "neutral"}">${needsSign ? "To sign" : signed ? "Signed" : "On file"}</span></td>
          <td class="portal-actions"><a class="portal-secondary-link" href="/clients/crew/documents/${encodeURIComponent(document.id)}">Download</a>${needsSign && document.contentType === "application/pdf" ? `<a class="portal-secondary-link" href="/clients/crew/documents/${encodeURIComponent(document.id)}/sign">Sign</a>` : ""}</td></tr>`);
  }
  return `<table class="portal-table crew-paperwork">
        <thead><tr><th scope="col">Paperwork</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
}

function historyRows(entries, clients) {
  if (!entries.length) return '<p class="portal-empty">Nothing sent yet.</p>';
  const rows = entries.map((entry) => {
    const files = [
      entry.fileKey ? `<a class="portal-secondary-link" href="/clients/crew/bills/${encodeURIComponent(entry.id)}/file">Invoice</a>` : "",
      entry.waiver?.fileKey ? `<a class="portal-secondary-link" href="/clients/crew/bills/${encodeURIComponent(entry.id)}/waiver.pdf">Lien waiver</a>` : "",
      entry.status === "waiver" ? `<a class="portal-secondary-link" href="/clients/crew/bills/${encodeURIComponent(entry.id)}/waiver">Sign lien waiver</a>` : ""
    ].filter(Boolean).join("");
    return `<tr>
          <td>${escapeHtml(workSummary(entry))}${entry.description ? `<small>${escapeHtml(entry.description)}</small>` : ""}</td>
          <td>${escapeHtml(jobName(clients, entry.clientSlug))}</td>
          <td>${entry.kind === "hours" ? escapeHtml(hoursText(entry.hours)) : money(entry.amountCents)}</td>
          <td>${statusBadge(entry)}${entry.status === "returned" && entry.returnNote ? `<small>${escapeHtml(entry.returnNote)}</small>` : ""}${entry.status === "paid" ? `<small>${dateText(entry.payment?.paidOn)}</small>` : ""}</td>
          <td class="portal-actions">${files}</td>
        </tr>`;
  });
  return `<table class="portal-table">
        <thead><tr><th scope="col">Work</th><th scope="col">Job</th><th scope="col">Hours or amount</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Files</span></th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
}

export function crewHomePage({ worker, entries, clients, documents, today, secureReady, status = null }) {
  const employee = worker.kind === "employee";
  const sendForm = employee
    ? `<form class="portal-form crew-send" action="/clients/crew/hours" method="post">
          <h3>Send your hours</h3>
          <div class="crew-fields">
            <label for="hours-date">Date worked
              <input id="hours-date" name="workDate" type="date" required value="${escapeAttribute(today)}" max="${escapeAttribute(today)}">
            </label>
            <label for="hours-job">Job
              <select id="hours-job" name="job">${jobOptions(clients, "")}</select>
            </label>
            <label for="hours-count">Hours
              <input id="hours-count" name="hours" type="text" inputmode="decimal" required placeholder="8 or 7.5" maxlength="5">
            </label>
          </div>
          <label for="hours-notes">What you did (optional)
            <input id="hours-notes" name="description" type="text" maxlength="200">
          </label>
          <button class="button button-solid" type="submit">Send hours</button>
        </form>`
    : `<form class="portal-form crew-send" action="/clients/crew/bills" method="post" enctype="multipart/form-data">
          <h3>Send an invoice</h3>
          <p>After this you sign Michigan's conditional lien waiver for the invoice. It takes effect only when My Home Builder pays it.</p>
          <div class="crew-fields">
            <label for="bill-job">Job
              <select id="bill-job" name="job">${jobOptions(clients, "")}</select>
            </label>
            <label for="bill-number">Your invoice number
              <input id="bill-number" name="invoiceNumber" type="text" required maxlength="40">
            </label>
            <label for="bill-date">Invoice date
              <input id="bill-date" name="invoiceDate" type="date" required value="${escapeAttribute(today)}" max="${escapeAttribute(today)}">
            </label>
            <label for="bill-amount">Amount ($)
              <input id="bill-amount" name="amount" type="text" inputmode="decimal" required placeholder="0.00" maxlength="12">
            </label>
            <label for="bill-through">Work through (date)
              <input id="bill-through" name="through" type="date" required value="${escapeAttribute(today)}" max="${escapeAttribute(today)}">
            </label>
          </div>
          <label for="bill-notes">What you provided
            <input id="bill-notes" name="description" type="text" maxlength="200" required value="${escapeAttribute(worker.trade ? `${worker.trade} labor and materials` : "")}">
          </label>
          <label for="bill-file">Your invoice (PDF or photo, optional)
            <input id="bill-file" name="file" type="file" accept="application/pdf,image/*">
          </label>
          <label class="portal-check" for="bill-final">
            <input id="bill-final" name="final" type="checkbox" value="yes">
            <span>This is my final invoice for this job (you sign a full conditional waiver instead of a partial one)</span>
          </label>
          <button class="button button-solid" type="submit">Continue to the lien waiver</button>
        </form>`;
  const coiForm = worker.kind === "subcontractor"
    ? `<form class="portal-form portal-upload" action="/clients/crew/documents/upload" method="post" enctype="multipart/form-data">
          <h3>Upload your certificate of insurance</h3>
          <p>A PDF or photo of your current certificate, up to 20 MB.</p>
          <label for="coi-file">Choose a file
            <input id="coi-file" name="file" type="file" required accept="application/pdf,image/*">
          </label>
          <button class="button button-solid" type="submit">Upload</button>
        </form>`
    : "";
  return crewShell(`<div class="site-width portal-shell">
      <section>
        <p class="portal-kicker">Crew portal · ${escapeHtml(WORKER_KINDS[worker.kind])}</p>
        <h1 class="portal-heading">Hi, ${escapeHtml(firstName(worker))}.</h1>
        <p class="portal-lead">Send your ${employee ? "hours" : "invoices"}, and fill out and sign your paperwork for My Home Builder, in one place.</p>
        ${notice(status)}
      </section>
      <section class="portal-section" aria-labelledby="paperwork-heading">
        <h2 id="paperwork-heading">Your paperwork</h2>
        ${paperworkRows(worker, documents, { secureReady })}
        ${coiForm}
      </section>
      <section class="portal-section" aria-labelledby="send-heading">
        <h2 id="send-heading">${employee ? "Hours" : "Invoices"}</h2>
        ${sendForm}
      </section>
      <section class="portal-section" aria-labelledby="history-heading">
        <h2 id="history-heading">What you've sent</h2>
        ${historyRows(entries, clients)}
      </section>
    </div>`, { title: "Crew portal" });
}

// ---------- Crew: paperwork ----------

const INPUT_MODES = { ssn: "numeric", ein: "numeric", zip: "numeric", routing: "numeric", account: "numeric", money: "decimal", phone: "tel" };

function fieldMarkup(field, values, prefix = "field") {
  const id = `${prefix}-${field.name}`;
  const value = values[field.name] ?? "";
  const hint = field.hint ? `<small class="form-hint">${escapeHtml(field.hint)}</small>` : "";
  if (field.type === "check") {
    return `<label class="portal-check" for="${id}"><input id="${id}" name="${field.name}" type="checkbox" value="yes"${value === "yes" || value === true ? " checked" : ""}><span>${escapeHtml(field.label)}</span></label>${hint}`;
  }
  if (field.type === "choice") {
    const options = field.options.map(([key, label], index) => `<label class="portal-check" for="${id}-${index}"><input id="${id}-${index}" name="${field.name}" type="radio" value="${escapeAttribute(key)}"${String(value) === key ? " checked" : ""}${field.required ? " required" : ""}><span>${escapeHtml(label)}</span></label>`).join("");
    return `<fieldset class="form-choice"><legend>${escapeHtml(field.label)}</legend>${options}${hint}</fieldset>`;
  }
  const type = field.type === "date" ? "date" : field.type === "email" ? "email" : field.type === "count" ? "number" : "text";
  const extra = [
    field.required ? " required" : "",
    INPUT_MODES[field.type] ? ` inputmode="${INPUT_MODES[field.type]}"` : "",
    field.autocomplete ? ` autocomplete="${field.autocomplete}"` : field.type === "ssn" || field.type === "account" ? ' autocomplete="off"' : "",
    field.type === "count" ? ' min="0" max="99" step="1"' : "",
    field.type === "state" ? ' maxlength="2"' : field.max ? ` maxlength="${field.max}"` : field.type === "ssn" ? ' maxlength="11"' : ""
  ].join("");
  return `<label for="${id}">${escapeHtml(field.label)}
            <input id="${id}" name="${field.name}" type="${type}" value="${escapeAttribute(value)}"${extra}>${hint}
          </label>`;
}

function signatureBlock({ attestation, note = "", signerName = "", button }) {
  return `<div class="form-attest">
            <p>${escapeHtml(attestation)}</p>
            ${note ? `<p class="portal-security-note">${escapeHtml(note)}</p>` : ""}
          </div>
          <label for="signer-name">Full legal name
            <input id="signer-name" name="name" type="text" autocomplete="name" maxlength="120" required value="${escapeAttribute(signerName)}">
          </label>
          <div class="sign-pad" data-sign-pad>
            <span class="sign-pad-label">Draw your signature</span>
            <canvas width="720" height="220" aria-label="Signature drawing area"></canvas>
            <div class="sign-pad-tools">
              <button class="portal-logout-button" type="button" data-sign-clear>Clear</button>
              <small>No drawing? Your typed name will be used as your signature.</small>
            </div>
          </div>
          <input type="hidden" name="signature" value="">
          <label class="portal-check" for="sign-consent">
            <input id="sign-consent" name="consent" type="checkbox" value="yes" required>
            <span>I agree to sign electronically and understand that my electronic signature is as valid as a handwritten one.</span>
          </label>
          <button class="button button-solid" type="submit">${escapeHtml(button)}</button>`;
}

export function paperworkFormPage({ spec, values = {}, error = "", action, backPath, admin = false, section = null, signerName = "", heading = null, lead = null }) {
  const groups = spec.sections.filter((group) => !section || group.part === section);
  const body = groups.map((group) => `<fieldset class="form-section">
          <legend>${escapeHtml(group.heading)}</legend>
          ${group.hint ? `<p class="form-hint">${escapeHtml(group.hint)}</p>` : ""}
          <div class="form-grid">${group.fields.map((field) => fieldMarkup(field, values)).join("")}</div>
        </fieldset>`).join("");
  const attestation = section === "section2" ? spec.employerAttestation : spec.attestation;
  const content = `<div class="site-width portal-shell portal-detail">
      <p class="portal-kicker">${escapeHtml(spec.title)}</p>
      <h1 class="portal-heading">${escapeHtml(heading || spec.heading)}.</h1>
      <p class="portal-lead">${escapeHtml(lead || spec.intro)}</p>
      ${error ? `<p class="portal-error" role="alert">${escapeHtml(error)}</p>` : ""}
      <form class="portal-form paperwork-form" action="${escapeAttribute(action)}" method="post" data-sign-form>
        ${body}
        ${signatureBlock({ attestation, note: section === "section2" ? "" : spec.attestationNote || "", signerName, button: section === "section2" ? "Sign Section 2" : "Sign and send" })}
        <p><a class="portal-secondary-link" href="${escapeAttribute(backPath)}">Back</a></p>
        <p class="portal-security-note">Your answers are encrypted when they are saved. Only you and My Home Builder can open this form.</p>
      </form>
    </div>`;
  return admin ? adminShell(content, { title: spec.title, scripts: [SIGN_SCRIPT] }) : crewShell(content, { title: spec.title, scripts: [SIGN_SCRIPT] });
}

// ---------- Crew: lien waiver ----------

// The waiver's words as they will print. The blanks the subcontractor can change carry
// data-fill, and "does" / "does not" data-choice, so sign.js updates them while they type.
const EDITABLE = ["property", "provided"];
function waiverPreview(kind, values) {
  const marked = { ...values, ...Object.fromEntries(EDITABLE.map((name) => [name, `\u0001${name}`])) };
  return waiverParagraphs(kind, marked).map((paragraph) => {
    const runs = typeof paragraph === "string" ? [{ text: paragraph }] : paragraph;
    return `<p>${runs.map((run) => {
      if (run.fill && run.text.startsWith("\u0001")) {
        const name = run.text.slice(1);
        return `<span class="waiver-fill" data-fill="${name}">${escapeHtml(values[name] || "")}</span>`;
      }
      if (run.fill) return `<span class="waiver-fill">${escapeHtml(run.text)}</span>`;
      if (run.circle !== undefined) {
        const choice = run.text === "does" ? "yes" : "no";
        const circled = values.coversAll === (choice === "yes");
        return `<span class="waiver-choice${circled ? " is-circled" : ""}" data-choice="${choice}">${escapeHtml(run.text)}</span>`;
      }
      return escapeHtml(run.text);
    }).join("")}</p>`;
  }).join("");
}

export function waiverPage({ entry, values, jobName: job, error = "" }) {
  const kind = entry.final ? "full-conditional" : "partial-conditional";
  const spec = WAIVERS[kind];
  return crewShell(`<div class="site-width portal-shell portal-detail">
      <p class="portal-kicker">Invoice ${escapeHtml(entry.invoiceNumber)} · ${escapeHtml(job)} · ${waiverAmount(entry.amountCents)}</p>
      <h1 class="portal-heading">Sign your lien waiver.</h1>
      <p class="portal-lead">Michigan's ${escapeHtml(spec.name.toLowerCase())} for this invoice (Construction Lien Act, MCL 570.1115). It takes effect only when My Home Builder pays the amount shown. Your invoice is sent once you sign.</p>
      ${error ? `<p class="portal-error" role="alert">${escapeHtml(error)}</p>` : ""}
      <form class="portal-form paperwork-form" action="/clients/crew/bills/${encodeURIComponent(entry.id)}/waiver" method="post" data-sign-form>
        <fieldset class="form-section">
          <legend>The blanks on the waiver</legend>
          <div class="form-grid">
            <label for="waiver-property">Property described as
              <input id="waiver-property" name="property" type="text" maxlength="200" required value="${escapeAttribute(values.property)}">
              <small class="form-hint">The job site's address, as it appears on the property records if you have it.</small>
            </label>
            <label for="waiver-provided">To provide
              <input id="waiver-provided" name="provided" type="text" maxlength="200" required value="${escapeAttribute(values.provided)}">
            </label>
            <label for="waiver-claimant">Lien claimant (you, or your company by you)
              <input id="waiver-claimant" name="claimant" type="text" maxlength="120" required value="${escapeAttribute(values.claimant)}">
            </label>
            <label for="waiver-address">Your address
              <input id="waiver-address" name="address" type="text" maxlength="160" required value="${escapeAttribute(values.address)}">
            </label>
            <label for="waiver-phone">Your telephone
              <input id="waiver-phone" name="phone" type="text" inputmode="tel" maxlength="30" required value="${escapeAttribute(values.phone)}">
            </label>
          </div>
          ${spec.full ? "" : `<fieldset class="form-choice"><legend>Together with any earlier waivers, does this waiver cover all amounts due to you for work through ${escapeHtml(dateText(values.through))}?</legend>
            <label class="portal-check" for="covers-yes"><input id="covers-yes" name="coversAll" type="radio" value="yes"${values.coversAll ? " checked" : ""} required><span>Does: nothing else is owed to me for work through that date</span></label>
            <label class="portal-check" for="covers-no"><input id="covers-no" name="coversAll" type="radio" value="no"${values.coversAll === false ? " checked" : ""} required><span>Does not: more is owed to me for work through that date</span></label>
          </fieldset>`}
        </fieldset>
        <section class="waiver-preview" aria-label="The waiver you are signing">
          <h2>${escapeHtml(spec.title)}</h2>
          ${waiverPreview(kind, values)}
          <p class="waiver-warning">DO NOT SIGN BLANK OR INCOMPLETE FORMS. RETAIN A COPY.</p>
          <p class="portal-security-note">This is the waiver you sign, with your answers filled in. Your signature, the date and your contact details go below it.</p>
        </section>
        ${signatureBlock({ attestation: "By signing, I sign this lien waiver as the lien claimant named above.", signerName: values.signerName, button: "Sign waiver and send invoice" })}
      </form>
    </div>`, { title: "Sign your lien waiver", scripts: [SIGN_SCRIPT] });
}

// ---------- Admin: Labor ----------

function workCell(entry, { admin = true } = {}) {
  const base = `/clients/admin/labor/entries/${encodeURIComponent(entry.id)}`;
  const files = [
    entry.fileKey ? `<a class="portal-secondary-link" href="${base}/file">Invoice</a>` : "",
    entry.waiver?.fileKey ? `<a class="portal-secondary-link" href="${base}/waiver">Lien waiver</a>` : ""
  ].filter(Boolean).join(" ");
  return `${escapeHtml(workSummary(entry))}${entry.description ? `<small>${escapeHtml(entry.description)}</small>` : ""}${admin && files ? `<small class="labor-files">${files}</small>` : ""}`;
}

function workerCell(entry) {
  return `<a class="portal-inline-link" href="/clients/admin/labor/workers/${encodeURIComponent(entry.workerId)}">${escapeHtml(entry.workerName)}</a><small>${escapeHtml(entry.kind === "hours" ? "Hours" : "Invoice")}</small>`;
}

function pendingRows(entries, workers, clients) {
  if (!entries.length) return '<p class="portal-empty">Nothing is waiting for approval.</p>';
  const rows = entries.map((entry) => {
    const form = `labor-${entry.id}`;
    const worker = workers.find((candidate) => candidate.id === entry.workerId);
    const suggested = entry.kind === "hours" ? (worker?.hourlyRateCents ? hoursCost(entry.hours, worker.hourlyRateCents) : null) : entry.amountCents;
    const amount = entry.kind === "hours"
      ? `<input class="labor-amount" form="${form}" name="amount" type="text" inputmode="decimal" maxlength="12" required value="${escapeAttribute(moneyInput(suggested))}" aria-label="Cost of ${escapeAttribute(entry.workerName)}'s hours" placeholder="0.00"><small>${worker?.hourlyRateCents ? `${money(worker.hourlyRateCents)} an hour` : "No hourly rate set"}</small>`
      : money(entry.amountCents);
    return `<tr>
          <td>${workerCell(entry)}</td>
          <td>${workCell(entry)}</td>
          <td><select form="${form}" name="job" aria-label="Job for ${escapeAttribute(entry.workerName)}'s work">${jobOptions(clients, entry.clientSlug || "")}</select></td>
          <td>${amount}</td>
          <td>
            <form id="${form}" class="labor-actions" method="post" action="/clients/admin/labor/entries/${encodeURIComponent(entry.id)}/approve">
              <button class="button button-solid button-small" type="submit">Approve</button>
              <input name="note" type="text" maxlength="200" placeholder="Note, to return it" aria-label="Note for returning ${escapeAttribute(entry.workerName)}'s work">
              <button class="portal-logout-button" type="submit" formaction="/clients/admin/labor/entries/${encodeURIComponent(entry.id)}/return" formnovalidate>Return</button>
            </form>
          </td>
        </tr>`;
  });
  return `<table class="portal-table labor-table">
        <thead><tr><th scope="col">Who</th><th scope="col">Work</th><th scope="col">Job</th><th scope="col">Cost</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
}

function approvedRows(entries, clients) {
  if (!entries.length) return '<p class="portal-empty">Everything approved has been paid.</p>';
  const rows = entries.map((entry) => `<tr>
          <td>${workerCell(entry)}</td>
          <td>${workCell(entry)}</td>
          <td>${escapeHtml(jobName(clients, entry.clientSlug))}</td>
          <td>${money(entry.amountCents)}</td>
          <td class="labor-actions">
            <a class="button button-solid button-small" href="/clients/admin/labor/entries/${encodeURIComponent(entry.id)}/paid" data-labor-pay data-label="${escapeAttribute(`${entry.workerName} · ${money(entry.amountCents)}`)}" data-kind="${entry.kind}">Mark paid</a>
            <form method="post" action="/clients/admin/labor/entries/${encodeURIComponent(entry.id)}/unapprove"><button class="portal-logout-button" type="submit">Undo approval</button></form>
          </td>
        </tr>`);
  return `<table class="portal-table labor-table">
        <thead><tr><th scope="col">Who</th><th scope="col">Work</th><th scope="col">Job</th><th scope="col">Owed</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
}

function paidRows(entries, clients) {
  if (!entries.length) return '<p class="portal-empty">Nothing paid yet.</p>';
  const rows = entries.map((entry) => `<tr>
          <td>${workerCell(entry)}</td>
          <td>${workCell(entry)}</td>
          <td>${escapeHtml(jobName(clients, entry.clientSlug))}</td>
          <td>${money(entry.amountCents)}<small>${escapeHtml(LABOR_PAYMENT_METHODS[entry.payment?.method] || "")}${entry.payment?.reference ? ` ${escapeHtml(entry.payment.reference)}` : ""} · ${dateText(entry.payment?.paidOn)}</small></td>
          <td><form method="post" action="/clients/admin/labor/entries/${encodeURIComponent(entry.id)}/unpaid"><button class="portal-logout-button" type="submit">Mark unpaid</button></form></td>
        </tr>`);
  return `<table class="portal-table labor-table">
        <thead><tr><th scope="col">Who</th><th scope="col">Work</th><th scope="col">Job</th><th scope="col">Paid</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
}

export function paperworkCount(worker) {
  const required = (PAPERWORK[worker.kind] || []).filter((key) => !FORMS[key].optional);
  return { done: required.filter((key) => worker.paperwork?.[key]).length, total: required.length };
}

function signInState(worker) {
  if (worker.active === false) return "Inactive";
  if (worker.passwordHash) return worker.lastSignInAt ? `Signed in ${dateText(worker.lastSignInAt)}` : "Password set";
  return "Invited";
}

function crewRows(workers) {
  if (!workers.length) return '<p class="portal-empty">No employees or subcontractors yet. Add one to send their invite.</p>';
  const rows = workers.map((worker) => {
    const { done, total } = paperworkCount(worker);
    return `<tr>
          <td><a class="portal-inline-link" href="/clients/admin/labor/workers/${encodeURIComponent(worker.id)}">${escapeHtml(worker.name)}</a><small>${escapeHtml(worker.company || worker.email)}</small></td>
          <td>${escapeHtml(WORKER_KINDS[worker.kind])}${worker.trade ? `<small>${escapeHtml(worker.trade)}</small>` : ""}</td>
          <td><span class="portal-status portal-status-${done === total ? "paid" : "open"}">${done} of ${total} signed</span></td>
          <td>${escapeHtml(signInState(worker))}</td>
        </tr>`;
  });
  return `<table class="portal-table">
        <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Paperwork</th><th scope="col">Sign-in</th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
}

function payFields(today, kind = "invoice") {
  const methods = Object.entries(LABOR_PAYMENT_METHODS).map(([key, label]) => `<option value="${key}"${key === (kind === "hours" ? "payroll" : "check") ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
  return `<label for="labor-pay-method">Paid by
              <select id="labor-pay-method" name="method" data-payment-method>${methods}</select>
            </label>
            <label for="labor-pay-other" data-payment-other>Other method (when Other is chosen)
              <input id="labor-pay-other" name="methodName" type="text" maxlength="60" placeholder="How it was paid">
            </label>
            <label for="labor-pay-reference">Reference (optional)
              <input id="labor-pay-reference" name="reference" type="text" maxlength="80" placeholder="Check #1042 or confirmation number">
            </label>
            <label for="labor-pay-date">Paid on
              <input id="labor-pay-date" name="paidOn" type="date" required value="${escapeAttribute(today)}">
            </label>`;
}

// The Mark paid popup (billing.js opens it from each Mark paid link).
function payDialog(today) {
  return `<dialog class="admin-dialog" id="labor-pay-dialog" aria-labelledby="labor-pay-title">
          <div class="admin-dialog-head">
            <h2 id="labor-pay-title" data-labor-pay-title>Mark paid</h2>
            <button class="admin-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
          </div>
          <form class="admin-stack-form" method="post" data-labor-pay-form>
            <p class="admin-meta">How was it paid?</p>
            ${payFields(today)}
            <button class="button button-solid" type="submit">Mark paid</button>
          </form>
        </dialog>`;
}

// The same form as a page, for Mark paid without scripts.
export function laborPayPage({ entry, today }) {
  return adminShell(`<div class="site-width portal-shell portal-detail">
      <p class="portal-kicker"><a class="portal-inline-link" href="/clients/admin/labor">Labor</a></p>
      <h1 class="portal-heading">Mark paid.</h1>
      <p class="portal-lead">${escapeHtml(entry.workerName)} · ${escapeHtml(workSummary(entry))} · ${money(entry.amountCents)}</p>
      <form class="portal-form admin-form" method="post" action="/clients/admin/labor/entries/${encodeURIComponent(entry.id)}/paid">
        ${payFields(today, entry.kind)}
        <button class="button button-solid" type="submit">Mark paid</button>
      </form>
    </div>`, { title: "Mark paid", scripts: [BILLING_SCRIPT] });
}

function employerForm(employer) {
  const field = (name, label, extra = "") => `<label for="employer-${name}">${label}
              <input id="employer-${name}" name="${name}" type="text" value="${escapeAttribute(employer[name] || "")}"${extra}>
            </label>`;
  return `<form class="portal-form admin-form" action="/clients/admin/labor/employer" method="post">
            <h3>Employer details</h3>
            <p>Printed on W-4s, MI-W4s, I-9s, W-9s and lien waivers.</p>
            ${field("legalName", "Legal business name", ' maxlength="120" required')}
            ${field("ein", "Federal employer identification number (EIN)", ' maxlength="10" placeholder="12-3456789"')}
            ${field("street", "Street address", ' maxlength="120" required')}
            ${field("city", "City", ' maxlength="60" required')}
            ${field("state", "State", ' maxlength="2" required')}
            ${field("zip", "ZIP code", ' maxlength="10" required')}
            ${field("contactName", "Contact person (MI-W4)", ' maxlength="80"')}
            ${field("contactPhone", "Contact phone (MI-W4)", ' maxlength="30"')}
            <button class="button button-solid" type="submit">Save employer details</button>
          </form>`;
}

export function adminLaborPage({ workers, entries, clients, employer, today, status = null, secureReady = true }) {
  const pending = entries.filter((entry) => entry.status === "submitted");
  const approved = entries.filter((entry) => entry.status === "approved");
  const paid = entries.filter((entry) => entry.status === "paid").slice(0, 25);
  return adminShell(`<div class="site-width portal-shell">
      <section class="admin-intro">
        <p class="portal-kicker">Admin panel</p>
        <h1 class="portal-heading">Labor.</h1>
        <p class="portal-lead">Employees and subcontractors send their hours and invoices from the crew portal. Approve each to a job and it becomes that job's cost in the books; mark it paid when you pay it.</p>
        ${notice(status)}
        ${employer.ein ? "" : '<p class="portal-notice">Add the business\'s EIN under Employer details: it goes on employees\' W-4s, MI-W4s and I-9s.</p>'}
        ${secureReady ? "" : '<p class="portal-error">Paperwork storage is not configured, so paperwork cannot be filled out yet.</p>'}
      </section>
      <div class="admin-layout">
        <aside class="admin-sidebar">
          <form class="portal-form admin-form" action="/clients/admin/labor/workers" method="post">
            <h3>Add an employee or subcontractor</h3>
            <fieldset class="form-choice">
              <legend>Kind</legend>
              <label class="portal-check" for="worker-employee"><input id="worker-employee" name="kind" type="radio" value="employee" required><span>Employee (W-2)</span></label>
              <label class="portal-check" for="worker-sub"><input id="worker-sub" name="kind" type="radio" value="subcontractor" required><span>Subcontractor (1099)</span></label>
            </fieldset>
            <label for="worker-name">Name
              <input id="worker-name" name="name" type="text" maxlength="120" required>
            </label>
            <label for="worker-email">Email (their sign-in)
              <input id="worker-email" name="email" type="email" maxlength="254" required>
            </label>
            <label for="worker-phone">Phone (optional)
              <input id="worker-phone" name="phone" type="text" maxlength="30">
            </label>
            <label for="worker-trade">Trade (optional)
              <input id="worker-trade" name="trade" type="text" maxlength="60" placeholder="Carpenter, electrician, drywall">
            </label>
            <label for="worker-company">Company (subcontractors, optional)
              <input id="worker-company" name="company" type="text" maxlength="120">
            </label>
            <label for="worker-rate">Hourly rate (employees, $)
              <input id="worker-rate" name="rate" type="text" inputmode="decimal" maxlength="10" placeholder="0.00">
            </label>
            <label for="worker-start">Start date (employees)
              <input id="worker-start" name="startDate" type="date">
            </label>
            <button class="button button-solid" type="submit">Add and send invite</button>
            <p class="portal-security-note">They get an email to choose a password for the crew portal at myhomebuilderllc.com/clients/crew.</p>
          </form>
          ${employerForm(employer)}
        </aside>
        <section class="admin-panel" aria-labelledby="labor-waiting">
          <h2 id="labor-waiting">Waiting for approval</h2>
          ${pendingRows(pending, workers, clients)}
          <h2 class="admin-panel-subheading">Approved, not paid yet</h2>
          ${approvedRows(approved, clients)}
          <h2 class="admin-panel-subheading">Employees and subcontractors</h2>
          ${crewRows(workers)}
          <h2 class="admin-panel-subheading">Paid recently</h2>
          ${paidRows(paid, clients)}
          ${payDialog(today)}
        </section>
      </div>
    </div>`, { title: "Labor", scripts: [BILLING_SCRIPT] });
}

// ---------- Admin: one employee or subcontractor ----------

export function adminWorkerPage({ worker, entries, clients, documents, status = null, secureReady = true }) {
  const base = `/clients/admin/labor/workers/${encodeURIComponent(worker.id)}`;
  const employee = worker.kind === "employee";
  const paperwork = (PAPERWORK[worker.kind] || []).map((key) => {
    const spec = FORMS[key];
    const done = worker.paperwork?.[key];
    const i9 = key === "i9" && done;
    const state = !done ? (spec.optional ? "Optional, not filled out" : "Not signed yet")
      : i9 && done.status !== "complete" ? `Section 1 signed ${dateText(done.signedAt)}; Section 2 is yours`
        : `Signed ${dateText(done.signedAt)}${done.completedAt ? `; Section 2 signed ${dateText(done.completedAt)}` : ""}`;
    return `<li><span><strong>${escapeHtml(spec.title)}</strong> · ${escapeHtml(state)}</span>
            <span class="admin-manage">${done ? `<a class="portal-secondary-link" href="${base}/forms/${key}/pdf">Download</a>` : ""}${i9 && done.status !== "complete" ? `<a class="button button-solid button-small" href="${base}/forms/i9/section2">Complete Section 2</a>` : ""}</span></li>`;
  }).join("");
  const newHire = employee
    ? `<li><span><strong>Michigan new hire report</strong> · ${worker.newHireReportedOn ? `Reported ${dateText(worker.newHireReportedOn)}` : "Report within 20 days of the start date at www.mi-newhire.com"}</span>
          ${worker.newHireReportedOn ? "" : `<form class="admin-manage" method="post" action="${base}/new-hire"><button class="portal-logout-button" type="submit">Mark reported</button></form>`}</li>`
    : "";
  const sectionOptions = CREW_SECTIONS.map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join("");
  const documentRows = documents.length
    ? `<ul class="admin-activity">${documents.map((document) => {
      const signed = document.signatures?.some((entry) => entry.party === "client");
      const mine = document.requiresAdminSignature && !document.signatures?.some((entry) => entry.party === "admin");
      return `<li><span>${escapeHtml(document.name)} · ${escapeHtml(CREW_SECTIONS.find(([key]) => key === document.section)?.[1] || "Other documents")}${document.requiresClientSignature ? (signed ? " · signed" : " · waiting for their signature") : ""}</span>
            <span class="admin-manage"><a class="portal-secondary-link" href="${base}/documents/${encodeURIComponent(document.id)}">Download</a>${mine && document.contentType === "application/pdf" ? `<a class="portal-secondary-link" href="${base}/documents/${encodeURIComponent(document.id)}/sign">Sign</a>` : ""}</span></li>`;
    }).join("")}</ul>`
    : '<p class="admin-meta">No documents yet.</p>';
  const totals = new Map();
  for (const entry of entries.filter((item) => ["approved", "paid"].includes(item.status))) {
    totals.set(entry.clientSlug || "", (totals.get(entry.clientSlug || "") || 0) + entry.amountCents);
  }
  const workRows = entries.length
    ? `<table class="portal-table">
          <thead><tr><th scope="col">Work</th><th scope="col">Job</th><th scope="col">Amount</th><th scope="col">Status</th></tr></thead>
          <tbody>${entries.map((entry) => `<tr><td>${workCell(entry)}</td><td>${escapeHtml(jobName(clients, entry.clientSlug))}</td><td>${entry.status === "submitted" && entry.kind === "hours" ? escapeHtml(hoursText(entry.hours)) : money(entry.amountCents)}</td><td>${statusBadge(entry)}${entry.returnNote ? `<small>${escapeHtml(entry.returnNote)}</small>` : ""}</td></tr>`).join("")}</tbody>
        </table>`
    : '<p class="portal-empty">Nothing sent yet.</p>';
  return adminShell(`<div class="site-width portal-shell">
      <section class="admin-intro">
        <p class="portal-kicker"><a class="portal-inline-link" href="/clients/admin/labor">Labor</a></p>
        <h1 class="portal-heading">${escapeHtml(worker.name)}.</h1>
        <p class="portal-lead">${escapeHtml([WORKER_KINDS[worker.kind], worker.trade, worker.company, worker.hourlyRateCents ? `${money(worker.hourlyRateCents)} an hour` : "", worker.email].filter(Boolean).join(" · "))}</p>
        ${notice(status)}
      </section>
      <div class="admin-grid labor-worker-grid">
        <section class="admin-card">
          <h2>Profile</h2>
          <form class="admin-stack-form" method="post" action="${base}/profile">
            <label for="profile-name">Name <input id="profile-name" name="name" type="text" maxlength="120" required value="${escapeAttribute(worker.name)}"></label>
            <label for="profile-email">Email (their sign-in) <input id="profile-email" name="email" type="email" maxlength="254" required value="${escapeAttribute(worker.email)}"></label>
            <label for="profile-phone">Phone <input id="profile-phone" name="phone" type="text" maxlength="30" value="${escapeAttribute(worker.phone || "")}"></label>
            <label for="profile-trade">Trade <input id="profile-trade" name="trade" type="text" maxlength="60" value="${escapeAttribute(worker.trade || "")}"></label>
            <label for="profile-company">Company <input id="profile-company" name="company" type="text" maxlength="120" value="${escapeAttribute(worker.company || "")}"></label>
            <label for="profile-address">Address (for lien waivers) <input id="profile-address" name="address" type="text" maxlength="160" value="${escapeAttribute(worker.address || "")}"></label>
            ${employee ? `<label for="profile-rate">Hourly rate ($) <input id="profile-rate" name="rate" type="text" inputmode="decimal" maxlength="10" value="${escapeAttribute(moneyInput(worker.hourlyRateCents ?? null))}"></label>
            <label for="profile-start">Start date <input id="profile-start" name="startDate" type="date" value="${escapeAttribute(worker.startDate || "")}"></label>` : ""}
            <button class="button button-solid" type="submit">Save profile</button>
          </form>
        </section>
        <section class="admin-card">
          <h2>Sign-in</h2>
          <p class="admin-meta">${escapeHtml(signInState(worker))}${worker.invite?.sentAt ? ` · last link sent ${dateText(worker.invite.sentAt)}` : ""}</p>
          <form class="admin-manage" method="post" action="${base}/invite">
            <button class="button button-solid" type="submit">${worker.passwordHash ? "Send a password reset link" : "Send the invite again"}</button>
          </form>
          <form class="admin-danger" method="post" action="${base}/active">
            <input type="hidden" name="active" value="${worker.active === false ? "yes" : "no"}">
            <button class="portal-logout-button" type="submit">${worker.active === false ? "Reactivate" : "Deactivate"}</button>
            <p class="portal-security-note">${worker.active === false ? "Reactivating lets them sign in again." : "Deactivating signs them out and stops them signing in. Their paperwork, hours and invoices stay."}</p>
          </form>
        </section>
        <section class="admin-card">
          <h2>Paperwork</h2>
          ${secureReady ? "" : '<p class="portal-error">Paperwork storage is not configured.</p>'}
          <ul class="admin-activity">${paperwork}${newHire}</ul>
        </section>
        <section class="admin-card">
          <h2>Documents</h2>
          ${documentRows}
          <form class="admin-stack-form" method="post" action="${base}/documents" enctype="multipart/form-data">
            <label for="crew-doc-file">File <input id="crew-doc-file" name="file" type="file" required></label>
            <label for="crew-doc-section">Section <select id="crew-doc-section" name="section">${sectionOptions}</select></label>
            <label class="portal-check" for="crew-doc-sign"><input id="crew-doc-sign" name="requiresClientSignature" type="checkbox" value="yes"><span>${employee ? "Employee" : "Subcontractor"} must sign (PDF only)</span></label>
            <label class="portal-check" for="crew-doc-admin"><input id="crew-doc-admin" name="requiresAdminSignature" type="checkbox" value="yes"><span>I will sign on my end (PDF only)</span></label>
            <button class="button button-solid" type="submit">Share with ${escapeHtml(firstName(worker))}</button>
          </form>
        </section>
      </div>
      <section class="admin-panel admin-panel-wide" aria-labelledby="worker-work">
        <h2 id="worker-work">${employee ? "Hours" : "Invoices"}</h2>
        ${totals.size ? `<p class="admin-meta">Approved to date: ${[...totals.entries()].map(([slug, cents]) => `${escapeHtml(jobName(clients, slug))} ${money(cents)}`).join(" · ")}</p>` : ""}
        ${workRows}
      </section>
    </div>`, { title: worker.name });
}
