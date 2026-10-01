// The My Home Builder client portal (myhomebuilderllc.com/clients) as a fetch-style handler:
// it takes a Web Request whose URL is on the public site and returns a Web Response. index.js
// adapts Express requests from the site's forwarding Function (and Stripe's webhook) to it.
import { db } from "../../config/db.js";
import {
  constantTimeMatches,
  createAdminSession,
  createClientSession,
  expiredAdminSession,
  expiredClientSession,
  hasAdminSession,
  hashPassword,
  isValidSlug,
  randomCode,
  randomId,
  readBoundedForm,
  readBoundedMultipart,
  readClientSession,
  responseHeaders,
  sha256Hex,
  slugify,
  verifyPassword
} from "./security.js";
import {
  DEFAULT_CLIENT_SLUG,
  allowAdminRequest,
  claimAdminAttempt,
  claimSentEmail,
  completeSentEmail,
  createStore,
  deleteSentEmails,
  deleteAdminChallenge,
  deleteBilling,
  deletePhoto,
  deleteTemplate,
  getBilling,
  getBillingById,
  getClient,
  getDocument,
  getFile,
  getPhoto,
  getSentEmail,
  getShareLink,
  getTemplate,
  listAllDocuments,
  listBilling,
  listClients,
  listDocuments,
  listPhotos,
  listRecipients,
  listTemplates,
  moveBilling,
  renumberInvoices,
  nextBillingNumber,
  putAdminChallenge,
  putBilling,
  putClient,
  putDocument,
  putFile,
  putPhoto,
  putSentEmail,
  putShareLink,
  putTemplate,
  releaseSentEmail,
  rememberRecipient
} from "./store.js";
import {
  createCheckoutSession,
  expireCheckoutSession,
  listRefunds,
  retrieveCharge,
  retrieveCheckoutSession,
  retrieveDispute,
  retrievePaymentDetails,
  retrievePaymentIntent,
  stripeConfigured,
  verifyWebhookSignature
} from "./stripe.js";
import {
  MAX_RECIPIENTS,
  adminCodeEmail,
  adminCodeMessage,
  adminEmail,
  adminPaidMessage,
  billingIssuedMessage,
  clientEmails,
  clientSender,
  deletedInvoicePaymentMessage,
  duplicatePaymentMessage,
  emailConfigured,
  mismatchedPaymentMessage,
  isValidEmail,
  maskedEmail,
  parseEmailList,
  paymentFailedMessage,
  partialPaymentReceiptMessage,
  paymentReceiptMessage,
  quoteAcceptedMessage,
  sendEmail
} from "./email.js";
import {
  MAX_TOTAL_CENTS,
  MIN_INVOICE_CENTS,
  addDays,
  isValidDate,
  balanceDue,
  installmentsTotal,
  parseMoney,
  billingLabel,
  billingLineItems,
  issuedDate,
  isEditable,
  isPayable,
  parseBillingForm,
  parseListedPayments,
  parseManualPayment,
  todayInMichigan
} from "./billing.js";
import { formatDate, money } from "./format.js";
import { isPdf, signDocument } from "./pdf.js";
import { activityCsv, booksReport, checkBooks, correctBooks, jobBook, ledgerCsv, record, verifyActivityLog } from "./books.js";
import { CLIENT_UPLOADS, parseSection, sectionName } from "./documents.js";
import { CREW_SECTIONS, listWorkers } from "./labor.js";
import { deleteSecure, getSecureJson, putSecureJson, secureReady } from "./secure.js";
import { handleAdminLabor, handleCrew } from "./crew.js";
import { handleAdminBank, listBankAccounts, unfileExpenseMatch } from "./bank.js";
import { handleAdminTeam } from "./team.js";
import { DESIGNER_PATH, handleDesigner, hasRenders } from "./designer.js";
import { categoryName, deleteExpense, getExpense, listAllExpenses, listExpenses, paidToSuggestions, paidWithOptions, putExpense, resolveCategory } from "./expenses.js";
import {
  adminBillingPage,
  adminBooksPage,
  adminDashboardPage,
  adminAddExpensePage,
  adminAddPaymentPage,
  adminDocumentsPage,
  adminJobBookPage,
  adminRequestPage,
  adminTemplatesPage,
  billingDeletePage,
  billingDetailPage,
  billingEditorPage,
  loginPage,
  messagePage,
  portalHomePage,
  serviceUnavailablePage,
  sharedBillingPage,
  signPage
} from "./pages.js";

const MAX_FORM_BYTES = 4096;
const MAX_BILLING_FORM_BYTES = 64 * 1024;
const MAX_SIGN_FORM_BYTES = 512 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
// The gallery: several photos at once (each up to MAX_UPLOAD_BYTES) sharing one note.
const MAX_PHOTOS_PER_UPLOAD = 20;
const MAX_PHOTO_BATCH_BYTES = 100 * 1024 * 1024;
const MAX_PHOTO_NOTE = 500;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const PROJECT_PATH = "/clients/muskegon-addition";
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,64}$/u;
const CHECKOUT_SESSION_PATTERN = /^cs_[A-Za-z0-9_]+$/u;
const ALLOWED_UPLOAD_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain"
]);

// The Muskegon project files are static files on the website. After checking the session, the
// portal answers with an empty grant naming the file; the site's Function serves that file with
// these headers. X-MHB-Asset is only honored for paths under /clients/muskegon-addition/.
function projectAssetGrant(assetPath) {
  const headers = new Headers({
    "X-MHB-Asset": assetPath,
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'; worker-src 'self' blob:; form-action 'self' https://formsubmit.co; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'; object-src 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Vary": "Cookie",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive"
  });
  return new Response(null, { status: 200, headers });
}

function htmlResponse(markup, status = 200, additionalHeaders = undefined, options = {}) {
  const headers = responseHeaders("text/html; charset=utf-8", options);
  if (additionalHeaders) {
    for (const [name, value] of Object.entries(additionalHeaders)) headers.set(name, value);
  }
  return new Response(markup, { status, headers });
}

// Pages that load /clients/portal/billing.js (line editor, copy and print buttons).
function scriptedHtmlResponse(markup, status = 200) {
  return htmlResponse(markup, status, undefined, { scripts: true });
}

function redirectResponse(location, cookie = undefined) {
  const headers = responseHeaders("text/plain; charset=utf-8");
  headers.set("Location", location);
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response("Redirecting", { status: 303, headers });
}

function fileResponse(object, name, contentType) {
  const headers = responseHeaders(contentType || object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${name.replaceAll('"', "").replaceAll(/[^\x20-\x7e]/gu, "_")}"`);
  if (object.size) headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

function methodNotAllowedResponse(allowedMethods) {
  return htmlResponse(messagePage({
    heading: "Request not allowed.",
    lead: '<a href="/clients">Return to the client portal.</a>'
  }), 405, { Allow: allowedMethods.join(", ") });
}

function notFoundResponse(session, admin) {
  return htmlResponse(messagePage({
    heading: "Page not found.",
    lead: '<a href="/clients">Return to the client portal.</a>',
    authenticated: Boolean(session),
    admin
  }), 404);
}

function safeProjectDestination(value) {
  if (typeof value !== "string" || value.length > 4096) return "";
  try {
    const destination = new URL(value, "https://portal.invalid");
    if (destination.origin !== "https://portal.invalid") return "";
    if (destination.username || destination.password || destination.hash) return "";
    // The Muskegon project's files, or the designer's page (a shared design link).
    const project = destination.pathname === PROJECT_PATH || destination.pathname.startsWith(`${PROJECT_PATH}/`);
    if (!project && destination.pathname !== "/clients/designer/") return "";
    return `${destination.pathname}${destination.search}`;
  } catch {
    return "";
  }
}

function loginLocation(destination) {
  const safeDestination = safeProjectDestination(destination);
  return safeDestination ? `/clients?next=${encodeURIComponent(safeDestination)}` : "/clients";
}

function requestedProjectDestination(url, pathname) {
  const trailingSlash = url.pathname.endsWith("/") || pathname === PROJECT_PATH ? "/" : "";
  return `${pathname}${trailingSlash}${url.search}`;
}

const NOTICES = {
  uploaded: { text: "Your document was uploaded and shared with My Home Builder." },
  "document-shared": { text: "Document shared. The client finds it in their portal under the section you chose." },
  signed: { text: "Your signature was applied. A signed copy is now on file." },
  paid: { text: "Payment received. Thank you." },
  "payment-pending": { text: "Your payment is still processing. This page will update once Stripe confirms it.", tone: "info" },
  accepted: { text: "Quote accepted. My Home Builder has been notified." },
  "upload-failed": { text: "That file could not be uploaded. Use a PDF, image or office document under 20 MB.", tone: "error" },
  "billing-added": { text: "Posted to the client portal." },
  "billing-sent": { text: "Posted to the client portal and emailed to the client." },
  "billing-send-failed": { text: "Posted to the client portal, but the email did not go out. Use Email on this page to try again.", tone: "error" },
  "billing-updated": { text: "Changes saved." },
  "client-added": { text: "Client portal created." },
  "client-added-private": { text: "Project created. It has no client login, so only you can see it." },
  "login-saved": { text: "Client login saved. The client signs in with it on the client portal." },
  "login-invalid": { text: "The client login needs 10 to 120 characters.", tone: "error" },
  "login-taken": { text: "That login already opens another client portal. Choose a different one.", tone: "error" },
  "client-exists": { text: "A client portal with that id already exists.", tone: "error" },
  "client-updated": { text: "Client emails saved." },
  "site-saved": { text: "Job site address saved. It goes on subcontractors' lien waivers for this job." },
  invalid: { text: "Please check the form and try again.", tone: "error" },
  voided: { text: "Marked void." },
  sent: { text: "Emailed to the client." },
  "send-failed": { text: "The email did not go out. Check the address and try again.", tone: "error" },
  "email-not-configured": { text: "Email delivery is not set up yet.", tone: "error" },
  "payment-recorded": { text: "Payment recorded." },
  "payment-recorded-receipt": { text: "Payment recorded and a receipt was emailed to the client." },
  "receipt-sent": { text: "Receipt emailed." },
  "receipt-failed": { text: "The receipt email did not go out. Try again.", tone: "error" },
  "invoice-created": { text: "Invoice created from the quote. Review it, then email it to the client." },
  "invoice-too-small": { text: "Invoices must be at least $0.50 so they can be paid online.", tone: "error" },
  "template-saved": { text: "Template saved." },
  "template-deleted": { text: "Template deleted." },
  "not-payable": { text: "This invoice is not open for payment.", tone: "info" },
  "online-payment-unavailable": { text: "Online payment is not available yet. Please contact My Home Builder to arrange payment.", tone: "error" },
  "checkout-failed": { text: "Stripe checkout could not be started. Please try again in a moment.", tone: "error" },
  "not-editable": { text: "Only open quotes and invoices, and paid invoices, can be edited.", tone: "error" },
  "payment-updated": { text: "Payment details saved. Use Resend receipt to email the corrected receipt." },
  "payment-removed": { text: "Marked unpaid. The invoice is open for payment again." },
  "payment-from-stripe": { text: "This payment came through Stripe, so its details stay as Stripe recorded them.", tone: "info" },
  "payment-other-required": { text: "Type the payment method when you choose Other.", tone: "error" },
  "payment-date-invalid": { text: "Enter the date the payment was received.", tone: "error" },
  "payment-partial": { text: "Payment added. The rest of the invoice is still due." },
  "expense-added": { text: "Expense added." },
  "access-saved": { text: "Saved." },
  "read-only": { text: "This project is read only." },
  "expense-deleted": { text: "Expense deleted and taken out of the books." },
  "expense-date-invalid": { text: "Enter the date of the expense (today or earlier).", tone: "error" },
  "expense-vendor-required": { text: "Enter the expense (up to 200 characters) and who it was paid to (up to 120).", tone: "error" },
  "expense-category-invalid": { text: "Keep the category under 60 characters.", tone: "error" },
  "expense-amount-invalid": { text: "Enter the expense amount, like 412.37.", tone: "error" },
  "expense-paid-invalid": { text: "Choose what the expense was paid with.", tone: "error" },
  "expense-receipt-invalid": { text: "Attach the receipt as a PDF or photo under 20 MB, or leave it off.", tone: "error" },
  "payment-partial-receipt": { text: "Payment added and a receipt was emailed to the client. The rest of the invoice is still due." },
  "payment-amount-invalid": { text: "Enter the amount received, like 500 or 500.00.", tone: "error" },
  "payment-over-balance": { text: "That is more than the invoice's balance due, so it was not added.", tone: "error" },
  "payment-invoice-required": { text: "Choose the invoice the payment goes toward.", tone: "error" },
  "partial-removed": { text: "Payment removed. The invoice's balance due went back up." },
  "void-has-payments": { text: "Payments have been added to this invoice, so it cannot be voided. Remove them first.", tone: "error" },
  moved: { text: "Sent to this project. It keeps its number and link, and this project's emails are used from now on." },
  "moved-pair": { text: "Sent to this project with its linked quote or invoice. Both keep their numbers and links." },
  "move-processing": { text: "A bank payment for this invoice is still processing, so it stays in this project until the payment finishes.", tone: "error" },
  "project-invalid": { text: "Choose one of the other client portals.", tone: "error" },
  "invoice-deleted": { text: "Invoice deleted. Its link no longer works." },
  "quote-deleted": { text: "Quote deleted. Its link no longer works." },
  renumbered: { text: "Invoice numbers were updated to keep them in date order." },
  "books-corrected": { text: "Corrections posted. The books balance again." },
  "books-balanced": { text: "The books already balance; nothing needed correcting." },
  "delete-processing": { text: "A bank payment for this invoice is still processing, so it can be deleted once the payment finishes.", tone: "error" },
  "name-required": { text: "Enter your name to accept the quote.", tone: "error" },
  "files-not-configured": { text: "File storage is not configured, so documents cannot be stored yet.", tone: "error" },
  "photos-added": { text: "Photos added." },
  "photos-invalid": { text: "Choose JPEG, PNG, WebP or GIF photos up to 20 MB each, with a note under 500 characters.", tone: "error" },
  "photo-deleted": { text: "Photo deleted." },
  "gallery-saved": { text: "Saved." },
  "group-saved": { text: "Saved." },
  "group-needs-login": { text: "Save a client login for this project first.", tone: "error" },
  "switch-invalid": { text: "That project is not under your login.", tone: "error" }
};

function noticeFromQuery(url) {
  const texts = [url.searchParams.get("notice"), ...url.searchParams.getAll("also")].map((code) => NOTICES[code]).filter(Boolean);
  if (!texts.length) return null;
  return { text: texts.map((notice) => notice.text).join(" "), tone: texts.some((notice) => notice.tone === "error") ? "error" : texts[0].tone };
}

function safeFileName(name) {
  const trimmed = String(name || "document").replaceAll(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").trim().slice(0, 140);
  return trimmed || "document";
}

function requestIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "";
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function decodeSignatureImage(value) {
  if (typeof value !== "string" || !value.startsWith("data:image/png;base64,")) return null;
  const base64 = value.slice("data:image/png;base64,".length);
  if (base64.length > 400000) return null;
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
    return bytes;
  } catch {
    return null;
  }
}

// The projects a typed login opens, by name: the Muskegon project's (its secret), or each project
// whose login hash it matches. Projects under one login share a hash, which is checked once.
async function loginOwners(env, store, suppliedPassword, { first = false } = {}) {
  if (typeof suppliedPassword !== "string" || !suppliedPassword) return [];
  const owners = [];
  if (await constantTimeMatches(suppliedPassword, env.CLIENT_PORTAL_PASSWORD)) {
    owners.push(DEFAULT_CLIENT_SLUG);
    if (first) return owners;
  }
  if (!store) return owners;
  const checked = new Map();
  for (const client of await listClients(store)) {
    if (!client.passwordHash || client.active === false || owners.includes(client.slug)) continue;
    if (!checked.has(client.passwordHash)) checked.set(client.passwordHash, await verifyPassword(suppliedPassword, client.passwordHash));
    if (!checked.get(client.passwordHash)) continue;
    owners.push(client.slug);
    if (first) return owners;
  }
  return owners;
}

// The project a login opens: with several under one login, the first by name.
async function resolveLogin(env, store, suppliedPassword) {
  return (await loginOwners(env, store, suppliedPassword, { first: true }))[0] || null;
}

// Projects under one login share `loginGroup`, the same login hash and the same sealed login.
function loginGroupOf(clients, client) {
  if (!client?.loginGroup) return client ? [client] : [];
  return clients.filter((entry) => entry.loginGroup === client.loginGroup);
}

// The projects a client can switch between: those under the same login (and still opened by it).
function switchableProjects(clients, client) {
  if (!client?.loginGroup || !client.passwordHash) return [];
  return clients.filter((entry) => entry.loginGroup === client.loginGroup && entry.passwordHash === client.passwordHash && entry.active !== false && !entry.managedBySecret);
}

// ---------- Quotes and invoices ----------

function shareLinks(origin, item) {
  const token = encodeURIComponent(item.shareToken || "");
  return item.kind === "invoice"
    ? { view: `${origin}/clients/invoice/${token}`, pay: `${origin}/clients/pay/${token}` }
    : { view: `${origin}/clients/quote/${token}`, pay: "" };
}

function adminBillingPath(slug, id) {
  return `/clients/admin/clients/${encodeURIComponent(slug)}/billing/${encodeURIComponent(id)}`;
}

// Gives quotes and invoices made before share links existed a link. The caller saves the item.
async function withShareToken(store, item) {
  if (item.shareToken) return item;
  const updated = { ...item, shareToken: randomId(24) };
  await putShareLink(store, updated.shareToken, updated);
  return updated;
}

async function buildBillingItem(store, client, values, extra = {}) {
  return {
    id: randomId(9),
    clientSlug: client.slug,
    kind: values.kind,
    number: await nextBillingNumber(store, values.kind),
    title: values.title,
    description: values.description,
    lineItems: values.lineItems,
    amountCents: values.amountCents,
    currency: "usd",
    dueDate: values.dueDate || "",
    issuedOn: values.issuedOn || todayInMichigan(),
    status: "open",
    shareToken: randomId(24),
    createdAt: new Date().toISOString(),
    ...extra
  };
}

// Saves a new quote or invoice. An invoice then takes its place in date order, which can move
// other invoices' numbers; the saved item comes back with its number, with `renumbered` set when
// other invoices moved.
// What an edit changed, in words, for the activity log.
function editSummary(before, after) {
  const changes = [];
  if (before.amountCents !== after.amountCents) changes.push(`total ${money(before.amountCents, before.currency)} → ${money(after.amountCents, after.currency)}`);
  if (issuedDate(before) !== issuedDate(after)) changes.push(`date ${formatDate(issuedDate(before))} → ${formatDate(issuedDate(after))}`);
  if (before.title !== after.title) changes.push(`title “${before.title}” → “${after.title}”`);
  if ((before.dueDate || "") !== (after.dueDate || "")) changes.push(`due date ${formatDate(before.dueDate) || "none"} → ${formatDate(after.dueDate) || "none"}`);
  if (before.amountCents === after.amountCents && JSON.stringify(before.lineItems || []) !== JSON.stringify(after.lineItems || [])) changes.push("line items");
  if ((before.description || "") !== (after.description || "")) changes.push("notes and terms");
  return `Edited ${billingLabel(after)}${changes.length ? `: ${changes.join("; ")}` : " (no changes)"}`;
}

async function saveNewBillingItem(store, item, event = {}) {
  await putShareLink(store, item.shareToken, item);
  await putBilling(store, item);
  let saved = item;
  let renumbered = false;
  if (item.kind === "invoice") {
    const moved = await renumberInvoices(store);
    saved = (await getBilling(store, item.clientSlug, item.id)) || item;
    renumbered = moved.some((id) => id !== item.id);
    if (renumbered) await noteRenumbered(store, moved.filter((id) => id !== item.id).length);
  }
  await record(store, {
    action: `${saved.kind}.created`, item: saved, amountCents: saved.amountCents,
    summary: `Created ${billingLabel(saved)} · ${saved.title} · ${money(saved.amountCents, saved.currency)}${event.from ? ` from ${event.from}` : ""}`,
    ...event.context
  });
  return { item: saved, renumbered };
}

// Re-sorts invoice numbers after an invoice is re-dated or deleted. True when any number moved.
async function keepInvoicesInDateOrder(store, kind) {
  if (kind !== "invoice") return false;
  const moved = await renumberInvoices(store);
  if (moved.length) await noteRenumbered(store, moved.length);
  return moved.length > 0;
}

async function noteRenumbered(store, count) {
  await record(store, { actor: "system", action: "invoices.renumbered", summary: `Invoice numbers re-sorted by date: ${count} invoice${count === 1 ? "" : "s"} moved` });
}

// Emails a quote or invoice to a list of addresses, as one email. Returns the item with
// sentAt/sentTo set for the caller to save.
async function emailBillingItem(env, store, item, client, to, origin) {
  const links = shareLinks(origin, item);
  const message = billingIssuedMessage({ item, client, viewUrl: links.view, payUrl: isPayable(item) && stripeConfigured(env) ? links.pay : "" });
  const delivery = await sendEmail(env, { to, ...message, ...clientSender(env), category: item.kind });
  if (!delivery.ok) return { ok: false, item };
  await rememberForProject(store, client, to);
  return { ok: true, item: { ...item, sentAt: new Date().toISOString(), sentTo: to.join(", ") } };
}

// Adds addresses to the admin pick list. A failure here never fails the email it follows.
async function remember(store, addresses) {
  try {
    for (const address of Array.isArray(addresses) ? addresses : [addresses]) await rememberRecipient(store, address);
  } catch (error) {
    console.error(JSON.stringify({ message: "recipient not remembered", error: error instanceof Error ? error.message : "Unknown error" }));
  }
}

// A project's saved list replaces the single `email` field projects had before lists.
function withClientEmails(client, emails) {
  const { email: _single, ...rest } = client;
  return { ...rest, emails };
}

// Addresses the admin emails from a project join the pick list and the project's own list, so
// the project's other quotes, invoices and receipts are addressed to them too. Addresses are
// removed on the client panel. A failure here never fails the email it follows.
async function rememberForProject(store, client, addresses) {
  await remember(store, addresses);
  try {
    const current = await getClient(store, client.slug);
    if (!current) return;
    const saved = clientEmails(current);
    const known = new Set(saved.map((address) => address.toLowerCase()));
    const added = addresses.filter((address) => !known.has(address.toLowerCase()));
    if (added.length) await putClient(store, withClientEmails(current, [...saved, ...added].slice(0, MAX_RECIPIENTS)));
  } catch (error) {
    console.error(JSON.stringify({ message: "project emails not saved", error: error instanceof Error ? error.message : "Unknown error" }));
  }
}

// What is wrong with the addresses typed into an email field, or "" when they can be used.
function recipientProblem({ addresses, invalid }) {
  if (invalid.length === 1) return `${invalid[0]} is not a complete email address. Check it and try again.`;
  if (invalid.length > 1) return `These are not complete email addresses: ${invalid.join(", ")}. Check them and try again.`;
  if (!addresses.length) return "Enter at least one email address.";
  if (addresses.length > MAX_RECIPIENTS) return `Enter up to ${MAX_RECIPIENTS} email addresses.`;
  return "";
}

class EmailDeliveryError extends Error {}

function sentKey(item, name) {
  return `${item.clientSlug}:${item.id}:${name}`;
}

// Sends an automatic email once per key. The claim is atomic in Postgres, so concurrent
// requests (a webhook and a retry of it, for example) cannot both send. A claim held by a
// send still in progress reports not-ok, so the webhook answers 500 and Stripe retries later.
// Client-facing messages (receipts) pass remember so the address joins the admin pick list.
async function sendOnce(env, store, key, message, { remember: rememberTo = false } = {}) {
  const claim = await claimSentEmail(store, key, Array.isArray(message.to) ? message.to.join(", ") : message.to);
  if (!claim.claimed) return claim.status === "sent" ? { ok: true, record: claim.record } : { ok: false };
  const delivery = await sendEmail(env, message);
  if (!delivery.ok) {
    await releaseSentEmail(store, key);
    return { ok: false };
  }
  const record = await completeSentEmail(store, key, delivery.id);
  if (rememberTo) await remember(store, message.to);
  return { ok: true, record };
}

function receiptMessage(env, item, client, to, origin) {
  return { to, ...paymentReceiptMessage({ item, client, viewUrl: shareLinks(origin, item).view }), ...clientSender(env), category: "receipt" };
}

// The project's email list, or else the address the payer gave Stripe.
function receiptRecipients(client, item) {
  const saved = clientEmails(client);
  if (saved.length) return saved;
  return isValidEmail(item.payment?.email) ? [item.payment.email] : [];
}

// With a webhook configured, only the webhook sends payment emails; the client's return from
// Checkout records the payment for the page it lands on. One sender per payment keeps each
// email to a single send.
function webhookConfigured(env) {
  return typeof env.STRIPE_WEBHOOK_SECRET === "string" && env.STRIPE_WEBHOOK_SECRET.length > 0;
}

// A Checkout pays an invoice only for the total it was opened with. Stripe's copy of the session
// says what it took.
function paymentMatches(invoice, session) {
  return (!Number.isInteger(session.amount_total) || session.amount_total === balanceDue(invoice))
    && (!session.currency || session.currency === (invoice.currency || "usd"));
}

// Records a paid Checkout Session and, when notify is set, emails the client's receipt and the
// builder's notice. A failed email throws EmailDeliveryError so the webhook answers 500 and
// Stripe retries; the retry skips anything already recorded or sent.
async function settleStripePayment(env, store, invoice, session, origin, { notify }) {
  const client = await getClient(store, invoice.clientSlug);
  const adminUrl = `${origin}${adminBillingPath(invoice.clientSlug, invoice.id)}`;

  // A second payment for an invoice that is already paid (another session, or a recorded check).
  if (invoice.status === "paid" && invoice.stripeSessionId !== session.id) {
    if (notify) {
      const message = duplicatePaymentMessage({ item: invoice, client, session, adminUrl });
      const alert = await sendOnce(env, store, sentKey(invoice, `duplicate:${session.id}`), { to: adminEmail(env), ...message, category: "builder-notice" });
      if (!alert.ok) throw new EmailDeliveryError("duplicate payment alert");
      const amountCents = Number.isInteger(session.amount_total) ? session.amount_total : invoice.amountCents;
      await record(store, {
        actor: "stripe", action: "stripe.duplicate", item: invoice, amountCents, data: { session: session.id },
        summary: `Stripe took a second payment of ${money(amountCents, invoice.currency)} for ${billingLabel(invoice)}, which was already paid`,
        unapplied: { externalId: session.id, amountCents, item: invoice, memo: `${billingLabel(invoice)} · second payment, already paid (refund or apply it)` }
      });
    }
    return invoice;
  }

  // An amount the invoice does not total (it changed after Checkout opened) is kept as unapplied
  // and the builder is told, once per Checkout; the invoice stays open.
  if (invoice.status !== "paid" && !paymentMatches(invoice, session)) {
    if (notify) {
      const amountCents = Number.isInteger(session.amount_total) ? session.amount_total : 0;
      const alert = await sendOnce(env, store, sentKey(invoice, `mismatch:${session.id}`), { to: adminEmail(env), ...mismatchedPaymentMessage({ item: invoice, client, session, adminUrl }), category: "builder-notice" });
      if (!alert.ok) throw new EmailDeliveryError("mismatched payment alert");
      await record(store, {
        actor: "stripe", action: "stripe.mismatch", item: invoice, amountCents, data: { session: session.id },
        summary: `Stripe took ${money(amountCents, session.currency || invoice.currency)} for ${billingLabel(invoice)}, whose balance due is ${money(balanceDue(invoice), invoice.currency)}; not applied`,
        unapplied: { externalId: session.id, amountCents, item: invoice, memo: `${billingLabel(invoice)} · payment did not match its total (refund or apply it)` }
      });
    }
    return invoice;
  }

  let paid = invoice;
  if (invoice.status !== "paid") {
    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    const details = await retrievePaymentDetails(env, paymentIntentId);
    paid = {
      ...invoice,
      status: "paid",
      paidAt: details?.chargedAt || new Date().toISOString(),
      stripeSessionId: session.id,
      payment: {
        source: "stripe",
        method: details?.method || "",
        label: details?.label || "",
        receiptUrl: details?.receiptUrl || "",
        ...(Number.isInteger(details?.feeCents) ? { feeCents: details.feeCents } : {}),
        email: session.customer_details?.email || session.customer_email || "",
        amountCents: Number.isInteger(session.amount_total) ? session.amount_total : balanceDue(invoice),
        paymentIntentId: paymentIntentId || "",
        chargeId: details?.chargeId || ""
      }
    };
    await putBilling(store, paid);
    await record(store, {
      actor: "stripe", action: "stripe.paid", item: paid, amountCents: paid.payment.amountCents, data: { session: session.id, paymentIntent: paid.payment.paymentIntentId },
      summary: `Stripe payment of ${money(paid.payment.amountCents, paid.currency)} for ${billingLabel(paid)}${paid.payment.label ? ` (${paid.payment.label})` : ""}${Number.isInteger(paid.payment.feeCents) ? `, Stripe fee ${money(paid.payment.feeCents, paid.currency)}` : ""}`
    });
  }
  if (!notify) return paid;

  const receiptTo = receiptRecipients(client, paid);
  let receipt = null;
  if (receiptTo.length) {
    receipt = await sendOnce(env, store, sentKey(paid, "receipt"), receiptMessage(env, paid, client, receiptTo, origin), { remember: true });
    if (!receipt.ok) throw new EmailDeliveryError("payment receipt");
  }
  const message = adminPaidMessage({ item: paid, client, adminUrl, receiptTo: receipt?.record.to || "" });
  const notice = await sendOnce(env, store, sentKey(paid, "paid-notice"), { to: adminEmail(env), ...message, category: "builder-notice" });
  if (!notice.ok) throw new EmailDeliveryError("payment notice");
  return paid;
}

// ACH and other bank payments complete Checkout before the money arrives.
async function markProcessing(store, invoice, session) {
  if (invoice.status !== "open" || !paymentMatches(invoice, session)) return invoice;
  const updated = { ...invoice, status: "processing", processingAt: new Date().toISOString(), stripeSessionId: session.id };
  await putBilling(store, updated);
  await record(store, { actor: "stripe", action: "stripe.processing", item: updated, amountCents: Number.isInteger(session.amount_total) ? session.amount_total : invoice.amountCents, summary: `Bank payment started for ${billingLabel(invoice)}`, data: { session: session.id } });
  return updated;
}

// The notice goes out before the invoice reopens, so a Stripe retry after a failed email still
// finds the invoice processing and sends it.
async function recordPaymentFailure(env, store, invoice, session, origin) {
  if (invoice.status !== "processing") return invoice;
  const updated = { ...invoice, status: "open", paymentFailedAt: new Date().toISOString() };
  const client = await getClient(store, invoice.clientSlug);
  const message = paymentFailedMessage({ item: updated, client, adminUrl: `${origin}${adminBillingPath(invoice.clientSlug, invoice.id)}` });
  const notice = await sendOnce(env, store, sentKey(invoice, `failed:${session.id}`), { to: adminEmail(env), ...message, category: "builder-notice" });
  if (!notice.ok) throw new EmailDeliveryError("payment failure notice");
  await putBilling(store, updated);
  await record(store, { actor: "stripe", action: "stripe.failed", item: updated, summary: `Bank payment failed for ${billingLabel(invoice)}; the invoice is open again`, data: { session: session.id } });
  return updated;
}

// Reuses the invoice's open Checkout Session so two tabs or two clicks cannot start two payments.
async function checkoutUrl(env, store, invoice, client, { successUrl, cancelUrl }) {
  const now = Math.floor(Date.now() / 1000);
  // An open Checkout is reused only while it still shows this total and number (numbers follow
  // invoice dates, so they can change).
  if (invoice.checkoutSessionId && invoice.checkoutSuccessUrl === successUrl && invoice.checkoutAmountCents === balanceDue(invoice) && invoice.checkoutNumber === invoice.number && (invoice.checkoutExpiresAt || 0) > now + 300) {
    const existing = await retrieveCheckoutSession(env, invoice.checkoutSessionId).catch(() => null);
    if (existing?.status === "open" && existing.url) return existing.url;
  }
  const session = await createCheckoutSession(env, { invoice, client, successUrl, cancelUrl });
  await record(store, { actor: "client", action: "stripe.checkout", item: invoice, amountCents: balanceDue(invoice), summary: `Opened Stripe Checkout for ${billingLabel(invoice)} (${money(balanceDue(invoice), invoice.currency)})`, data: { session: session.id } });
  await putBilling(store, {
    ...invoice,
    checkoutSessionId: session.id,
    checkoutExpiresAt: session.expires_at || now + 23 * 60 * 60,
    checkoutSuccessUrl: successUrl,
    checkoutAmountCents: balanceDue(invoice),
    checkoutNumber: invoice.number
  });
  return session.url;
}

// Confirms a Checkout Session when the client comes back from Stripe. Errors are not shown to
// the client once Stripe says the payment went through; the webhook records the same payment.
async function confirmReturn(env, store, invoice, sessionId, origin) {
  if (invoice.status === "paid") return "paid";
  if (!stripeConfigured(env) || !CHECKOUT_SESSION_PATTERN.test(sessionId)) return "payment-pending";
  const checkout = await retrieveCheckoutSession(env, sessionId);
  // Matched by invoice id alone: an invoice sent to another project keeps its id, while a
  // Checkout started before the move still names the old project.
  const belongs = checkout?.metadata?.invoiceId === invoice.id;
  if (!belongs) return "payment-pending";
  try {
    if (checkout.payment_status === "paid") {
      const settled = await settleStripePayment(env, store, invoice, checkout, origin, { notify: !webhookConfigured(env) });
      return settled.status === "paid" ? "paid" : "payment-pending";
    }
    if (checkout.status === "complete") await markProcessing(store, invoice, checkout);
  } catch (error) {
    console.error(JSON.stringify({ message: "checkout return could not be recorded", invoice: invoice.id, error: error instanceof Error ? error.message : "Unknown error" }));
    if (checkout.payment_status === "paid") return "paid";
  }
  return "payment-pending";
}

// The acceptance is saved even if the builder's notice cannot be sent; the admin panel shows it.
async function acceptQuote(env, store, quote, client, acceptedBy, via, origin) {
  if (quote.kind !== "quote" || quote.status !== "open" || quote.invoiceId) return quote;
  const updated = { ...quote, status: "accepted", acceptedAt: new Date().toISOString(), acceptedBy: acceptedBy || "", acceptedVia: via };
  await putBilling(store, updated);
  await record(store, { actor: via === "admin" ? "admin" : "client", action: "quote.accepted", item: updated, amountCents: updated.amountCents, summary: `${billingLabel(updated)} accepted${updated.acceptedBy ? ` by ${updated.acceptedBy}` : ""}` });
  const message = quoteAcceptedMessage({ item: updated, client, adminUrl: `${origin}${adminBillingPath(quote.clientSlug, quote.id)}` });
  const notice = await sendOnce(env, store, sentKey(quote, "accepted-notice"), { to: adminEmail(env), ...message, category: "builder-notice" });
  if (!notice.ok) console.error(JSON.stringify({ message: "quote accepted notice not sent", quote: quote.id }));
  return updated;
}

function acceptedName(form) {
  const name = String(form?.get("name") || "").trim().replaceAll(/\s+/gu, " ");
  return name.length <= 120 ? name : name.slice(0, 120);
}

async function handleShare(context, store, match, origin) {
  const [, route, tokenRaw, action] = match;
  const env = context.env;
  const method = context.request.method;
  const isRead = method === "GET" || method === "HEAD";
  const url = new URL(context.request.url);
  if (!store) return htmlResponse(serviceUnavailablePage(), 503);

  const token = decodeSegment(tokenRaw);
  const link = SHARE_TOKEN_PATTERN.test(token) ? await getShareLink(store, token) : null;
  const item = link && isValidSlug(link.clientSlug) ? await getBilling(store, link.clientSlug, link.id) : null;
  const client = item ? await getClient(store, item.clientSlug) : null;
  if (!item || !client || item.shareToken !== token) return notFoundResponse(null, false);

  const encoded = encodeURIComponent(token);
  const viewPath = item.kind === "invoice" ? `/clients/invoice/${encoded}` : `/clients/quote/${encoded}`;
  const stripeReady = stripeConfigured(env);
  const render = (notice, status = 200) => scriptedHtmlResponse(sharedBillingPage({ client, item, stripeReady, token, notice }), status);

  if (item.kind === "invoice" && route === "quote") return redirectResponse(viewPath);
  if (item.kind === "quote" && route !== "quote") return redirectResponse(viewPath);

  if (!action && route !== "pay") {
    if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
    return render(noticeFromQuery(url));
  }

  if (route === "pay" && !action) {
    if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
    if (method === "HEAD") return redirectResponse(viewPath);
    if (item.status === "paid") return redirectResponse(`${viewPath}?notice=paid`);
    if (!isPayable(item)) return redirectResponse(`${viewPath}?notice=not-payable`);
    if (!stripeReady) return redirectResponse(`${viewPath}?notice=online-payment-unavailable`);
    try {
      const destination = await checkoutUrl(env, store, item, client, {
        successUrl: `${origin}/clients/pay/${encoded}/return?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}${viewPath}`
      });
      return redirectResponse(destination);
    } catch (error) {
      console.error(JSON.stringify({ message: "stripe checkout could not start", invoice: item.id, error: error instanceof Error ? error.message : "Unknown error" }));
      return redirectResponse(`${viewPath}?notice=checkout-failed`);
    }
  }

  if (route === "pay" && action === "return") {
    if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
    const result = await confirmReturn(env, store, item, url.searchParams.get("session_id") || "", origin);
    return redirectResponse(`${viewPath}?notice=${result}`);
  }

  if (route === "quote" && action === "accept") {
    if (method !== "POST") return methodNotAllowedResponse(["POST"]);
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const name = acceptedName(form);
    if (!name) return render(NOTICES["name-required"], 400);
    await acceptQuote(env, store, item, client, name, "link", origin);
    return redirectResponse(`${viewPath}?notice=accepted`);
  }

  return notFoundResponse(null, false);
}

// A dispute as the books need it: what Stripe withdrew, its fee, any fee returned, and when it
// opened and closed. `at` is the event's time, for when Stripe gives none.
function disputeFields(dispute, before, at) {
  const moves = Array.isArray(dispute.balance_transactions) ? dispute.balance_transactions : [];
  const sum = (pick) => moves.reduce((total, move) => total + Math.max(Number(pick(move)) || 0, 0), 0);
  const iso = (seconds) => (Number.isInteger(seconds) ? new Date(seconds * 1000).toISOString() : null);
  const reinstated = moves.filter((move) => Number(move.amount) > 0 && Number.isInteger(move.created)).map((move) => move.created).sort((left, right) => left - right).pop();
  const closed = ["won", "lost", "warning_closed"].includes(dispute.status);
  return {
    id: String(dispute.id || ""),
    status: String(dispute.status || ""),
    amountCents: sum((move) => -move.amount),
    feeCents: sum((move) => move.fee),
    feeReturnedCents: sum((move) => -move.fee),
    openedAt: before?.openedAt || iso(dispute.created) || at,
    closedAt: closed ? before?.closedAt || iso(reinstated) || at : null
  };
}

function disputeSummary(label, dispute, before, currency) {
  const amount = money(dispute.amountCents, currency);
  if (dispute.status === "won") return `Won the dispute on ${label}; Stripe returned ${amount}`;
  if (dispute.status === "lost") return `Lost the dispute on ${label} (${amount})`;
  if (before?.status && before.status !== dispute.status) return `The dispute on ${label} is now ${dispute.status.replaceAll("_", " ")}`;
  if (before?.status) return `Stripe updated the dispute on ${label}: holding ${amount}`;
  return `A dispute opened on ${label}${dispute.amountCents ? `; Stripe is holding ${amount}` : ""}${dispute.feeCents ? ` and charged a ${money(dispute.feeCents, currency)} fee` : ""}`;
}

// Refunds and disputes on a portal payment. Stripe's own copies of the charge, its refunds and the
// dispute are read, so a late or repeated event changes nothing. Each refund is kept on the
// invoice's payment with its day, and the dispute with what Stripe withdrew, its fee and how it
// ended; the books follow. A refund of money not applied to an invoice (a second payment, a
// deleted invoice's) comes out of Unapplied payments. Returns whether it was a portal payment.
async function settleChargeEvent(env, store, event, chargeId) {
  const charge = await retrieveCharge(env, chargeId);
  const intentId = typeof charge?.payment_intent === "string" ? charge.payment_intent : charge?.payment_intent?.id;
  if (!intentId) return false;
  const invoiceId = charge.metadata?.invoiceId || (await retrievePaymentIntent(env, intentId))?.metadata?.invoiceId;
  if (typeof invoiceId !== "string" || !invoiceId) return false;
  const disputeEvent = String(event.type).startsWith("charge.dispute.");
  const refunds = disputeEvent ? [] : await listRefunds(env, chargeId);
  const dispute = disputeEvent ? await retrieveDispute(env, event.data.object.id) : null;
  const at = Number.isInteger(event.created) ? new Date(event.created * 1000).toISOString() : new Date().toISOString();
  const invoice = await getBillingById(store, invoiceId);
  const label = invoice ? billingLabel(invoice) : charge.metadata?.invoiceNumber ? `Invoice ${charge.metadata.invoiceNumber}` : "an invoice";
  const currency = charge.currency || invoice?.currency || "usd";
  const live = (refund) => refund.amount > 0 && !["failed", "canceled"].includes(refund.status);

  if (!invoice || invoice.kind !== "invoice" || invoice.status !== "paid" || invoice.payment?.source !== "stripe" || invoice.payment.paymentIntentId !== intentId) {
    for (const refund of refunds.filter(live)) {
      await record(store, {
        actor: "stripe", action: "stripe.refunded", item: invoice || null, clientSlug: invoice?.clientSlug ?? charge.metadata?.clientSlug ?? null, amountCents: refund.amount, data: { refund: refund.id, charge: chargeId },
        summary: `Refunded ${money(refund.amount, currency)} of a payment for ${label} that was not applied to it`,
        unappliedRefund: {
          externalId: refund.id, amountCents: refund.amount, item: invoice || null, clientSlug: invoice?.clientSlug ?? null,
          date: todayInMichigan(Number.isInteger(refund.created) ? new Date(refund.created * 1000) : new Date()), memo: `${label} · refund of a payment not applied to it`
        }
      });
    }
    if (dispute && ["charge.dispute.created", "charge.dispute.closed"].includes(event.type)) {
      await record(store, { actor: "stripe", action: "stripe.dispute", item: invoice || null, clientSlug: invoice?.clientSlug ?? null, data: { dispute: dispute.id, status: dispute.status },
        summary: `The dispute on a payment for ${label} that was not applied to it is ${String(dispute.status || "").replaceAll("_", " ")}; see the Stripe dashboard` });
    }
    return true;
  }

  const payment = { ...invoice.payment };
  const events = [];
  if (!disputeEvent) {
    const known = new Map((payment.refunds || []).map((refund) => [refund.id, refund]));
    const listed = [];
    for (const refund of refunds) {
      if (typeof refund.id !== "string" || !Number.isInteger(refund.amount)) continue;
      const status = String(refund.status || "succeeded").slice(0, 25);
      const before = known.get(refund.id);
      known.delete(refund.id);
      listed.push({ id: refund.id, amountCents: refund.amount, status, refundedAt: before?.refundedAt || (Number.isInteger(refund.created) ? new Date(refund.created * 1000).toISOString() : at) });
      if (!before && live(refund)) events.push({ action: "stripe.refunded", amountCents: refund.amount, data: { refund: refund.id }, summary: `Refunded ${money(refund.amount, currency)} of ${label} through Stripe` });
      else if (before && before.status !== status && ["failed", "canceled"].includes(status)) events.push({ action: "stripe.refund-failed", amountCents: refund.amount, data: { refund: refund.id }, summary: `A refund of ${money(refund.amount, currency)} on ${label} ${status === "canceled" ? "was canceled" : "failed"}` });
    }
    payment.refunds = [...listed, ...known.values()];
    payment.refundedCents = Number.isInteger(charge.amount_refunded) ? charge.amount_refunded : payment.refunds.filter((refund) => refund.amountCents > 0 && !["failed", "canceled"].includes(refund.status)).reduce((sum, refund) => sum + refund.amountCents, 0);
  }
  if (dispute) {
    const fields = disputeFields(dispute, payment.dispute, at);
    if (JSON.stringify(fields) !== JSON.stringify(payment.dispute || null)) {
      events.push({ action: "stripe.dispute", amountCents: fields.amountCents, data: { dispute: fields.id, status: fields.status }, summary: disputeSummary(label, fields, payment.dispute, currency) });
    }
    payment.dispute = fields;
  }
  if (JSON.stringify(payment) === JSON.stringify(invoice.payment)) return true;
  const updated = { ...invoice, payment };
  await putBilling(store, updated);
  if (!events.length) events.push({ action: "stripe.updated", summary: `Stripe updated the payment for ${label}` });
  for (const entry of events) await record(store, { actor: "stripe", item: updated, ...entry });
  return true;
}

// Each Stripe event the portal handled is kept by id, for the record.
async function rememberStripeEvent(store, event) {
  if (typeof event.id !== "string" || !event.id) return;
  try {
    await store.db("mhb_stripe_events").insert({ id: event.id.slice(0, 255), type: String(event.type || "").slice(0, 80) }).onConflict("id").ignore();
  } catch (error) {
    console.error(JSON.stringify({ message: "stripe event not kept", error: error instanceof Error ? error.message : "Unknown error" }));
  }
}

async function handleWebhook(context, store, origin) {
  const secret = context.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !store) return new Response("Webhook not configured", { status: 503 });
  const declared = Number(context.request.headers.get("Content-Length") || "0");
  if (declared > MAX_WEBHOOK_BYTES) return new Response("Payload too large", { status: 413 });
  const payload = await context.request.text();
  if (payload.length > MAX_WEBHOOK_BYTES) return new Response("Payload too large", { status: 413 });
  const valid = await verifyWebhookSignature(payload, context.request.headers.get("Stripe-Signature"), secret);
  if (!valid) return new Response("Invalid signature", { status: 400 });

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }

  const received = () => new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  const unavailable = (error, what) => {
    console.error(JSON.stringify({ message: `stripe ${what} unavailable; Stripe will retry the event`, event: String(event.id || ""), error: error instanceof Error ? error.message : "Unknown error" }));
    return new Response("Stripe unavailable; retry later", { status: 500 });
  };
  const object = event.data?.object || {};
  const invoiceId = object.metadata?.invoiceId;
  const handled = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"];
  let relevant = false;
  if (handled.includes(event.type) && typeof invoiceId === "string" && invoiceId) {
    // Stripe's own copy of the session decides, not the event's: events can arrive late, twice or
    // out of order. Without a secret key (a webhook alone), the event's copy is all there is.
    let session = object;
    if (stripeConfigured(context.env)) {
      try {
        session = await retrieveCheckoutSession(context.env, object.id);
      } catch (error) {
        return unavailable(error, "session");
      }
      if (session?.metadata?.invoiceId !== invoiceId) return received();
    }
    relevant = true;
    // By id alone: the session's clientSlug is the project the invoice was in when Checkout
    // started, and the invoice may have been sent to another project since.
    const invoice = await getBillingById(store, invoiceId);
    // Paid for an invoice deleted from the portal: the money is in Stripe with nothing here to
    // record it on, so the builder is told, once per Checkout.
    if (!invoice && event.type !== "checkout.session.async_payment_failed" && session.payment_status === "paid") {
      const slug = session.metadata?.clientSlug;
      const client = isValidSlug(slug) ? await getClient(store, slug) : null;
      const adminUrl = client ? `${origin}/clients/admin?client=${encodeURIComponent(client.slug)}` : `${origin}/clients/admin`;
      const alert = await sendOnce(context.env, store, `deleted-invoice:${session.id}`, { to: adminEmail(context.env), ...deletedInvoicePaymentMessage({ session, client, adminUrl }), category: "builder-notice" });
      if (!alert.ok) return new Response("Email delivery failed; retry later", { status: 500 });
      const amountCents = Number.isInteger(session.amount_total) ? session.amount_total : 0;
      const label = session.metadata?.invoiceNumber ? `Invoice ${session.metadata.invoiceNumber}` : "an invoice";
      if (amountCents > 0) {
        await record(store, {
          actor: "stripe", action: "stripe.deleted-invoice", clientSlug: client?.slug || null, amountCents, data: { session: session.id, invoiceId },
          summary: `Stripe payment of ${money(amountCents, session.currency || "usd")} for deleted ${label}`,
          unapplied: { externalId: session.id, amountCents, clientSlug: client?.slug || null, memo: `${label} (deleted) · Stripe payment not tied to an invoice` }
        });
      }
    }
    if (invoice && invoice.kind === "invoice") {
      try {
        if (event.type === "checkout.session.async_payment_failed") {
          await recordPaymentFailure(context.env, store, invoice, session, origin);
        } else if (session.payment_status === "paid") {
          await settleStripePayment(context.env, store, invoice, session, origin, { notify: true });
        } else if (event.type === "checkout.session.completed" && session.status === "complete" && session.payment_status === "unpaid") {
          await markProcessing(store, invoice, session);
        }
      } catch (error) {
        if (!(error instanceof EmailDeliveryError)) throw error;
        console.error(JSON.stringify({ message: "payment email not sent; Stripe will retry the event", invoice: invoice.id, email: error.message }));
        return new Response("Email delivery failed; retry later", { status: 500 });
      }
    }
  }
  const refundEvent = event.type === "charge.refunded" || event.type === "charge.refund.updated";
  if ((refundEvent || String(event.type).startsWith("charge.dispute.")) && stripeConfigured(context.env)) {
    const chargeId = event.type === "charge.refunded" ? object.id : typeof object.charge === "string" ? object.charge : object.charge?.id;
    if (typeof chargeId === "string" && chargeId.startsWith("ch_")) {
      try {
        relevant = await settleChargeEvent(context.env, store, event, chargeId);
      } catch (error) {
        return unavailable(error, "charge");
      }
    }
  }
  if (relevant) await rememberStripeEvent(store, event);
  return received();
}

// ---------- Documents ----------

// `uploadedBy` is admin, client or crew. Documents shared with an employee or subcontractor live
// under the portal id crew:<worker id>, in the crew sections (labor.js), with `flags.crewName`.
async function storeUpload(store, slug, file, uploadedBy, flags) {
  if (!store.files) return { error: "files-not-configured" };
  const crew = slug.startsWith("crew:");
  if (!file || typeof file.arrayBuffer !== "function" || !file.size || file.size > MAX_UPLOAD_BYTES) return { error: "upload-failed" };
  const contentType = (file.type || "application/octet-stream").split(";")[0].trim().toLowerCase();
  const name = safeFileName(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const looksPdf = isPdf(bytes);
  const resolvedType = looksPdf ? "application/pdf" : contentType;
  if (!ALLOWED_UPLOAD_TYPES.has(resolvedType)) return { error: "upload-failed" };
  if ((flags.requiresClientSignature || flags.requiresAdminSignature) && !looksPdf) return { error: "upload-failed" };

  const id = randomId(12);
  const key = `clients/${slug}/documents/${id}/${name}`;
  await putFile(store, key, bytes, resolvedType);
  const document = {
    id,
    clientSlug: slug,
    name,
    contentType: resolvedType,
    size: bytes.byteLength,
    key,
    uploadedBy,
    createdAt: new Date().toISOString(),
    requiresClientSignature: Boolean(flags.requiresClientSignature),
    requiresAdminSignature: Boolean(flags.requiresAdminSignature),
    section: crew ? crewSection(flags.section) : uploadedBy === "admin" ? parseSection(flags.section) : CLIENT_UPLOADS,
    signatures: [],
    signedKey: null
  };
  await putDocument(store, document);
  const toSign = document.requiresClientSignature ? ", to sign" : "";
  const summary = crew
    ? (uploadedBy === "admin" ? `Shared ${name} with ${flags.crewName} in ${CREW_SECTIONS.find(([key]) => key === document.section)[1]}${toSign}` : `${flags.crewName} uploaded ${name}`)
    : (uploadedBy === "admin" ? `Shared ${name} with the client in ${sectionName(document.section, "admin")}${toSign}` : `The client uploaded ${name}`);
  await record(store, { actor: uploadedBy === "admin" ? "admin" : crew ? "crew" : "client", action: "document.uploaded", clientSlug: crew ? null : slug, summary, data: { documentId: id, ...(crew ? { workerId: slug.slice(5) } : {}) } });
  return { document };
}

function crewSection(value) {
  return CREW_SECTIONS.some(([key]) => key === value) ? value : "other";
}

async function applySignature(store, document, party, form, request) {
  const name = form.get("name")?.trim();
  if (!name || name.length > 120 || form.get("consent") !== "yes") return { error: "Enter your full name and confirm the electronic signature agreement." };
  if (document.contentType !== "application/pdf") return { error: "Only PDF documents can be signed in the portal." };
  if (document.signatures?.some((entry) => entry.party === party)) return { error: "This document has already been signed by you." };

  const original = await getFile(store, document.key);
  if (!original) return { error: "The original document could not be loaded." };
  const originalBytes = new Uint8Array(await original.arrayBuffer());

  const image = decodeSignatureImage(form.get("signature"));
  let imageKey = null;
  if (image) {
    imageKey = `clients/${document.clientSlug}/documents/${document.id}/signature-${party}.png`;
    await putFile(store, imageKey, image, "image/png");
  }

  const signature = { party, name, signedAt: new Date().toISOString(), ip: requestIp(request), imageKey };
  const signatures = [...(document.signatures || []), signature];
  const signedBytes = await signDocument(originalBytes, document.name, signatures, async (key) => {
    const object = await getFile(store, key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  });
  const signedKey = `clients/${document.clientSlug}/documents/${document.id}/signed/${document.name.replace(/\.pdf$/iu, "")}-signed.pdf`;
  await putFile(store, signedKey, signedBytes, "application/pdf");

  const updated = { ...document, signatures, signedKey, signedAt: signature.signedAt };
  await putDocument(store, updated);
  const crew = document.clientSlug.startsWith("crew:");
  await record(store, { actor: party === "admin" ? "admin" : crew ? "crew" : "client", ip: signature.ip, action: "document.signed", clientSlug: crew ? null : document.clientSlug, summary: `${name} signed ${document.name}${party === "admin" ? " for My Home Builder" : ""}`, data: { documentId: document.id, party } });
  return { document: updated };
}

async function documentDownload(store, document) {
  const key = document.signedKey || document.key;
  const object = await getFile(store, key);
  if (!object) return null;
  const name = document.signedKey ? `${document.name.replace(/\.pdf$/iu, "")}-signed.pdf` : document.name;
  return fileResponse(object, name, document.contentType);
}

// ---------- Photos (the gallery) ----------

// What an image really is, from its first bytes (the type a browser sends is not trusted):
// JPEG, PNG, GIF or WebP, or "" for anything else.
function imageType(bytes) {
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return "";
}

// Adds the photos chosen in a form (`photos`, several at once) to a project's gallery, sharing the
// form's `note`. Every file must be an image within the limits, or none is added. Photos start
// shown; the admin hides them one by one or all at once. `uploader`: uploadedBy (client, crew or
// admin), uploaderName, and for crew workerId.
async function storePhotos(store, project, form, { uploadedBy, uploaderName, workerId = null, ip = "" }) {
  if (!store.files) return { error: "files-not-configured" };
  const files = form.getAll("photos").filter((file) => file && typeof file.arrayBuffer === "function" && file.size > 0);
  const note = String(form.get("note") || "").replaceAll(/\r\n?/gu, "\n").trim();
  if (!files.length || files.length > MAX_PHOTOS_PER_UPLOAD || note.length > MAX_PHOTO_NOTE) return { error: "photos-invalid" };
  const ready = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) return { error: "photos-invalid" };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = imageType(bytes);
    if (!type) return { error: "photos-invalid" };
    ready.push({ name: safeFileName(file.name || "photo"), bytes, type });
  }
  const photos = [];
  for (const { name, bytes, type } of ready) {
    const id = randomId(12);
    const key = `photos/${project.slug}/${id}/${name}`;
    await putFile(store, key, bytes, type);
    const now = new Date().toISOString();
    const photo = {
      id, clientSlug: project.slug, file: { key, name, type, size: bytes.byteLength }, note, uploadedBy, uploaderName,
      ...(workerId ? { workerId } : {}), hidden: false, createdAt: now, updatedAt: now
    };
    await putPhoto(store, photo);
    photos.push(photo);
  }
  const who = uploadedBy === "admin" ? "Added" : uploadedBy === "client" ? "The client added" : `${uploaderName} added`;
  const shortNote = note.length > 120 ? `${note.slice(0, 117)}…` : note;
  await record(store, {
    actor: uploadedBy, ip, action: "photo.added", clientSlug: project.slug, data: { photoIds: photos.map((photo) => photo.id), ...(workerId ? { workerId } : {}) },
    summary: `${who} ${photos.length === 1 ? "a photo" : `${photos.length} photos`} to the gallery of ${project.name}${shortNote ? `: “${shortNote.replaceAll("\n", " ")}”` : ""}`
  });
  return { photos };
}

// A photo opens in the browser (inline) rather than downloading.
async function photoResponse(store, photo) {
  const object = photo?.file?.key ? await getFile(store, photo.file.key) : null;
  if (!object) return null;
  const response = fileResponse(object, photo.file.name, photo.file.type);
  response.headers.set("Content-Disposition", response.headers.get("Content-Disposition").replace(/^attachment/u, "inline"));
  return response;
}

function photoTitle(photo) {
  return photo.note ? `“${photo.note.length > 60 ? `${photo.note.slice(0, 57)}…` : photo.note}”`.replaceAll("\n", " ") : photo.file?.name || "a photo";
}

// ---------- Admin: quotes, invoices and templates ----------

function editorValuesFromItem(item) {
  return { kind: item.kind, title: item.title, description: item.description || "", dueDate: item.dueDate || "", lineItems: item.lineItems || [] };
}

function editorValuesFromTemplate(template, today) {
  return {
    kind: template.kind,
    title: template.title,
    description: template.description || "",
    dueDate: Number.isInteger(template.dueInDays) ? addDays(today, template.dueInDays) : "",
    lineItems: template.lineItems || []
  };
}

function templateRecord(values, existing = null) {
  const now = new Date().toISOString();
  return {
    id: existing?.id || randomId(9),
    name: values.templateName,
    kind: values.kind,
    title: values.title,
    description: values.description,
    lineItems: values.lineItems,
    amountCents: values.amountCents,
    dueInDays: values.dueInDays,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

// A new invoice with payments already received: the earliest are payments toward the balance, and
// when they reach the total the last one settles it.
function withListedPayments(item, payments) {
  if (!payments.length) return item;
  const recordedAt = new Date().toISOString();
  const sorted = [...payments].sort((left, right) => left.paidOn.localeCompare(right.paidOn));
  const toEntry = ({ paidOn, amountCents, ...details }) => ({ id: randomId(8), source: "manual", ...details, amountCents, paidOn, recordedAt });
  const total = sorted.reduce((sum, entry) => sum + entry.amountCents, 0);
  if (total < item.amountCents) return { ...item, installments: sorted.map(toEntry) };
  const last = sorted.pop();
  const { paidOn, amountCents, ...details } = last;
  return { ...item, installments: sorted.map(toEntry), status: "paid", paidAt: paidOn, payment: { source: "manual", ...details, amountCents, recordedAt } };
}

// Adds a job expense from the Add expense form (multipart, with an optional receipt) and returns
// the notice to show. `payers` are what it can be paid with (expenses.js paidWithOptions).
// Records an expense and returns the notice to show: a cost of `target`'s job, or overhead with no
// target (the Books page). The category is chosen or typed (expenses.js resolveCategory).
async function addExpense({ store, target, form, payers, ip }) {
  const spentOn = String(form.get("spentOn") || "").trim();
  const vendor = String(form.get("vendor") || "").trim().replaceAll(/\s+/gu, " ");
  const description = String(form.get("description") || "").trim().replaceAll(/\s+/gu, " ");
  const resolved = resolveCategory(form.get("category"), { overhead: !target });
  const amountCents = parseMoney(String(form.get("amount") || ""));
  const paidWith = payers.find((option) => option.key === String(form.get("paidWith") || ""));
  if (!isValidDate(spentOn) || spentOn > todayInMichigan()) return "expense-date-invalid";
  if ((!vendor && !description) || vendor.length > 120 || description.length > 200) return "expense-vendor-required";
  if (!resolved) return "expense-category-invalid";
  const category = resolved.code;
  if (!amountCents || amountCents > MAX_TOTAL_CENTS) return "expense-amount-invalid";
  if (!paidWith) return "expense-paid-invalid";
  const id = randomId(12);
  let receipt = null;
  const file = form.get("receipt");
  if (file && typeof file.arrayBuffer === "function" && file.size > 0) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = isPdf(bytes) ? "application/pdf" : String(file.type || "").split(";")[0].trim().toLowerCase();
    if (bytes.byteLength > MAX_UPLOAD_BYTES || !["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"].includes(type)) return "expense-receipt-invalid";
    const name = safeFileName(file.name);
    receipt = { key: `expenses/${target ? target.slug : "overhead"}/${id}/${name}`, name, type };
    await putFile(store, receipt.key, bytes, type);
  }
  const expense = {
    id, clientSlug: target ? target.slug : null, spentOn, vendor, description, category, categoryName: resolved.name, amountCents,
    paidWith: { key: paidWith.key, account: paidWith.account, label: paidWith.label },
    receipt, bankTransactionId: null, createdAt: new Date().toISOString()
  };
  await putExpense(store, expense);
  await record(store, {
    actor: "admin", ip, action: "expense.added", clientSlug: target ? target.slug : null, amountCents, expense, data: { expenseId: id },
    summary: `Added ${target ? `an expense for ${target.name}` : "an overhead expense"}: ${[description, vendor].filter(Boolean).join(" · ")} · ${resolved.name} · ${money(amountCents)}, paid with ${paidWith.label}`
  });
  return "expense-added";
}

// Records a payment received outside Stripe for an open invoice and returns the notice to show.
// Less than the balance is a payment toward it (item.installments; the invoice stays open for the
// rest); the balance, or no amount given, settles the invoice (item.payment). More is refused.
// With sendReceipt, the client is emailed a receipt for it.
async function addPayment({ env, store, target, item, form, readiness, origin, note }) {
  if (item.kind !== "invoice" || item.status !== "open") return "not-payable";
  const entered = parseManualPayment(form);
  if (entered.error) return entered.error;
  const balance = balanceDue(item);
  const typed = String(form.get("amount") || "").trim();
  const amountCents = typed ? parseMoney(typed) : balance;
  if (!amountCents || amountCents < 0) return "payment-amount-invalid";
  if (amountCents > balance) return "payment-over-balance";
  // The balance Checkout would charge is changing.
  if (item.checkoutSessionId) await expireCheckoutSession(env, item.checkoutSessionId);
  const { paidOn, ...details } = entered;
  const receiptTo = clientEmails(target);
  const wantsReceipt = form.get("sendReceipt") === "yes" && readiness.email && receiptTo.length;

  if (amountCents < balance) {
    const installment = { id: randomId(8), source: "manual", ...details, amountCents, paidOn, recordedAt: new Date().toISOString() };
    const updated = await withShareToken(store, { ...item, installments: [...(item.installments || []), installment] });
    await putBilling(store, updated);
    await note({ action: "payment.partial", item: updated, amountCents, summary: `Recorded a ${installment.label} payment of ${money(amountCents, updated.currency)} toward ${billingLabel(updated)}, received ${formatDate(paidOn)}; ${money(balanceDue(updated), updated.currency)} still due` });
    if (!wantsReceipt) return "payment-partial";
    const message = partialPaymentReceiptMessage({ item: updated, client: target, installment, viewUrl: shareLinks(origin, updated).view });
    const receipt = await sendOnce(env, store, sentKey(updated, `receipt:${installment.id}`), { to: receiptTo, ...message, ...clientSender(env), category: "receipt" }, { remember: true });
    if (!receipt.ok) return "payment-partial";
    await note({ action: "receipt.emailed", item: updated, summary: `Emailed the receipt for the ${money(amountCents, updated.currency)} payment toward ${billingLabel(updated)} to ${receiptTo.join(", ")}` });
    return "payment-partial-receipt";
  }

  const updated = await withShareToken(store, {
    ...item,
    status: "paid",
    paidAt: paidOn,
    payment: { source: "manual", ...details, amountCents: balance, recordedAt: new Date().toISOString() }
  });
  await putBilling(store, updated);
  await note({ action: "payment.recorded", item: updated, amountCents: balance, summary: `Recorded a ${updated.payment.label} payment of ${money(balance, updated.currency)} for ${billingLabel(updated)}, received ${formatDate(updated.paidAt)}${installmentsTotal(updated) ? "; it is paid in full" : ""}` });
  if (!wantsReceipt) return "payment-recorded";
  const receipt = await sendOnce(env, store, sentKey(updated, "receipt"), receiptMessage(env, updated, target, receiptTo, origin), { remember: true });
  if (!receipt.ok) return "payment-recorded";
  await note({ action: "receipt.emailed", item: updated, summary: `Emailed the receipt for ${billingLabel(updated)} to ${receiptTo.join(", ")}` });
  return "payment-recorded-receipt";
}

async function handleAdminBilling(context, store, target, id, action, readiness, origin) {
  const env = context.env;
  const method = context.request.method;
  const isRead = method === "GET" || method === "HEAD";
  const url = new URL(context.request.url);
  const slug = target.slug;
  const billingBase = `/clients/admin/clients/${encodeURIComponent(slug)}/billing`;
  const today = todayInMichigan();
  // Every change here goes in the books: the activity log, and for invoices the journal.
  const admin = { actor: "admin", ip: requestIp(context.request) };
  const note = (event) => record(store, { ...admin, ...event });
  const noteEmailed = (sent, addresses, ok) => note({
    action: `${sent.kind}.emailed`, item: sent, data: { to: addresses, ok },
    summary: ok ? `Emailed ${billingLabel(sent)} to ${addresses.join(", ")}` : `${billingLabel(sent)} was not emailed to ${addresses.join(", ")}: the email did not go out`
  });

  if (id === "new" && !action) {
    if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
    const templates = await listTemplates(store);
    const template = url.searchParams.get("template") ? templates.find((entry) => entry.id === url.searchParams.get("template")) : null;
    const values = { ...(template ? editorValuesFromTemplate(template, today) : { kind: url.searchParams.get("kind") === "quote" ? "quote" : "invoice", lineItems: [] }), issuedOn: today };
    return scriptedHtmlResponse(billingEditorPage({ mode: "create", client: target, values, actionPath: billingBase, backPath: `/clients/admin?client=${encodeURIComponent(slug)}`, templates, readiness }));
  }

  if (!id) {
    if (method !== "POST") return methodNotAllowedResponse(["POST"]);
    const form = await readBoundedForm(context.request, MAX_BILLING_FORM_BYTES);
    const renderError = async (values, error) => scriptedHtmlResponse(billingEditorPage({
      mode: "create", client: target, values, error, actionPath: billingBase, backPath: `/clients/admin?client=${encodeURIComponent(slug)}`, templates: await listTemplates(store), readiness
    }), 400);
    if (!form) return renderError({ kind: "invoice", lineItems: [] }, "The form could not be read. Try again with fewer or shorter lines.");

    const saveTemplate = form.get("saveTemplate") === "yes";
    const sendNow = form.get("sendNow") === "yes";
    const parsed = parseBillingForm(form);
    // Payments already received, listed on a new invoice (quotes take none).
    const listed = parsed.values.kind === "invoice" ? parseListedPayments(form) : { payments: [], typed: [] };
    const echo = { ...parsed.values, saveTemplate, sendNow, payments: listed.typed };
    if (parsed.error) return renderError(echo, parsed.error);
    if (listed.error) return renderError(echo, listed.error);
    const listedCents = (listed.payments || []).reduce((sum, entry) => sum + entry.amountCents, 0);
    if (listedCents > parsed.values.amountCents) return renderError(echo, `The payments listed (${money(listedCents)}) are more than the invoice total (${money(parsed.values.amountCents)}).`);
    if (saveTemplate && (!parsed.values.templateName || parsed.values.templateName.length > 80)) return renderError(echo, "Give the template a name of 80 characters or fewer, or untick Also save this as a template.");

    // Saved (and numbered in date order) before it is emailed, so the email carries its number.
    const built = withListedPayments(await buildBillingItem(store, target, parsed.values), listed.payments || []);
    const saved = await saveNewBillingItem(store, built, { context: admin });
    if (listed.payments?.length) {
      await note({
        action: "payment.listed", item: saved.item, amountCents: listedCents,
        summary: `Listed ${listed.payments.length === 1 ? "a payment" : `${listed.payments.length} payments`} already received on ${billingLabel(saved.item)}: ${listed.payments.map((entry) => `${money(entry.amountCents)} ${entry.label} ${formatDate(entry.paidOn)}`).join("; ")}${saved.item.status === "paid" ? "; it is paid in full" : `; ${money(balanceDue(saved.item))} due`}`
      });
    }
    let item = saved.item;
    let notice = "billing-added";
    const projectEmails = clientEmails(target);
    if (sendNow && readiness.email && projectEmails.length) {
      const result = await emailBillingItem(env, store, item, target, projectEmails, origin);
      if (result.ok) await putBilling(store, result.item);
      item = result.item;
      notice = result.ok ? "billing-sent" : "billing-send-failed";
      await noteEmailed(item, projectEmails, result.ok);
    }
    if (saveTemplate) {
      await putTemplate(store, templateRecord({ ...parsed.values, dueInDays: null }));
      await note({ action: "template.saved", summary: `Saved the template ${parsed.values.templateName}` });
    }
    const also = [saveTemplate ? "&also=template-saved" : "", saved.renumbered ? "&also=renumbered" : ""].join("");
    return redirectResponse(`${adminBillingPath(slug, item.id)}?notice=${notice}${also}`);
  }

  let item = await getBilling(store, slug, id);
  if (!item) return notFoundResponse(null, true);
  const itemPath = adminBillingPath(slug, item.id);

  // The item's admin page. After a problem with typed addresses it names the problem and keeps
  // what was typed in the field it came from.
  const itemPage = async ({ notice = noticeFromQuery(url), typed = null, status = 200 } = {}) => {
    if (!item.shareToken) {
      item = await withShareToken(store, item);
      await putBilling(store, item);
    }
    const links = { ...shareLinks(origin, item), today };
    const receipt = item.status === "paid" ? await getSentEmail(store, sentKey(item, "receipt")) : null;
    const [recipients, projects] = await Promise.all([listRecipients(store), listClients(store)]);
    return scriptedHtmlResponse(adminBillingPage({ client: target, item, links, receipt, recipients, projects, readiness, notice, typed }), status);
  };

  // The other project named by a Copy or Send form, or null.
  const otherProject = async (toSlug) => (toSlug !== slug && isValidSlug(toSlug) ? getClient(store, toSlug) : null);

  // Reads the addresses typed into a Send to field. Returns them, or the page explaining the problem.
  const typedAddresses = async (field) => {
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const typedText = String(form?.get("to") || "");
    const parsed = parseEmailList(typedText);
    const problem = form ? recipientProblem(parsed) : "The form could not be read. Please try again.";
    if (!problem) return { addresses: parsed.addresses };
    return { response: await itemPage({ notice: { text: problem, tone: "error" }, typed: { field, value: typedText.trim() }, status: 400 }) };
  };

  if (!action) {
    if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
    return itemPage();
  }

  if (action === "edit") {
    if (!isEditable(item)) return redirectResponse(`${itemPath}?notice=not-editable`);
    const editorPath = `${itemPath}/edit`;
    // How a paid invoice was paid ("manual" or "stripe"), for the editor's note; "" when unpaid.
    const paid = item.status === "paid" ? (item.payment?.source === "stripe" ? "stripe" : "manual") : "";
    if (isRead) {
      return scriptedHtmlResponse(billingEditorPage({ mode: "edit", client: target, values: { ...editorValuesFromItem(item), issuedOn: issuedDate(item) }, actionPath: editorPath, backPath: itemPath, readiness, number: item.number, paid }));
    }
    if (method !== "POST") return methodNotAllowedResponse(["GET", "HEAD", "POST"]);
    const form = await readBoundedForm(context.request, MAX_BILLING_FORM_BYTES);
    if (!form) return redirectResponse(`${itemPath}?notice=invalid`);
    form.set("kind", item.kind);
    const parsed = parseBillingForm(form);
    if (parsed.error) {
      return scriptedHtmlResponse(billingEditorPage({ mode: "edit", client: target, values: parsed.values, error: parsed.error, actionPath: editorPath, backPath: itemPath, readiness, number: item.number, paid }), 400);
    }
    if (parsed.values.amountCents < installmentsTotal(item)) {
      return scriptedHtmlResponse(billingEditorPage({ mode: "edit", client: target, values: parsed.values, error: `The total cannot be less than the ${money(installmentsTotal(item), item.currency)} already paid toward this invoice.`, actionPath: editorPath, backPath: itemPath, readiness, number: item.number, paid }), 400);
    }
    if (item.checkoutSessionId && parsed.values.amountCents !== item.amountCents) await expireCheckoutSession(env, item.checkoutSessionId);
    const { title, description, lineItems, amountCents, dueDate } = parsed.values;
    const issuedOn = parsed.values.issuedOn || issuedDate(item);
    // A payment recorded by hand settles the invoice, so its amount follows the new total, less
    // any payments toward the balance before it. A Stripe payment keeps the amount Stripe charged.
    const payment = item.payment?.source === "manual" ? { payment: { ...item.payment, amountCents: amountCents - installmentsTotal(item) } } : {};
    const edited = { ...item, title, description, lineItems, amountCents, dueDate, issuedOn, ...payment, updatedAt: new Date().toISOString() };
    await putBilling(store, edited);
    const renumbered = issuedOn !== issuedDate(item) && (await keepInvoicesInDateOrder(store, item.kind));
    await note({ action: `${item.kind}.edited`, item: (await getBilling(store, slug, item.id)) || edited, amountCents, summary: editSummary(item, edited) });
    return redirectResponse(`${itemPath}?notice=billing-updated${renumbered ? "&also=renumbered" : ""}`);
  }

  // Copy to another project: that project's new quote or invoice editor, filled in from this one
  // to review and post there. A due date already past is left for the admin to set.
  if (action === "copy") {
    if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
    const destination = await otherProject(url.searchParams.get("to") || "");
    if (!destination) return redirectResponse(`${itemPath}?notice=project-invalid`);
    const values = { ...editorValuesFromItem(item), lineItems: billingLineItems(item), dueDate: item.dueDate && item.dueDate >= today ? item.dueDate : "", issuedOn: today };
    const notice = { text: `Copied from ${billingLabel(item)} in ${target.name}. Review it, then post it to ${destination.name}.` };
    return scriptedHtmlResponse(billingEditorPage({
      mode: "create", client: destination, values, notice, actionPath: `/clients/admin/clients/${encodeURIComponent(destination.slug)}/billing`, backPath: itemPath, readiness
    }));
  }

  // Delete: a page confirming what goes with it, then the quote or invoice is removed with its
  // sent-email records. Later invoices move up a number (a quote's number is not used again), and
  // a quote and the invoice made from it lose their link to each other. An unpaid invoice's open
  // Checkout is closed first; a bank payment still processing keeps the invoice until it finishes.
  if (action === "delete") {
    const partnerId = item.kind === "invoice" ? item.fromQuoteId : item.invoiceId;
    const partner = partnerId ? await getBilling(store, slug, partnerId) : null;
    if (isRead) return scriptedHtmlResponse(billingDeletePage({ client: target, item, partner }));
    if (method !== "POST") return methodNotAllowedResponse(["GET", "HEAD", "POST"]);
    if (item.status === "processing") return redirectResponse(`${itemPath}?notice=delete-processing`);
    if (item.status === "open" && item.checkoutSessionId) await expireCheckoutSession(env, item.checkoutSessionId);
    let unlink = null;
    if (partner) {
      const { invoiceId: _invoiceId, invoiceNumber: _invoiceNumber, fromQuoteId: _quoteId, fromQuoteNumber: _quoteNumber, ...rest } = partner;
      unlink = { ...rest, updatedAt: new Date().toISOString() };
    }
    await deleteBilling(store, item, { unlink });
    await note({ action: `${item.kind}.deleted`, item, deleted: true, reason: "deleted", amountCents: item.amountCents, summary: `Deleted ${billingLabel(item)} · ${item.title} · ${money(item.amountCents, item.currency)}` });
    const renumbered = await keepInvoicesInDateOrder(store, item.kind);
    return redirectResponse(`/clients/admin?client=${encodeURIComponent(slug)}&notice=${item.kind}-deleted${renumbered ? "&also=renumbered" : ""}`);
  }

  if (method !== "POST") return methodNotAllowedResponse(["POST"]);

  // Send to another project, for one entered in the wrong project: it moves there with its
  // number and link, together with the quote or invoice linked to it. An unpaid invoice's open
  // Checkout names the old project, so it is closed; paying starts a new one.
  if (action === "move") {
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const destination = await otherProject(String(form?.get("to") || ""));
    if (!destination) return redirectResponse(`${itemPath}?notice=project-invalid`);
    const partnerId = item.kind === "quote" ? item.invoiceId : item.fromQuoteId;
    const partner = partnerId ? await getBilling(store, slug, partnerId) : null;
    const moving = partner ? [item, partner] : [item];
    if (moving.some((entry) => entry.status === "processing")) return redirectResponse(`${itemPath}?notice=move-processing`);
    const movedAt = new Date().toISOString();
    const moved = [];
    for (const entry of moving) {
      const next = { ...entry, clientSlug: destination.slug, movedFrom: { slug, name: target.name, movedAt }, updatedAt: movedAt };
      if (entry.status === "open" && entry.checkoutSessionId) {
        await expireCheckoutSession(env, entry.checkoutSessionId);
        for (const field of ["checkoutSessionId", "checkoutExpiresAt", "checkoutSuccessUrl", "checkoutAmountCents"]) delete next[field];
      }
      moved.push(next);
    }
    await moveBilling(store, moved, slug);
    for (const entry of moved) await note({ action: `${entry.kind}.moved`, item: entry, moved: true, summary: `Sent ${billingLabel(entry)} from ${target.name} to ${destination.name}` });
    return redirectResponse(`${adminBillingPath(destination.slug, item.id)}?notice=${partner ? "moved-pair" : "moved"}`);
  }

  if (action === "send") {
    if (!readiness.email) return redirectResponse(`${itemPath}?notice=email-not-configured`);
    const { addresses, response } = await typedAddresses("send");
    if (response) return response;
    const result = await emailBillingItem(env, store, await withShareToken(store, item), target, addresses, origin);
    await putBilling(store, result.item);
    await noteEmailed(result.item, addresses, result.ok);
    return redirectResponse(`${itemPath}?notice=${result.ok ? "sent" : "send-failed"}`);
  }

  if (action === "void") {
    if (item.status === "open" && installmentsTotal(item) > 0) return redirectResponse(`${itemPath}?notice=void-has-payments`);
    if (item.status === "open") {
      if (item.checkoutSessionId) await expireCheckoutSession(env, item.checkoutSessionId);
      const voided = { ...item, status: "void", voidedAt: new Date().toISOString() };
      await putBilling(store, voided);
      await note({ action: `${item.kind}.voided`, item: voided, reason: "voided", amountCents: item.amountCents, summary: `Voided ${billingLabel(item)} · ${money(item.amountCents, item.currency)}` });
    }
    return redirectResponse(`${itemPath}?notice=voided`);
  }

  // A payment from the invoice page, the admin list's status popup or Add payment (return=list,
  // which goes back to the list): toward the balance, or settling it (addPayment).
  if (action === "record-payment") {
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const back = (notice) => redirectResponse(form?.get("return") === "list" ? `/clients/admin?client=${encodeURIComponent(slug)}&notice=${notice}` : `${itemPath}?notice=${notice}`);
    return back(await addPayment({ env, store, target, item, form, readiness, origin, note }));
  }

  // Removes a payment toward the balance added by mistake, while the invoice is still open.
  if (action === "remove-payment") {
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const back = (notice) => redirectResponse(`${itemPath}?notice=${notice}`);
    if (item.kind !== "invoice" || item.status !== "open") return back("not-payable");
    const removed = (item.installments || []).find((entry) => entry.id === String(form?.get("installment") || ""));
    if (!removed) return back("invalid");
    if (item.checkoutSessionId) await expireCheckoutSession(env, item.checkoutSessionId);
    const updated = { ...item, installments: item.installments.filter((entry) => entry.id !== removed.id) };
    await putBilling(store, updated);
    await note({ action: "payment.removed", item: updated, reason: "payment-removed", amountCents: removed.amountCents, summary: `Removed the ${removed.label} payment of ${money(removed.amountCents, item.currency)} (${formatDate(removed.paidOn)}) from ${billingLabel(item)}; ${money(balanceDue(updated), item.currency)} is due` });
    await deleteSentEmails(store, [sentKey(item, `receipt:${removed.id}`)]);
    return back("partial-removed");
  }

  // Corrects a payment recorded by hand (method, reference or date; the amount is the invoice
  // total). Stripe payments keep what Stripe recorded. The receipt is not re-sent; "Resend
  // receipt" sends the corrected one.
  // Saved from the invoice page, or from the admin list's How it was paid popup (return=list).
  if (action === "payment") {
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const back = (notice) => redirectResponse(form?.get("return") === "list" ? `/clients/admin?client=${encodeURIComponent(slug)}&notice=${notice}` : `${itemPath}?notice=${notice}`);
    if (item.kind !== "invoice" || item.status !== "paid") return back("not-payable");
    if (item.payment?.source !== "manual") return back("payment-from-stripe");
    const entered = parseManualPayment(form);
    if (entered.error) return back(entered.error);
    const { paidOn, ...details } = entered;
    const corrected = { ...item, paidAt: paidOn, payment: { ...item.payment, ...details, amountCents: item.amountCents - installmentsTotal(item), updatedAt: new Date().toISOString() } };
    await putBilling(store, corrected);
    const was = `${item.payment?.label || "payment"}, ${formatDate(item.paidAt)}`;
    const now = `${corrected.payment.label}, ${formatDate(corrected.paidAt)}`;
    await note({ action: "payment.corrected", item: corrected, amountCents: corrected.payment.amountCents, summary: `Changed the payment for ${billingLabel(item)}${was === now ? "" : `: ${was} → ${now}`}` });
    return back("payment-updated");
  }

  // Undoes a payment recorded by mistake. The invoice is open (payable) again, and its receipt
  // and payment notice are forgotten so a later payment sends fresh ones.
  if (action === "reopen") {
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const back = (notice) => redirectResponse(form?.get("return") === "list" ? `/clients/admin?client=${encodeURIComponent(slug)}&notice=${notice}` : `${itemPath}?notice=${notice}`);
    if (item.kind !== "invoice" || item.status !== "paid") return back("not-payable");
    if (item.payment?.source !== "manual") return back("payment-from-stripe");
    const { payment: _payment, paidAt: _paidAt, ...unpaid } = item;
    const reopened = { ...unpaid, status: "open", reopenedAt: new Date().toISOString() };
    await putBilling(store, reopened);
    await note({ action: "payment.removed", item: reopened, reason: "payment-removed", amountCents: item.payment?.amountCents ?? item.amountCents, summary: `Marked ${billingLabel(item)} unpaid, removing its ${item.payment?.label || ""} payment of ${money(item.payment?.amountCents ?? item.amountCents, item.currency)}`.replace("its  payment", "its payment") });
    await deleteSentEmails(store, [sentKey(item, "receipt"), sentKey(item, "paid-notice")]);
    return back("payment-removed");
  }

  // Sends the receipt again on request, to any addresses, and records the latest send.
  if (action === "receipt") {
    if (item.kind !== "invoice" || item.status !== "paid") return redirectResponse(itemPath);
    if (!readiness.email) return redirectResponse(`${itemPath}?notice=email-not-configured`);
    const { addresses, response } = await typedAddresses("receipt");
    if (response) return response;
    const withToken = await withShareToken(store, item);
    if (withToken !== item) await putBilling(store, withToken);
    const delivery = await sendEmail(env, receiptMessage(env, withToken, target, addresses, origin));
    if (delivery.ok) {
      await putSentEmail(store, sentKey(item, "receipt"), { to: addresses.join(", "), sentAt: new Date().toISOString(), messageId: delivery.id || "" });
      await rememberForProject(store, target, addresses);
      await note({ action: "receipt.emailed", item: withToken, summary: `Emailed the receipt for ${billingLabel(withToken)} to ${addresses.join(", ")}` });
    }
    return redirectResponse(`${itemPath}?notice=${delivery.ok ? "receipt-sent" : "receipt-failed"}`);
  }

  if (action === "invoice") {
    if (item.kind !== "quote" || item.invoiceId || !(item.status === "open" || item.status === "accepted")) return redirectResponse(itemPath);
    if (item.amountCents < MIN_INVOICE_CENTS) return redirectResponse(`${itemPath}?notice=invoice-too-small`);
    // Dated the day it is made; its number is its place in date order.
    const { item: invoice, renumbered } = await saveNewBillingItem(store, await buildBillingItem(store, target, { ...editorValuesFromItem(item), kind: "invoice", dueDate: "", issuedOn: "", amountCents: item.amountCents }, { fromQuoteId: item.id, fromQuoteNumber: item.number }), { context: admin, from: billingLabel(item) });
    const accepted = item.status === "open" ? { status: "accepted", acceptedAt: new Date().toISOString(), acceptedVia: "admin" } : {};
    await putBilling(store, { ...item, ...accepted, invoiceId: invoice.id, invoiceNumber: invoice.number });
    if (accepted.status) await note({ action: "quote.accepted", item: { ...item, ...accepted }, amountCents: item.amountCents, summary: `Marked ${billingLabel(item)} accepted by making ${billingLabel(invoice)} from it` });
    return redirectResponse(`${adminBillingPath(slug, invoice.id)}?notice=invoice-created${renumbered ? "&also=renumbered" : ""}`);
  }

  return notFoundResponse(null, true);
}

// The Books page: the journal, the balance check and the activity log, for all client portals or
// one, over a date range; its corrections; and its downloads.
async function handleBooks(context, store, pathname, url) {
  const method = context.request.method;
  const isRead = method === "GET" || method === "HEAD";
  const clients = await listClients(store);
  const names = new Map(clients.map((client) => [client.slug, client.name]));
  const slug = names.has(url.searchParams.get("client")) ? url.searchParams.get("client") : "";
  const day = (value) => (/^\d{4}-\d{2}-\d{2}$/u.test(value || "") ? value : "");
  const from = day(url.searchParams.get("from"));
  const to = day(url.searchParams.get("to"));

  if (pathname === "/clients/admin/books/correct") {
    if (method !== "POST") return methodNotAllowedResponse(["POST"]);
    const posted = await correctBooks(store, { ip: requestIp(context.request) });
    return redirectResponse(`/clients/admin/books?notice=${posted ? "books-corrected" : "books-balanced"}`);
  }

  // Add expense from the Books page: a job's, or overhead with no job. Its receipt and delete.
  const expenseMatch = pathname.match(/^\/clients\/admin\/books\/expenses(?:\/([A-Za-z0-9_-]+))?(?:\/(receipt|delete))?$/u);
  if (expenseMatch) {
    const [, id, action] = expenseMatch;
    if (!id || (id === "new" && !action)) {
      const payers = paidWithOptions(await listBankAccounts(store));
      if (id === "new") {
        if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
        return scriptedHtmlResponse(adminAddExpensePage({ jobs: clients, payers, today: todayInMichigan(), paidTo: await expensePaidTo(store), notice: noticeFromQuery(url) }));
      }
      if (method !== "POST") return methodNotAllowedResponse(["POST"]);
      const form = await readBoundedMultipart(context.request, MAX_UPLOAD_BYTES + 8192);
      const job = String(form?.get("job") || "");
      const target = job ? clients.find((client) => client.slug === job) : null;
      const result = !form || (job && !target) ? "invalid" : await addExpense({ store, target, form, payers, ip: requestIp(context.request) });
      return redirectResponse(`/clients/admin/books?notice=${result}`);
    }
    const expense = await getExpense(store, null, id);
    if (!expense || !action) return notFoundResponse(null, true);
    if (action === "receipt") {
      if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
      const object = expense.receipt ? await getFile(store, expense.receipt.key) : null;
      return object ? fileResponse(object, expense.receipt.name, expense.receipt.type) : notFoundResponse(null, true);
    }
    if (method !== "POST") return methodNotAllowedResponse(["POST"]);
    await removeExpense(store, expense, { ip: requestIp(context.request), jobName: names.get(expense.clientSlug) || "" });
    return redirectResponse("/clients/admin/books?notice=expense-deleted");
  }

  // One job's book.
  const jobMatch = pathname.match(/^\/clients\/admin\/books\/jobs\/([^/]+)$/u);
  if (jobMatch) {
    if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
    const client = clients.find((entry) => entry.slug === decodeSegment(jobMatch[1]));
    if (!client) return notFoundResponse(null, true);
    return htmlResponse(adminJobBookPage({ client, book: await jobBook(store, client.slug, { from, to }), today: todayInMichigan() }));
  }
  if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
  const report = await booksReport(store, { slug, from, to });
  if (pathname === "/clients/admin/books/ledger.csv" || pathname === "/clients/admin/books/activity.csv") {
    const ledger = pathname.endsWith("ledger.csv");
    const name = `my-home-builder-${ledger ? "ledger" : "activity"}${slug ? `-${slug}` : ""}${from ? `-from-${from}` : ""}${to ? `-to-${to}` : ""}.csv`;
    const headers = responseHeaders("text/csv; charset=utf-8");
    headers.set("Content-Disposition", `attachment; filename="${name}"`);
    return new Response(ledger ? ledgerCsv(report, names) : activityCsv(report, names), { status: 200, headers });
  }
  if (pathname !== "/clients/admin/books") return notFoundResponse(null, true);
  const [check, log, overheadExpenses, accounts, paidTo] = await Promise.all([checkBooks(store), verifyActivityLog(store), listExpenses(store, null), listBankAccounts(store), expensePaidTo(store)]);
  return scriptedHtmlResponse(adminBooksPage({ report, check, log, clients, today: todayInMichigan(), notice: noticeFromQuery(url), overheadExpenses, payers: paidWithOptions(accounts), paidTo }));
}

// Who expenses can be paid to (expenses.js paidToSuggestions).
async function expensePaidTo(store) {
  const [workers, expenses] = await Promise.all([listWorkers(store), listAllExpenses(store)]);
  return paidToSuggestions({ workers, expenses });
}

// Deletes an expense and takes it out of the books (and unfiles a bank withdrawal matched to it).
async function removeExpense(store, expense, { ip, jobName }) {
  if (expense.bankTransactionId) await unfileExpenseMatch(store, expense, { ip });
  await deleteExpense(store, expense.id);
  await record(store, {
    actor: "admin", ip, action: "expense.deleted", clientSlug: expense.clientSlug, amountCents: expense.amountCents, reason: "deleted", expense: { ...expense, deleted: true }, data: { expenseId: expense.id },
    summary: `Deleted ${expense.clientSlug ? `the expense for ${jobName || expense.clientSlug}` : "the overhead expense"}: ${[expense.description, expense.vendor].filter(Boolean).join(" · ")} · ${categoryName(expense)} · ${money(expense.amountCents)}`
  });
}

// A project's client login in plain text, so the admin panel can show it: kept sealed
// (secure.js, AES-256-GCM) beside its hash. Logins saved before this are not on file (null).
function loginKey(slug) {
  return `client-login:${slug}`;
}

async function keepLogin(env, store, slug, login) {
  if (!secureReady(env)) return;
  try {
    await putSecureJson(store, env, loginKey(slug), { login });
  } catch (error) {
    console.error(JSON.stringify({ message: "client login not kept", slug, error: error instanceof Error ? error.message : "Unknown error" }));
  }
}

// A project with no login (or a login not known in plain text) keeps no sealed copy.
async function forgetLogin(store, slug) {
  try {
    await deleteSecure(store, loginKey(slug));
  } catch (error) {
    console.error(JSON.stringify({ message: "client login not forgotten", slug, error: error instanceof Error ? error.message : "Unknown error" }));
  }
}

async function keptLogin(env, store, client) {
  if (!client) return null;
  if (client.managedBySecret) return env.CLIENT_PORTAL_PASSWORD || null;
  if (!client.passwordHash || !secureReady(env)) return null;
  try {
    return (await getSecureJson(store, env, loginKey(client.slug)))?.login || null;
  } catch {
    return null;
  }
}

async function handleAdminTemplates(context, store, id, action) {
  const method = context.request.method;
  const isRead = method === "GET" || method === "HEAD";
  const url = new URL(context.request.url);
  const listPath = "/clients/admin/templates";

  if (!id) {
    if (isRead) return htmlResponse(adminTemplatesPage({ templates: await listTemplates(store), notice: noticeFromQuery(url) }));
    if (method !== "POST") return methodNotAllowedResponse(["GET", "HEAD", "POST"]);
  }

  if (id === "new") {
    if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
    return scriptedHtmlResponse(billingEditorPage({ mode: "template-new", values: { kind: "invoice", lineItems: [] }, actionPath: listPath, backPath: listPath }));
  }

  if (id === "from-billing") {
    if (method !== "POST") return methodNotAllowedResponse(["POST"]);
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const slug = String(form?.get("client") || "");
    const item = isValidSlug(slug) ? await getBilling(store, slug, String(form?.get("id") || "")) : null;
    if (!item) return redirectResponse(`${listPath}?notice=invalid`);
    const template = templateRecord({ ...editorValuesFromItem(item), templateName: item.title.slice(0, 80), amountCents: item.amountCents, dueInDays: null, lineItems: item.lineItems || [{ description: item.title, quantity: 1, unitCents: item.amountCents, amountCents: item.amountCents }] });
    await putTemplate(store, template);
    await record(store, { actor: "admin", ip: requestIp(context.request), action: "template.saved", summary: `Saved ${billingLabel(item)} as the template ${template.name}` });
    return redirectResponse(`${listPath}/${encodeURIComponent(template.id)}?notice=template-saved`);
  }

  const existing = id ? await getTemplate(store, id) : null;
  if (id && !existing) return notFoundResponse(null, true);
  const editorPath = existing ? `${listPath}/${encodeURIComponent(existing.id)}` : listPath;

  if (existing && action === "delete") {
    if (method !== "POST") return methodNotAllowedResponse(["POST"]);
    await deleteTemplate(store, existing.id);
    await record(store, { actor: "admin", ip: requestIp(context.request), action: "template.deleted", summary: `Deleted the template ${existing.name}` });
    return redirectResponse(`${listPath}?notice=template-deleted`);
  }
  if (action) return notFoundResponse(null, true);

  if (existing && isRead) {
    const values = { ...editorValuesFromItem(existing), templateName: existing.name, dueInDays: existing.dueInDays ?? "" };
    return scriptedHtmlResponse(billingEditorPage({ mode: "template-edit", values, actionPath: editorPath, backPath: listPath, notice: noticeFromQuery(url) }));
  }
  if (method !== "POST") return methodNotAllowedResponse(["GET", "HEAD", "POST"]);

  const form = await readBoundedForm(context.request, MAX_BILLING_FORM_BYTES);
  const mode = existing ? "template-edit" : "template-new";
  if (!form) return scriptedHtmlResponse(billingEditorPage({ mode, values: { kind: "invoice", lineItems: [] }, error: "The form could not be read.", actionPath: editorPath, backPath: listPath }), 400);
  const parsed = parseBillingForm(form, { template: true });
  if (parsed.error) return scriptedHtmlResponse(billingEditorPage({ mode, values: parsed.values, error: parsed.error, actionPath: editorPath, backPath: listPath }), 400);
  const template = templateRecord(parsed.values, existing);
  await putTemplate(store, template);
  await record(store, { actor: "admin", ip: requestIp(context.request), action: "template.saved", summary: `${existing ? "Changed" : "Created"} the template ${template.name}` });
  return redirectResponse(`${listPath}?notice=template-saved`);
}

// What crew.js uses from here: responses and the document functions.
const KIT = {
  htmlResponse,
  scriptedHtmlResponse,
  redirectResponse,
  fileResponse,
  methodNotAllowedResponse,
  notFound: () => notFoundResponse(null, false),
  storeUpload,
  applySignature,
  documentDownload,
  decodeSignatureImage,
  decodeSegment,
  requestIp,
  safeFileName,
  loginLocation,
  storePhotos,
  photoResponse,
  MAX_PHOTO_BATCH_BYTES
};

// ---------- The Back button ----------
// Every form answers with a redirect when it succeeds. A page that answers a form directly (a
// problem to fix, or a step such as "code sent") loads history.js, which turns its place in the
// browser's history into a plain visit, so Back never asks to resubmit the form. Opened again, a
// form's address goes to the page it belongs to rather than "Request not allowed".
const HISTORY_SCRIPT = "/clients/portal/history.js";

function pageFor(pathname) {
  const invoice = pathname.match(/^\/clients\/admin\/clients\/([^/]+)\/billing\/([^/]+)/u);
  if (invoice && invoice[2] !== "new") return `/clients/admin/clients/${invoice[1]}/billing/${invoice[2]}`;
  const client = pathname.match(/^\/clients\/admin\/clients\/([^/]+)/u);
  if (client) return `/clients/admin?client=${client[1]}`;
  const worker = pathname.match(/^\/clients\/admin\/labor\/workers\/([^/]+)/u);
  if (worker) return `/clients/admin/labor/workers/${worker[1]}`;
  for (const section of ["/clients/admin/labor", "/clients/admin/bank", "/clients/admin/books", "/clients/admin/templates", "/clients/admin/documents", "/clients/admin/schedule", "/clients/admin/notes"]) {
    if (pathname === section || pathname.startsWith(`${section}/`)) return section;
  }
  if (/^\/clients\/admin\/(request|verify)$/u.test(pathname)) return "/clients/admin/code";
  if (pathname.startsWith("/clients/admin")) return "/clients/admin";
  if (pathname.startsWith("/clients/crew")) return "/clients/crew";
  return "/clients";
}

async function answerToForm(response) {
  const type = response.headers.get("Content-Type") || "";
  if (!type.startsWith("text/html") || (response.status >= 300 && response.status < 400)) return response;
  const html = await response.text();
  const headers = new Headers(response.headers);
  const policy = headers.get("Content-Security-Policy") || "";
  if (policy && !policy.includes("script-src")) headers.set("Content-Security-Policy", policy.replace("default-src 'none'; ", "default-src 'none'; script-src 'self'; "));
  headers.delete("Content-Length");
  const body = html.includes("</head>") ? html.replace("</head>", `  <script src="${HISTORY_SCRIPT}" defer></script>\n</head>`) : html;
  return new Response(body, { status: response.status, headers });
}

// context: { request, env }. env carries the portal settings under the names below; index.js
// maps them from the MHB_* environment variables.
export async function handlePortalRequest(context) {
  const response = await routePortalRequest(context);
  const method = context.request.method;
  if (method === "GET" || method === "HEAD") {
    return response.status === 405 ? redirectResponse(pageFor(new URL(context.request.url).pathname)) : response;
  }
  return answerToForm(response);
}

async function routePortalRequest(context) {
  const url = new URL(context.request.url);
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  const method = context.request.method;
  const isRead = method === "GET" || method === "HEAD";
  const origin = url.origin;

  try {
    const env = context.env;
    const password = env.CLIENT_PORTAL_PASSWORD;
    const sessionSecret = env.CLIENT_PORTAL_SESSION_SECRET;
    if (!password || !sessionSecret) {
      console.error(JSON.stringify({ message: "client portal secrets are not configured", path: pathname }));
      return htmlResponse(serviceUnavailablePage(), 503);
    }

    const store = createStore(db);
    const readiness = {
      store: true,
      files: true,
      stripe: stripeConfigured(env),
      webhook: typeof env.STRIPE_WEBHOOK_SECRET === "string" && env.STRIPE_WEBHOOK_SECRET.length > 0,
      email: emailConfigured(env)
    };

    const codeTo = maskedEmail(adminCodeEmail(env));

    if (pathname === "/clients/stripe/webhook") {
      if (method !== "POST") return methodNotAllowedResponse(["POST"]);
      return handleWebhook(context, store, origin);
    }

    // Public quote and invoice links. The unguessable token in the path is the access key.
    const shareMatch = pathname.match(/^\/clients\/(invoice|pay|quote)\/([^/]+)(?:\/(return|accept))?$/u);
    if (shareMatch) return handleShare(context, store, shareMatch, origin);

    // The crew portal: employees and subcontractors, with their own sign-in.
    if (pathname === "/clients/crew" || pathname.startsWith("/clients/crew/")) return handleCrew({ ...context, kit: KIT }, store, pathname, url);

    const session = await readClientSession(context.request, sessionSecret, DEFAULT_CLIENT_SLUG);
    const admin = await hasAdminSession(context.request, sessionSecret);
    const client = session ? await getClient(store, session.slug) : null;
    // A project with no login (admin only, such as one taken out from under a shared login) is not
    // opened by a client session.
    const authenticated = Boolean(session && client && (client.managedBySecret || client.passwordHash));

    if (isRead && (pathname === "/clients" || pathname === "/clients/login")) {
      const destination = safeProjectDestination(url.searchParams.get("next"));
      if (authenticated && destination) return redirectResponse(destination);
      if (authenticated && pathname === "/clients/login") return redirectResponse("/clients");
      if (!authenticated) return htmlResponse(loginPage(false, destination));

      // Photos shown in the portal: all of them unless the admin hid them, less any hidden one by one.
      const [billing, documents, book, photos, projects, designer] = store
        ? await Promise.all([
          listBilling(store, client.slug),
          client.readOnly ? [] : listDocuments(store, client.slug),
          client.readOnly ? jobBook(store, client.slug) : null,
          client.photosVisible === false ? [] : listPhotos(store, client.slug).then((list) => list.filter((photo) => !photo.hidden)),
          client.loginGroup ? listClients(store).then((clients) => switchableProjects(clients, client)) : [],
          client.projectPath ? true : hasRenders(store, client.slug)
        ])
        : [[], [], null, [], [], false];
      return htmlResponse(portalHomePage({ client, billing, documents, storeReady: Boolean(store), admin, notice: noticeFromQuery(url), book, photos, projects: projects.length > 1 ? projects : [], designer }));
    }

    if (method === "POST" && pathname === "/clients/login") {
      const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
      const destination = safeProjectDestination(form?.get("next"));
      const slug = await resolveLogin(env, store, form?.get("password"));
      if (!slug) return htmlResponse(loginPage(true, destination), 401);
      await record(store, { actor: "client", action: "client.signed-in", clientSlug: slug, ip: requestIp(context.request), summary: `${(await getClient(store, slug))?.name || slug} signed in to their portal` });
      return redirectResponse(destination || "/clients", await createClientSession(sessionSecret, slug));
    }

    if (method === "POST" && pathname === "/clients/logout") {
      return redirectResponse("/clients", expiredClientSession());
    }

    if (pathname === "/clients/login" || pathname === "/clients/logout") {
      return methodNotAllowedResponse(pathname === "/clients/login" ? ["GET", "HEAD", "POST"] : ["POST"]);
    }

    // Projects under one login: the client switches to another of them, which signs them in to it.
    if (pathname === "/clients/switch") {
      if (method !== "POST") return methodNotAllowedResponse(["POST"]);
      if (!authenticated) return redirectResponse("/clients");
      const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
      const wanted = String(form?.get("project") || "");
      const target = switchableProjects(await listClients(store), client).find((entry) => entry.slug === wanted && entry.slug !== client.slug);
      if (!target) return redirectResponse("/clients?notice=switch-invalid");
      await record(store, { actor: "client", action: "client.switched", clientSlug: target.slug, ip: requestIp(context.request), summary: `Switched from ${client.name} to ${target.name} under their shared login` });
      return redirectResponse("/clients", await createClientSession(sessionSecret, target.slug));
    }

    // The gallery: the client adds photos with a note, and opens the photos shown in their portal.
    if (pathname === "/clients/photos" || pathname.startsWith("/clients/photos/")) {
      if (!authenticated) return redirectResponse("/clients");
      if (pathname === "/clients/photos") {
        if (method !== "POST") return methodNotAllowedResponse(["POST"]);
        if (client.readOnly) return redirectResponse("/clients?notice=read-only");
        const form = await readBoundedMultipart(context.request, MAX_PHOTO_BATCH_BYTES);
        const result = form ? await storePhotos(store, client, form, { uploadedBy: "client", uploaderName: "Client", ip: requestIp(context.request) }) : { error: "photos-invalid" };
        return redirectResponse(`/clients?notice=${result.error || "photos-added"}`);
      }
      if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
      const photo = await getPhoto(store, decodeSegment(pathname.slice("/clients/photos/".length)));
      if (!photo || photo.clientSlug !== client.slug || photo.hidden || client.photosVisible === false) return notFoundResponse(session, admin);
      return (await photoResponse(store, photo)) || notFoundResponse(session, admin);
    }

    // The live material designer (every project) and its renders API.
    if (pathname === DESIGNER_PATH || pathname.startsWith(`${DESIGNER_PATH}/`)) {
      return handleDesigner({ ...context, kit: KIT }, store, pathname, url, { client, authenticated, admin });
    }
    // The designer used to live inside the Muskegon project's files.
    if (pathname === `${PROJECT_PATH}/material-render` || pathname.startsWith(`${PROJECT_PATH}/material-render/`)) {
      return redirectResponse(`${DESIGNER_PATH}/${url.search}`);
    }

    if (isRead && (pathname === PROJECT_PATH || pathname.startsWith(`${PROJECT_PATH}/`))) {
      if (!authenticated || client.projectPath !== PROJECT_PATH) return redirectResponse(loginLocation(requestedProjectDestination(url, pathname)));
      return projectAssetGrant(pathname === PROJECT_PATH ? `${PROJECT_PATH}/` : url.pathname);
    }

    if (pathname === PROJECT_PATH || pathname.startsWith(`${PROJECT_PATH}/`)) {
      return methodNotAllowedResponse(["GET", "HEAD"]);
    }

    // Admin verification flow. Available from the login page and from inside any client portal.
    if (pathname === "/clients/admin/request") {
      if (method !== "POST") return methodNotAllowedResponse(["POST"]);
      if (admin) return redirectResponse("/clients/admin");
      if (!store) return htmlResponse(adminRequestPage({ codeTo, state: "storage-not-configured", authenticated }), 503);
      if (!readiness.email) return htmlResponse(adminRequestPage({ codeTo, state: "email-not-configured", authenticated }), 503);
      if (!(await allowAdminRequest(store, requestIp(context.request) || "unknown"))) {
        return htmlResponse(adminRequestPage({ codeTo, state: "rate-limited", authenticated }), 429);
      }

      const code = randomCode();
      const challengeId = randomId(16);
      await putAdminChallenge(store, challengeId, await sha256Hex(`${code}:${challengeId}`));
      const message = adminCodeMessage(code, requestIp(context.request), `${origin}/clients/admin/code`);
      const delivery = await sendEmail(env, { to: adminCodeEmail(env), ...message, category: "admin-code" });
      if (!delivery.ok) {
        await deleteAdminChallenge(store, challengeId);
        // 500, not 502: Cloudflare replaces a 502 with its own error page.
        return htmlResponse(adminRequestPage({ codeTo, state: "send-failed", authenticated }), 500);
      }
      await record(store, { actor: "visitor", action: "admin.code-requested", ip: requestIp(context.request), summary: `Admin code emailed to ${adminCodeEmail(env)}` });
      return htmlResponse(adminRequestPage({ codeTo, state: "sent", authenticated }));
    }

    // Where a code is entered on any device, without asking for a new one.
    if (pathname === "/clients/admin/code") {
      if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
      if (admin) return redirectResponse("/clients/admin");
      return htmlResponse(adminRequestPage({ codeTo, state: "code", authenticated }));
    }

    // A code works on any device, not just the one that asked for it: it is checked against every
    // code still live. Each attempt counts against all of them (claimAdminAttempt), so no code is
    // tried more than ADMIN_CODE_MAX_ATTEMPTS times, as when a code was tied to one page.
    if (pathname === "/clients/admin/verify") {
      if (method !== "POST") return methodNotAllowedResponse(["POST"]);
      if (!store) return htmlResponse(adminRequestPage({ codeTo, state: "storage-not-configured", authenticated }), 503);
      const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
      const code = String(form?.get("code") || "").trim();
      const retry = (error, status) => htmlResponse(adminRequestPage({ codeTo, state: "code", error, authenticated }), status);

      const { live, spent } = await claimAdminAttempt(store);
      const rejected = (why) => record(store, { actor: "visitor", action: "admin.code-rejected", ip: requestIp(context.request), summary: `Admin code not accepted: ${why}` });
      if (!live.length && spent) {
        await rejected("too many attempts");
        return retry("Too many attempts. Request a new code.", 429);
      }
      if (!live.length) {
        await rejected("no code was live");
        return retry("That code has expired. Request a new one from the Admin button.", 401);
      }
      let matched = null;
      if (/^\d{6}$/u.test(code)) {
        for (const challenge of live) {
          if (await constantTimeMatches(await sha256Hex(`${code}:${challenge.id}`), challenge.hash)) matched = challenge;
        }
      }
      if (!matched) {
        await rejected("it did not match");
        return retry("That code did not match. Check the email and try again.", 401);
      }

      await deleteAdminChallenge(store, matched.id);
      await record(store, { actor: "admin", action: "admin.signed-in", ip: requestIp(context.request), summary: "Signed in to the admin panel" });
      return redirectResponse("/clients/admin", await createAdminSession(sessionSecret));
    }

    if (pathname === "/clients/admin/logout") {
      if (method !== "POST") return methodNotAllowedResponse(["POST"]);
      return redirectResponse("/clients", expiredAdminSession());
    }

    // Admin panel.
    if (pathname === "/clients/admin" || pathname.startsWith("/clients/admin/")) {
      if (!admin) return redirectResponse("/clients");

      const dashboard = async ({ requested, notice = noticeFromQuery(url), newClient = null, clientError = "", typedEmails = null, status = 200 }) => {
        // Invoice numbers follow the invoice dates (the same date: the order they were entered).
        // Anything saved before that rule, or changed outside the portal, is put in order here.
        const moved = store ? await renumberInvoices(store) : [];
        if (moved.length) {
          await noteRenumbered(store, moved.length);
          notice = { text: [notice?.text, NOTICES.renumbered.text].filter(Boolean).join(" "), tone: notice?.tone };
        }
        const clients = await listClients(store);
        const selected = clients.find((entry) => entry.slug === requested) || null;
        const [billing, documents, templates, recipients, expenses, accounts, paidTo, selectedLogin, photos] = await Promise.all([
          selected ? listBilling(store, selected.slug) : [],
          selected ? listDocuments(store, selected.slug) : [],
          listTemplates(store),
          listRecipients(store),
          selected ? listExpenses(store, selected.slug) : [],
          selected ? listBankAccounts(store) : [],
          selected ? expensePaidTo(store) : [],
          keptLogin(env, store, selected),
          selected ? listPhotos(store, selected.slug) : []
        ]);
        return scriptedHtmlResponse(adminDashboardPage({
          clients, selected, billing, documents, templates, recipients, readiness, notice, authenticated, newClient, clientError, typedEmails,
          expenses, payers: paidWithOptions(accounts), paidTo, selectedLogin, photos, today: todayInMichigan()
        }), status);
      };

      if (isRead && pathname === "/clients/admin") return dashboard({ requested: url.searchParams.get("client") });

      if (!store) return redirectResponse("/clients/admin?notice=invalid");

      if (pathname === "/clients/admin/books" || pathname.startsWith("/clients/admin/books/")) return handleBooks(context, store, pathname, url);
      if (pathname === "/clients/admin/labor" || pathname.startsWith("/clients/admin/labor/")) return handleAdminLabor({ ...context, kit: KIT }, store, pathname, url);
      if (pathname === "/clients/admin/bank" || pathname.startsWith("/clients/admin/bank/")) return handleAdminBank({ ...context, kit: KIT }, store, pathname, url);
      if (/^\/clients\/admin\/(schedule|notes)(\/|$)/u.test(pathname)) return handleAdminTeam({ ...context, kit: KIT }, store, pathname, url);

      // Share a document into any client portal's section, and see what awaits a signature.
      if (pathname === "/clients/admin/documents") {
        const clients = await listClients(store);
        if (isRead) {
          const known = new Set(clients.map((entry) => entry.slug));
          const documents = (await listAllDocuments(store)).filter((document) => known.has(document.clientSlug));
          return htmlResponse(adminDocumentsPage({ clients, documents, notice: noticeFromQuery(url) }));
        }
        if (method !== "POST") return methodNotAllowedResponse(["GET", "HEAD", "POST"]);
        const form = await readBoundedMultipart(context.request, MAX_UPLOAD_BYTES + 4096);
        const target = clients.find((entry) => entry.slug === String(form?.get("client") || ""));
        if (!form || !target) return redirectResponse("/clients/admin/documents?notice=invalid");
        const result = await storeUpload(store, target.slug, form.get("file"), "admin", {
          section: form.get("section"),
          requiresClientSignature: form.get("requiresClientSignature") === "yes",
          requiresAdminSignature: form.get("requiresAdminSignature") === "yes"
        });
        return redirectResponse(`/clients/admin/documents?notice=${result.error || "document-shared"}`);
      }

      const templateMatch = pathname.match(/^\/clients\/admin\/templates(?:\/([^/]+))?(?:\/(delete))?$/u);
      if (templateMatch) return handleAdminTemplates(context, store, templateMatch[1] ? decodeSegment(templateMatch[1]) : "", templateMatch[2] || "");

      // A problem is explained next to the form, which keeps what was typed (except the login).
      if (method === "POST" && pathname === "/clients/admin/clients") {
        const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
        // Projects go by their names; the address id is made from the name (a number is added when
        // another project has it). Without a login a project is not client facing: only the admin
        // sees it.
        const entered = {
          name: String(form?.get("name") || "").trim(),
          emails: String(form?.get("emails") || "").trim(),
          siteAddress: String(form?.get("siteAddress") || "").trim().replaceAll(/\s+/gu, " "),
          readOnly: form?.get("readOnly") === "yes"
        };
        const clientPassword = String(form?.get("password") || "");
        let slug = slugify(entered.name);
        const emails = parseEmailList(entered.emails);
        let clientError = "";
        if (!form) clientError = "The form could not be read. Please try again.";
        else if (!entered.name || entered.name.length > 120) clientError = "Enter the client or project name, up to 120 characters.";
        else if (!isValidSlug(slug)) clientError = "Enter a name with letters or numbers, for example Smith Residence.";
        else if (clientPassword && (clientPassword.length < 10 || clientPassword.length > 120)) clientError = "The project login needs 10 to 120 characters, or leave it blank to keep the project admin only.";
        else if (entered.siteAddress.length > 200) clientError = "Keep the job site address under 200 characters.";
        // The emails are optional, so only addresses that were typed are checked.
        else if (emails.addresses.length || emails.invalid.length) clientError = recipientProblem(emails);
        // Each login must open exactly one portal.
        if (!clientError && clientPassword && (await resolveLogin(env, store, clientPassword))) clientError = "That project login already opens another client portal. Choose a different login.";
        if (clientError) return dashboard({ requested: null, newClient: entered, clientError, status: 400 });
        const stem = slug.slice(0, 58).replace(/-+$/u, "");
        for (let number = 2; slug === DEFAULT_CLIENT_SLUG || (await getClient(store, slug)); number += 1) slug = `${stem}-${number}`;

        await putClient(store, {
          slug, name: entered.name, emails: emails.addresses, active: true, passwordHash: clientPassword ? await hashPassword(clientPassword) : null,
          ...(entered.siteAddress ? { siteAddress: entered.siteAddress } : {}), ...(entered.readOnly ? { readOnly: true } : {}), createdAt: new Date().toISOString()
        });
        if (clientPassword) await keepLogin(env, store, slug, clientPassword);
        await record(store, { actor: "admin", action: "client.created", clientSlug: slug, ip: requestIp(context.request), summary: `Created the ${clientPassword ? "client portal" : "admin-only project"} ${entered.name}${emails.addresses.length ? ` for ${emails.addresses.join(", ")}` : ""}${entered.readOnly ? " (read only)" : ""}` });
        return redirectResponse(`/clients/admin?client=${encodeURIComponent(slug)}&notice=${clientPassword ? "client-added" : "client-added-private"}`);
      }

      const adminMatch = pathname.match(/^\/clients\/admin\/clients\/([^/]+)\/(billing|documents|profile|site|login|group|access|payments|expenses|photos|gallery)(?:\/([^/]+))?(?:\/([a-z-]+))?$/u);
      if (adminMatch) {
        const [, slugRaw, area, idRaw, action] = adminMatch;
        const slug = decodeSegment(slugRaw);
        const target = isValidSlug(slug) ? await getClient(store, slug) : null;
        if (!target) return notFoundResponse(session, admin);
        const back = `/clients/admin?client=${encodeURIComponent(slug)}`;
        const id = idRaw ? decodeSegment(idRaw) : "";

        if (area === "billing") return handleAdminBilling(context, store, target, id, action || "", readiness, origin);

        // Add expense: a cost of this job (the page without scripts; the list opens the same form in
        // a popup), its receipt, and deleting it (which takes it out of the books).
        if (area === "expenses") {
          if ((id === "new" && !action) || (!id && !action)) {
            const payers = paidWithOptions(await listBankAccounts(store));
            if (id === "new") {
              if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
              return scriptedHtmlResponse(adminAddExpensePage({ client: target, payers, today: todayInMichigan(), paidTo: await expensePaidTo(store), notice: noticeFromQuery(url) }));
            }
            if (method !== "POST") return methodNotAllowedResponse(["POST"]);
            const form = await readBoundedMultipart(context.request, MAX_UPLOAD_BYTES + 8192);
            const result = form ? await addExpense({ store, target, form, payers, ip: requestIp(context.request) }) : "invalid";
            return redirectResponse(`${back}&notice=${result}`);
          }
          const expense = await getExpense(store, slug, id);
          if (!expense) return notFoundResponse(session, admin);
          if (action === "receipt") {
            if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
            const object = expense.receipt ? await getFile(store, expense.receipt.key) : null;
            return object ? fileResponse(object, expense.receipt.name, expense.receipt.type) : notFoundResponse(session, admin);
          }
          if (action === "delete") {
            if (method !== "POST") return methodNotAllowedResponse(["POST"]);
            await removeExpense(store, expense, { ip: requestIp(context.request), jobName: target.name });
            return redirectResponse(`${back}&notice=expense-deleted`);
          }
          return notFoundResponse(session, admin);
        }

        // Add payment: a payment toward any open invoice of this project (the page without scripts;
        // the list opens the same form in a popup).
        if (area === "payments" && !action && (id === "new" || !id)) {
          const billing = await listBilling(store, slug);
          if (id === "new") {
            if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
            return scriptedHtmlResponse(adminAddPaymentPage({ client: target, billing, readiness, selected: url.searchParams.get("invoice") || "", notice: noticeFromQuery(url) }));
          }
          if (method !== "POST") return methodNotAllowedResponse(["POST"]);
          const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
          const item = billing.find((entry) => entry.id === String(form?.get("invoice") || "") && entry.kind === "invoice");
          if (!form || !item) return redirectResponse(`${back}&notice=payment-invoice-required`);
          const admin = { actor: "admin", ip: requestIp(context.request) };
          const notice = await addPayment({ env, store, target, item, form, readiness, origin, note: (event) => record(store, { ...admin, ...event }) });
          return redirectResponse(`${back}&notice=${notice}`);
        }

        // The project's email list: saving an empty field clears it.
        if (area === "profile" && !id && !action) {
          if (method !== "POST") return methodNotAllowedResponse(["POST"]);
          const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
          if (!form) return redirectResponse(`${back}&notice=invalid`);
          const typed = String(form.get("emails") || "").trim();
          const emails = parseEmailList(typed);
          const problem = emails.addresses.length || emails.invalid.length ? recipientProblem(emails) : "";
          if (problem) return dashboard({ requested: slug, notice: { text: problem, tone: "error" }, typedEmails: typed, status: 400 });
          const saved = clientEmails(target);
          if (saved.join("\n") !== emails.addresses.join("\n") || !Array.isArray(target.emails)) {
            await putClient(store, withClientEmails(target, emails.addresses));
            await record(store, { actor: "admin", action: "client.emails-saved", clientSlug: slug, ip: requestIp(context.request), summary: `Saved the emails for ${target.name}: ${emails.addresses.join(", ") || "none"}` });
          }
          return redirectResponse(`${back}&notice=client-updated`);
        }

        // The project's client login: set it to make an admin-only project client facing, or
        // change it. Each login opens one portal, or the projects under it (a login group), and
        // a new login on any of those changes it for all of them.
        if (area === "login" && !id && !action) {
          if (method !== "POST") return methodNotAllowedResponse(["POST"]);
          if (target.managedBySecret) return redirectResponse(`${back}&notice=invalid`);
          const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
          const login = String(form?.get("login") || "");
          if (login.length < 10 || login.length > 120) return redirectResponse(`${back}&notice=login-invalid`);
          const members = loginGroupOf(await listClients(store), target);
          const memberSlugs = new Set(members.map((member) => member.slug));
          if ((await loginOwners(env, store, login)).some((owner) => !memberSlugs.has(owner))) return redirectResponse(`${back}&notice=login-taken`);
          const passwordHash = await hashPassword(login);
          for (const member of members) {
            await putClient(store, { ...member, passwordHash });
            await keepLogin(env, store, member.slug, login);
            await record(store, {
              actor: "admin", action: "client.login-saved", clientSlug: member.slug, ip: requestIp(context.request),
              summary: `${member.passwordHash ? "Changed the client login for" : "Gave a client login to"} ${member.name}${members.length > 1 ? ` (shared with ${members.filter((other) => other.slug !== member.slug).map((other) => other.name).join(", ")})` : ""}`
            });
          }
          return redirectResponse(`${back}&notice=login-saved`);
        }

        // Projects under this login: the projects checked share this project's login (one login
        // group: the same `loginGroup`, login hash and sealed login). A project unchecked from the
        // group is left with no login, admin only, until it is given its own. The Muskegon project
        // (its login is a secret in Render) is never grouped.
        if (area === "group" && !id && !action) {
          if (method !== "POST") return methodNotAllowedResponse(["POST"]);
          if (target.managedBySecret) return redirectResponse(`${back}&notice=invalid`);
          const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
          if (!form) return redirectResponse(`${back}&notice=invalid`);
          const clients = await listClients(store);
          const eligible = new Map(clients.filter((entry) => entry.slug !== slug && !entry.managedBySecret).map((entry) => [entry.slug, entry]));
          const chosen = [...new Set(form.getAll("projects").map(String))];
          if (chosen.some((entry) => !eligible.has(entry))) return redirectResponse(`${back}&notice=project-invalid`);
          if (chosen.length && !target.passwordHash) return redirectResponse(`${back}&notice=group-needs-login`);
          const groupId = target.loginGroup || randomId(9);
          const ip = requestIp(context.request);
          const login = await keptLogin(env, store, target);
          const current = target.loginGroup ? clients.filter((entry) => entry.loginGroup === target.loginGroup && entry.slug !== slug) : [];
          const joining = chosen.map((entry) => eligible.get(entry)).filter((entry) => !target.loginGroup || entry.loginGroup !== target.loginGroup);
          const leaving = current.filter((entry) => !chosen.includes(entry.slug));
          // Groups a joining project leaves behind.
          const leftBehind = new Set(joining.map((entry) => entry.loginGroup).filter((group) => group && group !== groupId));
          for (const entry of joining) {
            await putClient(store, { ...entry, loginGroup: groupId, passwordHash: target.passwordHash });
            if (login) await keepLogin(env, store, entry.slug, login);
            else await forgetLogin(store, entry.slug);
            await record(store, { actor: "admin", action: "client.login-grouped", clientSlug: entry.slug, ip, summary: `Put ${entry.name} under the client login of ${target.name}` });
          }
          for (const entry of leaving) {
            const { loginGroup: _group, ...rest } = entry;
            await putClient(store, { ...rest, passwordHash: null });
            await forgetLogin(store, entry.slug);
            await record(store, { actor: "admin", action: "client.login-ungrouped", clientSlug: entry.slug, ip, summary: `Took ${entry.name} out from under the client login of ${target.name}; it is admin only until it is given its own login` });
          }
          if ((chosen.length > 0) !== Boolean(target.loginGroup)) {
            const { loginGroup: _group, ...rest } = target;
            await putClient(store, chosen.length ? { ...target, loginGroup: groupId } : rest);
          }
          // A group left with one project is no longer a group.
          if (leftBehind.size) {
            const after = await listClients(store);
            for (const group of leftBehind) {
              const left = after.filter((other) => other.loginGroup === group);
              if (left.length !== 1) continue;
              const { loginGroup: _group, ...rest } = left[0];
              await putClient(store, rest);
            }
          }
          return redirectResponse(`${back}&notice=group-saved`);
        }

        // The gallery's master switch: Show photos in the client portal (all of them, or none).
        if (area === "gallery" && !id && !action) {
          if (method !== "POST") return methodNotAllowedResponse(["POST"]);
          const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
          if (!form) return redirectResponse(`${back}&notice=invalid`);
          const photosVisible = form.get("shown") === "yes";
          if (photosVisible !== (target.photosVisible !== false)) {
            await putClient(store, { ...target, photosVisible });
            await record(store, { actor: "admin", action: photosVisible ? "photos.shown" : "photos.hidden", clientSlug: slug, ip: requestIp(context.request), summary: `${photosVisible ? "Showed the photos in" : "Hid all photos from"} ${target.name}'s client portal` });
          }
          return redirectResponse(`${back}&notice=gallery-saved#gallery`);
        }

        // The gallery: add photos with a note, open one, show or hide one, delete one.
        if (area === "photos") {
          if (!id && !action) {
            if (method !== "POST") return methodNotAllowedResponse(["POST"]);
            const form = await readBoundedMultipart(context.request, MAX_PHOTO_BATCH_BYTES);
            const result = form ? await storePhotos(store, target, form, { uploadedBy: "admin", uploaderName: "My Home Builder", ip: requestIp(context.request) }) : { error: "photos-invalid" };
            return redirectResponse(`${back}&notice=${result.error || "photos-added#gallery"}`);
          }
          const photo = await getPhoto(store, id);
          if (!photo || photo.clientSlug !== slug) return notFoundResponse(session, admin);
          if (!action) {
            if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
            return (await photoResponse(store, photo)) || notFoundResponse(session, admin);
          }
          if (action !== "shown" && action !== "delete") return notFoundResponse(session, admin);
          if (method !== "POST") return methodNotAllowedResponse(["POST"]);
          const ip = requestIp(context.request);
          if (action === "shown") {
            const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
            if (!form) return redirectResponse(`${back}&notice=invalid`);
            const hidden = form.get("shown") !== "yes";
            if (hidden !== Boolean(photo.hidden)) {
              await putPhoto(store, { ...photo, hidden, updatedAt: new Date().toISOString() });
              await record(store, { actor: "admin", action: hidden ? "photo.hidden" : "photo.shown", clientSlug: slug, ip, data: { photoId: photo.id }, summary: `${hidden ? "Hid" : "Showed"} the photo ${photoTitle(photo)} ${hidden ? "from" : "in"} ${target.name}'s client portal` });
            }
            return redirectResponse(`${back}&notice=gallery-saved#gallery`);
          }
          await deletePhoto(store, photo);
          await record(store, { actor: "admin", action: "photo.deleted", clientSlug: slug, ip, data: { photoId: photo.id }, summary: `Deleted the photo ${photoTitle(photo)} from the gallery of ${target.name}` });
          return redirectResponse(`${back}&notice=photo-deleted#gallery`);
        }

        // Display all data to client portal (read only): the client sees every figure and can
        // do nothing (handlePortalRequest refuses paying, accepting, uploads and documents).
        if (area === "access" && !id && !action) {
          if (method !== "POST") return methodNotAllowedResponse(["POST"]);
          const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
          if (!form) return redirectResponse(`${back}&notice=invalid`);
          const readOnly = form.get("readOnly") === "yes";
          if (readOnly !== Boolean(target.readOnly)) {
            await putClient(store, { ...target, readOnly });
            await record(store, { actor: "admin", action: readOnly ? "client.read-only" : "client.read-write", clientSlug: slug, ip: requestIp(context.request), summary: `${readOnly ? "Showed all data, read only, in" : "Turned off read only for"} ${target.name}'s client portal` });
          }
          return redirectResponse(`${back}&notice=access-saved`);
        }

        // The job site's address, printed on subcontractors' lien waivers for this job.
        if (area === "site" && !id && !action) {
          if (method !== "POST") return methodNotAllowedResponse(["POST"]);
          const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
          const siteAddress = String(form?.get("siteAddress") || "").trim().replaceAll(/\s+/gu, " ");
          if (!form || siteAddress.length > 200) return redirectResponse(`${back}&notice=invalid`);
          if (siteAddress !== (target.siteAddress || "")) {
            await putClient(store, { ...target, siteAddress });
            await record(store, { actor: "admin", action: "client.site-saved", clientSlug: slug, ip: requestIp(context.request), summary: `Saved the job site address for ${target.name}: ${siteAddress || "none"}` });
          }
          return redirectResponse(`${back}&notice=site-saved`);
        }

        if (area === "documents" && !id && !action && method === "POST") {
          const form = await readBoundedMultipart(context.request, MAX_UPLOAD_BYTES + 4096);
          const result = form
            ? await storeUpload(store, slug, form.get("file"), "admin", {
              section: form.get("section"),
              requiresClientSignature: form.get("requiresClientSignature") === "yes",
              requiresAdminSignature: form.get("requiresAdminSignature") === "yes"
            })
            : { error: "upload-failed" };
          return redirectResponse(`${back}&notice=${result.error || "document-shared"}`);
        }

        if (area === "documents" && id && (!action || action === "sign")) {
          const document = await getDocument(store, slug, id);
          if (!document) return notFoundResponse(session, admin);
          const signPath = `/clients/admin/clients/${encodeURIComponent(slug)}/documents/${encodeURIComponent(id)}/sign`;
          const downloadPath = `/clients/admin/clients/${encodeURIComponent(slug)}/documents/${encodeURIComponent(id)}`;

          if (!action && isRead) {
            const response = await documentDownload(store, document);
            return response || notFoundResponse(session, admin);
          }
          if (action === "sign" && isRead) {
            return htmlResponse(signPage({ document, party: "admin", actionPath: signPath, backPath: downloadPath, admin: true, authenticated }), 200, undefined, { scripts: true });
          }
          if (action === "sign" && method === "POST") {
            const form = await readBoundedForm(context.request, MAX_SIGN_FORM_BYTES);
            const result = form ? await applySignature(store, document, "admin", form, context.request) : { error: "The signature could not be read." };
            if (result.error) {
              return htmlResponse(signPage({ document, party: "admin", actionPath: signPath, backPath: downloadPath, error: result.error, admin: true, authenticated }), 400, undefined, { scripts: true });
            }
            return redirectResponse(`${back}&notice=signed`);
          }
          return methodNotAllowedResponse(action === "sign" ? ["GET", "HEAD", "POST"] : ["GET", "HEAD"]);
        }
      }

      return notFoundResponse(session, admin);
    }

    // Client billing and documents (require a client session and configured storage).
    if (pathname.startsWith("/clients/billing/") || pathname.startsWith("/clients/documents")) {
      if (!authenticated) return redirectResponse("/clients");
      if (!store) return htmlResponse(portalHomePage({ client, billing: [], documents: [], storeReady: false, admin }), 503);

      const billingMatch = pathname.match(/^\/clients\/billing\/([^/]+)(?:\/(pay|return|accept))?$/u);
      if (billingMatch) {
        const [, idRaw, action] = billingMatch;
        const item = await getBilling(store, client.slug, decodeSegment(idRaw));
        if (!item) return notFoundResponse(session, admin);
        const detailPath = `/clients/billing/${encodeURIComponent(item.id)}`;

        if (!action && isRead) {
          return scriptedHtmlResponse(billingDetailPage({ client, item, stripeReady: readiness.stripe, admin, notice: noticeFromQuery(url) }));
        }
        // A read-only project's client can look but not pay or accept.
        if ((action === "pay" || action === "accept") && method === "POST" && client.readOnly) return redirectResponse(`${detailPath}?notice=read-only`);
        if (action === "pay" && method === "POST") {
          if (!isPayable(item) || !readiness.stripe) return redirectResponse(detailPath);
          try {
            return redirectResponse(await checkoutUrl(env, store, item, client, {
              successUrl: `${origin}${detailPath}/return?session_id={CHECKOUT_SESSION_ID}`,
              cancelUrl: `${origin}${detailPath}`
            }));
          } catch (error) {
            console.error(JSON.stringify({ message: "stripe checkout could not start", invoice: item.id, error: error instanceof Error ? error.message : "Unknown error" }));
            return redirectResponse(`${detailPath}?notice=checkout-failed`);
          }
        }
        if (action === "return" && isRead) {
          const result = await confirmReturn(env, store, item, url.searchParams.get("session_id") || "", origin);
          return redirectResponse(`${detailPath}?notice=${result}`);
        }
        if (action === "accept" && method === "POST") {
          const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
          await acceptQuote(env, store, item, client, acceptedName(form), "portal", origin);
          return redirectResponse(`${detailPath}?notice=accepted`);
        }
        return methodNotAllowedResponse(action === "pay" || action === "accept" ? ["POST"] : ["GET", "HEAD"]);
      }

      // A read-only project has no uploads and no documents to open or sign.
      if (client.readOnly && pathname.startsWith("/clients/documents")) {
        return method === "POST" || isRead ? redirectResponse("/clients?notice=read-only") : methodNotAllowedResponse(["GET", "HEAD", "POST"]);
      }

      if (pathname === "/clients/documents/upload") {
        if (method !== "POST") return methodNotAllowedResponse(["POST"]);
        const form = await readBoundedMultipart(context.request, MAX_UPLOAD_BYTES + 4096);
        const result = form ? await storeUpload(store, client.slug, form.get("file"), "client", {}) : { error: "upload-failed" };
        return redirectResponse(`/clients?notice=${result.error || "uploaded"}`);
      }

      const documentMatch = pathname.match(/^\/clients\/documents\/([^/]+)(?:\/(sign))?$/u);
      if (documentMatch) {
        const [, idRaw, action] = documentMatch;
        const document = await getDocument(store, client.slug, decodeSegment(idRaw));
        if (!document) return notFoundResponse(session, admin);
        const downloadPath = `/clients/documents/${encodeURIComponent(document.id)}`;
        const signPath = `${downloadPath}/sign`;

        if (!action && isRead) {
          const response = await documentDownload(store, document);
          return response || notFoundResponse(session, admin);
        }
        if (action === "sign" && isRead) {
          if (!document.requiresClientSignature) return redirectResponse("/clients");
          return htmlResponse(signPage({ document, party: "client", actionPath: signPath, backPath: downloadPath, admin }), 200, undefined, { scripts: true });
        }
        if (action === "sign" && method === "POST") {
          if (!document.requiresClientSignature) return redirectResponse("/clients");
          const form = await readBoundedForm(context.request, MAX_SIGN_FORM_BYTES);
          const result = form ? await applySignature(store, document, "client", form, context.request) : { error: "The signature could not be read." };
          if (result.error) {
            return htmlResponse(signPage({ document, party: "client", actionPath: signPath, backPath: downloadPath, error: result.error, admin }), 400, undefined, { scripts: true });
          }
          return redirectResponse("/clients?notice=signed");
        }
        return methodNotAllowedResponse(action === "sign" ? ["GET", "HEAD", "POST"] : ["GET", "HEAD"]);
      }
    }

    return notFoundResponse(session, admin);
  } catch (error) {
    console.error(JSON.stringify({
      message: "client portal request failed",
      path: pathname,
      error: error instanceof Error ? error.message : "Unknown error"
    }));
    return htmlResponse(serviceUnavailablePage(), 500);
  }
}
