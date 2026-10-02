import { balanceDue, billingLabel, billingLineItems, installmentsTotal, isEditable, isPayable, issuedDate, MAX_PAYMENT_NOTE, moneyInput, PAYMENT_METHODS, quantityText, todayInMichigan } from "./billing.js";
import { addressesText, clientEmails, MAX_RECIPIENTS } from "./email.js";
import { escapeHtml, formatDate, money } from "./format.js";
import { DOCUMENT_SECTIONS, awaitingSignature, groupBySection, sectionName, sectionOf } from "./documents.js";
import { JOB_CATEGORIES, OVERHEAD_CATEGORIES, categoryName } from "./expenses.js";

export { escapeHtml, money };
export const escapeAttribute = escapeHtml;

export function dateText(value) {
  return escapeHtml(formatDate(value));
}

function sizeText(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const BILLING_SCRIPT = "/clients/portal/billing.js";

// Printed on every quote and invoice (and the client PDF, export.js), worded exactly as the owner
// gave them.
export const BUSINESS_ADDRESS = ["6749 Fulton St E, Ste A #2333", "Ada, MI 49301"];
export const BUILDER_LICENSE = "License # 242601116";
export const INSURANCE = "$1,000,000 liability insurance provided by Next First Insurance Agency Inc";
// The Ada address is a digital mailbox, so checks go to this address instead.
const CHECK_ADDRESS = ["5899 1/2 White Rd", "Muskegon, MI 49442"];

// A disclosure (no script needed): the button reveals where to mail a check.
function checkOption(item) {
  return `<details class="billing-check">
          <summary class="button button-outline">I&#39;m paying by check</summary>
          <div class="billing-check-address">
            <p>Mail your check to:</p>
            <address><strong>My Home Builder LLC</strong><br>${CHECK_ADDRESS.map(escapeHtml).join("<br>")}</address>
            <p>Make it payable to My Home Builder LLC and write ${escapeHtml(billingLabel(item))} in the memo.</p>
          </div>
        </details>`;
}

// Addresses the portal has emailed, newest first. billing.js turns this list into the pick list
// under each email field in the admin panel; without scripts the browser offers the same addresses.
const RECIPIENT_LIST_ID = "mhb-recipients";
const RECIPIENT_INPUT = `list="${RECIPIENT_LIST_ID}" autocomplete="off" data-recipient-input`;

// An admin email field: one or more addresses separated by commas. billing.js shows each address
// as a removable chip; the server accepts the same text typed by hand.
function emailsField({ id, name, label, addresses = [], typed = null, required = false, hint = "" }) {
  const value = typed ?? addresses.join(", ");
  return `<label class="admin-emails-field" for="${id}">${label}
              <input id="${id}" name="${name}" type="text" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="${MAX_RECIPIENTS * 100}"${required ? " required" : ""} ${RECIPIENT_INPUT} data-max-recipients="${MAX_RECIPIENTS}" value="${escapeAttribute(value)}" placeholder="client@example.com">
              ${hint ? `<small class="admin-field-hint">${hint}</small>` : ""}
            </label>`;
}

function recipientList(recipients) {
  if (!recipients.length) return "";
  const options = recipients.map((entry) => `<option value="${escapeAttribute(entry.email)}" label="${escapeAttribute(formatDate(entry.lastSentAt))}"></option>`).join("");
  return `<datalist id="${RECIPIENT_LIST_ID}">${options}</datalist>`;
}

// The MB mark from /assets/mb-logo.svg, drawn in the current text color so it shows on the white document.
const MB_MARK = `<svg class="billing-doc-mark" viewBox="170 95 1250 665" role="img" aria-label="My Home Builder">
            <g fill="none" stroke="currentColor" stroke-width="108" stroke-linecap="round" stroke-linejoin="round">
              <path d="M300 195 L345 205 L240 690"/>
              <path d="M345 205 L500 480 L800 165"/>
              <path d="M800 165 L680 650"/>
              <path d="M1000 190 L900 645"/>
              <path d="M1000 190 C1180 170 1380 190 1330 275 C1300 360 1120 380 965 385"/>
              <path d="M965 385 C1150 385 1400 400 1345 500 C1290 600 1080 650 900 645"/>
            </g>
          </svg>`;

// `crew`: signed in to the crew portal; `crewSignedOut`: its sign-in pages. `footerLinks` come
// first in the footer (the admin panel's Archive).
export function pageShell(content, { authenticated = false, admin = false, crew = false, crewSignedOut = false, bodyClass = "portal-page", scripts = [], title = "Client Portal", navCurrent = "login", footerLinks = [] } = {}) {
  const nav = [];
  if (crew) {
    nav.push('<a href="/clients/crew">Crew home</a>');
    nav.push('<form action="/clients/crew/logout" method="post"><button class="portal-logout-button" type="submit">Log out</button></form>');
  } else if (authenticated || admin) {
    nav.push('<a href="/clients">Home</a>');
    if (admin) {
      nav.push('<a href="/clients/admin">Admin panel</a>');
      nav.push('<a href="/clients/admin/schedule">Schedule</a>');
      nav.push('<a href="/clients/admin/notes">Important notes</a>');
      nav.push('<a href="/clients/admin/templates">Templates</a>');
      nav.push('<a href="/clients/admin/documents">Documents</a>');
      nav.push('<a href="/clients/admin/labor">Labor</a>');
      nav.push('<a href="/clients/admin/bank">Banking</a>');
      nav.push('<a href="/clients/admin/books">Books</a>');
      nav.push('<form action="/clients/admin/logout" method="post"><button class="portal-logout-button" type="submit">Exit admin</button></form>');
    } else {
      nav.push('<form action="/clients/admin/request" method="post"><button class="portal-logout-button" type="submit">Admin</button></form>');
    }
    if (authenticated) {
      nav.push('<form action="/clients/logout" method="post"><button class="portal-logout-button" type="submit">Log out</button></form>');
    }
  } else {
    nav.push('<a href="/">Home</a>');
    nav.push(`<a href="/clients"${navCurrent === "login" && !crewSignedOut ? ' aria-current="page"' : ""}>Client login</a>`);
    nav.push(`<a href="/clients/crew"${crewSignedOut ? ' aria-current="page"' : ""}>Crew login</a>`);
    nav.push('<form action="/clients/admin/request" method="post"><button class="portal-logout-button" type="submit">Admin</button></form>');
  }
  const crewPages = crew || crewSignedOut;
  const scriptTags = scripts.map((source) => `<script src="${escapeAttribute(source)}" defer></script>`).join("\n  ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="theme-color" content="${admin ? "#00212B" : "#ffffff"}">
  <link rel="icon" href="/assets/mhb-favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/assets/mhb-favicon.png" type="image/png" sizes="512x512">
  <link rel="alternate icon" href="/assets/mhb-favicon.ico" type="image/x-icon">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/clients.css">
  ${scriptTags}
  <title>${escapeHtml(title)} | My Home Builder LLC</title>
</head>
<body class="${escapeAttribute(bodyClass)}">
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="topline">
    <div class="site-width topline-inner">
      <span>Muskegon, Michigan</span>
      <span>${admin ? "Administrator access" : crewPages ? "Private crew access" : "Private project access"}</span>
      <a href="/">Return to website</a>
    </div>
  </div>
  <header class="site-header">
    <div class="site-width header-inner">
      <a class="brand brand-header" href="/" aria-label="My Home Builder LLC home">
        <img class="brand-mark" src="/assets/mb-logo.svg" alt="" width="1250" height="665">
        <span class="brand-copy">
          <strong>MY HOME BUILDER</strong>
          <small>${admin ? "Admin panel" : crewPages ? "Crew portal" : "Client portal"}</small>
        </span>
      </a>
      <nav class="portal-nav" aria-label="Client portal navigation">
        ${nav.join("\n        ")}
      </nav>
    </div>
  </header>
  <main class="portal-main" id="main">
    <!-- Cloudflare leaves addresses in these private pages as they are: its email obfuscation needs a
         script the portal's Content Security Policy does not allow. -->
    <!--email_off-->
    ${content}
    <!--/email_off-->
  </main>
  <footer class="site-footer">
    <div class="site-width portal-footer-inner">
      <p>© ${new Date().getUTCFullYear()} My Home Builder LLC</p>
      <div class="portal-footer-links">
        ${footerLinks.map((link) => `${link}\n        `).join("")}<a href="/legal/">Legal and privacy</a>
        <a href="/#contact">Contact My Home Builder</a>
      </div>
    </div>
  </footer>
</body>
</html>`;
}

export function messagePage({ kicker = "Client portal", heading, lead, authenticated = false, admin = false }) {
  return pageShell(`<div class="site-width portal-shell">
      <p class="portal-kicker">${escapeHtml(kicker)}</p>
      <h1 class="portal-heading">${escapeHtml(heading)}</h1>
      <p class="portal-lead">${lead}</p>
    </div>`, { authenticated, admin, title: heading, navCurrent: null });
}

export function serviceUnavailablePage() {
  return messagePage({
    heading: "Temporarily unavailable.",
    lead: 'The client portal is being configured. Please try again shortly or <a href="/#contact">contact us through the main website</a>.'
  });
}

export function loginPage(hasError = false, destination = "") {
  const errorMessage = hasError
    ? '<p class="portal-error" role="alert">That project login was not recognized. Please try again.</p>'
    : "";
  const destinationField = destination
    ? `<input name="next" type="hidden" value="${escapeAttribute(destination)}">`
    : "";

  return pageShell(`<div class="site-width portal-shell portal-login-grid">
      <section>
        <p class="portal-kicker">Client portal</p>
        <h1 class="portal-heading">Private project access.</h1>
        <p class="portal-lead">Enter the login provided for your project to review selections, renderings, quotes, invoices and documents.</p>
      </section>
      <form class="portal-login-card" action="/clients/login" method="post">
        <h2>Open your project</h2>
        <p>Project resources are available only to clients with a current login.</p>
        ${errorMessage}
        ${destinationField}
        <label for="project-login">Project login
          <input id="project-login" name="password" type="password" autocomplete="current-password" required autofocus>
        </label>
        <button class="button button-solid" type="submit">Continue</button>
        <p class="portal-security-note">Your login is checked securely and is not stored in this browser.</p>
      </form>
      <form class="portal-admin-entry" action="/clients/admin/request" method="post">
        <span>My Home Builder staff?</span>
        <div class="portal-admin-entry-actions">
          <button class="portal-logout-button" type="submit">Administrator access</button>
          <a class="portal-logout-button" href="/clients/admin/code">Enter a code</a>
        </div>
      </form>
    </div>`, { title: "Client Login" });
}

function billingStatus(item) {
  if (item.status === "paid") return ["paid", "Paid"];
  if (item.status === "accepted") return ["paid", "Accepted"];
  if (item.status === "void") return ["void", "Void"];
  if (item.status === "processing") return ["open", "Processing"];
  if (item.kind === "invoice") return installmentsTotal(item) > 0 ? ["open", "Partly paid"] : ["open", "Due"];
  return ["open", "Awaiting review"];
}

function kindLabel(item) {
  return item.kind === "invoice" ? "Invoice" : "Quote";
}

function documentStatus(document, viewer) {
  const clientSigned = document.signatures?.some((entry) => entry.party === "client");
  const adminSigned = document.signatures?.some((entry) => entry.party === "admin");
  if (document.requiresClientSignature && !clientSigned) return ["open", viewer === "client" ? "Awaiting your signature" : "Awaiting client signature"];
  if (document.requiresAdminSignature && !adminSigned) return ["open", viewer === "admin" ? "Awaiting your signature" : "Awaiting builder signature"];
  if (clientSigned || adminSigned) return ["paid", "Signed"];
  return ["neutral", "On file"];
}

const TRASH_ICON = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.5h13"/><path d="M8 5.5V3.8h4v1.7"/><path d="M5.2 5.5l.8 11h8l.8-11"/><path d="M8.4 8.6v5.2M11.6 8.6v5.2"/></g></svg>`;

// Under an invoice's status in the admin list: how it was paid, or when it is due.
function statusDetail(item) {
  if (item.kind !== "invoice") return "";
  if (item.status === "paid") return [item.payment?.label || (item.payment?.source === "stripe" ? "Stripe" : "Payment"), dateText(item.paidAt)].filter(Boolean).join(" · ");
  if (item.status === "processing") return "Bank payment processing";
  if (item.status !== "open") return "";
  if (!item.dueDate) return "No due date";
  return `${item.dueDate < todayInMichigan() ? "Past due" : "Due"} ${dateText(item.dueDate)}`;
}

// What deleting takes with it, for the confirmation popup (the delete page says it in full).
function deleteNote(item) {
  if (item.status === "processing") return "A bank payment for this invoice is still processing, so it can be deleted once it finishes.";
  if (item.kind === "quote") return "Its link stops working and its number is not used again. This can't be undone.";
  return `${item.status === "paid" || installmentsTotal(item) > 0 ? "Its payment records are deleted with it. " : ""}Its link stops working, and later invoices move up a number. This can't be undone.`;
}

function billingRows(items, { basePath, viewer, readOnly = false }) {
  if (!items.length) {
    return `<p class="portal-empty">${viewer === "client" ? "No quotes or invoices have been posted yet." : "No quotes or invoices for this client yet."}</p>`;
  }
  const rows = items.map((item) => {
    const [tone, label] = billingStatus(item);
    const href = `${basePath}/${encodeURIComponent(item.id)}`;
    const admin = viewer === "admin";
    const name = `${billingLabel(item)} · ${item.title}`;
    // Without scripts, the status opens the invoice and the trash button its delete page.
    const action = admin
      ? `<div class="billing-row-actions">
            <a class="billing-trash" href="${href}/delete" data-delete-menu data-label="${escapeAttribute(name)}" data-kind="${item.kind}" data-note="${escapeAttribute(deleteNote(item))}"${item.status === "processing" ? " data-blocked" : ""} aria-label="Delete ${escapeAttribute(billingLabel(item))}" title="Delete">${TRASH_ICON}</a>
          </div>`
      : `<a class="portal-secondary-link" href="${href}">${item.kind === "invoice" && item.status === "open" && !readOnly ? "View and pay" : "View"}</a>`;
    const note = admin && item.invoiceNumber ? `<small>Invoiced as Invoice ${escapeHtml(item.invoiceNumber)}</small>` : "";
    const dueLine = item.dueDate && !(admin && item.kind === "invoice") ? `<small>${item.kind === "invoice" ? "Due" : "Valid until"} ${dateText(item.dueDate)}</small>` : "";
    const badge = `<span class="portal-status portal-status-${tone}">${label}</span>`;
    const detail = admin ? statusDetail(item) : "";
    const status = admin && item.kind === "invoice" && ["open", "paid"].includes(item.status)
      ? `<a class="status-change" href="${href}" data-status-menu data-label="${escapeAttribute(name)}" data-state="${item.status === "paid" ? "paid" : "due"}" data-source="${escapeAttribute(item.payment?.source || "")}" data-method="${escapeAttribute(item.payment?.label || "")}" data-detail="${escapeAttribute(detail)}" aria-label="${label}: change the status of ${escapeAttribute(billingLabel(item))}" title="Change status">${badge}</a>`
      : badge;
    // How a payment recorded by hand was paid opens a popup to change it (method, reference or
    // date). A Stripe payment keeps what Stripe recorded.
    const payment = item.payment || {};
    const detailText = admin && item.status === "paid" && payment.source === "manual"
      ? `<a class="payment-change" href="${href}" data-payment-menu data-label="${escapeAttribute(name)}" data-method="${escapeAttribute(payment.method || "")}" data-method-name="${escapeAttribute(payment.methodName || "")}" data-note="${escapeAttribute(payment.note || "")}" data-paid-on="${escapeAttribute(String(item.paidAt || "").slice(0, 10))}" title="Change how it was paid">${escapeHtml(detail)}</a>`
      : escapeHtml(detail);
    return `<tr${admin ? ` class="billing-row-link" data-row-href="${href}"` : ""}>
          <td><span class="portal-number">${escapeHtml(item.number)}</span></td>
          <td>${admin ? `<a class="billing-row-title" href="${href}">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}${dueLine}${note}</td>
          <td>${money(item.amountCents, item.currency)}${partlyPaid(item) ? `<small>${money(balanceDue(item), item.currency)} due</small>` : ""}</td>
          <td>${status}${detail ? `<small class="status-detail">${detailText}</small>` : ""}</td>
          <td>${action}</td>
        </tr>`;
  });
  return `<table class="portal-table">
        <thead><tr><th scope="col">Number</th><th scope="col">Item</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Action</span></th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>${viewer === "admin" || readOnly ? billingTotals(items) : ""}`;
}

// Invoiced, paid and outstanding across a project's invoices; voided invoices and quotes are left
// out. Outstanding is each invoice's balance due, as its page shows it: all of an unpaid invoice,
// and whatever a payment fell short of a paid one's total.
function billingTotals(items) {
  const invoices = items.filter((item) => item.kind === "invoice" && item.status !== "void");
  if (!invoices.length) return "";
  const invoiced = invoices.reduce((sum, item) => sum + item.amountCents, 0);
  const paid = invoices.reduce((sum, item) => sum + item.amountCents - balanceDue(item), 0);
  const outstanding = invoices.reduce((sum, item) => sum + balanceDue(item), 0);
  return `
      <dl class="billing-totals">
        <div><dt>Invoiced</dt><dd>${money(invoiced)}</dd></div>
        <div><dt>Paid</dt><dd>${money(paid)}</dd></div>
        <div class="billing-totals-due"><dt>Outstanding</dt><dd>${money(outstanding)}</dd></div>
      </dl>`;
}

function documentRows(documents, { basePath, viewer }) {
  if (!documents.length) {
    return `<p class="portal-empty">${viewer === "client" ? "No documents have been shared yet." : "No documents for this client yet."}</p>`;
  }
  const rows = documents.map((document) => {
    const [tone, label] = documentStatus(document, viewer);
    const needsMySignature = viewer === "client"
      ? document.requiresClientSignature && !document.signatures?.some((entry) => entry.party === "client")
      : document.requiresAdminSignature && !document.signatures?.some((entry) => entry.party === "admin");
    const href = `${basePath}/${encodeURIComponent(document.id)}`;
    return `<tr>
          <td>${escapeHtml(document.name)}<small>${document.uploadedBy === "admin" ? "From My Home Builder" : "Uploaded by client"} · ${dateText(document.createdAt)}${document.size ? ` · ${sizeText(document.size)}` : ""}</small></td>
          <td><span class="portal-status portal-status-${tone}">${label}</span></td>
          <td class="portal-actions">
            <a class="portal-secondary-link" href="${href}">Download</a>
            ${needsMySignature && document.contentType === "application/pdf" ? `<a class="portal-secondary-link" href="${href}/sign">Sign</a>` : ""}
          </td>
        </tr>`;
  });
  return `<table class="portal-table portal-table-documents">
        <thead><tr><th scope="col">Document</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
}

// A portal's documents under their section headings (documents.js), for the client and the admin.
function documentSections(documents, { basePath, viewer }) {
  if (!documents.length) return documentRows(documents, { basePath, viewer });
  return groupBySection(documents).map(([key, group]) => `<h3 class="document-section-heading">${escapeHtml(sectionName(key, viewer))}</h3>
        ${documentRows(group, { basePath, viewer })}`).join("\n        ");
}

// The gallery's photos as tiles (the image itself, cropped to fit), each opening the full image,
// with its note. `meta` is a line under it (who added it and when, or the job); `extra` adds
// controls (the admin's Shown checkbox and trash button).
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

// The date a photo shows (YYYY-MM-DD): the one the admin gave it, or else the day it was added in
// Michigan. A date the admin deleted is "": the photo shows no date.
export function photoDate(photo) {
  if (typeof photo.date === "string") return photo.date;
  return photo.createdAt ? todayInMichigan(new Date(photo.createdAt)) : "";
}

export function photoGrid(photos, { href, meta = () => "", extra = () => "" }) {
  if (!photos.length) return "";
  const tiles = photos.map((photo) => {
    const path = href(photo);
    const note = photo.note || "";
    const line = meta(photo);
    return `<li class="photo-card${photo.hidden ? " is-hidden" : ""}">
            <a class="photo-link" href="${escapeAttribute(path)}"><img src="${escapeAttribute(path)}" alt="${escapeAttribute(note ? note.slice(0, 120) : "Project photo")}" loading="lazy" decoding="async"></a>
            ${note ? `<p class="photo-note">${escapeHtml(note)}</p>` : ""}
            ${line ? `<small class="photo-meta">${line}</small>` : ""}
            ${extra(photo)}
          </li>`;
  }).join("");
  return `<ul class="photo-grid">${tiles}</ul>`;
}

// Add photos: several at once, sharing one note.
export function photoFields(prefix) {
  return `<label for="${prefix}-files">Photos
            <input id="${prefix}-files" name="photos" type="file" accept="${PHOTO_ACCEPT}" multiple required>
          </label>
          <label for="${prefix}-note">Note (optional)
            <textarea id="${prefix}-note" name="note" maxlength="500" rows="3"></textarea>
          </label>`;
}

function noticeMarkup(notice) {
  if (!notice) return "";
  const tone = notice.tone === "error" ? "portal-error" : "portal-notice";
  return `<p class="${tone}" role="status">${escapeHtml(notice.text)}</p>`;
}

// A read-only client sees the whole job's money (from books.js jobBook): its gross income,
// expenses and profit, and each expense.
function financialsSection(book) {
  if (!book) return "";
  const rows = book.expenses.map((row) => `<tr>
          <td>${dateText(row.date)}</td>
          <td>${escapeHtml(row.what)}${row.paidTo ? `<small>${escapeHtml(row.paidTo)}</small>` : ""}</td>
          <td>${escapeHtml(row.category)}</td>
          <td>${money(row.amount)}</td>
        </tr>`).join("");
  return `<section class="portal-section" aria-labelledby="financials-heading">
        <h2 id="financials-heading">Financials</h2>
        ${grossFigures(book.totals)}
        ${rows ? `<table class="portal-table">
          <thead><tr><th scope="col">Date</th><th scope="col">Expense</th><th scope="col">Category</th><th scope="col">Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>` : '<p class="portal-empty">No expenses yet.</p>'}
      </section>`;
}

function grossFigures(totals) {
  return `<dl class="billing-totals">
        <div><dt>Gross income</dt><dd>${money(totals.income)}</dd></div>
        <div><dt>Gross expenses</dt><dd>${money(totals.expenses)}</dd></div>
        <div class="billing-totals-due"><dt>Gross profit</dt><dd${totals.profit < 0 ? ' class="books-loss"' : ""}>${money(totals.profit)}</dd></div>
      </dl>`;
}

// `photos`: the gallery's photos shown in this portal. `projects`: the projects under the client's
// login (a login group), for switching between them; empty when the login opens one project.
export function portalHomePage({ client, billing, documents, storeReady, admin = false, notice = null, book = null, photos = [], projects = [], designer = false }) {
  // Display all data to client portal (read only): every figure, and nothing to do or download.
  const readOnly = Boolean(client.readOnly);
  const shownPhotos = client.photosVisible === false ? [] : photos.filter((photo) => !photo.hidden);
  const switcher = projects.length > 1
    ? `<nav class="project-switch" aria-label="Your projects">
        <form action="/clients/switch" method="post">
          ${projects.map((project) => (project.slug === client.slug
    ? `<span class="project-switch-current" aria-current="page">${escapeHtml(project.name)}</span>`
    : `<button type="submit" name="project" value="${escapeAttribute(project.slug)}">${escapeHtml(project.name)}</button>`)).join("\n          ")}
        </form>
      </nav>`
    : "";
  const gallery = shownPhotos.length
    ? `<section class="portal-section photo-gallery" aria-labelledby="photos-heading">
        <h2 class="visually-hidden" id="photos-heading">Photos</h2>
        ${photoGrid(shownPhotos, { href: (photo) => `/clients/photos/${encodeURIComponent(photo.id)}` })}
      </section>`
    : "";
  const projectSection = client.projectPath
    ? `<section class="portal-section" aria-labelledby="projects-heading">
        <h2 id="projects-heading">Project resources</h2>
        <article class="client-project-card">
          <div class="client-project-copy">
            <span class="client-project-status">Available for review</span>
            <h3>Muskegon Addition Selections</h3>
            <p>Open the current visual selections and rendered views for the Muskegon addition project.</p>
          </div>
          <div class="client-project-action">
            <a class="button button-solid" href="/clients/designer/">Open live designer</a>
            <a class="portal-secondary-link" href="${escapeAttribute(client.projectPath)}/">Review fixed room looks</a>
            <small>Both views remain securely inside your private client session.</small>
          </div>
        </article>
      </section>`
    : designer
      ? `<section class="portal-section" aria-labelledby="projects-heading">
        <h2 id="projects-heading">Project resources</h2>
        <article class="client-project-card">
          <div class="client-project-copy">
            <span class="client-project-status">Available for review</span>
            <h3>Live material designer</h3>
            <p>Try finishes on your project's renders.</p>
          </div>
          <div class="client-project-action">
            <a class="button button-solid" href="/clients/designer/">Open live designer</a>
          </div>
        </article>
      </section>`
      : "";

  const setupNote = storeReady
    ? ""
    : '<p class="portal-notice">Quotes, invoices and documents are being set up for this portal and will appear here soon.</p>';

  return pageShell(`<div class="site-width portal-shell">
      ${switcher}
      <section>
        <p class="portal-kicker">Client portal</p>
        <h1 class="portal-heading">${escapeHtml(client.name)}</h1>
        <p class="portal-lead">${readOnly ? "Everything on this project, read only." : "Review project resources, pay invoices securely, and upload or sign documents in one place."}</p>
        ${storeReady && !readOnly ? '<p class="portal-lead-actions"><a class="button button-outline" href="#upload-document">Upload document</a></p>' : ""}
        ${noticeMarkup(notice)}
        ${setupNote}
      </section>
      ${gallery}
      ${projectSection}
      <section class="portal-section" aria-labelledby="billing-heading">
        <h2 id="billing-heading">Quotes and invoices</h2>
        ${billingRows(billing, { basePath: "/clients/billing", viewer: "client", readOnly })}
      </section>
      ${readOnly ? financialsSection(book) : ""}
      <section class="portal-section" aria-labelledby="documents-heading">
        <h2 id="documents-heading">Documents</h2>
        ${readOnly ? '<p class="portal-empty">Document view disabled for completed projects</p>' : documentSections(documents, { basePath: "/clients/documents", viewer: "client" })}
        ${storeReady && !readOnly ? `<div class="portal-uploads">
        <form class="portal-form portal-upload" id="upload-document" action="/clients/documents/upload" method="post" enctype="multipart/form-data">
          <h3>Upload document</h3>
          <p>Share plans, photos, permits or signed paperwork with My Home Builder. PDF, images and common office files up to 20 MB.</p>
          <label for="client-upload">Choose a file
            <input id="client-upload" name="file" type="file" required>
          </label>
          <button class="button button-solid" type="submit">Upload document</button>
        </form>
        <form class="portal-form portal-upload photo-upload" id="upload-photos" action="/clients/photos" method="post" enctype="multipart/form-data">
          <h3>Gallery</h3>
          ${photoFields("client-photos")}
          <button class="button button-solid" type="submit">Add photos</button>
        </form>
        </div>` : ""}
      </section>
      <div class="portal-account-actions">
        <p>Finished for now? Log out to close this client session.</p>
        <form action="/clients/logout" method="post"><button class="portal-logout-button" type="submit">Log out</button></form>
      </div>
    </div>`, { authenticated: true, admin, title: client.name });
}

// ---------- Quote and invoice document ----------

// Refunds Stripe made or is making on an invoice's payment (not failed or canceled ones).
function liveRefunds(item) {
  return (item.payment?.refunds || []).filter((refund) => refund.amountCents > 0 && !["failed", "canceled"].includes(refund.status));
}

// What happened to a Stripe payment after it was made, as Stripe reported it.
function stripeAftermath(item) {
  const lines = liveRefunds(item).map((refund) => `Refunded ${money(refund.amountCents, item.currency)} on ${formatDate(refund.refundedAt)}${refund.status === "pending" ? " (pending)" : ""}.`);
  const dispute = item.payment?.dispute;
  if (dispute?.id) {
    lines.push(dispute.closedAt
      ? `Disputed; the dispute was ${["won", "warning_closed"].includes(dispute.status) ? "won" : "lost"} on ${formatDate(dispute.closedAt)}.`
      : `Disputed on ${formatDate(dispute.openedAt)} (${dispute.status.replaceAll("_", " ")}). Respond in the Stripe dashboard.`);
  }
  return lines.map((line) => `<p class="admin-meta">${escapeHtml(line)}</p>`).join("\n          ");
}

// Open with payments toward it already (a client paying a bill down over time).
function partlyPaid(item) {
  return item.kind === "invoice" && ["open", "processing"].includes(item.status) && installmentsTotal(item) > 0;
}

function paidSoFar(item) {
  return partlyPaid(item) ? `<p class="portal-notice">You have paid ${money(installmentsTotal(item), item.currency)} of ${money(item.amountCents, item.currency)}. ${money(balanceDue(item), item.currency)} is left to pay.</p>` : "";
}

function paymentSummary(item) {
  const payment = item.payment || {};
  return [formatDate(item.paidAt), payment.label].filter(Boolean).join(" · ");
}

export function billingDocument({ item, client }) {
  const [tone, label] = billingStatus(item);
  const invoice = item.kind === "invoice";
  const lines = billingLineItems(item).map((line) => `<tr>
              <td>${escapeHtml(line.description)}</td>
              <td data-label="Qty">${escapeHtml(quantityText(line.quantity))}</td>
              <td data-label="Unit price">${money(line.unitCents, item.currency)}</td>
              <td data-label="Amount">${money(line.amountCents, item.currency)}</td>
            </tr>`).join("");

  const totals = [];
  const earlier = (item.installments || []).map((entry) => `<tr><th scope="row" colspan="3">Paid ${escapeHtml([formatDate(entry.paidOn), entry.label].filter(Boolean).join(" · "))}</th><td>${money(-entry.amountCents, item.currency)}</td></tr>`);
  if (invoice && item.status === "paid") {
    const paidCents = item.payment?.amountCents ?? item.amountCents - installmentsTotal(item);
    totals.push(`<tr><th scope="row" colspan="3">Total</th><td>${money(item.amountCents, item.currency)}</td></tr>`);
    totals.push(...earlier);
    totals.push(`<tr><th scope="row" colspan="3">Paid ${escapeHtml(paymentSummary(item))}</th><td>${money(-paidCents, item.currency)}</td></tr>`);
    for (const refund of liveRefunds(item)) {
      totals.push(`<tr><th scope="row" colspan="3">Refunded ${escapeHtml(formatDate(refund.refundedAt))}</th><td>${money(refund.amountCents, item.currency)}</td></tr>`);
    }
    totals.push(`<tr class="billing-total"><th scope="row" colspan="3">Balance due</th><td>${money(balanceDue(item), item.currency)}</td></tr>`);
  } else if (invoice && earlier.length && item.status !== "void") {
    totals.push(`<tr><th scope="row" colspan="3">Total</th><td>${money(item.amountCents, item.currency)}</td></tr>`);
    totals.push(...earlier);
    totals.push(`<tr class="billing-total"><th scope="row" colspan="3">Balance due</th><td>${money(balanceDue(item), item.currency)}</td></tr>`);
  } else if (invoice) {
    totals.push(`<tr class="billing-total"><th scope="row" colspan="3">${item.status === "void" ? "Total (void)" : "Amount due"}</th><td>${money(item.amountCents, item.currency)}</td></tr>`);
  } else {
    totals.push(`<tr class="billing-total"><th scope="row" colspan="3">Quote total</th><td>${money(item.amountCents, item.currency)}</td></tr>`);
  }

  return `<article class="billing-doc" aria-label="${kindLabel(item)} ${escapeAttribute(item.number)}">
        <header class="billing-doc-head">
          <div class="billing-doc-brand">
          ${MB_MARK}
            <p class="billing-doc-from"><strong>My Home Builder LLC</strong>${BUSINESS_ADDRESS.map((line) => `<span>${escapeHtml(line)}</span>`).join("")}<span>myhomebuilderllc.com</span><span class="billing-doc-license">${escapeHtml(BUILDER_LICENSE)}</span></p>
          </div>
          <p class="billing-doc-type"><span>${kindLabel(item)}</span><strong>${escapeHtml(item.number)}</strong></p>
        </header>
        <dl class="billing-doc-meta">
          <div><dt>${invoice ? "Bill to" : "Prepared for"}</dt><dd>${escapeHtml(client.name)}</dd></div>
          <div><dt>Issued</dt><dd>${dateText(issuedDate(item))}</dd></div>
          ${item.dueDate ? `<div><dt>${invoice ? "Due" : "Valid until"}</dt><dd>${dateText(item.dueDate)}</dd></div>` : ""}
          <div><dt>Status</dt><dd><span class="portal-status portal-status-${tone}">${label}</span></dd></div>
        </dl>
        <h2 class="billing-doc-title">${escapeHtml(item.title)}</h2>
        <table class="billing-lines">
          <thead><tr><th scope="col">Description</th><th scope="col">Qty</th><th scope="col">Unit price</th><th scope="col">Amount</th></tr></thead>
          <tbody>
            ${lines}
          </tbody>
          <tfoot>
            ${totals.join("\n            ")}
          </tfoot>
        </table>
        ${item.description ? `<section class="billing-doc-notes"><h3>Notes and terms</h3><p>${escapeHtml(item.description).replaceAll("\n", "<br>")}</p></section>` : ""}
        <footer class="billing-doc-foot">
          <p class="billing-doc-insurance">${escapeHtml(INSURANCE)}</p>
          <p>Thank you for building with My Home Builder LLC.</p>
        </footer>
      </article>`;
}

const PRINT_BUTTON = '<button class="portal-logout-button billing-print" type="button" data-print hidden>Print or save as PDF</button>';

function statusPanel(item) {
  if (item.status === "processing") {
    return '<p class="portal-notice">Your bank payment is processing. This page will show it as paid once the bank confirms it.</p>';
  }
  if (item.status === "paid") {
    const summary = paymentSummary(item);
    return `<p class="portal-notice">Paid${summary ? ` ${escapeHtml(summary)}` : ""}. Thank you.</p>`;
  }
  if (item.status === "accepted") {
    return `<p class="portal-notice">Accepted ${dateText(item.acceptedAt)}${item.acceptedBy ? ` by ${escapeHtml(item.acceptedBy)}` : ""}. My Home Builder will follow up with the next step.</p>`;
  }
  if (item.status === "void") {
    return `<p class="portal-notice">This ${item.kind === "invoice" ? "invoice" : "quote"} was voided. Contact My Home Builder with any questions.</p>`;
  }
  return "";
}

function acceptForm(action, { requireName }) {
  return `<form class="billing-accept" action="${escapeAttribute(action)}" method="post">
          <label for="accepted-by">Your name
            <input id="accepted-by" name="name" type="text" autocomplete="name" maxlength="120"${requireName ? " required" : ""}>
          </label>
          <button class="button button-solid" type="submit">Accept this quote</button>
          <p class="portal-security-note">Accepting lets My Home Builder know you are ready to move forward. A contract or invoice will follow.</p>
        </form>`;
}

export function billingDetailPage({ client, item, stripeReady, admin = false, notice = null }) {
  let action = statusPanel(item);
  if (client.readOnly) {
    action += paidSoFar(item);
  } else if (item.kind === "invoice" && item.status === "open") {
    action = stripeReady && isPayable(item)
      ? `${paidSoFar(item)}<form action="/clients/billing/${encodeURIComponent(item.id)}/pay" method="post">
          <button class="button button-solid" type="submit">Pay ${money(balanceDue(item), item.currency)} securely</button>
          <p class="portal-security-note">Payments are processed by Stripe. Card and bank details are entered on Stripe's secure checkout page and never touch this website.</p>
        </form>`
      : '<p class="portal-notice">Online payment is not available yet. Please contact My Home Builder to arrange payment.</p>';
    action += checkOption(item);
  } else if (item.kind === "quote" && item.status === "open") {
    action = acceptForm(`/clients/billing/${encodeURIComponent(item.id)}/accept`, { requireName: false });
  }

  return pageShell(`<div class="site-width portal-shell portal-detail">
      <p class="portal-kicker">${kindLabel(item)} ${escapeHtml(item.number)}</p>
      <h1 class="portal-heading portal-heading-sm">${escapeHtml(item.title)}</h1>
      ${noticeMarkup(notice)}
      <div class="billing-layout">
        ${billingDocument({ item, client })}
        <aside class="portal-card portal-card-action billing-actions">
          ${action}
          ${PRINT_BUTTON}
          <a class="portal-secondary-link" href="/clients">Back to your portal</a>
        </aside>
      </div>
    </div>`, { authenticated: true, admin, title: `${billingLabel(item)} · ${item.title}`, scripts: [BILLING_SCRIPT] });
}

// Public page behind an unguessable link, so clients can pay or accept straight from an email.
export function sharedBillingPage({ client, item, stripeReady, token, notice = null }) {
  const invoice = item.kind === "invoice";
  let action = statusPanel(item);
  if (invoice && item.status === "open") {
    action = stripeReady && isPayable(item)
      ? `${paidSoFar(item)}<a class="button button-solid" href="/clients/pay/${encodeURIComponent(token)}">Pay ${money(balanceDue(item), item.currency)} securely</a>
          <p class="portal-security-note">Payments are processed by Stripe. Card and bank details are entered on Stripe's secure checkout page and never touch this website.</p>`
      : '<p class="portal-notice">Online payment is not available yet. Please contact My Home Builder to arrange payment.</p>';
    action += checkOption(item);
  } else if (!invoice && item.status === "open") {
    action = acceptForm(`/clients/quote/${encodeURIComponent(token)}/accept`, { requireName: true });
  }

  return pageShell(`<div class="site-width portal-shell portal-detail">
      <p class="portal-kicker">${kindLabel(item)} ${escapeHtml(item.number)}</p>
      <h1 class="portal-heading portal-heading-sm">${escapeHtml(item.title)}</h1>
      ${noticeMarkup(notice)}
      <div class="billing-layout">
        ${billingDocument({ item, client })}
        <aside class="portal-card portal-card-action billing-actions">
          ${action}
          ${PRINT_BUTTON}
          <p class="portal-security-note">Have a project login? <a class="portal-inline-link" href="/clients">Open your client portal</a> to see every quote, invoice and document.</p>
        </aside>
      </div>
    </div>`, { title: `${kindLabel(item)} ${item.number}`, scripts: [BILLING_SCRIPT], navCurrent: null });
}

export function signPage({ document, party, actionPath, backPath, error = "", admin = false, authenticated = true, crew = false }) {
  const heading = party === "admin" ? "Sign as My Home Builder LLC." : "Sign this document.";
  return pageShell(`<div class="site-width portal-shell portal-detail">
      <p class="portal-kicker">Electronic signature</p>
      <h1 class="portal-heading">${heading}</h1>
      <p class="portal-lead">You are signing <strong>${escapeHtml(document.name)}</strong>. Review the document first, then draw or type your signature below.</p>
      ${error ? `<p class="portal-error" role="alert">${escapeHtml(error)}</p>` : ""}
      <form class="portal-form portal-sign" action="${escapeAttribute(actionPath)}" method="post" data-sign-form>
        <a class="portal-secondary-link" href="${escapeAttribute(backPath)}">Open the document to review it</a>
        <label for="signer-name">Full legal name
          <input id="signer-name" name="name" type="text" autocomplete="name" maxlength="120" required>
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
          <span>I agree to sign this document electronically and understand that my electronic signature is as valid as a handwritten one.</span>
        </label>
        <p class="portal-security-note">How electronic records and signatures work, and how to get paper copies: <a class="portal-inline-link" href="/legal/#electronic-signatures" target="_blank" rel="noopener">Legal and privacy</a></p>
        <button class="button button-solid" type="submit">Apply signature</button>
      </form>
    </div>`, { authenticated, admin, crew, scripts: ["/clients/portal/sign.js"], title: `Sign ${document.name}` });
}

// Admin sign-in. "sent" follows a code request; "code" is the page any device can open to enter a
// code it already has (/clients/admin/code). A code is not tied to the page that asked for it.
// `codeTo` names the inbox the codes go to, masked (email.js maskedEmail).
export function adminRequestPage({ state, error = "", authenticated = false, codeTo = "" }) {
  const inbox = codeTo ? `<strong>${escapeHtml(codeTo)}</strong>` : "the admin email";
  let body;
  if (state === "sent" || state === "code") {
    const intro = state === "sent"
      ? `<p>A 6-digit code was sent to ${inbox}. It expires in 10 minutes and works on any device.</p>`
      : `<p>Enter the 6-digit code emailed to ${inbox}. It works on any device for 10 minutes after it was sent.</p>`;
    const elsewhere = state === "sent"
      ? `<p class="portal-security-note">On another device, open <a class="portal-inline-link" href="/clients/admin/code">myhomebuilderllc.com/clients/admin/code</a> and enter the code there.</p>`
      : `<p class="portal-security-note">No code yet? <button class="portal-logout-button" type="submit" form="admin-email-code">Email a code</button></p>`;
    body = `<form class="portal-login-card" action="/clients/admin/verify" method="post">
        <h2>Enter the verification code</h2>
        ${intro}
        ${error ? `<p class="portal-error" role="alert">${escapeHtml(error)}</p>` : ""}
        <label for="admin-code">Verification code
          <input id="admin-code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus>
        </label>
        <button class="button button-solid" type="submit">Open admin panel</button>
        <p class="portal-security-note">Codes are single use and are checked securely.</p>
        ${elsewhere}
      </form>
      ${state === "code" ? '<form id="admin-email-code" action="/clients/admin/request" method="post" hidden></form>' : ""}`;
  } else if (state === "email-not-configured") {
    body = `<div class="portal-login-card">
        <h2>Email delivery is not set up</h2>
        <p>The admin verification email cannot be sent until an email API key is configured for this portal. See the repository README for the required secrets.</p>
        <a class="portal-secondary-link" href="/clients">Back to the portal</a>
      </div>`;
  } else if (state === "rate-limited") {
    body = `<div class="portal-login-card">
        <h2>Too many code requests</h2>
        <p>Several verification codes were requested in the last few minutes. Wait 10 minutes, then press Admin again.</p>
        <a class="portal-secondary-link" href="/clients">Back to the portal</a>
      </div>`;
  } else if (state === "storage-not-configured") {
    body = `<div class="portal-login-card">
        <h2>Portal storage is not set up</h2>
        <p>Admin access needs the portal storage bindings before verification codes can be issued. See the repository README for setup.</p>
        <a class="portal-secondary-link" href="/clients">Back to the portal</a>
      </div>`;
  } else {
    body = `<div class="portal-login-card">
        <h2>The code could not be sent</h2>
        <p>The verification email did not go out. Please try again in a moment.</p>
        <form action="/clients/admin/request" method="post"><button class="button button-solid" type="submit">Try again</button></form>
      </div>`;
  }

  return pageShell(`<div class="site-width portal-shell portal-login-grid">
      <section>
        <p class="portal-kicker">Admin access</p>
        <h1 class="portal-heading">Verify it is you.</h1>
        <p class="portal-lead">Admin tools let My Home Builder add quotes and invoices, share contracts and sign documents for any client portal.</p>
      </section>
      ${body}
    </div>`, { authenticated, title: "Admin verification" });
}

// ---------- Admin ----------

function statusChip(ready, label) {
  return `<span class="admin-chip ${ready ? "admin-chip-on" : "admin-chip-off"}">${label}: ${ready ? "ready" : "not configured"}</span>`;
}

function adminShell(content, { title, scripts = [] }) {
  return pageShell(content, { authenticated: false, admin: true, bodyClass: "portal-page portal-admin", title, scripts });
}

// Templates, beside a new quote or invoice's heading: choosing one opens the editor filled in from
// it (billing.js). Without scripts its button does.
function templatePicker(templates, action) {
  if (!templates.length) return "";
  const options = templates.map((template) => `<option value="${escapeAttribute(template.id)}">${escapeHtml(template.name)} (${template.kind === "invoice" ? "invoice" : "quote"})</option>`).join("");
  return `<form class="admin-template-picker" action="${escapeAttribute(action)}" method="get">
          <select class="select-plain" id="template-pick" name="template" required aria-label="Templates" data-autosubmit><option value="" selected disabled hidden>Templates</option>${options}</select>
          <noscript><button class="portal-logout-button" type="submit">Use template</button></noscript>
        </form>`;
}

// A disk: the save button beside a single field.
const SAVE_ICON = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 3.5h10.2l2.8 2.8v10.2h-13z"/><path d="M6.5 3.5v4h6v-4"/><path d="M6 16.5v-5.2h8v5.2"/></g></svg>`;

// The popups the admin list opens (billing.js): change an invoice's status, and confirm a
// delete. Due to paid asks how it was paid; paid to due removes a payment recorded by hand.
function statusDialogs(client, readiness) {
  const emails = clientEmails(client);
  const receipt = readiness.email && emails.length
    ? `<label class="portal-check" for="list-payment-receipt">
              <input id="list-payment-receipt" name="sendReceipt" type="checkbox" value="yes" checked>
              <span>Email a receipt to ${escapeHtml(addressesText(emails))}</span>
            </label>`
    : "";
  return `<dialog class="admin-dialog" id="status-dialog" aria-labelledby="status-dialog-title">
          <div class="admin-dialog-head">
            <h2 id="status-dialog-title" data-status-title>Change status</h2>
            <button class="admin-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
          </div>
          <p class="admin-meta" data-status-current></p>
          <div class="status-choice" role="group" aria-label="Status">
            <button type="button" class="status-option" data-status-option="due" aria-pressed="false">Due</button>
            <button type="button" class="status-option" data-status-option="paid" aria-pressed="false">Paid</button>
          </div>
          <form class="admin-stack-form" method="post" data-status-paid hidden>
            <input type="hidden" name="return" value="list">
            ${paymentFields("list-payment", { date: todayInMichigan() })}
            ${receipt}
            <button class="button button-solid" type="submit">Mark as paid</button>
          </form>
          <form class="admin-stack-form" method="post" data-status-due hidden>
            <input type="hidden" name="return" value="list">
            <p class="admin-meta" data-status-due-text></p>
            <button class="button button-solid" type="submit">Mark as due</button>
          </form>
          <p class="portal-security-note" data-status-stripe hidden>Paid through Stripe, so it stays paid.</p>
        </dialog>
        <dialog class="admin-dialog" id="payment-dialog" aria-labelledby="payment-dialog-title">
          <div class="admin-dialog-head">
            <h2 id="payment-dialog-title" data-payment-title>How it was paid</h2>
            <button class="admin-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
          </div>
          <form class="admin-stack-form" method="post" data-payment-form>
            <input type="hidden" name="return" value="list">
            ${paymentFields("list-edit-payment", { date: todayInMichigan() })}
            <button class="button button-solid" type="submit">Save payment</button>
          </form>
        </dialog>
        <dialog class="admin-dialog" id="delete-dialog" aria-labelledby="delete-dialog-title">
          <div class="admin-dialog-head">
            <h2 id="delete-dialog-title" data-delete-title>Delete?</h2>
            <button class="admin-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
          </div>
          <p class="admin-meta" data-delete-note></p>
          <form class="admin-dialog-actions" method="post" data-delete-form>
            <button class="button button-danger" type="submit" data-delete-submit>Delete</button>
            <button class="portal-logout-button" type="button" data-dialog-close>Cancel</button>
          </form>
          <p><a class="portal-secondary-link" href="#" data-delete-details>What goes with it</a></p>
        </dialog>`;
}

// Expenses, newest first, with their total: a job's on its panel, overhead on the Books page.
// Clients see them only on a project shown read only.
function expenseRows(expenses, { base, totalLabel = "Job expenses" }) {
  if (!expenses.length) return '<p class="portal-empty">No expenses yet.</p>';
  const rows = expenses.map((expense) => {
    const path = `${base}/expenses/${encodeURIComponent(expense.id)}`;
    const what = expense.description || expense.vendor;
    const name = `${what} · ${money(expense.amountCents)}`;
    return `<tr>
          <td>${dateText(expense.spentOn)}</td>
          <td>${escapeHtml(what)}${expense.description && expense.vendor ? `<small>${escapeHtml(expense.vendor)}</small>` : ""}</td>
          <td>${escapeHtml(categoryName(expense))}</td>
          <td>${escapeHtml(expense.paidWith?.label || "")}${expense.bankTransactionId ? "<small>Matched to the bank</small>" : ""}</td>
          <td>${money(expense.amountCents)}</td>
          <td><div class="billing-row-actions">
            ${expense.receipt ? `<a class="portal-secondary-link" href="${path}/receipt">Receipt</a>` : ""}
            <form method="post" action="${path}/delete" data-confirm="${escapeAttribute(`Delete the expense ${name}? It comes out of the books. This can't be undone.`)}">
              <button class="billing-trash" type="submit" aria-label="Delete the expense ${escapeAttribute(name)}" title="Delete">${TRASH_ICON}</button>
            </form>
          </div></td>
        </tr>`;
  }).join("");
  const total = expenses.reduce((sum, expense) => sum + expense.amountCents, 0);
  return `<table class="portal-table">
        <thead><tr><th scope="col">Date</th><th scope="col">Expense</th><th scope="col">Category</th><th scope="col">Paid with</th><th scope="col">Amount</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <dl class="billing-totals">
        <div class="billing-totals-due"><dt>${escapeHtml(totalLabel)}</dt><dd>${money(total)}</dd></div>
      </dl>`;
}

// Add expense, compact: each box says what goes in it. Paid to suggests everyone in Labor and
// whoever earlier expenses went to, and Category the usual categories, but both take anything
// typed. With `jobs` (the Books page) it starts with the job, where no job is overhead.
function addExpenseFields({ action, payers, today, prefix, paidTo = [], jobs = null }) {
  const categories = jobs ? [...JOB_CATEGORIES, ...OVERHEAD_CATEGORIES] : JOB_CATEGORIES;
  const hidden = (id, label, control) => `<label class="in-box" for="${prefix}-${id}"><span class="visually-hidden">${label}</span>${control}</label>`;
  const shown = (id, label, control) => `<label class="in-box in-box-tagged" for="${prefix}-${id}"><span class="in-box-tag">${label}</span>${control}</label>`;
  return `<form class="admin-stack-form expense-form" method="post" action="${escapeAttribute(action)}" enctype="multipart/form-data">
            ${jobs ? shown("job", "Job", `<select id="${prefix}-job" name="job"><option value="">Overhead (no job)</option>${jobs.map((client) => `<option value="${escapeAttribute(client.slug)}">${escapeHtml(client.label || client.name)}</option>`).join("")}</select>`) : ""}
            ${hidden("description", "Expense", `<input id="${prefix}-description" name="description" type="text" maxlength="200" required placeholder="Expense">`)}
            ${hidden("vendor", "Paid to", `<input id="${prefix}-vendor" name="vendor" type="text" maxlength="120" list="${prefix}-paid-to" autocomplete="off" placeholder="Paid to">`)}
            <datalist id="${prefix}-paid-to">${paidTo.map((name) => `<option value="${escapeAttribute(name)}"></option>`).join("")}</datalist>
            ${hidden("category", "Category", `<input id="${prefix}-category" name="category" type="text" maxlength="60" list="${prefix}-categories" autocomplete="off" placeholder="Category">`)}
            <datalist id="${prefix}-categories">${categories.map(([, name]) => `<option value="${escapeAttribute(name)}"></option>`).join("")}</datalist>
            <div class="expense-pair">
              ${hidden("amount", "Amount", `<input id="${prefix}-amount" name="amount" type="text" inputmode="decimal" maxlength="12" required placeholder="Amount">`)}
              ${shown("date", "Date", `<input id="${prefix}-date" name="spentOn" type="date" required value="${escapeAttribute(today)}" max="${escapeAttribute(today)}">`)}
            </div>
            ${shown("paid", "Paid with", `<select id="${prefix}-paid" name="paidWith">${payers.map((option) => `<option value="${escapeAttribute(option.key)}">${escapeHtml(option.label)}</option>`).join("")}</select>`)}
            ${shown("receipt", "Receipt", `<input id="${prefix}-receipt" name="receipt" type="file" accept="application/pdf,image/*">`)}
            <button class="button button-solid" type="submit">Add expense</button>
          </form>`;
}

function addExpenseDialog(options) {
  return `<dialog class="admin-dialog expense-dialog" id="add-expense-dialog" aria-labelledby="add-expense-title">
          <div class="admin-dialog-head">
            <h2 id="add-expense-title">Add an expense</h2>
            <button class="admin-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
          </div>
          ${addExpenseFields({ ...options, prefix: "add-expense" })}
        </dialog>`;
}

// The page without scripts: a job's (client) or, from the Books page, any job's or overhead (jobs).
export function adminAddExpensePage({ client = null, jobs = null, payers, today, paidTo = [], notice = null }) {
  const back = client ? `/clients/admin?client=${encodeURIComponent(client.slug)}` : "/clients/admin/books";
  const action = client ? `/clients/admin/clients/${encodeURIComponent(client.slug)}/expenses` : "/clients/admin/books/expenses";
  return adminShell(`<div class="site-width portal-shell portal-detail">
      <p class="portal-kicker"><a class="portal-inline-link" href="${back}">${escapeHtml(client ? client.name : "Books")}</a></p>
      <h1 class="portal-heading portal-heading-sm">Add an expense.</h1>
      ${noticeMarkup(notice)}
      <section class="admin-card admin-card-narrow">
        ${addExpenseFields({ action, payers, today, paidTo, jobs: client ? null : jobs, prefix: "add-expense" })}
      </section>
    </div>`, { title: "Add an expense", scripts: [BILLING_SCRIPT] });
}

// Add payment: a payment toward one of the project's open invoices. The list opens it in a popup;
// the same form is a page without scripts.
function addPaymentFields({ client, billing, readiness, selected = "", prefix }) {
  const open = billing.filter((item) => item.kind === "invoice" && item.status === "open" && balanceDue(item) > 0);
  if (!open.length) return '<p class="admin-meta">No invoices in this project are waiting for payment.</p>';
  const chosen = open.find((item) => item.id === selected) || open[0];
  const emails = clientEmails(client);
  const options = open.map((item) => `<option value="${escapeAttribute(item.id)}" data-balance="${escapeAttribute(moneyInput(balanceDue(item)))}"${item === chosen ? " selected" : ""}>${escapeHtml(billingLabel(item))} · ${escapeHtml(item.title)} · ${money(balanceDue(item), item.currency)} due</option>`).join("");
  return `<form class="admin-stack-form" method="post" action="/clients/admin/clients/${encodeURIComponent(client.slug)}/payments" data-add-payment-form>
            <label for="${prefix}-invoice">Invoice
              <select id="${prefix}-invoice" name="invoice" data-add-payment-invoice>${options}</select>
            </label>
            <label for="${prefix}-amount">Amount received ($)
              <input id="${prefix}-amount" name="amount" type="text" inputmode="decimal" maxlength="12" required value="${escapeAttribute(moneyInput(balanceDue(chosen)))}" data-add-payment-amount>
            </label>
            ${paymentFields(prefix, { date: todayInMichigan() })}
            ${readiness.email && emails.length ? `<label class="portal-check" for="${prefix}-receipt">
              <input id="${prefix}-receipt" name="sendReceipt" type="checkbox" value="yes" checked>
              <span>Email a receipt to ${escapeHtml(addressesText(emails))}</span>
            </label>` : ""}
            <button class="button button-solid" type="submit">Add payment</button>
          </form>`;
}

function addPaymentDialog({ client, billing, readiness }) {
  return `<dialog class="admin-dialog" id="add-payment-dialog" aria-labelledby="add-payment-title">
          <div class="admin-dialog-head">
            <h2 id="add-payment-title">Add a payment</h2>
            <button class="admin-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
          </div>
          ${addPaymentFields({ client, billing, readiness, prefix: "add-payment" })}
        </dialog>`;
}

export function adminAddPaymentPage({ client, billing, readiness, selected = "", notice = null }) {
  return adminShell(`<div class="site-width portal-shell portal-detail">
      <p class="portal-kicker"><a class="portal-inline-link" href="/clients/admin?client=${encodeURIComponent(client.slug)}">${escapeHtml(client.name)}</a></p>
      <h1 class="portal-heading portal-heading-sm">Add a payment.</h1>
      ${noticeMarkup(notice)}
      <section class="admin-card admin-card-narrow">
        ${addPaymentFields({ client, billing, readiness, selected, prefix: "add-payment" })}
      </section>
    </div>`, { title: "Add a payment", scripts: [BILLING_SCRIPT] });
}

// Admin Documents page: share a document into any client portal's section and ask for
// signatures, with everything still awaiting a signature listed first.
export function adminDocumentsPage({ clients, documents, notice = null }) {
  const names = new Map(clients.map((client) => [client.slug, client.label || client.name]));
  const row = (document) => {
    const [tone, label] = documentStatus(document, "admin");
    const path = `/clients/admin/clients/${encodeURIComponent(document.clientSlug)}/documents/${encodeURIComponent(document.id)}`;
    const mine = document.requiresAdminSignature && !document.signatures?.some((entry) => entry.party === "admin") && document.contentType === "application/pdf";
    return `<tr>
          <td>${escapeHtml(document.name)}<small>${escapeHtml(names.get(document.clientSlug) || document.clientSlug)} · ${escapeHtml(sectionName(sectionOf(document), "admin"))} · ${dateText(document.createdAt)}</small></td>
          <td><span class="portal-status portal-status-${tone}">${label}</span></td>
          <td class="portal-actions">
            <a class="portal-secondary-link" href="${path}">Download</a>
            ${mine ? `<a class="portal-secondary-link" href="${path}/sign">Sign</a>` : ""}
          </td>
        </tr>`;
  };
  const table = (rows, empty) => rows.length
    ? `<table class="portal-table portal-table-documents">
        <thead><tr><th scope="col">Document</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${rows.map(row).join("")}</tbody>
      </table>`
    : `<p class="portal-empty">${empty}</p>`;
  const waiting = documents.filter(awaitingSignature);
  const shared = documents.filter((document) => !awaitingSignature(document)).slice(0, 50);
  const portals = clients.map((client) => `<option value="${escapeAttribute(client.slug)}">${escapeHtml(client.label || client.name)}</option>`).join("");
  return adminShell(`<div class="site-width portal-shell">
      <section class="admin-intro">
        <p class="portal-kicker">Admin panel</p>
        <h1 class="portal-heading">Documents.</h1>
        <p class="portal-lead">Share contracts, change orders, plans and other files into any client portal, in the section the client will find them, and ask for signatures.</p>
        ${noticeMarkup(notice)}
      </section>
      <div class="admin-layout">
        <aside class="admin-sidebar">
          <form class="portal-form admin-form" action="/clients/admin/documents" method="post" enctype="multipart/form-data">
            <h3>Upload a document</h3>
            <label for="documents-client">Client portal
              <select id="documents-client" name="client" required>${portals}</select>
            </label>
            <label for="documents-section">Section
              <select id="documents-section" name="section">${DOCUMENT_SECTIONS.map(([key, label]) => `<option value="${key}"${key === "contracts" ? " selected" : ""}>${label}</option>`).join("")}</select>
            </label>
            <label for="documents-file">File
              <input id="documents-file" name="file" type="file" required>
            </label>
            <label class="portal-check" for="documents-client-sign">
              <input id="documents-client-sign" name="requiresClientSignature" type="checkbox" value="yes">
              <span>Client must sign (PDF only)</span>
            </label>
            <label class="portal-check" for="documents-admin-sign">
              <input id="documents-admin-sign" name="requiresAdminSignature" type="checkbox" value="yes">
              <span>I will sign on my end (PDF only)</span>
            </label>
            <button class="button button-solid" type="submit">Share with client</button>
            <p class="portal-security-note">PDF, images and common office files up to 20 MB. Only a PDF can be signed in the portal.</p>
          </form>
        </aside>
        <section class="admin-panel" aria-labelledby="documents-waiting">
          <h2 id="documents-waiting">Awaiting signatures</h2>
          ${table(waiting, "Nothing is waiting for a signature.")}
          <h2 class="admin-panel-subheading">Shared recently</h2>
          ${table(shared, "No documents have been shared yet.")}
        </section>
      </div>
    </div>`, { title: "Documents" });
}

// ---------- Client portals and their projects ----------

// What the right-click menu (billing.js) needs to know about a client portal or project: its id
// and name, the client portal it is in (a project can be made its own client portal again) and
// that portal's name (Export Client to PDF exports the whole client), and whether its login is set
// in Render (the Muskegon project stays a client portal of its own).
function portalMenuData(client, clientName = client.name) {
  return ` data-portal-menu="${escapeAttribute(client.slug)}" data-portal-name="${escapeAttribute(client.name)}" data-portal-client="${escapeAttribute(clientName)}"${client.parentSlug ? ` data-portal-parent="${escapeAttribute(client.parentSlug)}"` : ""}${client.managedBySecret ? " data-portal-secret" : ""}`;
}

// Export Client to PDF: the popup asks what goes in, then the PDF downloads. Without scripts the
// link downloads the full breakdown.
function exportDialog() {
  return `<dialog class="admin-dialog" id="export-dialog" aria-labelledby="export-dialog-title">
          <div class="admin-dialog-head">
            <h2 id="export-dialog-title">Export Client to PDF</h2>
            <button class="admin-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
          </div>
          <form class="admin-stack-form" method="get" data-export-form>
            <p class="admin-meta" data-export-for></p>
            <label class="portal-check" for="export-costs">
              <input id="export-costs" name="costs" type="checkbox" value="yes" checked>
              <span>Costs, profit and payments</span>
            </label>
            <small class="admin-field-hint">For investors. Untick it for a potential client: the PDF then shows each project's work, its price and photos, and nothing about payments, balances, costs or profit.</small>
            <label class="portal-check" for="export-photos">
              <input id="export-photos" name="photos" type="checkbox" value="yes" checked>
              <span>Photos</span>
            </label>
            <button class="button button-solid" type="submit">Download PDF</button>
            <p class="portal-security-note">A breakdown of every project in the client portal. Client emails, logins and documents are never in it.</p>
          </form>
        </dialog>`;
}

function insideOptions(portals) {
  return `<option value="" selected disabled>Choose a client portal</option>${portals.map((portal) => `<option value="${escapeAttribute(portal.slug)}">${escapeHtml(portal.name)}</option>`).join("")}`;
}

// The menu a right-click (or a long press) on a client portal or project opens, and the popup that
// asks which client portal it goes inside. billing.js fills both in for the one chosen; `portals`
// are the client portals in use. Each project's panel has the same actions under Archive or move.
function portalMenu(portals) {
  return `<div class="portal-menu" id="portal-menu" role="menu" aria-label="Client portal" hidden>
          <form method="post" data-portal-menu-archive><button type="submit" role="menuitem">Send to archive</button></form>
          <button type="button" role="menuitem" data-portal-menu-inside>Inside another portal</button>
          <form method="post" data-portal-menu-own><button type="submit" role="menuitem">Make it its own client portal</button></form>
          <button type="button" role="menuitem" data-portal-menu-export>Export Client to PDF</button>
        </div>
        ${exportDialog()}
        <dialog class="admin-dialog" id="inside-dialog" aria-labelledby="inside-dialog-title">
          <div class="admin-dialog-head">
            <h2 id="inside-dialog-title" data-inside-title>Inside another portal</h2>
            <button class="admin-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
          </div>
          <form class="admin-stack-form" method="post" data-inside-form>
            <label for="inside-to">Inside another portal
              <select id="inside-to" name="to" required>${insideOptions(portals)}</select>
            </label>
            <p class="portal-security-note">It becomes a project in the client portal you choose (a client portal brings its projects with it). Quotes, invoices, expenses and documents go with it, and it uses that portal's client login from then on.</p>
            <button class="button button-solid" type="submit">Put it inside</button>
          </form>
          <p class="admin-meta" data-inside-none hidden>There is no other client portal to put it in yet.</p>
        </dialog>`;
}

// What is in the archive: client portals sent there (with the projects that went with them), and
// projects sent there on their own while their client portal is still in use.
function archiveContents(clients) {
  const bySlug = new Map(clients.map((client) => [client.slug, client]));
  const portals = clients.filter((client) => !client.parentSlug && client.archivedAt);
  const projects = clients.filter((client) => client.parentSlug && client.archivedAt && !bySlug.get(client.parentSlug)?.archivedAt);
  return { portals, projects, count: portals.length + projects.length, bySlug };
}

// Show finances for all projects under this client: each project's date (its earliest invoice),
// its invoices (invoiced, paid and outstanding, as its list totals them) and its job book (gross
// income, gross expenses and gross profit), then all of them together. Folded until it is opened;
// in a narrow window each project is a card instead of a row.
function clientFinances(projects, billing, books) {
  const rows = projects.map((project) => {
    const invoices = billing.filter((item) => item.clientSlug === project.slug && item.kind === "invoice" && item.status !== "void");
    const book = books.get(project.slug) || { income: 0, expenses: 0, profit: 0 };
    return {
      project,
      date: invoices.map(issuedDate).sort()[0] || "",
      invoiced: invoices.reduce((sum, item) => sum + item.amountCents, 0),
      paid: invoices.reduce((sum, item) => sum + item.amountCents - balanceDue(item), 0),
      outstanding: invoices.reduce((sum, item) => sum + balanceDue(item), 0),
      income: book.income,
      expenses: book.expenses,
      profit: book.profit
    };
  });
  const fields = ["invoiced", "paid", "outstanding", "income", "expenses", "profit"];
  const total = Object.fromEntries(fields.map((field) => [field, rows.reduce((sum, row) => sum + row[field], 0)]));
  const cells = (row) => `<td class="books-money" data-label="Invoiced">${money(row.invoiced)}</td>
              <td class="books-money" data-label="Paid">${money(row.paid)}</td>
              <td class="books-money" data-label="Outstanding">${money(row.outstanding)}</td>
              <td class="books-money" data-label="Gross income">${money(row.income)}</td>
              <td class="books-money" data-label="Gross expenses">${money(row.expenses)}</td>
              <td class="books-money${row.profit < 0 ? " books-loss" : ""}" data-label="Gross profit">${money(row.profit)}</td>`;
  return `<details class="client-finances" id="client-finances">
          <summary>Show finances for all projects under this client</summary>
          <div class="fit-table-box">
          <table class="portal-table books-table fit-table client-finances-table">
            <thead><tr><th scope="col">Date</th><th scope="col">Project</th><th scope="col" class="books-money">Invoiced</th><th scope="col" class="books-money">Paid</th><th scope="col" class="books-money">Outstanding</th><th scope="col" class="books-money">Gross income</th><th scope="col" class="books-money">Gross expenses</th><th scope="col" class="books-money">Gross profit</th></tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td class="fit-table-date" data-label="Date">${row.date ? dateText(row.date) : ""}</td>
              <td class="fit-table-name"><a class="portal-inline-link" href="/clients/admin?client=${encodeURIComponent(row.project.slug)}">${escapeHtml(row.project.name)}</a></td>
              ${cells(row)}
            </tr>`).join("")}</tbody>
            <tfoot><tr><th class="fit-table-name" scope="row" colspan="2">All projects</th>${cells(total)}</tr></tfoot>
          </table>
          </div>
        </details>`;
}

// Export Client to PDF, at the very bottom of a client portal's page.
function exportLink(root) {
  return `<a class="button button-outline client-export" href="/clients/admin/clients/${encodeURIComponent(root.slug)}/export?costs=yes&amp;photos=yes" data-export-client data-export-name="${escapeAttribute(root.name)}">Export Client to PDF</a>`;
}

// The top of a client portal's page: Add project, the list of its projects (the client portal
// itself first; a click opens one, a right-click its menu), folded under the client portal's name
// when there is more than one, and Show finances for all projects under this client. A new
// project's job site address starts as the client portal's.
function clientProjects({ root, projects, selected, counted, projectBilling, projectBooks, newProject, projectError }) {
  const tabs = projects.map((project) => {
    const current = project.slug === selected.slug;
    return `<li><a class="client-project-tab${current ? " is-current" : ""}${project.archivedAt ? " is-archived" : ""}" href="/clients/admin?client=${encodeURIComponent(project.slug)}"${current ? ' aria-current="page"' : ""}${project.archivedAt ? "" : portalMenuData(project, root.name)}>${escapeHtml(project.name)}${project.archivedAt ? "<small>In archive</small>" : ""}</a></li>`;
  }).join("\n            ");
  const list = `<nav class="client-project-tabs" aria-label="Projects of ${escapeAttribute(root.name)}">
              <ul>
              ${tabs}
              </ul>
            </nav>`;
  const add = root.archivedAt ? "" : `<details class="admin-add-project" id="add-project" data-collapsible${projectError ? " open" : ""}>
          <summary>Add project</summary>
          <form class="admin-inline-form admin-add-project-form" action="/clients/admin/clients/${encodeURIComponent(root.slug)}/projects" method="post">
            ${projectError ? `<p class="portal-error" role="alert">${escapeHtml(projectError)}</p>` : ""}
            <label for="project-name">Project name
              <input id="project-name" name="name" type="text" maxlength="120" required value="${escapeAttribute(newProject?.name || "")}" placeholder="Kitchen Remodel">
            </label>
            <label for="project-site">Job site address (optional)
              <input id="project-site" name="siteAddress" type="text" maxlength="200" value="${escapeAttribute(newProject ? newProject.siteAddress : root.siteAddress || "")}" placeholder="1234 Lakeshore Dr, Muskegon, MI 49441">
            </label>
            <button class="button button-solid" type="submit">Add project</button>
          </form>
        </details>`;
  return `<div class="client-projects">
          ${add}
          ${projects.length > 1
    ? `<details class="client-project-menu" data-collapsible>
            <summary>${escapeHtml(root.name)}</summary>
            ${list}
          </details>`
    : `<div class="client-project-row">
            ${list}
          </div>`}
          ${clientFinances(counted, projectBilling, projectBooks)}
        </div>`;
}

// A project open from the archive: what that means, and Restore (a project inside a client portal
// that is in the archive too waits for the portal).
function archivedNote(selected, root) {
  if (!selected.archivedAt) return "";
  const waits = Boolean(selected.parentSlug && root?.archivedAt);
  return `<div class="admin-archived" role="status">
          <p><strong>In the archive</strong> since ${dateText(selected.archivedAt)}. It is left out of the books and the client portal screen, and the client cannot open it.</p>
          ${waits
    ? `<p class="admin-meta">It is inside ${escapeHtml(root.name)}, which is in the archive too. Restore ${escapeHtml(root.name)} to bring it back.</p>`
    : `<form action="/clients/admin/clients/${encodeURIComponent(selected.slug)}/restore" method="post"><button class="button button-solid" type="submit">Restore</button></form>`}
        </div>`;
}

// The right-click menu's actions on the project's own panel, folded at its bottom, for phones and
// pages without scripts.
function archiveOrMove(selected, portals) {
  if (selected.archivedAt) return "";
  const base = `/clients/admin/clients/${encodeURIComponent(selected.slug)}`;
  const targets = portals.filter((portal) => portal.slug !== selected.slug && portal.slug !== selected.parentSlug);
  const inside = selected.managedBySecret
    ? '<p class="portal-security-note">Its login is set in Render, so it stays a client portal of its own. Other portals can go inside it.</p>'
    : targets.length
      ? `<form class="admin-inline-form admin-inside-form" action="${base}/inside" method="post">
              <label for="manage-inside">Inside another portal
                <select id="manage-inside" name="to" required>${insideOptions(targets)}</select>
              </label>
              <button class="portal-logout-button" type="submit">Put it inside</button>
            </form>`
      : "";
  return `<details class="admin-archive-move">
          <summary>Archive or move</summary>
          <div class="admin-archive-move-body">
            <form action="${base}/archive" method="post">
              <button class="portal-logout-button" type="submit">Send to archive</button>
              <p class="portal-security-note">${selected.parentSlug ? "This project leaves" : "This client portal and its projects leave"} the client portal screen and the books, and the client cannot open ${selected.parentSlug ? "it" : "them"}. Archive, at the bottom of the admin panel, restores ${selected.parentSlug ? "it" : "them"}.</p>
            </form>
            ${inside}
            ${selected.parentSlug ? `<form action="${base}/own" method="post">
              <button class="portal-logout-button" type="submit">Make it its own client portal</button>
              <p class="portal-security-note">It leaves this client portal and has no client login until you give it one.</p>
            </form>` : ""}
          </div>
        </details>`;
}

// The project's gallery: the master switch, the photos (each with its Shown checkbox and trash
// button) and Add photos.
function adminGallery(selected, photos, base) {
  // Who added it, then its date: a click on the date opens a popup to change or delete it
  // (billing.js; without scripts, a page). A deleted date shows nothing; the empty spot still
  // opens the popup, to give it one again.
  const meta = (photo) => {
    const day = photoDate(photo);
    const path = `${base}/photos/${encodeURIComponent(photo.id)}/date`;
    const who = escapeHtml(photo.uploaderName || (photo.uploadedBy === "client" ? "Client" : "My Home Builder"));
    return day
      ? `${who} · <a class="photo-date" href="${path}" data-photo-date data-date="${escapeAttribute(day)}" title="Change the date">${dateText(day)}</a>`
      : `${who}<a class="photo-date is-empty" href="${path}" data-photo-date data-date="" aria-label="Add a date" title="Add a date"></a>`;
  };
  const extra = (photo) => {
    const path = `${base}/photos/${encodeURIComponent(photo.id)}`;
    return `<div class="photo-actions">
              <form class="photo-shown" action="${path}/shown" method="post">
                <label class="portal-check" for="photo-shown-${escapeAttribute(photo.id)}">
                  <input id="photo-shown-${escapeAttribute(photo.id)}" name="shown" type="checkbox" value="yes"${photo.hidden ? "" : " checked"} data-autosubmit>
                  <span>Shown</span>
                </label>
                <button class="portal-logout-button" type="submit" data-autosubmit-button>Save</button>
              </form>
              <form method="post" action="${path}/delete" data-confirm="Delete this photo? This can't be undone.">
                <button class="billing-trash" type="submit" aria-label="Delete photo" title="Delete">${TRASH_ICON}</button>
              </form>
            </div>`;
  };
  return `<div class="admin-subhead admin-gallery-head" id="gallery">
          <h3>Gallery</h3>
          <form class="gallery-master" action="${base}/gallery" method="post">
            <label class="portal-check" for="photos-visible">
              <input id="photos-visible" name="shown" type="checkbox" value="yes"${selected.photosVisible === false ? "" : " checked"} data-autosubmit>
              <span>Show photos in the client portal</span>
            </label>
            <button class="portal-logout-button" type="submit" data-autosubmit-button>Save</button>
          </form>
        </div>
        ${photos.length ? photoGrid(photos, { href: (photo) => `${base}/photos/${encodeURIComponent(photo.id)}`, meta, extra }) : '<p class="portal-empty">No photos yet.</p>'}
        <form class="portal-form admin-form photo-upload" action="${base}/photos" method="post" enctype="multipart/form-data">
          <h3>Add photos</h3>
          ${photoFields("admin-photos")}
          <button class="button button-solid" type="submit">Add photos</button>
        </form>
        ${photos.length ? `<dialog class="admin-dialog" id="photo-date-dialog" aria-labelledby="photo-date-title">
          <div class="admin-dialog-head">
            <h2 id="photo-date-title">Photo date</h2>
            <button class="admin-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
          </div>
          ${photoDateFields("photo-date-dialog-date", "")}
        </dialog>` : ""}`;
}

// A photo's date: change it, or delete it so the photo shows none. `action` is set by billing.js in
// the popup, and is the page's own address without scripts.
function photoDateFields(id, day, action = "") {
  return `<form class="admin-stack-form" method="post"${action ? ` action="${escapeAttribute(action)}"` : ""} data-photo-date-form>
            <label for="${id}">Date
              <input id="${id}" name="date" type="date" value="${escapeAttribute(day)}">
            </label>
            <div class="admin-dialog-actions">
              <button class="button button-solid" type="submit">Save date</button>
              <button class="portal-logout-button" type="submit" name="clear" value="yes">Delete date</button>
            </div>
            <p class="portal-security-note">With its date deleted, the photo shows no date.</p>
          </form>`;
}

// The same, as a page, for a page without scripts.
export function adminPhotoDatePage({ client, photo, base }) {
  const back = `/clients/admin?client=${encodeURIComponent(client.slug)}#gallery`;
  const image = `${base}/photos/${encodeURIComponent(photo.id)}`;
  return adminShell(`<div class="site-width portal-shell portal-detail">
      <p class="portal-kicker"><a class="portal-inline-link" href="${escapeAttribute(back)}">${escapeHtml(client.label || client.name)}</a></p>
      <h1 class="portal-heading portal-heading-sm">Photo date.</h1>
      <section class="admin-card admin-card-narrow photo-date-card">
        <img src="${escapeAttribute(image)}" alt="${escapeAttribute(photo.note ? photo.note.slice(0, 120) : "Project photo")}">
        ${photoDateFields("photo-date", photoDate(photo), `${image}/date`)}
      </section>
    </div>`, { title: "Photo date" });
}

// A one-line heading (a project's panel, an invoice's page) that opens to what is under it, with
// an optional short status at its end. billing.js remembers which ones are open, in this browser.
function fold(id, title, body, { open = false, status = "" } = {}) {
  return `<details class="admin-fold" id="${id}" data-remember${open ? " open" : ""}>
          <summary><h3>${title}</h3>${status ? `<span class="admin-fold-status">${status}</span>` : ""}</summary>
          <div class="admin-fold-body">
          ${body}
          </div>
        </details>`;
}

// The project's full book (books.js jobBook), oldest first: each invoice's income and each cost,
// with the gross profit as it stands after each, then the totals. The Job book page has periods
// and the download.
function projectLedger(book, slug) {
  const jobBookLink = `<p class="admin-fold-links"><a class="portal-secondary-link" href="/clients/admin/books/jobs/${encodeURIComponent(slug)}">Job book</a></p>`;
  const entries = [
    ...book.income.map((row) => ({ ...row, income: row.amount })),
    ...book.expenses.map((row) => ({ ...row, cost: row.amount }))
  ].sort((left, right) => left.date.localeCompare(right.date));
  if (!entries.length) return `<p class="portal-empty">Nothing in the books yet.</p>${jobBookLink}`;
  let profit = 0;
  const rows = entries.map((row) => {
    profit += (row.income ?? 0) - (row.cost ?? 0);
    const what = row.itemId
      ? `<a class="portal-inline-link" href="/clients/admin/clients/${encodeURIComponent(slug)}/billing/${encodeURIComponent(row.itemId)}">${escapeHtml(row.what)}</a>`
      : escapeHtml(row.what);
    return `<tr>
              <td class="fit-table-date" data-label="Date">${dateText(row.date)}</td>
              <td class="fit-table-name">${what}${row.paidTo ? `<small>${escapeHtml(row.paidTo)}</small>` : ""}</td>
              <td data-label="Category">${row.income === undefined ? escapeHtml(row.category) : "Income"}</td>
              <td class="books-money" data-label="Income">${row.income === undefined ? "" : money(row.income)}</td>
              <td class="books-money" data-label="Expense">${row.cost === undefined ? "" : money(row.cost)}</td>
              <td class="books-money${profit < 0 ? " books-loss" : ""}" data-label="Profit">${money(profit)}</td>
            </tr>`;
  }).join("");
  const totals = book.totals;
  return `<div class="fit-table-box">
          <table class="portal-table books-table fit-table ledger-table">
            <thead><tr><th scope="col">Date</th><th scope="col">Entry</th><th scope="col">Category</th><th scope="col" class="books-money">Income</th><th scope="col" class="books-money">Expense</th><th scope="col" class="books-money">Profit</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><th class="fit-table-name" scope="row" colspan="3">Gross</th><td class="books-money" data-label="Income">${money(totals.income)}</td><td class="books-money" data-label="Expense">${money(totals.expenses)}</td><td class="books-money${totals.profit < 0 ? " books-loss" : ""}" data-label="Profit">${money(totals.profit)}</td></tr></tfoot>
          </table>
          </div>
          ${jobBookLink}`;
}

// Payments received on the project's invoices, newest first: each payment toward a balance and
// the one that settled it, by hand or through Stripe, less Stripe refunds, with their notes.
function paymentRows(items, basePath) {
  const rows = [];
  for (const item of items) {
    if (item.kind !== "invoice" || item.status === "void") continue;
    for (const entry of item.installments || []) {
      rows.push({ item, date: entry.paidOn, how: entry.label, note: entry.note, amount: entry.amountCents });
    }
    if (item.status !== "paid") continue;
    const payment = item.payment || {};
    rows.push({ item, date: item.paidAt, how: payment.label || (payment.source === "stripe" ? "Stripe" : "Payment"), note: payment.note, amount: payment.amountCents ?? item.amountCents - installmentsTotal(item) });
    for (const refund of liveRefunds(item)) rows.push({ item, date: refund.refundedAt, how: "Refund", note: "", amount: -refund.amountCents });
  }
  if (!rows.length) return '<p class="portal-empty">No payments yet.</p>';
  rows.sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")));
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  return `<table class="portal-table payments-table">
          <thead><tr><th scope="col">Date</th><th scope="col">Invoice</th><th scope="col">Paid by</th><th scope="col">Notes</th><th scope="col">Amount</th></tr></thead>
          <tbody>${rows.map((row) => `<tr>
            <td>${row.date ? dateText(row.date) : ""}</td>
            <td><a class="portal-inline-link" href="${basePath}/${encodeURIComponent(row.item.id)}">${escapeHtml(billingLabel(row.item))}</a><small>${escapeHtml(row.item.title)}</small></td>
            <td>${escapeHtml(row.how || "")}</td>
            <td>${escapeHtml(row.note || "")}</td>
            <td>${money(row.amount, row.item.currency)}</td>
          </tr>`).join("")}</tbody>
        </table>
        <dl class="billing-totals">
          <div class="billing-totals-due"><dt>Received</dt><dd>${money(total)}</dd></div>
        </dl>`;
}

// The client portal screen. The sidebar lists the client portals in use (a right-click opens each
// one's menu); a portal's page starts with Add project, its projects and Show finances for all
// projects under this client, then the selected project's panel. `root` is the client portal the
// selected project is in (or the portal itself), `projects` its projects as listed, `counted` the
// ones its finances add up, from `projectBilling` (their quotes and invoices) and `projectBooks`
// (books.js jobTotals). `book` is the selected project's job book (books.js jobBook), for its
// Ledger. `selectedLogin` is the client portal's login in plain text, when on file.
export function adminDashboardPage({ clients, selected, root = selected, projects = selected ? [selected] : [], counted = projects, projectBilling = [], projectBooks = new Map(), book = null, blockedCount = 0, billing, documents, templates = [], recipients = [], readiness, notice = null, authenticated = true, newClient = null, clientError = "", typedEmails = null, newProject = null, projectError = "", expenses = [], payers = [], paidTo = [], selectedLogin = null, photos = [], today = todayInMichigan() }) {
  // Client portals in use; projects are listed on their client portal's page, and anything in the
  // archive under Archive in the footer.
  const portals = clients.filter((client) => !client.parentSlug && !client.archivedAt);
  const groupSizes = new Map();
  for (const client of portals) {
    if (client.loginGroup) groupSizes.set(client.loginGroup, (groupSizes.get(client.loginGroup) || 0) + 1);
  }
  const clientLinks = portals.map((client) => {
    const current = root && client.slug === root.slug;
    const emails = clientEmails(client);
    const adminOnly = !client.passwordHash && !client.managedBySecret;
    const shared = Boolean(client.loginGroup) && groupSizes.get(client.loginGroup) > 1;
    const inside = clients.filter((entry) => entry.parentSlug === client.slug && !entry.archivedAt).length;
    const detail = [adminOnly ? "Admin only" : "", shared ? "Shared login" : "", client.readOnly ? "Read only" : "", inside ? `${inside + 1} projects` : "", emails.length ? escapeHtml(emails.join(", ")) : "No email on file"].filter(Boolean).join(" · ");
    return `<li><a class="admin-client-link${current ? " is-current" : ""}" href="/clients/admin?client=${encodeURIComponent(client.slug)}"${current ? ' aria-current="page"' : ""}${portalMenuData(client)}>
        <strong>${escapeHtml(client.name)}</strong><small>${detail}</small></a></li>`;
  }).join("");
  const archive = archiveContents(clients);

  const selectedSection = selected
    ? (() => {
      const base = `/clients/admin/clients/${encodeURIComponent(selected.slug)}`;
      const loginRoot = root || selected;
      const shared = projects.filter((project) => !project.archivedAt).length > 1;
      return `<section class="admin-panel" aria-labelledby="selected-heading">
        ${archivedNote(selected, root)}
        ${clientProjects({ root: loginRoot, projects, selected, counted, projectBilling, projectBooks, newProject, projectError })}
        <details class="admin-panel-head"${typedEmails === null ? "" : " open"}>
          <summary class="admin-title-row">
            <h2 id="selected-heading">${escapeHtml(selected.name)}</h2>
            <a class="portal-secondary-link" href="/clients/designer/?project=${encodeURIComponent(selected.slug)}">Designer</a>
          </summary>
          <div class="admin-panel-fields">
          <form class="admin-inline-form admin-save-row" action="${base}/profile" method="post">
            <button class="icon-save" type="submit" aria-label="Save client email" title="Save">${SAVE_ICON}</button>
            ${emailsField({ id: "client-emails", name: "emails", label: "Client email", addresses: clientEmails(selected), typed: typedEmails })}
          </form>
          <form class="admin-inline-form admin-save-row" action="${base}/site" method="post">
            <button class="icon-save" type="submit" aria-label="Save job site address" title="Save">${SAVE_ICON}</button>
            <label for="client-site">Job site address (printed on subcontractors' lien waivers)
              <input id="client-site" name="siteAddress" type="text" maxlength="200" value="${escapeAttribute(selected.siteAddress || "")}" placeholder="1234 Lakeshore Dr, Muskegon, MI 49441">
            </label>
          </form>
          ${loginRoot.managedBySecret ? `<div class="admin-inline-form admin-save-row">
            <span class="icon-save icon-save-off" title="Set in Render" aria-hidden="true">${SAVE_ICON}</span>
            <label for="client-login">Client login
              <input id="client-login" type="text" readonly value="${escapeAttribute(selectedLogin || "")}">
              ${shared ? `<small class="admin-field-hint">${escapeHtml(loginRoot.name)}'s login, for every project in it.</small>` : ""}
            </label>
          </div>` : `<form class="admin-inline-form admin-save-row" action="${base}/login" method="post">
            <button class="icon-save" type="submit" aria-label="Save client login" title="Save">${SAVE_ICON}</button>
            <label for="client-login">Client login
              <input id="client-login" name="login" type="text" minlength="10" maxlength="120" autocomplete="off" required value="${escapeAttribute(selectedLogin || "")}" placeholder="${loginRoot.passwordHash ? "Set, but not on file. Type it again to show it here." : "None, so only you can see this project. Type one to share it."}">
              ${shared ? `<small class="admin-field-hint">${escapeHtml(loginRoot.name)}'s login, for every project in it.</small>` : ""}
            </label>
          </form>`}
          </div>
        </details>

        <div class="admin-actions-bar admin-project-actions">
          <a class="button button-outline" href="${base}/billing/new?kind=quote">Quote</a>
          <a class="button button-solid" href="${base}/billing/new?kind=invoice">Invoice</a>
          <a class="button button-outline" href="${base}/expenses/new" data-add-expense>Purchase</a>
          <a class="button button-outline" href="${base}/payments/new" data-add-payment>Payment</a>
        </div>
        <div class="admin-folds">
        ${fold("project-ledger", "Ledger", projectLedger(book || { income: [], expenses: [], totals: { income: 0, expenses: 0, profit: 0 } }, selected.slug))}
        ${fold("project-invoices", "Invoices", billingRows(billing, { basePath: `${base}/billing`, viewer: "admin" }), { open: true })}
        ${fold("project-payments", "Payments", paymentRows(billing, `${base}/billing`))}
        ${fold("project-purchases", "Purchases", expenseRows(expenses, { base }))}
        ${fold("project-documents", "Documents", `${documentSections(documents, { basePath: `${base}/documents`, viewer: "admin" })}
        <details class="admin-upload" id="upload-document">
        <summary>Upload Document</summary>
        <form class="portal-form admin-form" action="${base}/documents" method="post" enctype="multipart/form-data">
          <label for="admin-upload">File
            <input id="admin-upload" name="file" type="file" required>
          </label>
          <label for="admin-upload-section">Section in the client portal
            <select id="admin-upload-section" name="section">${DOCUMENT_SECTIONS.map(([key, label]) => `<option value="${key}"${key === "contracts" ? " selected" : ""}>${label}</option>`).join("")}</select>
          </label>
          <label class="portal-check" for="needs-client-signature">
            <input id="needs-client-signature" name="requiresClientSignature" type="checkbox" value="yes">
            <span>Client must sign (PDF only)</span>
          </label>
          <label class="portal-check" for="needs-admin-signature">
            <input id="needs-admin-signature" name="requiresAdminSignature" type="checkbox" value="yes">
            <span>I will sign on my end (PDF only)</span>
          </label>
          <button class="button button-solid" type="submit">Share with client</button>
        </form>
        </details>`)}
        </div>

        ${adminGallery(selected, photos, base)}
        <form class="admin-access" action="${base}/access" method="post">
          <label class="portal-check" for="client-read-only">
            <input id="client-read-only" name="readOnly" type="checkbox" value="yes"${selected.readOnly ? " checked" : ""} data-autosubmit>
            <span>Display all data to client portal (read only)</span>
          </label>
          <button class="portal-logout-button" type="submit" data-autosubmit-button>Save</button>
        </form>
        ${archiveOrMove(selected, portals)}
        <div class="admin-export">${exportLink(loginRoot)}</div>
        ${statusDialogs(selected, readiness)}
        ${addPaymentDialog({ client: selected, billing, readiness })}
        ${addExpenseDialog({ action: `${base}/expenses`, payers, today, paidTo })}
      </section>`;
    })()
    : `<section class="admin-panel"><p class="portal-empty">Choose a client portal to manage its quotes, invoices and documents.</p></section>`;

  return pageShell(`<div class="site-width portal-shell">
      <h1 class="visually-hidden">Admin panel</h1>
      <details class="admin-add-client" id="add-client" data-collapsible${clientError ? " open" : ""}>
        <summary>Add a client portal</summary>
        <button class="admin-collapse" type="button" data-collapse aria-label="Close Add a client portal" title="Close">−</button>
        <form class="admin-inline-form admin-add-client-form" action="/clients/admin/clients" method="post">
          ${clientError ? `<p class="portal-error" role="alert">${escapeHtml(clientError)}</p>` : ""}
          <label for="client-name">Client or project name
            <input id="client-name" name="name" type="text" maxlength="120" required value="${escapeAttribute(newClient?.name || "")}" placeholder="Wolf Lake Views">
          </label>
          <label for="client-password">Project login (optional)
            <input id="client-password" name="password" type="text" minlength="10" maxlength="120" autocomplete="off" placeholder="Leave blank to keep it admin only">
          </label>
          ${emailsField({ id: "new-client-emails", name: "emails", label: "Client email (optional)", typed: newClient?.emails ?? null })}
          <label for="new-client-site">Job site address (optional)
            <input id="new-client-site" name="siteAddress" type="text" maxlength="200" value="${escapeAttribute(newClient?.siteAddress || "")}" placeholder="1234 Lakeshore Dr, Muskegon, MI 49441">
          </label>
          <button class="button button-solid" type="submit">Create portal</button>
          <label class="portal-check admin-add-client-access" for="new-client-read-only">
            <input id="new-client-read-only" name="readOnly" type="checkbox" value="yes"${newClient?.readOnly ? " checked" : ""}>
            <span>Display all data to client portal (read only)</span>
          </label>
        </form>
      </details>
      ${[[readiness.store, "Portal storage"], [readiness.files, "File storage"], [readiness.stripe, "Stripe"], [readiness.webhook, "Stripe webhook"], [readiness.email, "Email"]].some(([ready]) => !ready)
        ? `<div class="admin-chips">${[[readiness.store, "Portal storage"], [readiness.files, "File storage"], [readiness.stripe, "Stripe"], [readiness.webhook, "Stripe webhook"], [readiness.email, "Email"]].filter(([ready]) => !ready).map(([ready, label]) => statusChip(ready, label)).join("")}</div>`
        : ""}
      ${noticeMarkup(notice)}

      <div class="admin-layout">
        <aside class="admin-sidebar">
          <h2>Client portals</h2>
          <ul class="admin-client-list">${clientLinks}</ul>
        </aside>
        ${selectedSection}
      </div>
      ${portalMenu(portals)}
      ${recipientList(recipients)}
    </div>`, {
    authenticated, admin: true, bodyClass: "portal-page portal-admin", title: "Admin panel", scripts: [BILLING_SCRIPT],
    footerLinks: [
      `<a class="portal-footer-archive" href="/clients/admin/archive">Archive${archive.count ? ` (${archive.count})` : ""}</a>`,
      `<a class="portal-footer-blocked" href="/clients/admin/blocked">Blocked sign-ins${blockedCount ? ` (${blockedCount})` : ""}</a>`
    ]
  });
}

// Blocked sign-ins (in the admin panel's footer): each address with failed sign-ins in a row
// (guard.js), whether it is blocked and until when, and Unblock. `yours` is the address the admin
// is on.
const SIGN_IN_PLACES = { client: "Client login", crew: "Crew login", admin: "Admin code" };

export function adminBlockedPage({ rows, yours = "", notice = null }) {
  const body = rows.length
    ? `<table class="portal-table admin-blocked-table">
        <thead><tr><th scope="col">Address</th><th scope="col">Failed in a row</th><th scope="col">Status</th><th scope="col">Last failed</th><th scope="col"><span class="visually-hidden">Unblock</span></th></tr></thead>
        <tbody>${rows.map((row) => {
    const [tone, status] = row.block?.permanent
      ? ["blocked", "Blocked for good"]
      : row.block ? ["open", `Blocked until ${dateTimeText(row.block.until)}`] : ["neutral", "Not blocked"];
    return `<tr>
          <td><code>${escapeHtml(row.address)}</code>${row.address === yours ? "<small>Your address</small>" : ""}</td>
          <td>${row.failures}</td>
          <td><span class="portal-status portal-status-${tone}">${status}</span></td>
          <td>${dateTimeText(row.lastFailedAt)}<small>${escapeHtml(SIGN_IN_PLACES[row.lastWhere] || "Sign-in")}</small></td>
          <td class="portal-actions"><form action="/clients/admin/blocked/unblock" method="post"><input type="hidden" name="address" value="${escapeAttribute(row.address)}"><button class="${row.block ? "button button-solid button-small" : "portal-logout-button"}" type="submit">${row.block ? "Unblock" : "Clear count"}</button></form></td>
        </tr>`;
  }).join("")}</tbody>
      </table>`
    : '<p class="portal-empty">No failed sign-ins are on record.</p>';
  return adminShell(`<div class="site-width portal-shell">
      <section class="admin-intro">
        <p class="portal-kicker"><a class="portal-inline-link" href="/clients/admin">Admin panel</a></p>
        <h1 class="portal-heading">Blocked sign-ins.</h1>
        <p class="portal-lead">Failed sign-ins in a row from one address (a wrong client login, crew password or admin code): the 5th blocks it for 20 minutes, the 10th for 60 minutes and the 15th for good. A successful sign-in starts the count again. IPv6 addresses count by their /64 network.</p>
        ${noticeMarkup(notice)}
      </section>
      <section class="books-section admin-blocked" aria-label="Addresses">
        ${body}
      </section>
    </div>`, { title: "Blocked sign-ins" });
}

// Archive (in the admin panel's footer): client portals sent to archive, with the projects that
// went with them, and projects sent there on their own. Each one opens on the admin panel to look
// at, and Restore brings it back to the client portal screen and the books.
export function adminArchivePage({ clients, notice = null }) {
  const { portals, projects, bySlug } = archiveContents(clients);
  const restore = (client) => `<form action="/clients/admin/clients/${encodeURIComponent(client.slug)}/restore" method="post"><button class="button button-solid button-small" type="submit">Restore</button></form>`;
  const open = (client) => `<a class="portal-inline-link" href="/clients/admin?client=${encodeURIComponent(client.slug)}">${escapeHtml(client.name)}</a>`;
  const portalRows = portals.map((portal) => {
    const inside = clients.filter((client) => client.parentSlug === portal.slug);
    const along = inside.filter((client) => client.archivedWith === portal.slug).map((client) => client.name);
    const before = inside.filter((client) => client.archivedAt && client.archivedWith !== portal.slug).map((client) => client.name);
    const notes = [along.length ? `With its projects ${along.join(", ")}` : "", before.length ? `Archived before it, on their own: ${before.join(", ")}` : ""].filter(Boolean);
    return `<tr>
          <td>${open(portal)}${notes.map((note) => `<small>${escapeHtml(note)}</small>`).join("")}</td>
          <td>${dateText(portal.archivedAt)}</td>
          <td class="portal-actions">${restore(portal)}</td>
        </tr>`;
  }).join("");
  const projectRows = projects.map((project) => `<tr>
          <td>${open(project)}<small>In ${escapeHtml(bySlug.get(project.parentSlug)?.name || "a client portal no longer here")}</small></td>
          <td>${dateText(project.archivedAt)}</td>
          <td class="portal-actions">${restore(project)}</td>
        </tr>`).join("");
  const table = (rows, empty) => rows
    ? `<table class="portal-table admin-archive-table">
        <thead><tr><th scope="col">Name</th><th scope="col">Sent to archive</th><th scope="col"><span class="visually-hidden">Restore</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<p class="portal-empty">${empty}</p>`;
  return adminShell(`<div class="site-width portal-shell">
      <section class="admin-intro">
        <p class="portal-kicker"><a class="portal-inline-link" href="/clients/admin">Admin panel</a></p>
        <h1 class="portal-heading">Archive.</h1>
        <p class="portal-lead">Client portals and projects sent to archive are left out of the books and the client portal screen, and their clients cannot open them. Restore brings one back, with everything it had.</p>
        ${noticeMarkup(notice)}
      </section>
      <section class="books-section admin-archive" aria-labelledby="archive-portals-heading">
        <div class="books-section-head"><h2 id="archive-portals-heading">Client portals</h2></div>
        ${table(portalRows, "No client portals are in the archive.")}
      </section>
      <section class="books-section admin-archive" aria-labelledby="archive-projects-heading">
        <div class="books-section-head"><h2 id="archive-projects-heading">Projects</h2></div>
        ${table(projectRows, "No projects are in the archive on their own.")}
      </section>
    </div>`, { title: "Archive" });
}

function lineRow(line, index) {
  const number = index + 1;
  const description = line?.description ?? "";
  const quantity = line?.quantityInput ?? (line?.quantity !== undefined ? quantityText(line.quantity) : "1");
  const price = line?.priceInput ?? (Number.isInteger(line?.unitCents) ? moneyInput(line.unitCents) : "");
  const amount = Number.isInteger(line?.amountCents) ? money(line.amountCents) : "";
  return `<tr class="line-row" data-line-row>
                <td><input name="itemDescription" type="text" maxlength="300" value="${escapeAttribute(description)}" aria-label="Line ${number} description" placeholder="Describe the work or material"></td>
                <td><input name="itemQuantity" type="text" inputmode="decimal" maxlength="12" value="${escapeAttribute(quantity)}" aria-label="Line ${number} quantity"></td>
                <td><input name="itemUnitPrice" type="text" inputmode="decimal" maxlength="16" value="${escapeAttribute(price)}" aria-label="Line ${number} unit price" placeholder="0.00"></td>
                <td class="line-amount" data-line-amount>${amount}</td>
                <td><button class="line-remove" type="button" data-line-remove hidden aria-label="Remove line ${number}">Remove</button></td>
              </tr>`;
}

// One editor serves new quotes and invoices, edits to open ones, and saved templates. `notes` are
// the saved notes and terms (store.js listNotesTemplates), offered beside Notes and terms.
export function billingEditorPage({ mode, client = null, values, error = "", notice = null, actionPath, backPath, templates = [], notes = [], readiness = {}, number = "", paid = false }) {
  const template = mode === "template-new" || mode === "template-edit";
  const creating = mode === "create";
  const lines = values.lineItems || [];
  const rows = [...lines];
  while (rows.length < Math.max(lines.length + 2, 4)) rows.push(null);
  const total = lines.every((line) => Number.isInteger(line.amountCents)) ? lines.reduce((sum, line) => sum + line.amountCents, 0) : null;
  const kind = values.kind === "quote" ? "quote" : "invoice";

  const heading = mode === "edit"
    ? `Edit ${kind === "invoice" ? "invoice" : "quote"} ${number}`
    : mode === "template-new" ? "New template" : mode === "template-edit" ? "Edit template" : `New ${kind}`;
  // The way back (the editor has no Cancel): the project's panel, or the templates list.
  const kicker = template
    ? `<a class="portal-inline-link" href="${escapeAttribute(backPath)}">Quote and invoice templates</a>`
    : client ? `<a class="portal-inline-link" href="/clients/admin?client=${encodeURIComponent(client.slug)}">${escapeHtml(client.name)}</a>` : "";

  const kindField = mode === "edit"
    ? `<input type="hidden" name="kind" value="${kind}"><p class="billing-editor-kind">${kind === "invoice" ? "Invoice" : "Quote"} ${escapeHtml(number)}</p>`
    : `<fieldset class="billing-kind">
            <legend>Type</legend>
            <label class="portal-check"><input type="radio" name="kind" value="invoice"${kind === "invoice" ? " checked" : ""}><span>Invoice (payable with Stripe)</span></label>
            <label class="portal-check"><input type="radio" name="kind" value="quote"${kind === "quote" ? " checked" : ""}><span>Quote (client can accept)</span></label>
          </fieldset>`;

  let sendOption = "";
  if (creating) {
    const emails = clientEmails(client);
    if (!readiness.email) {
      sendOption = '<p class="portal-security-note">Email delivery is not set up, so the client cannot be emailed yet. You can still copy the link from the next page.</p>';
    } else if (emails.length) {
      sendOption = `<label class="portal-check" for="send-now">
            <input id="send-now" name="sendNow" type="checkbox" value="yes"${values.sendNow === false ? "" : " checked"}>
            <span>Email it to ${escapeHtml(addressesText(emails))} after posting</span>
          </label>`;
    }
  }

  const loadTemplate = creating ? templatePicker(templates, `${actionPath}/new`) : "";

  const submitLabel = mode === "edit" ? "Save changes" : template ? "Save template" : kind === "invoice" ? "Post invoice" : "Post quote";

  // A new invoice lists payments already received (a deposit, earlier checks); an existing one's
  // are added and removed on its page. A row left without an amount is skipped. Other method shows
  // only when Other is chosen (billing.js).
  let paymentsSection = "";
  if (creating) {
    const typed = values.payments?.length ? values.payments : [{}];
    const methods = (chosen) => Object.entries(PAYMENT_METHODS).map(([key, label]) => `<option value="${key}"${key === (chosen || "check") ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
    paymentsSection = `<fieldset class="listed-payments" data-listed-payments${kind === "quote" ? " hidden" : ""}>
          <legend>Payments</legend>
          ${typed.map((row, index) => `<div class="listed-payment" data-listed-payment>
            <label for="listed-${index}-amount">Amount ($)
              <input id="listed-${index}-amount" name="paymentAmount" type="text" inputmode="decimal" maxlength="12" value="${escapeAttribute(row.amount || "")}" placeholder="0.00">
            </label>
            <label for="listed-${index}-method">Paid by
              <select id="listed-${index}-method" name="paymentMethod" data-listed-method>${methods(row.method)}</select>
            </label>
            <label for="listed-${index}-other" data-listed-other${row.method === "other" ? "" : " hidden"}>Other method
              <input id="listed-${index}-other" name="paymentMethodName" type="text" maxlength="60" value="${escapeAttribute(row.methodName || "")}">
            </label>
            <label for="listed-${index}-date">Received on
              <input id="listed-${index}-date" name="paymentPaidOn" type="date" value="${escapeAttribute(row.paidOn || "")}">
            </label>
            <label class="listed-payment-note" for="listed-${index}-note">Notes
              <input id="listed-${index}-note" name="paymentNote" type="text" maxlength="${MAX_PAYMENT_NOTE}" value="${escapeAttribute(row.note || "")}">
            </label>
          </div>`).join("")}
          <button class="portal-logout-button" type="button" data-listed-payment-add hidden>Add another payment</button>
        </fieldset>`;
  } else if (mode === "edit" && kind === "invoice") {
    paymentsSection = '<p class="admin-field-hint">Payments on this invoice are added and removed on its page (Add a payment).</p>';
  }

  // Notes and terms: Use template fills the box from a saved one; its Create new names this text,
  // saved as a template when the form is posted (billing.js; without scripts it is left out).
  const notesPicker = `<select class="select-plain notes-picker" aria-label="Notes and terms templates" data-notes-template hidden>
              <option value="" selected disabled hidden>Use template</option>
              <option value="new">Create new</option>${notes.map((entry) => `
              <option value="${escapeAttribute(entry.id)}" data-text="${escapeAttribute(entry.text)}">${escapeHtml(entry.name)}</option>`).join("")}
            </select>`;

  // Save as template, on a new quote or invoice: a link that opens the template's name.
  const saveAsTemplate = creating
    ? `<div class="save-template" data-save-template>
          <button class="portal-logout-button" type="button" data-save-template-open hidden>Save as template</button>
          <label for="new-template-name" data-save-template-name>Template name
            <input id="new-template-name" name="templateName" type="text" maxlength="80" value="${escapeAttribute(values.templateName || "")}" placeholder="Framing draw">
          </label>
        </div>`
    : "";

  return adminShell(`<div class="site-width portal-shell">
      <p class="portal-kicker">${kicker}</p>
      <div class="billing-editor-head">
        <h1 class="portal-heading portal-heading-sm"${creating ? " data-kind-heading" : ""}>${escapeHtml(heading)}</h1>
        ${loadTemplate}
      </div>
      ${noticeMarkup(notice)}
      <form class="portal-form admin-form billing-editor" action="${escapeAttribute(actionPath)}" method="post">
        ${error ? `<p class="portal-error" role="alert">${escapeHtml(error)}</p>` : ""}
        ${paid === "stripe"
          ? '<p class="portal-notice">This invoice was paid through Stripe. Changing its lines changes its total; the Stripe payment stays as Stripe recorded it.</p>'
          : paid ? '<p class="portal-notice">This invoice is marked paid. Changing its lines changes its total, and the recorded payment changes to match.</p>' : ""}
        ${template ? `<label for="template-name">Template name
          <input id="template-name" name="templateName" type="text" maxlength="80" required value="${escapeAttribute(values.templateName || "")}" placeholder="Framing draw">
        </label>` : ""}
        ${kindField}
        <label for="billing-title">Title
          <input id="billing-title" name="title" type="text" maxlength="140" required value="${escapeAttribute(values.title || "")}" placeholder="Kitchen addition deposit">
        </label>
        <div class="line-editor" data-line-editor>
          <table class="line-editor-table">
            <thead><tr><th scope="col">Description</th><th scope="col">Qty</th><th scope="col">Unit price</th><th scope="col">Amount</th><th scope="col"><span class="visually-hidden">Remove</span></th></tr></thead>
            <tbody>
              ${rows.map(lineRow).join("\n              ")}
            </tbody>
          </table>
          <div class="line-editor-foot">
            <button class="portal-logout-button" type="button" data-line-add hidden>Add a line</button>
            <p class="line-editor-total">Total <output data-line-total>${total === null ? "" : money(total)}</output></p>
          </div>
        </div>
        ${template
          ? `<label for="due-in-days">Days until due (optional)
          <input id="due-in-days" name="dueInDays" type="text" inputmode="numeric" maxlength="3" value="${escapeAttribute(values.dueInDays ?? "")}" placeholder="15">
        </label>`
          : `<label for="billing-date">Date
          <input id="billing-date" name="issuedOn" type="date" required value="${escapeAttribute(values.issuedOn || todayInMichigan())}">
          <small class="admin-field-hint">Shown as the issue date. Invoices are numbered in date order across every client portal; invoices with the same date, in the order they were entered.</small>
        </label>
        <label for="billing-due">${kind === "invoice" ? "Due date" : "Valid until"} (optional)
          <input id="billing-due" name="dueDate" type="date" value="${escapeAttribute(values.dueDate || "")}">
        </label>`}
        <div class="notes-field" data-notes-field>
          <div class="notes-head">
            <label for="billing-description">Notes and terms</label>
            ${notesPicker}
          </div>
          <textarea id="billing-description" name="description" rows="4" maxlength="2000" placeholder="Scope, milestones or payment terms">${escapeHtml(values.description || "")}</textarea>
          <label for="notes-template-name" data-notes-name${values.notesTemplateName ? "" : " hidden"}>Notes template name
            <input id="notes-template-name" name="notesTemplateName" type="text" maxlength="80" value="${escapeAttribute(values.notesTemplateName || "")}" placeholder="Standard terms">
          </label>
        </div>
        ${paymentsSection}
        ${saveAsTemplate}
        <div class="billing-editor-actions">
          <button class="button button-solid" type="submit"${creating ? " data-kind-submit" : ""}>${submitLabel}</button>
          ${sendOption}
        </div>
      </form>
      ${mode === "template-edit" ? `<form class="admin-danger" action="${escapeAttribute(actionPath)}/delete" method="post">
        <button class="portal-logout-button" type="submit">Delete this template</button>
      </form>` : ""}
    </div>`, { title: heading, scripts: [BILLING_SCRIPT] });
}

function copyField(id, label, value) {
  return `<div class="admin-copy">
            <label for="${id}">${escapeHtml(label)}</label>
            <div class="admin-copy-row">
              <input id="${id}" type="text" readonly value="${escapeAttribute(value)}">
              <button class="portal-logout-button" type="button" data-copy="${id}" hidden>Copy</button>
            </div>
          </div>`;
}

function activity(item, receipt) {
  const entries = [
    ["Created", item.createdAt],
    item.movedFrom ? [`Moved from ${item.movedFrom.name}`, item.movedFrom.movedAt] : null,
    item.updatedAt && item.updatedAt !== item.movedFrom?.movedAt ? ["Edited", item.updatedAt] : null,
    item.sentAt ? [`Emailed to ${item.sentTo}`, item.sentAt] : null,
    item.acceptedAt ? [`Accepted${item.acceptedBy ? ` by ${item.acceptedBy}` : ""}`, item.acceptedAt] : null,
    item.processingAt ? ["Bank payment started", item.processingAt] : null,
    item.paymentFailedAt ? ["Bank payment failed", item.paymentFailedAt] : null,
    item.reopenedAt ? ["Marked unpaid", item.reopenedAt] : null,
    item.paidAt ? [`Paid${item.payment?.label ? ` · ${item.payment.label}` : ""}`, item.paidAt] : null,
    item.payment?.updatedAt ? ["Payment details changed", item.payment.updatedAt] : null,
    receipt ? [`Receipt emailed to ${receipt.to}`, receipt.sentAt] : null,
    item.voidedAt ? ["Voided", item.voidedAt] : null
  ].filter(Boolean);
  return `<ol class="admin-activity">${entries.map(([label, when]) => `<li><span>${escapeHtml(label)}</span><time datetime="${escapeAttribute(when)}">${dateText(when)}</time></li>`).join("")}</ol>`;
}

// Paid by (with Other method when Other is chosen), received on and notes: shared by every form
// that records or changes a payment. billing.js shows the Other box only when Other is chosen.
function paymentFields(prefix, { payment = null, date }) {
  const chosen = payment?.method && Object.hasOwn(PAYMENT_METHODS, payment.method) ? payment.method : "check";
  const methods = Object.entries(PAYMENT_METHODS)
    .map(([value, label]) => `<option value="${value}"${value === chosen ? " selected" : ""}>${label}</option>`)
    .join("");
  return `<label for="${prefix}-method">Paid by
              <select id="${prefix}-method" name="method" data-payment-method>${methods}</select>
            </label>
            <label for="${prefix}-other" data-payment-other>Other method
              <input id="${prefix}-other" name="methodName" type="text" maxlength="60" value="${escapeAttribute(payment?.methodName || "")}">
            </label>
            <label for="${prefix}-date">Received on
              <input id="${prefix}-date" name="paidOn" type="date" value="${escapeAttribute(date)}" required>
            </label>
            <label for="${prefix}-note">Notes
              <input id="${prefix}-note" name="note" type="text" maxlength="${MAX_PAYMENT_NOTE}" value="${escapeAttribute(payment?.note || "")}">
            </label>`;
}

// Copy to another project opens that project's editor filled in from this quote or invoice. Send
// to another project moves it there, with the quote or invoice linked to it, for one entered in
// the wrong project. One project list serves both buttons. Nothing when there is no other project.
function otherProjectFold({ base, client, item, projects }) {
  const others = projects.filter((entry) => entry.slug !== client.slug);
  if (!others.length) return "";
  const processing = item.status === "processing";
  return fold("billing-project", "Another project", `<form class="admin-stack-form" action="${base}/copy" method="get">
            <label for="other-project">Project
              <select id="other-project" name="to" required>
                <option value="" selected disabled hidden>Choose a project</option>
                ${others.map((entry) => `<option value="${escapeAttribute(entry.slug)}">${escapeHtml(entry.label || entry.name)}</option>`).join("")}
              </select>
            </label>
            <div class="admin-manage">
              <button class="button button-solid" type="submit">Copy</button>
              ${processing ? "" : `<button class="button button-outline" type="submit" formaction="${base}/move" formmethod="post">Send</button>`}
            </div>
            ${processing ? '<p class="portal-security-note">A bank payment is still processing, so it can be sent once that finishes.</p>' : ""}
          </form>`);
}

// Payments toward the balance, each with Remove while the invoice is open.
function installmentList(item, base, { removable }) {
  const installments = item.installments || [];
  if (!installments.length) return "";
  return `<ul class="admin-activity">${installments.map((entry) => `<li><span>${money(entry.amountCents, item.currency)} · ${escapeHtml(entry.label)} · ${dateText(entry.paidOn)}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</span>${removable
    ? `
            <form class="admin-manage" action="${base}/remove-payment" method="post"><input type="hidden" name="installment" value="${escapeAttribute(entry.id)}"><button class="portal-logout-button" type="submit">Remove</button></form>`
    : ""}</li>`).join("")}</ul>`;
}

// A quote's or invoice's admin page: its actions beside the heading, then the document with
// one-line folds beside it (on a phone, above it): Payment, Email, Receipt, Share, Another project
// and History, each with a short status. `typed` keeps what was typed into a Send to field
// ({ field: "send" | "receipt", value }) when the addresses had a problem. `projects` lists every
// client portal, for Copy and Send.
export function adminBillingPage({ client, item, links, receipt = null, recipients = [], projects = [], readiness, notice = null, typed = null }) {
  const base = `/clients/admin/clients/${encodeURIComponent(client.slug)}/billing/${encodeURIComponent(item.id)}`;
  const invoice = item.kind === "invoice";
  const noun = invoice ? "invoice" : "quote";
  const projectEmails = clientEmails(client);
  const sent = (when) => `Sent ${dateText(when)}`;
  const folds = [];

  if (invoice && item.status === "open") {
    folds.push(fold("billing-payment", "Payment", `${installmentList(item, base, { removable: true })}
          <form class="admin-stack-form" action="${base}/record-payment" method="post">
            <label for="payment-amount">Amount ($)
              <input id="payment-amount" name="amount" type="text" inputmode="decimal" maxlength="12" required value="${escapeAttribute(moneyInput(balanceDue(item)))}">
            </label>
            ${paymentFields("payment", { date: links.today })}
            ${readiness.email && projectEmails.length ? `<label class="portal-check" for="payment-receipt">
              <input id="payment-receipt" name="sendReceipt" type="checkbox" value="yes" checked>
              <span>Email a receipt</span>
            </label>` : ""}
            <button class="button button-solid" type="submit">Add payment</button>
          </form>`, { open: true, status: `${money(balanceDue(item), item.currency)} due` }));
  }

  if (invoice && item.status === "paid") {
    const payment = item.payment || {};
    const status = [payment.label || (payment.source === "stripe" ? "Stripe" : "Paid"), dateText(item.paidAt)].filter(Boolean).join(" · ");
    folds.push(fold("billing-payment", "Payment", payment.source === "manual"
      ? `${installmentList(item, base, { removable: false })}
          <form class="admin-stack-form" action="${base}/payment" method="post">
            ${paymentFields("edit-payment", { payment, date: String(item.paidAt || links.today).slice(0, 10) })}
            <button class="button button-solid" type="submit">Save payment</button>
          </form>
          <form class="admin-danger" action="${base}/reopen" method="post">
            <button class="portal-logout-button" type="submit">Mark as unpaid</button>
          </form>`
      : `${installmentList(item, base, { removable: false })}
          <p class="admin-meta">Paid online through Stripe · ${money(payment.amountCents ?? item.amountCents, item.currency)}</p>
          ${stripeAftermath(item)}`, { status }));
  }

  if (item.status !== "void") {
    folds.push(fold("billing-email", "Email", readiness.email
      ? `<form class="admin-inline-form" action="${base}/send" method="post">
            ${emailsField({ id: "send-to", name: "to", label: "Send to", addresses: projectEmails, typed: typed?.field === "send" ? typed.value : null, required: true })}
            <button class="button button-solid" type="submit">Email ${noun}</button>
          </form>`
      : '<p class="portal-security-note">Email is not set up.</p>', { open: typed?.field === "send", status: item.sentAt ? sent(item.sentAt) : "" }));
  }

  if (invoice && item.status === "paid" && readiness.email) {
    const receiptTo = projectEmails.length ? projectEmails : [item.payment?.email].filter(Boolean);
    folds.push(fold("billing-receipt", "Receipt", `<form class="admin-inline-form" action="${base}/receipt" method="post">
            ${emailsField({ id: "receipt-to", name: "to", label: "Send to", addresses: receiptTo, typed: typed?.field === "receipt" ? typed.value : null, required: true })}
            <button class="button button-solid" type="submit">${receipt ? "Resend receipt" : "Send receipt"}</button>
          </form>`, { open: typed?.field === "receipt", status: receipt ? sent(receipt.sentAt) : "" }));
  }

  folds.push(fold("billing-share", "Share", (invoice
    ? [copyField("pay-link", "Pay link", links.pay), copyField("view-link", "Invoice link", links.view)]
    : [copyField("view-link", "Quote link", links.view)]).join("\n          ")));
  folds.push(otherProjectFold({ base, client, item, projects }));
  folds.push(fold("billing-history", "History", activity(item, receipt)));

  // Beside the heading: a quote's invoice, Edit, Save as template, Mark void and Delete (its page
  // confirms what goes with it).
  const actions = [];
  if (!invoice && item.invoiceNumber) {
    actions.push(`<a class="button button-outline" href="/clients/admin/clients/${encodeURIComponent(client.slug)}/billing/${encodeURIComponent(item.invoiceId)}">Invoice ${escapeHtml(item.invoiceNumber)}</a>`);
  } else if (!invoice && (item.status === "open" || item.status === "accepted")) {
    actions.push(`<form action="${base}/invoice" method="post"><button class="button button-solid" type="submit">Create invoice</button></form>`);
  }
  if (isEditable(item)) actions.push(`<a class="button ${!invoice && !item.invoiceNumber ? "button-outline" : "button-solid"}" href="${base}/edit">Edit</a>`);
  actions.push(`<form action="/clients/admin/templates/from-billing" method="post"><input type="hidden" name="client" value="${escapeAttribute(client.slug)}"><input type="hidden" name="id" value="${escapeAttribute(item.id)}"><button class="button button-outline" type="submit">Save as template</button></form>`);
  // An invoice with payments toward it is not voided (its payments would have nothing to apply to).
  if (item.status === "open" && !installmentsTotal(item)) actions.push(`<form action="${base}/void" method="post"><button class="button button-outline" type="submit">Mark void</button></form>`);
  actions.push(`<a class="billing-trash" href="${base}/delete" aria-label="Delete ${escapeAttribute(billingLabel(item))}" title="Delete">${TRASH_ICON}</a>`);

  return adminShell(`<div class="site-width portal-shell">
      <p class="portal-kicker"><a class="portal-inline-link" href="/clients/admin?client=${encodeURIComponent(client.slug)}">${escapeHtml(client.name)}</a></p>
      <div class="billing-admin-head">
        <h1 class="portal-heading portal-heading-sm">${kindLabel(item)} ${escapeHtml(item.number)}</h1>
        <div class="billing-admin-actions">
          ${actions.join("\n          ")}
        </div>
      </div>
      ${noticeMarkup(notice)}
      <div class="billing-layout billing-layout-admin">
        ${billingDocument({ item, client })}
        <div class="admin-folds billing-folds">
        ${folds.filter(Boolean).join("\n        ")}
        </div>
      </div>
      ${recipientList(recipients)}
    </div>`, { title: `${billingLabel(item)} · ${item.title}`, scripts: [BILLING_SCRIPT] });
}

// ---------- Books ----------

const WHO = { admin: "Admin", client: "Client", crew: "Crew", stripe: "Stripe", system: "Portal", visitor: "Visitor" };
const dateTimeFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/Detroit", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

function dateTimeText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : escapeHtml(dateTimeFormat.format(date));
}

// Blank for nothing, so a column shows only what moved.
function moneyCell(cents) {
  return cents ? money(cents) : "";
}

// Periods for the Books page's quick links, from today's date (YYYY-MM-DD).
function bookPeriods(today) {
  const [year, month] = today.split("-").map(Number);
  const pad = (value) => String(value).padStart(2, "0");
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const previous = month === 1 ? [year - 1, 12] : [year, month - 1];
  return [
    ["This month", `${year}-${pad(month)}-01`, today],
    ["Last month", `${previous[0]}-${pad(previous[1])}-01`, `${previous[0]}-${pad(previous[1])}-${pad(lastDay(previous[0], previous[1]))}`],
    ["This year", `${year}-01-01`, today],
    ["Last year", `${year - 1}-01-01`, `${year - 1}-12-31`],
    ["All time", "", ""]
  ];
}

// The Books page. `report` from books.js booksReport, `check` from checkBooks.
// Each job's gross income, gross expenses and gross profit, one job per row, and the jobs' total.
function jobsLedger(report, names, period) {
  if (!report.jobs.length) return '<p class="portal-empty">No job income or expenses in this period.</p>';
  const jobs = report.jobs.slice().sort((left, right) => (names.get(left.slug) || left.slug).localeCompare(names.get(right.slug) || right.slug));
  const total = jobs.reduce((sum, job) => ({ income: sum.income + job.income, expenses: sum.expenses + job.expenses, profit: sum.profit + job.profit }), { income: 0, expenses: 0, profit: 0 });
  const cells = (row) => `<td class="books-money" data-label="Gross income">${money(row.income)}</td>
          <td class="books-money" data-label="Gross expenses">${money(row.expenses)}</td>
          <td class="books-money${row.profit < 0 ? " books-loss" : ""}" data-label="Gross profit">${money(row.profit)}</td>`;
  return `<table class="portal-table books-table books-jobs">
          <thead><tr><th scope="col">Job</th><th scope="col" class="books-money">Gross income</th><th scope="col" class="books-money">Gross expenses</th><th scope="col" class="books-money">Gross profit</th></tr></thead>
          <tbody>${jobs.map((job) => `<tr>
          <td><a class="portal-inline-link" href="/clients/admin/books/jobs/${encodeURIComponent(job.slug)}${period}">${escapeHtml(names.get(job.slug) || job.slug)}</a></td>
          ${cells(job)}
        </tr>`).join("")}</tbody>
          <tfoot><tr><th scope="row">All jobs</th>${cells(total)}</tr></tfoot>
        </table>`;
}

// `clients` are every client portal and project (for names); those in the archive are out of the
// books, so the filter and Add expense leave them out.
export function adminBooksPage({ report, check, log = null, clients, today, notice = null, overheadExpenses = [], payers = [], paidTo = [] }) {
  const names = new Map(clients.map((client) => [client.slug, client.label || client.name]));
  const inUse = clients.filter((client) => !client.archivedAt);
  const query = (extra = {}) => {
    const params = new URLSearchParams();
    const values = { client: report.slug, from: report.from, to: report.to, ...extra };
    for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
    const text = params.toString();
    return text ? `?${text}` : "";
  };
  const itemLink = (entry, text) => (entry.itemExists && entry.clientSlug
    ? `<a class="portal-inline-link" href="/clients/admin/clients/${encodeURIComponent(entry.clientSlug)}/billing/${encodeURIComponent(entry.itemId)}">${escapeHtml(text)}</a>`
    : escapeHtml(text));

  const periods = bookPeriods(today).map(([label, from, to]) => {
    const current = report.from === from && report.to === to;
    return `<a class="portal-secondary-link" href="/clients/admin/books${query({ from, to })}"${current ? ' aria-current="page"' : ""}>${label}</a>`;
  }).join("");
  const range = report.from || report.to
    ? `${report.from ? dateText(report.from) : "the start"} to ${report.to ? dateText(report.to) : "today"}`
    : "all time";

  // Nothing shows while the books balance; a problem shows with the button that fixes it.
  const balance = check.balanced
    ? ""
    : `<section class="books-check books-check-off" aria-labelledby="books-check-heading">
          <h2 id="books-check-heading">The books do not balance.</h2>
          ${check.debits !== check.credits ? `<p>Debits are ${money(check.debits)} and credits are ${money(check.credits)}.</p>` : ""}
          ${check.problems.length ? `<ul>${check.problems.map((problem) => `<li>${escapeHtml(problem.label)}${problem.clientSlug && names.has(problem.clientSlug) ? ` (${escapeHtml(names.get(problem.clientSlug))})` : ""}: its ${problem.parts.map((part) => ({ issue: "invoiced amount", installment: "payment toward the balance", expense: "expense", payment: "payment", fee: "Stripe fee", refund: "refund", dispute: "dispute", "dispute-close": "dispute outcome", cost: "labor cost", paid: "labor payment" })[part] || part).join(" and ")} ${problem.parts.length > 1 ? "do" : "does"} not match the journal.</li>`).join("")}</ul>` : ""}
          <form action="/clients/admin/books/correct" method="post">
            <button class="button button-solid" type="submit">Post corrections</button>
          </form>
          <p class="portal-security-note">Corrections reverse what no longer matches and post each invoice as it stands now. Nothing is deleted from the journal.</p>
        </section>`;

  const summary = report.summary;
  const figures = [
    ["Invoiced", summary.invoiced, `in ${range}`],
    ["Received", summary.received, `in ${range}`],
    ["Stripe fees", summary.fees, `in ${range}`],
    ["Refunds", summary.refunds, `in ${range}`],
    ["Outstanding", summary.outstanding, report.to ? `owed on ${dateText(report.to)}` : "owed now", true],
    ["Unapplied payments", summary.unapplied, "received, not tied to an invoice"],
    ...(summary.owedToCrew ? [["Owed to crew", summary.owedToCrew, "approved labor not paid yet"]] : []),
    ...(summary.disputed ? [["Held in disputes", summary.disputed, "until Stripe decides"]] : [])
  ];

  // The jobs ledger, then overhead (what no job carries) by category, and what is left.
  const period = query({ client: "" });
  const jobs = jobsLedger(report, names, period);
  const grossProfit = report.jobs.reduce((sum, job) => sum + job.profit, 0);
  const overheadTotal = report.overhead.reduce((sum, entry) => sum + entry.amount, 0);
  const overhead = report.overhead.length
    ? `<table class="portal-table books-table books-overhead">
          <thead><tr><th scope="col">Category</th><th scope="col" class="books-money">Amount</th></tr></thead>
          <tbody>${report.overhead.map((entry) => `<tr><td>${escapeHtml(entry.name)}</td><td class="books-money" data-label="Amount">${money(entry.amount)}</td></tr>`).join("")}</tbody>
          <tfoot><tr><th scope="row">Overhead</th><td class="books-money" data-label="Amount">${money(overheadTotal)}</td></tr></tfoot>
        </table>`
    : '<p class="portal-empty">No overhead in this period.</p>';
  const net = grossProfit + report.otherIncome - overheadTotal;
  const bottomLine = `<dl class="billing-totals books-net">
          <div><dt>Gross profit</dt><dd${grossProfit < 0 ? ' class="books-loss"' : ""}>${money(grossProfit)}</dd></div>
          ${report.otherIncome ? `<div><dt>Other income</dt><dd>${money(report.otherIncome)}</dd></div>` : ""}
          <div><dt>Overhead</dt><dd>${money(overheadTotal)}</dd></div>
          <div class="billing-totals-due"><dt>Net profit</dt><dd${net < 0 ? ' class="books-loss"' : ""}>${money(net)}</dd></div>
        </dl>`;
  const jobOptions = inUse.map((client) => ({ slug: client.slug, name: client.label || client.name }));

  const ledgerRows = report.entries.slice().reverse().map((entry) => {
    const text = entry.itemExists ? [entry.itemLabel, ...entry.memo.split(" · ").slice(1)].join(" · ") : entry.memo;
    const received = entry.cash;
    return `<tr>
          <td>${dateText(entry.date)}</td>
          <td>${itemLink(entry, text)}<small>${escapeHtml(names.get(entry.clientSlug) || entry.clientSlug || "")}${entry.source === "opening" ? " · opening entry" : ""}${entry.kind === "reversal" ? " · reversal" : ""}</small></td>
          <td class="books-money" data-label="Invoiced">${moneyCell(entry.invoiced)}</td>
          <td class="books-money" data-label="Received">${moneyCell(received)}</td>
          <td class="books-money" data-label="Owed to you">${money(entry.owed)}</td>
        </tr>`;
  }).join("");
  const ledger = report.entries.length
    ? `<table class="portal-table books-table">
          <thead><tr><th scope="col">Date</th><th scope="col">Entry</th><th scope="col" class="books-money">Invoiced</th><th scope="col" class="books-money">Received</th><th scope="col" class="books-money">Owed to you</th></tr></thead>
          <tbody>${ledgerRows}</tbody>
        </table>`
    : '<p class="portal-empty">No entries in this period.</p>';

  const accountRows = report.accounts.map((account) => {
    const net = account.debit - account.credit;
    return `<tr>
          <td>${escapeHtml(account.code)} · ${escapeHtml(account.name)}</td>
          <td class="books-money" data-label="Debit">${net > 0 ? money(net) : ""}</td>
          <td class="books-money" data-label="Credit">${net < 0 ? money(-net) : ""}</td>
        </tr>`;
  }).join("");
  const debitTotal = report.accounts.reduce((sum, account) => sum + Math.max(account.debit - account.credit, 0), 0);
  const creditTotal = report.accounts.reduce((sum, account) => sum + Math.max(account.credit - account.debit, 0), 0);

  const activityRows = report.activity.map((entry) => `<tr>
          <td>${dateTimeText(entry.at)}</td>
          <td>${escapeHtml(WHO[entry.actor] || entry.actor)}</td>
          <td>${entry.itemExists && entry.clientSlug ? `${itemLink(entry, entry.summary)}` : escapeHtml(entry.summary)}${entry.clientSlug ? `<small>${escapeHtml(names.get(entry.clientSlug) || entry.clientSlug)}</small>` : ""}</td>
          <td class="books-money" data-label="Amount">${entry.amountCents === null ? "" : money(entry.amountCents)}</td>
        </tr>`).join("");
  const activity = report.activity.length
    ? `<table class="portal-table books-table books-activity">
          <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What happened</th><th scope="col" class="books-money">Amount</th></tr></thead>
          <tbody>${activityRows}</tbody>
        </table>`
    : '<p class="portal-empty">Nothing happened in this period.</p>';

  return adminShell(`<div class="site-width portal-shell books">
      <section class="admin-intro">
        <p class="portal-kicker">Admin panel</p>
        <h1 class="portal-heading">Books.</h1>
        <p class="portal-lead">${escapeHtml(report.slug ? names.get(report.slug) || report.slug : "Every job")}, ${escapeHtml(range)}.</p>
        <p class="portal-lead-actions"><a class="button button-outline" href="/clients/admin/books/expenses/new" data-add-expense>Add expense</a></p>
        ${noticeMarkup(notice)}
      </section>

      <form class="admin-template-picker books-filters" action="/clients/admin/books" method="get">
        <label for="books-client">Client portal
          <select id="books-client" name="client">
            <option value="">All client portals</option>
            ${inUse.map((client) => `<option value="${escapeAttribute(client.slug)}"${client.slug === report.slug ? " selected" : ""}>${escapeHtml(client.label || client.name)}</option>`).join("")}
          </select>
        </label>
        <label for="books-from">From
          <input id="books-from" name="from" type="date" value="${escapeAttribute(report.from)}">
        </label>
        <label for="books-to">To
          <input id="books-to" name="to" type="date" value="${escapeAttribute(report.to)}">
        </label>
        <button class="button button-solid" type="submit">Show</button>
      </form>
      <nav class="books-periods" aria-label="Periods">${periods}</nav>

      ${balance}

      <dl class="billing-totals books-summary">
        ${figures.map(([label, cents, note, due]) => `<div${due ? ' class="billing-totals-due"' : ""}><dt>${label}</dt><dd>${money(cents)}</dd><dd class="books-summary-note">${escapeHtml(note)}</dd></div>`).join("\n        ")}
      </dl>

      <section class="books-section" aria-labelledby="books-jobs-heading">
        <div class="books-section-head">
          <h2 id="books-jobs-heading">Jobs</h2>
        </div>
        ${jobs}
      </section>

      <section class="books-section" aria-labelledby="books-overhead-heading">
        <div class="books-section-head">
          <h2 id="books-overhead-heading">Overhead</h2>
        </div>
        ${overhead}
        ${bottomLine}
        ${overheadExpenses.length ? `<details class="books-overhead-added">
          <summary>Overhead expenses added here (${overheadExpenses.length})</summary>
          ${expenseRows(overheadExpenses, { base: "/clients/admin/books", totalLabel: "Overhead expenses" })}
        </details>` : ""}
      </section>

      <section class="books-section" aria-labelledby="books-ledger-heading">
        <div class="books-section-head">
          <h2 id="books-ledger-heading">Ledger</h2>
          <a class="portal-secondary-link" href="/clients/admin/books/ledger.csv${query()}">Download the ledger (CSV)</a>
        </div>
        <p class="admin-meta">Newest first. Entries are dated by the invoice or payment date; the download lists each debit and credit.</p>
        ${ledger}
      </section>

      <section class="books-section" aria-labelledby="books-accounts-heading">
        <div class="books-section-head">
          <h2 id="books-accounts-heading">Account balances</h2>
        </div>
        <p class="admin-meta">${report.to ? `On ${dateText(report.to)}` : "Now"}${report.slug ? `, for ${escapeHtml(names.get(report.slug) || report.slug)}` : ""}. Debits and credits total the same, which is what balanced books mean.</p>
        <table class="portal-table books-table books-accounts">
          <thead><tr><th scope="col">Account</th><th scope="col" class="books-money">Debit</th><th scope="col" class="books-money">Credit</th></tr></thead>
          <tbody>${accountRows}</tbody>
          <tfoot><tr><th scope="row">Total</th><td class="books-money" data-label="Debit">${money(debitTotal)}</td><td class="books-money" data-label="Credit">${money(creditTotal)}</td></tr></tfoot>
        </table>
      </section>

      <section class="books-section" aria-labelledby="books-activity-heading">
        <div class="books-section-head">
          <h2 id="books-activity-heading">Activity</h2>
          <a class="portal-secondary-link" href="/clients/admin/books/activity.csv${query()}">Download the activity (CSV)</a>
        </div>
        <p class="admin-meta">Everything done by the admin, clients, crew and Stripe, newest first.</p>
        ${logSeal(log)}
        ${activity}
      </section>
      ${addExpenseDialog({ action: "/clients/admin/books/expenses", payers, today, paidTo, jobs: jobOptions })}
    </div>`, { title: "Books", scripts: [BILLING_SCRIPT] });
}

// One job's book (books.js jobBook): what it earned and what it cost, and its gross profit.
export function adminJobBookPage({ client, book, today }) {
  const base = `/clients/admin/books/jobs/${encodeURIComponent(client.slug)}`;
  const periods = bookPeriods(today).map(([label, from, to]) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const text = params.toString();
    const current = book.from === from && book.to === to;
    return `<a class="portal-secondary-link" href="${base}${text ? `?${text}` : ""}"${current ? ' aria-current="page"' : ""}>${label}</a>`;
  }).join("");
  const download = new URLSearchParams({ client: client.slug, ...(book.from ? { from: book.from } : {}), ...(book.to ? { to: book.to } : {}) });
  const income = book.income.length
    ? `<table class="portal-table books-table">
          <thead><tr><th scope="col">Date</th><th scope="col">Income</th><th scope="col" class="books-money">Amount</th></tr></thead>
          <tbody>${book.income.map((row) => `<tr>
          <td>${dateText(row.date)}</td>
          <td>${row.itemId ? `<a class="portal-inline-link" href="/clients/admin/clients/${encodeURIComponent(client.slug)}/billing/${encodeURIComponent(row.itemId)}">${escapeHtml(row.what)}</a>` : escapeHtml(row.what)}</td>
          <td class="books-money" data-label="Amount">${money(row.amount)}</td>
        </tr>`).join("")}</tbody>
        </table>`
    : '<p class="portal-empty">No income in this period.</p>';
  const expenses = book.expenses.length
    ? `<table class="portal-table books-table">
          <thead><tr><th scope="col">Date</th><th scope="col">Expense</th><th scope="col">Category</th><th scope="col" class="books-money">Amount</th></tr></thead>
          <tbody>${book.expenses.map((row) => `<tr>
          <td>${dateText(row.date)}</td>
          <td>${escapeHtml(row.what)}${row.paidTo ? `<small>${escapeHtml(row.paidTo)}</small>` : ""}</td>
          <td>${escapeHtml(row.category)}</td>
          <td class="books-money" data-label="Amount">${money(row.amount)}</td>
        </tr>`).join("")}</tbody>
        </table>
        <table class="portal-table books-table books-categories">
          <thead><tr><th scope="col">Category</th><th scope="col" class="books-money">Amount</th></tr></thead>
          <tbody>${book.categories.map((entry) => `<tr><td>${escapeHtml(entry.name)}</td><td class="books-money" data-label="Amount">${money(entry.amount)}</td></tr>`).join("")}</tbody>
          <tfoot><tr><th scope="row">Gross expenses</th><td class="books-money" data-label="Amount">${money(book.totals.expenses)}</td></tr></tfoot>
        </table>`
    : '<p class="portal-empty">No expenses in this period.</p>';
  return adminShell(`<div class="site-width portal-shell books">
      <section class="admin-intro">
        <p class="portal-kicker"><a class="portal-inline-link" href="/clients/admin/books">Books</a></p>
        <h1 class="portal-heading portal-heading-sm">${escapeHtml(client.label || client.name)}</h1>
        ${client.archivedAt ? '<p class="portal-lead">In the archive, so it is left out of the Books page.</p>' : ""}
      </section>
      <nav class="books-periods" aria-label="Periods">${periods}</nav>
      ${grossFigures(book.totals)}
      <section class="books-section" aria-labelledby="job-income-heading">
        <div class="books-section-head"><h2 id="job-income-heading">Income</h2></div>
        ${income}
      </section>
      <section class="books-section" aria-labelledby="job-expenses-heading">
        <div class="books-section-head">
          <h2 id="job-expenses-heading">Expenses</h2>
          <div class="books-section-links">
            <a class="portal-secondary-link" href="/clients/admin?client=${encodeURIComponent(client.slug)}">Project</a>
            <a class="portal-secondary-link" href="/clients/admin/books/ledger.csv?${download}">Download (CSV)</a>
          </div>
        </div>
        ${expenses}
      </section>
    </div>`, { title: `${client.label || client.name} · Job book` });
}

// Whether the activity log is as it was written (books.js verifyActivityLog). Invoices and the
// books can be edited; the log cannot, so it shows who did what.
function logSeal(log) {
  if (!log) return "";
  const count = log.total.toLocaleString("en-US");
  if (!log.intact) {
    const where = log.broken.at ? ` (${dateTimeText(log.broken.at)}${log.broken.summary ? ` · ${escapeHtml(log.broken.summary)}` : ""})` : "";
    return `<section class="books-check books-check-off books-log-seal" aria-label="Activity log check">
          <h3>The activity log was altered.</h3>
          <p>Entry #${log.broken.seq.toLocaleString("en-US")}${where} no longer matches its seal, so the log from there on is not as it was recorded. Download the activity to keep a copy, and find out who has access to the portal's database.</p>
        </section>`;
  }
  if (!log.protected) {
    return `<section class="books-check books-check-off books-log-seal" aria-label="Activity log check">
          <h3>The activity log's protection is switched off.</h3>
          <p>All ${count} entries still match their seals, but the database would now let entries be changed. It has to be switched back on in the database (migration 20261006_myhomebuilder_portal_activity_seal).</p>
        </section>`;
  }
  return `<p class="books-log-seal books-log-ok">Permanent record: entries are added but can never be changed or deleted. All ${count} entries check out${log.latest ? ` · latest seal #${log.latest.seq.toLocaleString("en-US")} <code>${escapeHtml(log.latest.seal.slice(0, 12))}</code>` : ""}.</p>`;
}

// Confirms deleting a quote or invoice, saying what goes with it. `partner` is the quote an
// invoice was made from, or the invoice made from a quote.
export function billingDeletePage({ client, item, partner = null }) {
  const base = `/clients/admin/clients/${encodeURIComponent(client.slug)}/billing/${encodeURIComponent(item.id)}`;
  const invoice = item.kind === "invoice";
  const noun = invoice ? "invoice" : "quote";
  const label = billingLabel(item);
  const [, status] = billingStatus(item);
  const facts = [
    ["Title", item.title],
    [invoice ? "Amount" : "Quote total", money(item.amountCents, item.currency)],
    ["Status", status],
    ["Client portal", client.name]
  ];
  const notes = [];
  if (item.status === "paid") {
    const paid = `${paymentSummary(item)} · ${money(item.payment?.amountCents ?? item.amountCents, item.currency)}`;
    notes.push(item.payment?.source === "stripe"
      ? `It was paid online through Stripe (${paid}). The payment stays in the Stripe account; this portal will no longer show it.`
      : `It is marked paid (${paid}). That payment record is deleted with it.`);
  }
  if (installmentsTotal(item) > 0) notes.push(`Payments toward it (${item.installments.map((entry) => `${money(entry.amountCents, item.currency)} · ${entry.label} · ${formatDate(entry.paidOn)}`).join("; ")}) are deleted with it.`);
  if (item.sentAt) notes.push(`It was emailed to ${item.sentTo}. The link in that email will stop working.`);
  if (partner) {
    notes.push(invoice
      ? `It was made from Quote ${partner.number}. The quote stays and can be invoiced again.`
      : `Invoice ${partner.number} was made from it. The invoice stays.`);
  }
  if (item.status === "open" && invoice && !installmentsTotal(item)) notes.push("To keep a record of it instead, go back and use Mark void.");
  const numbering = invoice
    ? "Later invoices move up a number, so invoice numbers stay in date order."
    : "Its number is not used again.";
  const action = item.status === "processing"
    ? `<p class="portal-error" role="alert">A bank payment for this invoice is still processing, so it can be deleted once the payment finishes.</p>
          <a class="portal-secondary-link" href="${base}">Back to ${escapeHtml(label)}</a>`
    : `<form class="admin-manage" action="${base}/delete" method="post">
            <button class="button button-danger" type="submit">Delete ${noun}</button>
            <a class="portal-secondary-link" href="${base}">Cancel</a>
          </form>`;
  return adminShell(`<div class="site-width portal-shell">
      <p class="portal-kicker"><a class="portal-inline-link" href="/clients/admin?client=${encodeURIComponent(client.slug)}">${escapeHtml(client.name)}</a></p>
      <h1 class="portal-heading portal-heading-sm">Delete ${escapeHtml(label)}?</h1>
      <section class="admin-card billing-delete">
        <ol class="admin-activity">${facts.map(([name, value]) => `<li><span>${escapeHtml(name)}</span><span>${escapeHtml(value)}</span></li>`).join("")}</ol>
        ${notes.map((note) => `<p class="admin-meta">${escapeHtml(note)}</p>`).join("\n        ")}
        <p class="admin-meta"><strong>Deleting can't be undone.</strong> ${numbering}</p>
        ${action}
      </section>
    </div>`, { title: `Delete ${label}` });
}

export function adminTemplatesPage({ templates, notes = [], notice = null }) {
  const rows = templates.length
    ? `<table class="portal-table">
        <thead><tr><th scope="col">Template</th><th scope="col">Type</th><th scope="col">Total</th><th scope="col"><span class="visually-hidden">Action</span></th></tr></thead>
        <tbody>${templates.map((template) => `<tr>
          <td><strong>${escapeHtml(template.name)}</strong><small>${escapeHtml(template.title)}${template.dueInDays !== null && template.dueInDays !== undefined ? ` · due in ${template.dueInDays} days` : ""}</small></td>
          <td>${template.kind === "invoice" ? "Invoice" : "Quote"}</td>
          <td>${money(template.amountCents)}</td>
          <td><a class="portal-secondary-link" href="/clients/admin/templates/${encodeURIComponent(template.id)}">Edit</a></td>
        </tr>`).join("")}</tbody>
      </table>`
    : '<p class="portal-empty">No templates yet. Create one here, or use Save as template when posting a quote or invoice.</p>';
  // Saved notes and terms (the editor's Use template beside Notes and terms). Create new with a
  // name already here replaces its text.
  const notesSection = notes.length
    ? `<section class="templates-notes" aria-labelledby="notes-templates-heading">
        <h2 id="notes-templates-heading">Notes and terms</h2>
        <table class="portal-table">
          <thead><tr><th scope="col">Template</th><th scope="col"><span class="visually-hidden">Action</span></th></tr></thead>
          <tbody>${notes.map((entry) => `<tr>
            <td><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.text.length > 140 ? `${entry.text.slice(0, 137)}…` : entry.text)}</small></td>
            <td class="portal-actions"><form method="post" action="/clients/admin/templates/${encodeURIComponent(entry.id)}/delete" data-confirm="${escapeAttribute(`Delete the notes and terms template ${entry.name}?`)}">
              <button class="billing-trash" type="submit" aria-label="Delete ${escapeAttribute(entry.name)}" title="Delete">${TRASH_ICON}</button>
            </form></td>
          </tr>`).join("")}</tbody>
        </table>
      </section>`
    : "";

  return adminShell(`<div class="site-width portal-shell">
      <p class="portal-kicker">Admin panel</p>
      <h1 class="portal-heading portal-heading-sm">Quote and invoice templates.</h1>
      <p class="portal-lead">Save the line items, notes and terms you use often. Choose a template when you start a new quote or invoice for any client.</p>
      ${noticeMarkup(notice)}
      <div class="admin-actions-bar admin-actions-spaced">
        <a class="button button-solid" href="/clients/admin/templates/new">New template</a>
        <a class="portal-secondary-link" href="/clients/admin">Back to client portals</a>
      </div>
      ${rows}
      ${notesSection}
    </div>`, { title: "Templates", scripts: [BILLING_SCRIPT] });
}
