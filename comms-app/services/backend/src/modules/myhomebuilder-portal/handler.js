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
  deleteTemplate,
  getBilling,
  getBillingById,
  getClient,
  getDocument,
  getFile,
  getSentEmail,
  getShareLink,
  getTemplate,
  listAllDocuments,
  listBilling,
  listClients,
  listDocuments,
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
  parseEmailList,
  paymentFailedMessage,
  paymentReceiptMessage,
  quoteAcceptedMessage,
  sendEmail
} from "./email.js";
import {
  MIN_INVOICE_CENTS,
  addDays,
  billingLabel,
  billingLineItems,
  issuedDate,
  isEditable,
  isPayable,
  parseBillingForm,
  parseManualPayment,
  todayInMichigan
} from "./billing.js";
import { formatDate, money } from "./format.js";
import { isPdf, signDocument } from "./pdf.js";
import { activityCsv, booksReport, checkBooks, correctBooks, ledgerCsv, record } from "./books.js";
import { CLIENT_UPLOADS, parseSection, sectionName } from "./documents.js";
import {
  adminBillingPage,
  adminBooksPage,
  adminDashboardPage,
  adminDocumentsPage,
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
    if (destination.pathname !== PROJECT_PATH && !destination.pathname.startsWith(`${PROJECT_PATH}/`)) return "";
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
  "client-exists": { text: "A client portal with that id already exists.", tone: "error" },
  "client-updated": { text: "Client emails saved." },
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
  "files-not-configured": { text: "File storage is not configured, so documents cannot be stored yet.", tone: "error" }
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

async function resolveLogin(env, store, suppliedPassword) {
  if (typeof suppliedPassword !== "string" || !suppliedPassword) return null;
  if (await constantTimeMatches(suppliedPassword, env.CLIENT_PORTAL_PASSWORD)) return DEFAULT_CLIENT_SLUG;
  if (!store) return null;
  for (const client of await listClients(store)) {
    if (!client.passwordHash || client.active === false) continue;
    if (await verifyPassword(suppliedPassword, client.passwordHash)) return client.slug;
  }
  return null;
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
  return (!Number.isInteger(session.amount_total) || session.amount_total === invoice.amountCents)
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
        summary: `Stripe took ${money(amountCents, session.currency || invoice.currency)} for ${billingLabel(invoice)}, which totals ${money(invoice.amountCents, invoice.currency)}; not applied`,
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
        amountCents: Number.isInteger(session.amount_total) ? session.amount_total : invoice.amountCents,
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
  if (invoice.checkoutSessionId && invoice.checkoutSuccessUrl === successUrl && invoice.checkoutAmountCents === invoice.amountCents && invoice.checkoutNumber === invoice.number && (invoice.checkoutExpiresAt || 0) > now + 300) {
    const existing = await retrieveCheckoutSession(env, invoice.checkoutSessionId).catch(() => null);
    if (existing?.status === "open" && existing.url) return existing.url;
  }
  const session = await createCheckoutSession(env, { invoice, client, successUrl, cancelUrl });
  await record(store, { actor: "client", action: "stripe.checkout", item: invoice, amountCents: invoice.amountCents, summary: `Opened Stripe Checkout for ${billingLabel(invoice)} (${money(invoice.amountCents, invoice.currency)})`, data: { session: session.id } });
  await putBilling(store, {
    ...invoice,
    checkoutSessionId: session.id,
    checkoutExpiresAt: session.expires_at || now + 23 * 60 * 60,
    checkoutSuccessUrl: successUrl,
    checkoutAmountCents: invoice.amountCents,
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

async function storeUpload(store, slug, file, uploadedBy, flags) {
  if (!store.files) return { error: "files-not-configured" };
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
    section: uploadedBy === "admin" ? parseSection(flags.section) : CLIENT_UPLOADS,
    signatures: [],
    signedKey: null
  };
  await putDocument(store, document);
  await record(store, { actor: uploadedBy === "admin" ? "admin" : "client", action: "document.uploaded", clientSlug: slug, summary: uploadedBy === "admin" ? `Shared ${name} with the client in ${sectionName(document.section, "admin")}${document.requiresClientSignature ? ", to sign" : ""}` : `The client uploaded ${name}`, data: { documentId: id } });
  return { document };
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
  await record(store, { actor: party === "admin" ? "admin" : "client", ip: signature.ip, action: "document.signed", clientSlug: document.clientSlug, summary: `${name} signed ${document.name}${party === "admin" ? " for My Home Builder" : ""}`, data: { documentId: document.id, party } });
  return { document: updated };
}

async function documentDownload(store, document) {
  const key = document.signedKey || document.key;
  const object = await getFile(store, key);
  if (!object) return null;
  const name = document.signedKey ? `${document.name.replace(/\.pdf$/iu, "")}-signed.pdf` : document.name;
  return fileResponse(object, name, document.contentType);
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
    const echo = { ...parsed.values, saveTemplate, sendNow };
    if (parsed.error) return renderError(echo, parsed.error);
    if (saveTemplate && (!parsed.values.templateName || parsed.values.templateName.length > 80)) return renderError(echo, "Give the template a name of 80 characters or fewer, or untick Also save this as a template.");

    // Saved (and numbered in date order) before it is emailed, so the email carries its number.
    const saved = await saveNewBillingItem(store, await buildBillingItem(store, target, parsed.values), { context: admin });
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
    if (item.checkoutSessionId && parsed.values.amountCents !== item.amountCents) await expireCheckoutSession(env, item.checkoutSessionId);
    const { title, description, lineItems, amountCents, dueDate } = parsed.values;
    const issuedOn = parsed.values.issuedOn || issuedDate(item);
    // A payment recorded by hand is the invoice paid in full, so its amount follows the new total.
    // A Stripe payment keeps the amount Stripe charged.
    const payment = item.payment?.source === "manual" ? { payment: { ...item.payment, amountCents } } : {};
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
    if (item.status === "open") {
      if (item.checkoutSessionId) await expireCheckoutSession(env, item.checkoutSessionId);
      const voided = { ...item, status: "void", voidedAt: new Date().toISOString() };
      await putBilling(store, voided);
      await note({ action: `${item.kind}.voided`, item: voided, reason: "voided", amountCents: item.amountCents, summary: `Voided ${billingLabel(item)} · ${money(item.amountCents, item.currency)}` });
    }
    return redirectResponse(`${itemPath}?notice=voided`);
  }

  // Marked paid from the invoice page, or from the admin list's status popup (return=list),
  // which goes back to the list.
  if (action === "record-payment") {
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const back = (notice) => redirectResponse(form?.get("return") === "list" ? `/clients/admin?client=${encodeURIComponent(slug)}&notice=${notice}` : `${itemPath}?notice=${notice}`);
    if (item.kind !== "invoice" || item.status !== "open") return back("not-payable");
    const entered = parseManualPayment(form);
    if (entered.error) return back(entered.error);
    if (item.checkoutSessionId) await expireCheckoutSession(env, item.checkoutSessionId);
    const { paidOn, ...details } = entered;
    const updated = await withShareToken(store, {
      ...item,
      status: "paid",
      paidAt: paidOn,
      payment: { source: "manual", ...details, amountCents: item.amountCents, recordedAt: new Date().toISOString() }
    });
    await putBilling(store, updated);
    await note({ action: "payment.recorded", item: updated, amountCents: updated.payment.amountCents, summary: `Recorded a ${updated.payment.label} payment of ${money(updated.payment.amountCents, updated.currency)} for ${billingLabel(updated)}, received ${formatDate(updated.paidAt)}` });
    let notice = "payment-recorded";
    const receiptTo = clientEmails(target);
    if (form.get("sendReceipt") === "yes" && readiness.email && receiptTo.length) {
      const receipt = await sendOnce(env, store, sentKey(updated, "receipt"), receiptMessage(env, updated, target, receiptTo, origin), { remember: true });
      if (receipt.ok) {
        notice = "payment-recorded-receipt";
        await note({ action: "receipt.emailed", item: updated, summary: `Emailed the receipt for ${billingLabel(updated)} to ${receiptTo.join(", ")}` });
      }
    }
    return back(notice);
  }

  // Corrects a payment recorded by hand (method, reference or date; the amount is the invoice
  // total). Stripe payments keep what Stripe recorded. The receipt is not re-sent; "Resend
  // receipt" sends the corrected one.
  if (action === "payment") {
    if (item.kind !== "invoice" || item.status !== "paid") return redirectResponse(itemPath);
    if (item.payment?.source !== "manual") return redirectResponse(`${itemPath}?notice=payment-from-stripe`);
    const entered = parseManualPayment(await readBoundedForm(context.request, MAX_FORM_BYTES));
    if (entered.error) return redirectResponse(`${itemPath}?notice=${entered.error}`);
    const { paidOn, ...details } = entered;
    const corrected = { ...item, paidAt: paidOn, payment: { ...item.payment, ...details, amountCents: item.amountCents, updatedAt: new Date().toISOString() } };
    await putBilling(store, corrected);
    const was = `${item.payment?.label || "payment"}, ${formatDate(item.paidAt)}`;
    const now = `${corrected.payment.label}, ${formatDate(corrected.paidAt)}`;
    await note({ action: "payment.corrected", item: corrected, amountCents: corrected.payment.amountCents, summary: `Changed the payment for ${billingLabel(item)}${was === now ? "" : `: ${was} → ${now}`}` });
    return redirectResponse(`${itemPath}?notice=payment-updated`);
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
  const check = await checkBooks(store);
  return htmlResponse(adminBooksPage({ report, check, clients, today: todayInMichigan(), notice: noticeFromQuery(url) }));
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

// context: { request, env }. env carries the portal settings under the names below; index.js
// maps them from the MHB_* environment variables.
export async function handlePortalRequest(context) {
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

    if (pathname === "/clients/stripe/webhook") {
      if (method !== "POST") return methodNotAllowedResponse(["POST"]);
      return handleWebhook(context, store, origin);
    }

    // Public quote and invoice links. The unguessable token in the path is the access key.
    const shareMatch = pathname.match(/^\/clients\/(invoice|pay|quote)\/([^/]+)(?:\/(return|accept))?$/u);
    if (shareMatch) return handleShare(context, store, shareMatch, origin);

    const session = await readClientSession(context.request, sessionSecret, DEFAULT_CLIENT_SLUG);
    const admin = await hasAdminSession(context.request, sessionSecret);
    const client = session ? await getClient(store, session.slug) : null;
    const authenticated = Boolean(session && client);

    if (isRead && (pathname === "/clients" || pathname === "/clients/login")) {
      const destination = safeProjectDestination(url.searchParams.get("next"));
      if (authenticated && destination) return redirectResponse(destination);
      if (authenticated && pathname === "/clients/login") return redirectResponse("/clients");
      if (!authenticated) return htmlResponse(loginPage(false, destination));

      const [billing, documents] = store ? await Promise.all([listBilling(store, client.slug), listDocuments(store, client.slug)]) : [[], []];
      return htmlResponse(portalHomePage({ client, billing, documents, storeReady: Boolean(store), admin, notice: noticeFromQuery(url) }));
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
      if (!store) return htmlResponse(adminRequestPage({ state: "storage-not-configured", authenticated }), 503);
      if (!readiness.email) return htmlResponse(adminRequestPage({ state: "email-not-configured", authenticated }), 503);
      if (!(await allowAdminRequest(store, requestIp(context.request) || "unknown"))) {
        return htmlResponse(adminRequestPage({ state: "rate-limited", authenticated }), 429);
      }

      const code = randomCode();
      const challengeId = randomId(16);
      await putAdminChallenge(store, challengeId, await sha256Hex(`${code}:${challengeId}`));
      const message = adminCodeMessage(code, requestIp(context.request), `${origin}/clients/admin/code`);
      const delivery = await sendEmail(env, { to: adminEmail(env), ...message, category: "admin-code" });
      if (!delivery.ok) {
        await deleteAdminChallenge(store, challengeId);
        return htmlResponse(adminRequestPage({ state: "send-failed", authenticated }), 502);
      }
      await record(store, { actor: "visitor", action: "admin.code-requested", ip: requestIp(context.request), summary: `Admin code emailed to ${adminEmail(env)}` });
      return htmlResponse(adminRequestPage({ state: "sent", authenticated }));
    }

    // Where a code is entered on any device, without asking for a new one.
    if (pathname === "/clients/admin/code") {
      if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
      if (admin) return redirectResponse("/clients/admin");
      return htmlResponse(adminRequestPage({ state: "code", authenticated }));
    }

    // A code works on any device, not just the one that asked for it: it is checked against every
    // code still live. Each attempt counts against all of them (claimAdminAttempt), so no code is
    // tried more than ADMIN_CODE_MAX_ATTEMPTS times, as when a code was tied to one page.
    if (pathname === "/clients/admin/verify") {
      if (method !== "POST") return methodNotAllowedResponse(["POST"]);
      if (!store) return htmlResponse(adminRequestPage({ state: "storage-not-configured", authenticated }), 503);
      const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
      const code = String(form?.get("code") || "").trim();
      const retry = (error, status) => htmlResponse(adminRequestPage({ state: "code", error, authenticated }), status);

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
        const clients = await listClients(store);
        const selected = clients.find((entry) => entry.slug === requested) || null;
        const [billing, documents, templates, recipients] = await Promise.all([
          selected ? listBilling(store, selected.slug) : [],
          selected ? listDocuments(store, selected.slug) : [],
          listTemplates(store),
          listRecipients(store)
        ]);
        return scriptedHtmlResponse(adminDashboardPage({
          clients, selected, billing, documents, templates, recipients, readiness, notice, authenticated, newClient, clientError, typedEmails
        }), status);
      };

      if (isRead && pathname === "/clients/admin") return dashboard({ requested: url.searchParams.get("client") });

      if (!store) return redirectResponse("/clients/admin?notice=invalid");

      if (pathname === "/clients/admin/books" || pathname.startsWith("/clients/admin/books/")) return handleBooks(context, store, pathname, url);

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
        const entered = {
          name: String(form?.get("name") || "").trim(),
          slug: String(form?.get("slug") || "").trim(),
          emails: String(form?.get("emails") || "").trim()
        };
        const clientPassword = String(form?.get("password") || "");
        const slug = slugify(entered.slug || entered.name);
        const emails = parseEmailList(entered.emails);
        let clientError = "";
        if (!form) clientError = "The form could not be read. Please try again.";
        else if (!entered.name || entered.name.length > 120) clientError = "Enter the client or project name, up to 120 characters.";
        else if (!isValidSlug(slug)) clientError = "Enter a portal id with letters or numbers, for example smith-residence.";
        else if (clientPassword.length < 10 || clientPassword.length > 120) clientError = "The project login needs 10 to 120 characters.";
        // The emails are optional, so only addresses that were typed are checked.
        else if (emails.addresses.length || emails.invalid.length) clientError = recipientProblem(emails);
        if (!clientError) {
          if (slug === DEFAULT_CLIENT_SLUG || (await getClient(store, slug))) clientError = `A client portal with the id ${slug} already exists. Choose a different portal id.`;
          // Each login must open exactly one portal.
          else if (await resolveLogin(env, store, clientPassword)) clientError = "That project login already opens another client portal. Choose a different login.";
        }
        if (clientError) return dashboard({ requested: null, newClient: { ...entered, slug: entered.slug ? slug : "" }, clientError, status: 400 });

        await putClient(store, { slug, name: entered.name, emails: emails.addresses, active: true, passwordHash: await hashPassword(clientPassword), createdAt: new Date().toISOString() });
        await record(store, { actor: "admin", action: "client.created", clientSlug: slug, ip: requestIp(context.request), summary: `Created the client portal ${entered.name}${emails.addresses.length ? ` for ${emails.addresses.join(", ")}` : ""}` });
        return redirectResponse(`/clients/admin?client=${encodeURIComponent(slug)}&notice=client-added`);
      }

      const adminMatch = pathname.match(/^\/clients\/admin\/clients\/([^/]+)\/(billing|documents|profile)(?:\/([^/]+))?(?:\/([a-z-]+))?$/u);
      if (adminMatch) {
        const [, slugRaw, area, idRaw, action] = adminMatch;
        const slug = decodeSegment(slugRaw);
        const target = isValidSlug(slug) ? await getClient(store, slug) : null;
        if (!target) return notFoundResponse(session, admin);
        const back = `/clients/admin?client=${encodeURIComponent(slug)}`;
        const id = idRaw ? decodeSegment(idRaw) : "";

        if (area === "billing") return handleAdminBilling(context, store, target, id, action || "", readiness, origin);

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
