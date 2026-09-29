import { billingLabel, billingLineItems, isEditable, issuedDate, moneyInput, PAYMENT_METHODS, quantityText, todayInMichigan } from "./billing.js";
import { addressesText, clientEmails, MAX_RECIPIENTS } from "./email.js";
import { escapeHtml, formatDate, money } from "./format.js";
import { DOCUMENT_SECTIONS, awaitingSignature, groupBySection, sectionName, sectionOf } from "./documents.js";

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

export function pageShell(content, { authenticated = false, admin = false, bodyClass = "portal-page", scripts = [], title = "Client Portal", navCurrent = "login" } = {}) {
  const nav = [];
  if (authenticated || admin) {
    nav.push('<a href="/clients">Home</a>');
    if (admin) {
      nav.push('<a href="/clients/admin">Admin panel</a>');
      nav.push('<a href="/clients/admin/templates">Templates</a>');
      nav.push('<a href="/clients/admin/documents">Documents</a>');
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
    nav.push(`<a href="/clients"${navCurrent === "login" ? ' aria-current="page"' : ""}>Client login</a>`);
    nav.push('<form action="/clients/admin/request" method="post"><button class="portal-logout-button" type="submit">Admin</button></form>');
  }
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
      <span>${admin ? "Administrator access" : "Private project access"}</span>
      <a href="/">Return to website</a>
    </div>
  </div>
  <header class="site-header">
    <div class="site-width header-inner">
      <a class="brand brand-header" href="/" aria-label="My Home Builder LLC home">
        <img class="brand-mark" src="/assets/mb-logo.svg" alt="" width="1250" height="665">
        <span class="brand-copy">
          <strong>MY HOME BUILDER</strong>
          <small>${admin ? "Admin panel" : "Client portal"}</small>
        </span>
      </a>
      <nav class="portal-nav" aria-label="Client portal navigation">
        ${nav.join("\n        ")}
      </nav>
    </div>
  </header>
  <main class="portal-main" id="main">
    ${content}
  </main>
  <footer class="site-footer">
    <div class="site-width portal-footer-inner">
      <p>© ${new Date().getUTCFullYear()} My Home Builder LLC</p>
      <a href="/#contact">Contact My Home Builder</a>
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
  return item.kind === "invoice" ? ["open", "Due"] : ["open", "Awaiting review"];
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
  return `${item.status === "paid" ? "Its payment record is deleted with it. " : ""}Its link stops working, and later invoices move up a number. This can't be undone.`;
}

function billingRows(items, { basePath, viewer }) {
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
            <a class="portal-secondary-link" href="${href}">Open</a>
            <a class="billing-trash" href="${href}/delete" data-delete-menu data-label="${escapeAttribute(name)}" data-kind="${item.kind}" data-note="${escapeAttribute(deleteNote(item))}"${item.status === "processing" ? " data-blocked" : ""} aria-label="Delete ${escapeAttribute(billingLabel(item))}" title="Delete">${TRASH_ICON}</a>
          </div>`
      : `<a class="portal-secondary-link" href="${href}">${item.kind === "invoice" && item.status === "open" ? "View and pay" : "View"}</a>`;
    const note = admin && item.invoiceNumber ? `<small>Invoiced as Invoice ${escapeHtml(item.invoiceNumber)}</small>` : "";
    const dueLine = item.dueDate && !(admin && item.kind === "invoice") ? `<small>${item.kind === "invoice" ? "Due" : "Valid until"} ${dateText(item.dueDate)}</small>` : "";
    const badge = `<span class="portal-status portal-status-${tone}">${label}</span>`;
    const detail = admin ? statusDetail(item) : "";
    const status = admin && item.kind === "invoice" && ["open", "paid"].includes(item.status)
      ? `<a class="status-change" href="${href}" data-status-menu data-label="${escapeAttribute(name)}" data-state="${item.status === "paid" ? "paid" : "due"}" data-source="${escapeAttribute(item.payment?.source || "")}" data-method="${escapeAttribute(item.payment?.label || "")}" data-detail="${escapeAttribute(detail)}" aria-label="${label}: change the status of ${escapeAttribute(billingLabel(item))}" title="Change status">${badge}</a>`
      : badge;
    return `<tr>
          <td><span class="portal-number">${escapeHtml(item.number)}</span></td>
          <td>${escapeHtml(item.title)}${dueLine}${note}</td>
          <td>${money(item.amountCents, item.currency)}</td>
          <td>${status}${detail ? `<small class="status-detail">${escapeHtml(detail)}</small>` : ""}</td>
          <td>${action}</td>
        </tr>`;
  });
  return `<table class="portal-table">
        <thead><tr><th scope="col">Number</th><th scope="col">Item</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Action</span></th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>${viewer === "admin" ? billingTotals(items) : ""}`;
}

// Invoiced, paid and outstanding across a project's invoices; voided invoices and quotes are left
// out. Outstanding is each invoice's balance due, as its page shows it: all of an unpaid invoice,
// and whatever a payment fell short of a paid one's total.
function billingTotals(items) {
  const invoices = items.filter((item) => item.kind === "invoice" && item.status !== "void");
  if (!invoices.length) return "";
  const paidOf = (item) => (item.status === "paid" ? item.payment?.amountCents ?? item.amountCents : 0);
  const invoiced = invoices.reduce((sum, item) => sum + item.amountCents, 0);
  const paid = invoices.reduce((sum, item) => sum + paidOf(item), 0);
  const outstanding = invoices.reduce((sum, item) => sum + Math.max(item.amountCents - paidOf(item), 0), 0);
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

export function portalHomePage({ client, billing, documents, storeReady, admin = false, notice = null }) {
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
        <p class="portal-lead">Review project resources, pay invoices securely, and upload or sign documents in one place.</p>
        ${noticeMarkup(notice)}
        ${setupNote}
      </section>
      ${projectSection}
      <section class="portal-section" aria-labelledby="billing-heading">
        <h2 id="billing-heading">Quotes and invoices</h2>
        ${billingRows(billing, { basePath: "/clients/billing", viewer: "client" })}
      </section>
      <section class="portal-section" aria-labelledby="documents-heading">
        <h2 id="documents-heading">Documents</h2>
        ${documentSections(documents, { basePath: "/clients/documents", viewer: "client" })}
        ${storeReady ? `<form class="portal-form portal-upload" action="/clients/documents/upload" method="post" enctype="multipart/form-data">
          <h3>Upload a document</h3>
          <p>Share plans, photos, permits or signed paperwork with My Home Builder. PDF, images and common office files up to 20 MB.</p>
          <label for="client-upload">Choose a file
            <input id="client-upload" name="file" type="file" required>
          </label>
          <button class="button button-solid" type="submit">Upload</button>
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
  if (invoice && item.status === "paid") {
    const paidCents = item.payment?.amountCents ?? item.amountCents;
    totals.push(`<tr><th scope="row" colspan="3">Total</th><td>${money(item.amountCents, item.currency)}</td></tr>`);
    totals.push(`<tr><th scope="row" colspan="3">Paid ${escapeHtml(paymentSummary(item))}</th><td>${money(-paidCents, item.currency)}</td></tr>`);
    for (const refund of liveRefunds(item)) {
      totals.push(`<tr><th scope="row" colspan="3">Refunded ${escapeHtml(formatDate(refund.refundedAt))}</th><td>${money(refund.amountCents, item.currency)}</td></tr>`);
    }
    totals.push(`<tr class="billing-total"><th scope="row" colspan="3">Balance due</th><td>${money(Math.max(item.amountCents - paidCents, 0), item.currency)}</td></tr>`);
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
  if (item.kind === "invoice" && item.status === "open") {
    action = stripeReady
      ? `<form action="/clients/billing/${encodeURIComponent(item.id)}/pay" method="post">
          <button class="button button-solid" type="submit">Pay ${money(item.amountCents, item.currency)} securely</button>
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
    action = stripeReady
      ? `<a class="button button-solid" href="/clients/pay/${encodeURIComponent(token)}">Pay ${money(item.amountCents, item.currency)} securely</a>
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

export function signPage({ document, party, actionPath, backPath, error = "", admin = false, authenticated = true }) {
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
        <button class="button button-solid" type="submit">Apply signature</button>
      </form>
    </div>`, { authenticated, admin, scripts: ["/clients/portal/sign.js"], title: `Sign ${document.name}` });
}

// Admin sign-in. "sent" follows a code request; "code" is the page any device can open to enter a
// code it already has (/clients/admin/code). A code is not tied to the page that asked for it.
export function adminRequestPage({ state, error = "", authenticated = false }) {
  let body;
  if (state === "sent" || state === "code") {
    const intro = state === "sent"
      ? `<p>A 6-digit code was sent to <strong>mb@myhomebuilderllc.com</strong>. It expires in 10 minutes and works on any device.</p>`
      : `<p>Enter the 6-digit code emailed to <strong>mb@myhomebuilderllc.com</strong>. It works on any device for 10 minutes after it was sent.</p>`;
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

function templatePicker(templates, action) {
  if (!templates.length) return "";
  const options = templates.map((template) => `<option value="${escapeAttribute(template.id)}">${escapeHtml(template.name)} (${template.kind === "invoice" ? "invoice" : "quote"})</option>`).join("");
  return `<form class="admin-template-picker" action="${escapeAttribute(action)}" method="get">
            <label for="template-pick">Start from a template
              <select id="template-pick" name="template" required>${options}</select>
            </label>
            <button class="portal-logout-button" type="submit">Use template</button>
          </form>`;
}

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

export function adminDashboardPage({ clients, selected, billing, documents, templates = [], recipients = [], readiness, notice = null, authenticated = true, newClient = null, clientError = "", typedEmails = null }) {
  const clientLinks = clients.map((client) => {
    const current = selected && client.slug === selected.slug;
    const emails = clientEmails(client);
    const detail = [client.managedBySecret ? "Login set in Render (MHB_CLIENT_PORTAL_PASSWORD)" : `Portal id: ${escapeHtml(client.slug)}`, emails.length ? escapeHtml(emails.join(", ")) : "No email on file"].join(" · ");
    return `<li><a class="admin-client-link${current ? " is-current" : ""}" href="/clients/admin?client=${encodeURIComponent(client.slug)}"${current ? ' aria-current="page"' : ""}>
        <strong>${escapeHtml(client.name)}</strong><small>${detail}</small></a></li>`;
  }).join("");

  const selectedSection = selected
    ? (() => {
      const base = `/clients/admin/clients/${encodeURIComponent(selected.slug)}`;
      return `<section class="admin-panel" aria-labelledby="selected-heading">
        <div class="admin-panel-head">
          <p class="portal-kicker">Client portal</p>
          <h2 id="selected-heading">${escapeHtml(selected.name)}</h2>
          <form class="admin-inline-form" action="${base}/profile" method="post">
            ${emailsField({
              id: "client-emails",
              name: "emails",
              label: "Client emails for quotes, invoices and receipts",
              addresses: clientEmails(selected),
              typed: typedEmails,
              hint: "Every quote, invoice and receipt for this project is addressed to all of them. Addresses you email from this project are added here."
            })}
            <button class="portal-logout-button" type="submit">Save emails</button>
          </form>
        </div>

        <div class="admin-section-head">
          <h3>Quotes and invoices</h3>
          <div class="admin-actions-bar">
            <a class="button button-solid" href="${base}/billing/new?kind=invoice">New invoice</a>
            <a class="button button-outline" href="${base}/billing/new?kind=quote">New quote</a>
          </div>
          ${templatePicker(templates, `${base}/billing/new`)}
        </div>
        ${billingRows(billing, { basePath: `${base}/billing`, viewer: "admin" })}

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
        ${statusDialogs(selected, readiness)}
      </section>`;
    })()
    : `<section class="admin-panel"><p class="portal-empty">Choose a client portal to manage its quotes, invoices and documents.</p></section>`;

  return pageShell(`<div class="site-width portal-shell">
      <section class="admin-intro">
        <p class="portal-kicker">Admin panel</p>
        <h1 class="portal-heading">Manage client portals.</h1>
        <div class="admin-chips">
          ${statusChip(readiness.store, "Portal storage")}
          ${statusChip(readiness.files, "File storage")}
          ${statusChip(readiness.stripe, "Stripe")}
          ${statusChip(readiness.webhook, "Stripe webhook")}
          ${statusChip(readiness.email, "Email")}
        </div>
        ${noticeMarkup(notice)}
      </section>

      <div class="admin-layout">
        <aside class="admin-sidebar">
          <h2>Client portals</h2>
          <ul class="admin-client-list">${clientLinks}</ul>
          <form class="portal-form admin-form" id="add-client" action="/clients/admin/clients" method="post">
            <h3>Add a client portal</h3>
            ${clientError ? `<p class="portal-error" role="alert">${escapeHtml(clientError)}</p>` : ""}
            <label for="client-name">Client or project name
              <input id="client-name" name="name" type="text" maxlength="120" required value="${escapeAttribute(newClient?.name || "")}" placeholder="Wolf Lake Views" data-slug-source>
            </label>
            <label for="client-slug">Portal id
              <input id="client-slug" name="slug" type="text" maxlength="64" value="${escapeAttribute(newClient?.slug || "")}" placeholder="wolf-lake-views" data-slug-target>
              <small class="admin-field-hint">Filled in from the name. Letters, numbers and hyphens; spaces become hyphens.</small>
            </label>
            <label for="client-password">Project login
              <input id="client-password" name="password" type="text" minlength="10" maxlength="120" autocomplete="off" required>
              <small class="admin-field-hint">At least 10 characters, and different from every other portal's login.</small>
            </label>
            ${emailsField({ id: "new-client-emails", name: "emails", label: "Client emails (optional)", typed: newClient?.emails ?? null })}
            <button class="button button-solid" type="submit">Create portal</button>
            <p class="portal-security-note">The login is hashed before it is stored. Share it with the client directly.</p>
          </form>
          <p class="admin-sidebar-link"><a class="portal-secondary-link" href="/clients/admin/templates">Quote and invoice templates</a></p>
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
    cards.push(`<section class="admin-card">
          <h2>Record a payment</h2>
          <p class="admin-meta">For checks, Zelle, cash and other payments received outside Stripe.</p>
          <form class="admin-stack-form" action="${base}/record-payment" method="post">
            ${paymentFields("payment", { date: links.today })}
            ${readiness.email && projectEmails.length ? `<label class="portal-check" for="payment-receipt">
              <input id="payment-receipt" name="sendReceipt" type="checkbox" value="yes" checked>
              <span>Email a receipt to ${escapeHtml(addressesText(projectEmails))}</span>
            </label>` : ""}
            <button class="button button-solid" type="submit">Mark as paid</button>
          </form>
        </section>`);
  }

  if (invoice && item.status === "paid") {
    const payment = item.payment || {};
    const summary = [payment.label || "Payment", formatDate(item.paidAt), money(payment.amountCents ?? item.amountCents, item.currency)].filter(Boolean).join(" · ");
    cards.push(payment.source === "manual"
      ? `<section class="admin-card">
          <h2>Payment</h2>
          <p class="admin-meta">Recorded as ${escapeHtml(summary)}.</p>
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
  if (item.status === "open") manage.push(`<form action="${base}/void" method="post"><button class="portal-logout-button" type="submit">Mark void</button></form>`);
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

const WHO = { admin: "Admin", client: "Client", stripe: "Stripe", system: "Portal", visitor: "Visitor" };
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
export function adminBooksPage({ report, check, clients, today, notice = null }) {
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

  const balance = check.balanced
    ? `<section class="books-check books-check-ok" aria-labelledby="books-check-heading">
          <h2 id="books-check-heading">The books balance.</h2>
          <p>Debits and credits are equal (${money(check.debits)} each), and every invoice matches its entries.</p>
        </section>`
    : `<section class="books-check books-check-off" aria-labelledby="books-check-heading">
          <h2 id="books-check-heading">The books do not balance.</h2>
          ${check.debits !== check.credits ? `<p>Debits are ${money(check.debits)} and credits are ${money(check.credits)}.</p>` : ""}
          ${check.problems.length ? `<ul>${check.problems.map((problem) => `<li>${escapeHtml(problem.label)}${problem.clientSlug && names.has(problem.clientSlug) ? ` (${escapeHtml(names.get(problem.clientSlug))})` : ""}: its ${problem.parts.map((part) => ({ issue: "invoiced amount", payment: "payment", fee: "Stripe fee", refund: "refund", dispute: "dispute", "dispute-close": "dispute outcome" })[part] || part).join(" and ")} ${problem.parts.length > 1 ? "do" : "does"} not match the journal.</li>`).join("")}</ul>` : ""}
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
    ...(summary.disputed ? [["Held in disputes", summary.disputed, "until Stripe decides"]] : [])
  ];

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
        <p class="portal-lead">Everything done in the portal, and the money it moved: invoiced, received and still owed, for ${escapeHtml(report.slug ? names.get(report.slug) || report.slug : "every client portal")}, ${escapeHtml(range)}.</p>
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
        <p class="admin-meta">Everything done by the admin, clients and Stripe, newest first.</p>
        ${activity}
      </section>
    </div>`, { title: "Books" });
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
  if (item.sentAt) notes.push(`It was emailed to ${item.sentTo}. The link in that email will stop working.`);
  if (partner) {
    notes.push(invoice
      ? `It was made from Quote ${partner.number}. The quote stays and can be invoiced again.`
      : `Invoice ${partner.number} was made from it. The invoice stays.`);
  }
  if (item.status === "open" && invoice) notes.push("To keep a record of it instead, go back and use Mark void.");
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
