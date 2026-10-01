import { balanceDue, billingLabel, billingLineItems, installmentsTotal, isEditable, isPayable, issuedDate, moneyInput, PAYMENT_METHODS, quantityText, todayInMichigan } from "./billing.js";
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

// Printed on every quote and invoice, worded exactly as the owner gave them.
const BUSINESS_ADDRESS = ["6749 Fulton St E, Ste A #2333", "Ada, MI 49301"];
const BUILDER_LICENSE = "License # 242601116";
const INSURANCE = "$1,000,000 liability insurance provided by Next First Insurance Agency Inc";
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

// `crew`: signed in to the crew portal; `crewSignedOut`: its sign-in pages.
export function pageShell(content, { authenticated = false, admin = false, crew = false, crewSignedOut = false, bodyClass = "portal-page", scripts = [], title = "Client Portal", navCurrent = "login" } = {}) {
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
        <a href="/legal/">Legal and privacy</a>
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
      ? `<a class="payment-change" href="${href}" data-payment-menu data-label="${escapeAttribute(name)}" data-method="${escapeAttribute(payment.method || "")}" data-method-name="${escapeAttribute(payment.methodName || "")}" data-reference="${escapeAttribute(payment.reference || "")}" data-paid-on="${escapeAttribute(String(item.paidAt || "").slice(0, 10))}" title="Change how it was paid">${escapeHtml(detail)}</a>`
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

export function portalHomePage({ client, billing, documents, storeReady, admin = false, notice = null, book = null }) {
  // Display all data to client portal (read only): every figure, and nothing to do or download.
  const readOnly = Boolean(client.readOnly);
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
            <a class="button button-solid" href="${escapeAttribute(client.projectPath)}/material-render/?scene=kitchen">Open live designer</a>
            <a class="portal-secondary-link" href="${escapeAttribute(client.projectPath)}/">Review fixed room looks</a>
            <small>Both views remain securely inside your private client session.</small>
          </div>
        </article>
      </section>`
    : "";

  const setupNote = storeReady
    ? ""
    : '<p class="portal-notice">Quotes, invoices and documents are being set up for this portal and will appear here soon.</p>';

  return pageShell(`<div class="site-width portal-shell">
      <section>
        <p class="portal-kicker">Client portal</p>
        <h1 class="portal-heading">${escapeHtml(client.name)}</h1>
        <p class="portal-lead">${readOnly ? "Everything on this project, read only." : "Review project resources, pay invoices securely, and upload or sign documents in one place."}</p>
        ${storeReady && !readOnly ? '<p class="portal-lead-actions"><a class="button button-outline" href="#upload-document">Upload document</a></p>' : ""}
        ${noticeMarkup(notice)}
        ${setupNote}
      </section>
      ${projectSection}
      <section class="portal-section" aria-labelledby="billing-heading">
        <h2 id="billing-heading">Quotes and invoices</h2>
        ${billingRows(billing, { basePath: "/clients/billing", viewer: "client", readOnly })}
      </section>
      ${readOnly ? financialsSection(book) : ""}
      <section class="portal-section" aria-labelledby="documents-heading">
        <h2 id="documents-heading">Documents</h2>
        ${readOnly ? '<p class="portal-empty">Document view disabled for completed projects</p>' : documentSections(documents, { basePath: "/clients/documents", viewer: "client" })}
        ${storeReady && !readOnly ? `<form class="portal-form portal-upload" id="upload-document" action="/clients/documents/upload" method="post" enctype="multipart/form-data">
          <h3>Upload document</h3>
          <p>Share plans, photos, permits or signed paperwork with My Home Builder. PDF, images and common office files up to 20 MB.</p>
          <label for="client-upload">Choose a file
            <input id="client-upload" name="file" type="file" required>
          </label>
          <button class="button button-solid" type="submit">Upload document</button>
        </form>` : ""}
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

// Choosing a template opens a new quote or invoice from it (billing.js); without scripts its
// button does.
function templatePicker(templates, action) {
  if (!templates.length) return "";
  const options = templates.map((template) => `<option value="${escapeAttribute(template.id)}">${escapeHtml(template.name)} (${template.kind === "invoice" ? "invoice" : "quote"})</option>`).join("");
  return `<form class="admin-template-picker" action="${escapeAttribute(action)}" method="get">
            <label for="template-pick">Start from a template
              <select class="select-plain" id="template-pick" name="template" required data-autosubmit><option value="" selected disabled>Choose a template</option>${options}</select>
            </label>
            <button class="portal-logout-button" type="submit" data-autosubmit-button>Use template</button>
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
            <p class="admin-meta">How was it paid?</p>
            ${paymentFields("list-payment", { date: todayInMichigan() })}
            ${receipt}
            <button class="button button-solid" type="submit">Mark as paid</button>
          </form>
          <form class="admin-stack-form" method="post" data-status-due hidden>
            <input type="hidden" name="return" value="list">
            <p class="admin-meta" data-status-due-text></p>
            <button class="button button-solid" type="submit">Mark as due</button>
          </form>
          <p class="portal-security-note" data-status-stripe hidden>Paid online through Stripe. Stripe payments keep the details Stripe recorded, so this one stays paid.</p>
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
            <p class="portal-security-note">The receipt is not sent again. Resend receipt on the invoice's page sends the corrected one.</p>
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
            ${jobs ? shown("job", "Job", `<select id="${prefix}-job" name="job"><option value="">Overhead (no job)</option>${jobs.map((client) => `<option value="${escapeAttribute(client.slug)}">${escapeHtml(client.name)}</option>`).join("")}</select>`) : ""}
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
            <p class="portal-security-note">A payment less than the balance leaves the rest due, and the invoice shows each payment. The balance marks it paid.</p>
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
  const names = new Map(clients.map((client) => [client.slug, client.name]));
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
  const portals = clients.map((client) => `<option value="${escapeAttribute(client.slug)}">${escapeHtml(client.name)}</option>`).join("");
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

// `selectedLogin` is the selected project's client login in plain text, when it is on file.
export function adminDashboardPage({ clients, selected, billing, documents, templates = [], recipients = [], readiness, notice = null, authenticated = true, newClient = null, clientError = "", typedEmails = null, expenses = [], payers = [], paidTo = [], selectedLogin = null, today = todayInMichigan() }) {
  const clientLinks = clients.map((client) => {
    const current = selected && client.slug === selected.slug;
    const emails = clientEmails(client);
    const adminOnly = !client.passwordHash && !client.managedBySecret;
    const detail = [adminOnly ? "Admin only" : "", client.readOnly ? "Read only" : "", emails.length ? escapeHtml(emails.join(", ")) : "No email on file"].filter(Boolean).join(" · ");
    return `<li><a class="admin-client-link${current ? " is-current" : ""}" href="/clients/admin?client=${encodeURIComponent(client.slug)}"${current ? ' aria-current="page"' : ""}>
        <strong>${escapeHtml(client.name)}</strong><small>${detail}</small></a></li>`;
  }).join("");

  const selectedSection = selected
    ? (() => {
      const base = `/clients/admin/clients/${encodeURIComponent(selected.slug)}`;
      return `<section class="admin-panel" aria-labelledby="selected-heading">
        <div class="admin-panel-head">
          <h2 id="selected-heading">${escapeHtml(selected.name)}</h2>
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
          ${selected.managedBySecret ? `<div class="admin-inline-form admin-save-row">
            <span class="icon-save icon-save-off" title="Set in Render" aria-hidden="true">${SAVE_ICON}</span>
            <label for="client-login">Client login
              <input id="client-login" type="text" readonly value="${escapeAttribute(selectedLogin || "")}">
            </label>
          </div>` : `<form class="admin-inline-form admin-save-row" action="${base}/login" method="post">
            <button class="icon-save" type="submit" aria-label="Save client login" title="Save">${SAVE_ICON}</button>
            <label for="client-login">Client login
              <input id="client-login" name="login" type="text" minlength="10" maxlength="120" autocomplete="off" required value="${escapeAttribute(selectedLogin || "")}" placeholder="${selected.passwordHash ? "Set, but not on file. Type it again to show it here." : "None, so only you can see this project. Type one to share it."}">
            </label>
          </form>`}
        </div>

        <div class="admin-section-head">
          <h3>Quotes and invoices</h3>
          <div class="admin-actions-bar">
            <a class="button button-solid" href="${base}/billing/new?kind=invoice">New invoice</a>
            <a class="button button-outline" href="${base}/billing/new?kind=quote">New quote</a>
            <a class="button button-outline" href="${base}/payments/new" data-add-payment>Add payment</a>
            <a class="button button-outline" href="${base}/expenses/new" data-add-expense>Add expense</a>
          </div>
          ${templatePicker(templates, `${base}/billing/new`)}
        </div>
        ${billingRows(billing, { basePath: `${base}/billing`, viewer: "admin" })}

        <div class="admin-subhead">
          <h3>Expenses</h3>
          <a class="portal-secondary-link" href="/clients/admin/books/jobs/${encodeURIComponent(selected.slug)}">Job book</a>
        </div>
        ${expenseRows(expenses, { base })}

        <h3>Documents</h3>
        ${documentSections(documents, { basePath: `${base}/documents`, viewer: "admin" })}
        <form class="portal-form admin-form" action="${base}/documents" method="post" enctype="multipart/form-data">
          <h3>Upload a contract or document</h3>
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
        <form class="admin-access" action="${base}/access" method="post">
          <label class="portal-check" for="client-read-only">
            <input id="client-read-only" name="readOnly" type="checkbox" value="yes"${selected.readOnly ? " checked" : ""} data-autosubmit>
            <span>Display all data to client portal (read only)</span>
          </label>
          <button class="portal-logout-button" type="submit" data-autosubmit-button>Save</button>
        </form>
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
      ${recipientList(recipients)}
    </div>`, { authenticated, admin: true, bodyClass: "portal-page portal-admin", title: "Admin panel", scripts: [BILLING_SCRIPT] });
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

// One editor serves new quotes and invoices, edits to open ones, and saved templates.
export function billingEditorPage({ mode, client = null, values, error = "", notice = null, actionPath, backPath, templates = [], readiness = {}, number = "", paid = false }) {
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
  const kicker = template ? "Quote and invoice templates" : client ? escapeHtml(client.name) : "";

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
    } else if (!emails.length) {
      sendOption = '<p class="portal-security-note">Add client emails on the client panel, or email it from the next page, to email quotes, invoices and receipts. You can also copy its link there.</p>';
    } else {
      sendOption = `<label class="portal-check" for="send-now">
            <input id="send-now" name="sendNow" type="checkbox" value="yes"${values.sendNow === false ? "" : " checked"}>
            <span>Email it to ${escapeHtml(addressesText(emails))} after posting</span>
          </label>`;
    }
  }

  const loadTemplate = creating && templates.length
    ? `<form class="admin-template-picker billing-editor-template" action="${escapeAttribute(actionPath)}/new" method="get">
          <label for="editor-template">Start from a template
            <select id="editor-template" name="template" required>${templates.map((entry) => `<option value="${escapeAttribute(entry.id)}">${escapeHtml(entry.name)} (${entry.kind})</option>`).join("")}</select>
          </label>
          <button class="portal-logout-button" type="submit">Use template</button>
        </form>`
    : "";

  const submitLabel = mode === "edit" ? "Save changes" : template ? "Save template" : kind === "invoice" ? "Post invoice" : "Post quote";

  // A new invoice lists payments already received (a deposit, earlier checks); an existing one's
  // are added and removed on its page.
  let paymentsSection = "";
  if (creating) {
    const typed = values.payments?.length ? [...values.payments] : [];
    while (typed.length < Math.max(2, (values.payments?.length || 0) + 1)) typed.push({});
    const methods = (chosen) => Object.entries(PAYMENT_METHODS).map(([key, label]) => `<option value="${key}"${key === (chosen || "check") ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
    paymentsSection = `<fieldset class="listed-payments" data-listed-payments>
          <legend>Payments already received (optional, invoices only)</legend>
          <p class="admin-field-hint">A deposit or payments the client made before this invoice. Less than the total leaves the rest due; the total marks it paid. Blank rows are ignored.</p>
          ${typed.map((row, index) => `<div class="listed-payment" data-listed-payment>
            <label for="listed-${index}-amount">Amount ($)
              <input id="listed-${index}-amount" name="paymentAmount" type="text" inputmode="decimal" maxlength="12" value="${escapeAttribute(row.amount || "")}" placeholder="0.00">
            </label>
            <label for="listed-${index}-method">Paid by
              <select id="listed-${index}-method" name="paymentMethod">${methods(row.method)}</select>
            </label>
            <label for="listed-${index}-other">Other method
              <input id="listed-${index}-other" name="paymentMethodName" type="text" maxlength="60" value="${escapeAttribute(row.methodName || "")}">
            </label>
            <label for="listed-${index}-reference">Reference (optional)
              <input id="listed-${index}-reference" name="paymentReference" type="text" maxlength="80" value="${escapeAttribute(row.reference || "")}" placeholder="Check #1042">
            </label>
            <label for="listed-${index}-date">Received on
              <input id="listed-${index}-date" name="paymentPaidOn" type="date" value="${escapeAttribute(row.paidOn || "")}">
            </label>
          </div>`).join("")}
          <button class="portal-logout-button" type="button" data-listed-payment-add hidden>Add another payment</button>
        </fieldset>`;
  } else if (mode === "edit" && kind === "invoice") {
    paymentsSection = '<p class="admin-field-hint">Payments on this invoice are added and removed on its page (Add a payment).</p>';
  }

  return adminShell(`<div class="site-width portal-shell">
      <p class="portal-kicker">${kicker}</p>
      <h1 class="portal-heading portal-heading-sm">${escapeHtml(heading)}</h1>
      ${noticeMarkup(notice)}
      ${loadTemplate}
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
          <p class="portal-security-note">Blank rows are ignored. Use 0 for included items and a negative unit price for credits.</p>
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
        <label for="billing-description">Notes and terms
          <textarea id="billing-description" name="description" rows="4" maxlength="2000" placeholder="Scope, milestones or payment terms">${escapeHtml(values.description || "")}</textarea>
        </label>
        ${paymentsSection}
        ${sendOption}
        ${creating ? `<label class="portal-check" for="save-template">
            <input id="save-template" name="saveTemplate" type="checkbox" value="yes"${values.saveTemplate ? " checked" : ""}>
            <span>Also save this as a template</span>
          </label>
          <label for="new-template-name">Template name (when saving as a template)
            <input id="new-template-name" name="templateName" type="text" maxlength="80" value="${escapeAttribute(values.templateName || "")}" placeholder="Framing draw">
          </label>` : ""}
        <div class="billing-editor-actions">
          <button class="button button-solid" type="submit">${submitLabel}</button>
          <a class="portal-secondary-link" href="${escapeAttribute(backPath)}">Cancel</a>
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

// Method, the name when the method is Other, reference and date: shared by "Record a payment"
// and "Edit payment". billing.js shows the Other box only when Other is chosen.
function paymentFields(prefix, { payment = null, date }) {
  const chosen = payment?.method && Object.hasOwn(PAYMENT_METHODS, payment.method) ? payment.method : "check";
  const methods = Object.entries(PAYMENT_METHODS)
    .map(([value, label]) => `<option value="${value}"${value === chosen ? " selected" : ""}>${label}</option>`)
    .join("");
  return `<label for="${prefix}-method">Paid by
              <select id="${prefix}-method" name="method" data-payment-method>${methods}</select>
            </label>
            <label for="${prefix}-other" data-payment-other>Other method (when Other is chosen)
              <input id="${prefix}-other" name="methodName" type="text" maxlength="60" value="${escapeAttribute(payment?.methodName || "")}" placeholder="How it was paid">
            </label>
            <label for="${prefix}-reference">Reference (optional)
              <input id="${prefix}-reference" name="reference" type="text" maxlength="80" value="${escapeAttribute(payment?.reference || "")}" placeholder="Check #1042 or confirmation number">
            </label>
            <label for="${prefix}-date">Received on
              <input id="${prefix}-date" name="paidOn" type="date" value="${escapeAttribute(date)}" required>
            </label>`;
}

// Copy to another project opens that project's editor filled in from this quote or invoice. Send
// to another project moves it there, with the quote or invoice linked to it, for one entered in
// the wrong project. One project list serves both buttons.
function otherProjectCard({ base, client, item, projects }) {
  const noun = item.kind === "invoice" ? "invoice" : "quote";
  const others = projects.filter((entry) => entry.slug !== client.slug);
  if (!others.length) {
    return `<section class="admin-card">
          <h2>Another project</h2>
          <p class="admin-meta">Add another client portal to copy this ${noun} to it or send it there.</p>
        </section>`;
  }
  const partner = item.kind === "quote" && item.invoiceNumber
    ? ` with Invoice ${escapeHtml(item.invoiceNumber)}, which was made from it; both keep their numbers and links`
    : item.kind === "invoice" && item.fromQuoteNumber
      ? ` with Quote ${escapeHtml(item.fromQuoteNumber)}, which it was made from; both keep their numbers and links`
      : "; it keeps its number and link";
  const send = item.status === "processing"
    ? `<p class="portal-security-note">A bank payment is still processing, so this invoice can be sent to another project once it finishes.</p>`
    : `<p class="portal-security-note">Send to another project moves this ${noun} there${partner}.</p>`;
  return `<section class="admin-card">
          <h2>Another project</h2>
          <form class="admin-stack-form" action="${base}/copy" method="get">
            <label for="other-project">Project
              <select id="other-project" name="to" required>
                <option value="" selected disabled>Choose a project</option>
                ${others.map((entry) => `<option value="${escapeAttribute(entry.slug)}">${escapeHtml(entry.name)}</option>`).join("")}
              </select>
            </label>
            <div class="admin-manage">
              <button class="button button-solid" type="submit">Copy to another project</button>
              ${item.status === "processing" ? "" : `<button class="portal-logout-button" type="submit" formaction="${base}/move" formmethod="post">Send to another project</button>`}
            </div>
            <p class="portal-security-note">Copy to another project opens a new ${noun} for that project with these lines filled in, to review and post.</p>
            ${send}
          </form>
        </section>`;
}

// `typed` keeps what was typed into a Send to field ({ field: "send" | "receipt", value }) when
// the addresses had a problem. `projects` lists every client portal, for Copy and Send.
export function adminBillingPage({ client, item, links, receipt = null, recipients = [], projects = [], readiness, notice = null, typed = null }) {
  const base = `/clients/admin/clients/${encodeURIComponent(client.slug)}/billing/${encodeURIComponent(item.id)}`;
  const invoice = item.kind === "invoice";
  const projectEmails = clientEmails(client);
  const cards = [];

  const linkFields = invoice
    ? [copyField("pay-link", "Pay link (goes straight to Stripe Checkout)", links.pay), copyField("view-link", "Invoice link", links.view)]
    : [copyField("view-link", "Quote link", links.view)];
  cards.push(`<section class="admin-card">
          <h2>Share</h2>
          ${linkFields.join("\n          ")}
          <p class="portal-security-note">Anyone with a link can view this ${invoice ? "invoice and pay it" : "quote and accept it"} without a login. The client also sees it in their portal.</p>
        </section>`);

  if (item.status !== "void") {
    const sendBody = !readiness.email
      ? '<p class="portal-security-note">Email delivery is not set up yet.</p>'
      : `<form class="admin-inline-form" action="${base}/send" method="post">
            ${emailsField({
              id: "send-to",
              name: "to",
              label: "Send to",
              addresses: projectEmails,
              typed: typed?.field === "send" ? typed.value : null,
              required: true,
              hint: `Filled in from this project's emails. New addresses are added to the project.`
            })}
            <button class="button button-solid" type="submit">Email ${invoice ? "invoice" : "quote"}</button>
          </form>`;
    cards.push(`<section class="admin-card">
          <h2>Email</h2>
          ${item.sentAt ? `<p class="admin-meta">Last emailed to ${escapeHtml(item.sentTo)} on ${dateText(item.sentAt)}.</p>` : ""}
          ${sendBody}
        </section>`);
  }

  if (invoice && item.status === "open") {
    const installments = item.installments || [];
    const listed = installments.length
      ? `<ul class="admin-activity">${installments.map((entry) => `<li><span>${money(entry.amountCents, item.currency)} · ${escapeHtml(entry.label)} · ${dateText(entry.paidOn)}</span>
            <form class="admin-manage" action="${base}/remove-payment" method="post"><input type="hidden" name="installment" value="${escapeAttribute(entry.id)}"><button class="portal-logout-button" type="submit">Remove</button></form></li>`).join("")}</ul>
          <p class="admin-meta">Paid so far ${money(installmentsTotal(item), item.currency)} of ${money(item.amountCents, item.currency)}; ${money(balanceDue(item), item.currency)} is due.</p>`
      : "";
    cards.push(`<section class="admin-card">
          <h2>Add a payment</h2>
          <p class="admin-meta">For checks, Zelle, cash and other payments received outside Stripe. A payment less than the balance leaves the rest due; the balance marks the invoice paid.</p>
          ${listed}
          <form class="admin-stack-form" action="${base}/record-payment" method="post">
            <label for="payment-amount">Amount received ($)
              <input id="payment-amount" name="amount" type="text" inputmode="decimal" maxlength="12" required value="${escapeAttribute(moneyInput(balanceDue(item)))}">
            </label>
            ${paymentFields("payment", { date: links.today })}
            ${readiness.email && projectEmails.length ? `<label class="portal-check" for="payment-receipt">
              <input id="payment-receipt" name="sendReceipt" type="checkbox" value="yes" checked>
              <span>Email a receipt to ${escapeHtml(addressesText(projectEmails))}</span>
            </label>` : ""}
            <button class="button button-solid" type="submit">Add payment</button>
          </form>
        </section>`);
  }

  if (invoice && item.status === "paid") {
    const payment = item.payment || {};
    const summary = [payment.label || "Payment", formatDate(item.paidAt), money(payment.amountCents ?? item.amountCents, item.currency)].filter(Boolean).join(" · ");
    const earlier = (item.installments || []).length
      ? `<p class="admin-meta">Paid earlier toward the balance: ${item.installments.map((entry) => `${money(entry.amountCents, item.currency)} · ${escapeHtml(entry.label)} · ${dateText(entry.paidOn)}`).join("; ")}.</p>`
      : "";
    cards.push(payment.source === "manual"
      ? `<section class="admin-card">
          <h2>Payment</h2>
          <p class="admin-meta">Recorded as ${escapeHtml(summary)}.</p>
          ${earlier}
          <form class="admin-stack-form" action="${base}/payment" method="post">
            ${paymentFields("edit-payment", { payment, date: String(item.paidAt || links.today).slice(0, 10) })}
            <button class="button button-solid" type="submit">Save payment</button>
          </form>
          <form class="admin-danger" action="${base}/reopen" method="post">
            <button class="portal-logout-button" type="submit">Mark as unpaid</button>
            <p class="portal-security-note">Reopens the invoice for payment if it was marked paid by mistake.</p>
          </form>
        </section>`
      : `<section class="admin-card">
          <h2>Payment</h2>
          <p class="admin-meta">Paid online through Stripe: ${escapeHtml(summary)}.</p>
          ${earlier}
          ${stripeAftermath(item)}
          <p class="portal-security-note">Stripe payments keep the details Stripe recorded. Refunds are made in Stripe.</p>
        </section>`);
  }

  if (invoice && item.status === "paid" && readiness.email) {
    const receiptTo = projectEmails.length ? projectEmails : [item.payment?.email].filter(Boolean);
    cards.push(`<section class="admin-card">
          <h2>Receipt</h2>
          ${receipt ? `<p class="admin-meta">Emailed to ${escapeHtml(receipt.to)} on ${dateText(receipt.sentAt)}.</p>` : '<p class="admin-meta">No receipt has been emailed yet.</p>'}
          <form class="admin-inline-form" action="${base}/receipt" method="post">
            ${emailsField({ id: "receipt-to", name: "to", label: "Send to", addresses: receiptTo, typed: typed?.field === "receipt" ? typed.value : null, required: true })}
            <button class="portal-logout-button" type="submit">${receipt ? "Resend receipt" : "Send receipt"}</button>
          </form>
        </section>`);
  }

  if (!invoice && (item.status === "open" || item.status === "accepted")) {
    cards.push(`<section class="admin-card">
          <h2>Invoice</h2>
          ${item.invoiceNumber
            ? `<p class="admin-meta">Invoiced as <a class="portal-inline-link" href="/clients/admin/clients/${encodeURIComponent(client.slug)}/billing/${encodeURIComponent(item.invoiceId)}">Invoice ${escapeHtml(item.invoiceNumber)}</a>.</p>`
            : `<form action="${base}/invoice" method="post">
            <button class="button button-solid" type="submit">Create invoice from this quote</button>
          </form>
          <p class="portal-security-note">Copies the title, line items and notes into a new open invoice.</p>`}
        </section>`);
  }

  cards.push(otherProjectCard({ base, client, item, projects }));

  const manage = [];
  if (isEditable(item)) manage.push(`<a class="button button-outline" href="${base}/edit">Edit ${invoice ? "invoice" : "quote"}</a>`);
  // An invoice with payments toward it is not voided (its payments would have nothing to apply to).
  if (item.status === "open" && !installmentsTotal(item)) manage.push(`<form action="${base}/void" method="post"><button class="portal-logout-button" type="submit">Mark void</button></form>`);
  manage.push(`<form action="/clients/admin/templates/from-billing" method="post"><input type="hidden" name="client" value="${escapeAttribute(client.slug)}"><input type="hidden" name="id" value="${escapeAttribute(item.id)}"><button class="portal-logout-button" type="submit">Save as a template</button></form>`);
  cards.push(`<section class="admin-card">
          <h2>Manage</h2>
          <div class="admin-manage">${manage.join("\n            ")}</div>
          <div class="admin-danger"><a class="portal-logout-button" href="${base}/delete">Delete ${invoice ? "invoice" : "quote"}</a></div>
          ${activity(item, receipt)}
        </section>`);

  return adminShell(`<div class="site-width portal-shell">
      <p class="portal-kicker"><a class="portal-inline-link" href="/clients/admin?client=${encodeURIComponent(client.slug)}">${escapeHtml(client.name)}</a></p>
      <h1 class="portal-heading portal-heading-sm">${kindLabel(item)} ${escapeHtml(item.number)}</h1>
      ${noticeMarkup(notice)}
      <div class="billing-layout billing-layout-admin">
        ${billingDocument({ item, client })}
        <div class="admin-cards">
          ${cards.join("\n        ")}
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

export function adminBooksPage({ report, check, log = null, clients, today, notice = null, overheadExpenses = [], payers = [], paidTo = [] }) {
  const names = new Map(clients.map((client) => [client.slug, client.name]));
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
  const jobOptions = clients.map((client) => ({ slug: client.slug, name: client.name }));

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
            ${clients.map((client) => `<option value="${escapeAttribute(client.slug)}"${client.slug === report.slug ? " selected" : ""}>${escapeHtml(client.name)}</option>`).join("")}
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
        <h1 class="portal-heading portal-heading-sm">${escapeHtml(client.name)}</h1>
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
    </div>`, { title: `${client.name} · Job book` });
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

export function adminTemplatesPage({ templates, notice = null }) {
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
    : '<p class="portal-empty">No templates yet. Create one here, or tick "Also save this as a template" when posting a quote or invoice.</p>';

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
    </div>`, { title: "Templates" });
}
