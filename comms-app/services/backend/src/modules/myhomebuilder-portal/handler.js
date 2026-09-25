// The My Home Builder client portal (myhomebuilderllc.com/clients) as a fetch-style handler:
// it takes a Web Request whose URL is on the public site and returns a Web Response. index.js
// adapts Express requests from the site's forwarding Function (and Stripe's webhook) to it.
import { db } from "../../config/db.js";
import {
  ADMIN_CODE_MAX_ATTEMPTS,
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
  verifyPassword
} from "./security.js";
import {
  DEFAULT_CLIENT_SLUG,
  allowAdminRequest,
  claimSentEmail,
  completeSentEmail,
  createStore,
  deleteAdminChallenge,
  deleteTemplate,
  getAdminChallenge,
  getBilling,
  getClient,
  getDocument,
  getFile,
  getSentEmail,
  getShareLink,
  getTemplate,
  listBilling,
  listClients,
  listDocuments,
  listRecipients,
  listTemplates,
  nextBillingNumber,
  putAdminChallenge,
  putBilling,
  putClient,
  putDocument,
  putFile,
  putSentEmail,
  putShareLink,
  putTemplate,
  recordAdminAttempt,
  releaseSentEmail,
  rememberRecipient
} from "./store.js";
import {
  createCheckoutSession,
  expireCheckoutSession,
  retrieveCheckoutSession,
  retrievePaymentDetails,
  stripeConfigured,
  verifyWebhookSignature
} from "./stripe.js";
import {
  adminCodeMessage,
  adminEmail,
  adminPaidMessage,
  billingIssuedMessage,
  clientSender,
  duplicatePaymentMessage,
  emailConfigured,
  isValidEmail,
  paymentFailedMessage,
  paymentReceiptMessage,
  quoteAcceptedMessage,
  sendEmail
} from "./email.js";
import {
  MIN_INVOICE_CENTS,
  PAYMENT_METHODS,
  addDays,
  isEditable,
  isPayable,
  isValidDate,
  parseBillingForm,
  todayInMichigan
} from "./billing.js";
import { isPdf, signDocument } from "./pdf.js";
import {
  adminBillingPage,
  adminDashboardPage,
  adminRequestPage,
  adminTemplatesPage,
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
  "client-updated": { text: "Client email saved." },
  invalid: { text: "Please check the form and try again.", tone: "error" },
  voided: { text: "Marked void." },
  sent: { text: "Emailed to the client." },
  "send-failed": { text: "The email did not go out. Check the address and try again.", tone: "error" },
  "email-invalid": { text: "Enter a valid email address.", tone: "error" },
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
  "not-editable": { text: "Only open quotes and invoices can be edited.", tone: "error" },
  "name-required": { text: "Enter your name to accept the quote.", tone: "error" },
  "files-not-configured": { text: "File storage is not configured, so documents cannot be stored yet.", tone: "error" }
};

function noticeFromQuery(url) {
  const texts = [url.searchParams.get("notice"), url.searchParams.get("also")].map((code) => NOTICES[code]).filter(Boolean);
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
    status: "open",
    shareToken: randomId(24),
    createdAt: new Date().toISOString(),
    ...extra
  };
}

async function saveNewBillingItem(store, item) {
  await putShareLink(store, item.shareToken, item);
  await putBilling(store, item);
}

// Emails a quote or invoice. Returns the item with sentAt/sentTo set for the caller to save.
async function emailBillingItem(env, store, item, client, to, origin) {
  const links = shareLinks(origin, item);
  const message = billingIssuedMessage({ item, client, viewUrl: links.view, payUrl: item.kind === "invoice" && stripeConfigured(env) ? links.pay : "" });
  const delivery = await sendEmail(env, { to, ...message, ...clientSender(env), category: item.kind });
  if (!delivery.ok) return { ok: false, item };
  await remember(store, to);
  return { ok: true, item: { ...item, sentAt: new Date().toISOString(), sentTo: to } };
}

// Adds an address to the admin pick list. A failure here never fails the email it follows.
async function remember(store, address) {
  try {
    await rememberRecipient(store, address);
  } catch (error) {
    console.error(JSON.stringify({ message: "recipient not remembered", error: error instanceof Error ? error.message : "Unknown error" }));
  }
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
  const claim = await claimSentEmail(store, key, message.to);
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

function receiptRecipient(client, item) {
  const candidates = [client?.email, item.payment?.email];
  return candidates.find((value) => isValidEmail(value)) || "";
}

// With a webhook configured, only the webhook sends payment emails; the client's return from
// Checkout records the payment for the page it lands on. One sender per payment keeps each
// email to a single send.
function webhookConfigured(env) {
  return typeof env.STRIPE_WEBHOOK_SECRET === "string" && env.STRIPE_WEBHOOK_SECRET.length > 0;
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
      paidAt: new Date().toISOString(),
      stripeSessionId: session.id,
      payment: {
        source: "stripe",
        method: details?.method || "",
        label: details?.label || "",
        receiptUrl: details?.receiptUrl || "",
        email: session.customer_details?.email || session.customer_email || "",
        amountCents: Number.isInteger(session.amount_total) ? session.amount_total : invoice.amountCents,
        paymentIntentId: paymentIntentId || ""
      }
    };
    await putBilling(store, paid);
  }
  if (!notify) return paid;

  const receiptTo = receiptRecipient(client, paid);
  let receipt = null;
  if (receiptTo) {
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
  if (invoice.status !== "open") return invoice;
  const updated = { ...invoice, status: "processing", processingAt: new Date().toISOString(), stripeSessionId: session.id };
  await putBilling(store, updated);
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
  return updated;
}

// Reuses the invoice's open Checkout Session so two tabs or two clicks cannot start two payments.
async function checkoutUrl(env, store, invoice, client, { successUrl, cancelUrl }) {
  const now = Math.floor(Date.now() / 1000);
  if (invoice.checkoutSessionId && invoice.checkoutSuccessUrl === successUrl && invoice.checkoutAmountCents === invoice.amountCents && (invoice.checkoutExpiresAt || 0) > now + 300) {
    const existing = await retrieveCheckoutSession(env, invoice.checkoutSessionId).catch(() => null);
    if (existing?.status === "open" && existing.url) return existing.url;
  }
  const session = await createCheckoutSession(env, { invoice, client, successUrl, cancelUrl });
  await putBilling(store, {
    ...invoice,
    checkoutSessionId: session.id,
    checkoutExpiresAt: session.expires_at || now + 23 * 60 * 60,
    checkoutSuccessUrl: successUrl,
    checkoutAmountCents: invoice.amountCents
  });
  return session.url;
}

// Confirms a Checkout Session when the client comes back from Stripe. Errors are not shown to
// the client once Stripe says the payment went through; the webhook records the same payment.
async function confirmReturn(env, store, invoice, client, sessionId, origin) {
  if (invoice.status === "paid") return "paid";
  if (!stripeConfigured(env) || !CHECKOUT_SESSION_PATTERN.test(sessionId)) return "payment-pending";
  const checkout = await retrieveCheckoutSession(env, sessionId);
  const belongs = checkout?.metadata?.invoiceId === invoice.id && checkout?.metadata?.clientSlug === client.slug;
  if (!belongs) return "payment-pending";
  try {
    if (checkout.payment_status === "paid") {
      await settleStripePayment(env, store, invoice, checkout, origin, { notify: !webhookConfigured(env) });
      return "paid";
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
    const result = await confirmReturn(env, store, item, client, url.searchParams.get("session_id") || "", origin);
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

  const session = event.data?.object || {};
  const slug = session.metadata?.clientSlug;
  const invoiceId = session.metadata?.invoiceId;
  const handled = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"];
  if (handled.includes(event.type) && isValidSlug(slug) && typeof invoiceId === "string") {
    const invoice = await getBilling(store, slug, invoiceId);
    if (invoice && invoice.kind === "invoice") {
      try {
        if (event.type === "checkout.session.async_payment_failed") {
          await recordPaymentFailure(context.env, store, invoice, session, origin);
        } else if (session.payment_status === "paid") {
          await settleStripePayment(context.env, store, invoice, session, origin, { notify: true });
        } else if (event.type === "checkout.session.completed" && session.payment_status === "unpaid") {
          await markProcessing(store, invoice, session);
        }
      } catch (error) {
        if (!(error instanceof EmailDeliveryError)) throw error;
        console.error(JSON.stringify({ message: "payment email not sent; Stripe will retry the event", invoice: invoice.id, email: error.message }));
        return new Response("Email delivery failed; retry later", { status: 500 });
      }
    }
  }
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
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
    signatures: [],
    signedKey: null
  };
  await putDocument(store, document);
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

  if (id === "new" && !action) {
    if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
    const templates = await listTemplates(store);
    const template = url.searchParams.get("template") ? templates.find((entry) => entry.id === url.searchParams.get("template")) : null;
    const values = template ? editorValuesFromTemplate(template, today) : { kind: url.searchParams.get("kind") === "quote" ? "quote" : "invoice", lineItems: [] };
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

    let item = await buildBillingItem(store, target, parsed.values);
    let notice = "billing-added";
    if (sendNow && readiness.email && isValidEmail(target.email)) {
      const result = await emailBillingItem(env, store, item, target, target.email, origin);
      item = result.item;
      notice = result.ok ? "billing-sent" : "billing-send-failed";
    }
    await saveNewBillingItem(store, item);
    if (saveTemplate) await putTemplate(store, templateRecord({ ...parsed.values, dueInDays: null }));
    return redirectResponse(`${adminBillingPath(slug, item.id)}?notice=${notice}${saveTemplate ? "&also=template-saved" : ""}`);
  }

  let item = await getBilling(store, slug, id);
  if (!item) return notFoundResponse(null, true);
  const itemPath = adminBillingPath(slug, item.id);

  if (!action) {
    if (!isRead) return methodNotAllowedResponse(["GET", "HEAD"]);
    if (!item.shareToken) {
      item = await withShareToken(store, item);
      await putBilling(store, item);
    }
    const links = { ...shareLinks(origin, item), today };
    const receipt = item.status === "paid" ? await getSentEmail(store, sentKey(item, "receipt")) : null;
    const recipients = await listRecipients(store);
    return scriptedHtmlResponse(adminBillingPage({ client: target, item, links, receipt, recipients, readiness, notice: noticeFromQuery(url) }));
  }

  if (action === "edit") {
    if (!isEditable(item)) return redirectResponse(`${itemPath}?notice=not-editable`);
    const editorPath = `${itemPath}/edit`;
    if (isRead) {
      return scriptedHtmlResponse(billingEditorPage({ mode: "edit", client: target, values: editorValuesFromItem(item), actionPath: editorPath, backPath: itemPath, readiness, number: item.number }));
    }
    if (method !== "POST") return methodNotAllowedResponse(["GET", "HEAD", "POST"]);
    const form = await readBoundedForm(context.request, MAX_BILLING_FORM_BYTES);
    if (!form) return redirectResponse(`${itemPath}?notice=invalid`);
    form.set("kind", item.kind);
    const parsed = parseBillingForm(form);
    if (parsed.error) {
      return scriptedHtmlResponse(billingEditorPage({ mode: "edit", client: target, values: parsed.values, error: parsed.error, actionPath: editorPath, backPath: itemPath, readiness, number: item.number }), 400);
    }
    if (item.checkoutSessionId && parsed.values.amountCents !== item.amountCents) await expireCheckoutSession(env, item.checkoutSessionId);
    const { title, description, lineItems, amountCents, dueDate } = parsed.values;
    await putBilling(store, { ...item, title, description, lineItems, amountCents, dueDate, updatedAt: new Date().toISOString() });
    return redirectResponse(`${itemPath}?notice=billing-updated`);
  }

  if (method !== "POST") return methodNotAllowedResponse(["POST"]);

  if (action === "send") {
    if (!readiness.email) return redirectResponse(`${itemPath}?notice=email-not-configured`);
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const to = String(form?.get("to") || "").trim();
    if (!isValidEmail(to)) return redirectResponse(`${itemPath}?notice=email-invalid`);
    const result = await emailBillingItem(env, store, await withShareToken(store, item), target, to, origin);
    await putBilling(store, result.item);
    return redirectResponse(`${itemPath}?notice=${result.ok ? "sent" : "send-failed"}`);
  }

  if (action === "void") {
    if (item.status === "open") {
      if (item.checkoutSessionId) await expireCheckoutSession(env, item.checkoutSessionId);
      await putBilling(store, { ...item, status: "void", voidedAt: new Date().toISOString() });
    }
    return redirectResponse(`${itemPath}?notice=voided`);
  }

  if (action === "record-payment") {
    if (item.kind !== "invoice" || item.status !== "open") return redirectResponse(`${itemPath}?notice=not-payable`);
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const paymentMethod = String(form?.get("method") || "");
    const reference = String(form?.get("reference") || "").trim().slice(0, 80);
    const paidOn = String(form?.get("paidOn") || "").trim();
    if (!PAYMENT_METHODS[paymentMethod] || !isValidDate(paidOn)) return redirectResponse(`${itemPath}?notice=invalid`);
    if (item.checkoutSessionId) await expireCheckoutSession(env, item.checkoutSessionId);
    const updated = await withShareToken(store, {
      ...item,
      status: "paid",
      paidAt: paidOn,
      payment: { source: "manual", method: paymentMethod, label: [PAYMENT_METHODS[paymentMethod], reference].filter(Boolean).join(" "), amountCents: item.amountCents, recordedAt: new Date().toISOString() }
    });
    await putBilling(store, updated);
    let notice = "payment-recorded";
    if (form.get("sendReceipt") === "yes" && readiness.email && isValidEmail(target.email)) {
      const receipt = await sendOnce(env, store, sentKey(updated, "receipt"), receiptMessage(env, updated, target, target.email, origin), { remember: true });
      if (receipt.ok) notice = "payment-recorded-receipt";
    }
    return redirectResponse(`${itemPath}?notice=${notice}`);
  }

  // Sends the receipt again on request, to any address, and records the latest send.
  if (action === "receipt") {
    if (item.kind !== "invoice" || item.status !== "paid") return redirectResponse(itemPath);
    if (!readiness.email) return redirectResponse(`${itemPath}?notice=email-not-configured`);
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const to = String(form?.get("to") || "").trim();
    if (!isValidEmail(to)) return redirectResponse(`${itemPath}?notice=email-invalid`);
    const withToken = await withShareToken(store, item);
    if (withToken !== item) await putBilling(store, withToken);
    const delivery = await sendEmail(env, receiptMessage(env, withToken, target, to, origin));
    if (delivery.ok) {
      await putSentEmail(store, sentKey(item, "receipt"), { to, sentAt: new Date().toISOString(), messageId: delivery.id || "" });
      await remember(store, to);
    }
    return redirectResponse(`${itemPath}?notice=${delivery.ok ? "receipt-sent" : "receipt-failed"}`);
  }

  if (action === "invoice") {
    if (item.kind !== "quote" || item.invoiceId || !(item.status === "open" || item.status === "accepted")) return redirectResponse(itemPath);
    if (item.amountCents < MIN_INVOICE_CENTS) return redirectResponse(`${itemPath}?notice=invoice-too-small`);
    const invoice = await buildBillingItem(store, target, { ...editorValuesFromItem(item), kind: "invoice", dueDate: "", amountCents: item.amountCents }, { fromQuoteId: item.id, fromQuoteNumber: item.number });
    await saveNewBillingItem(store, invoice);
    const accepted = item.status === "open" ? { status: "accepted", acceptedAt: new Date().toISOString(), acceptedVia: "admin" } : {};
    await putBilling(store, { ...item, ...accepted, invoiceId: invoice.id, invoiceNumber: invoice.number });
    return redirectResponse(`${adminBillingPath(slug, invoice.id)}?notice=invoice-created`);
  }

  return notFoundResponse(null, true);
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
    return redirectResponse(`${listPath}/${encodeURIComponent(template.id)}?notice=template-saved`);
  }

  const existing = id ? await getTemplate(store, id) : null;
  if (id && !existing) return notFoundResponse(null, true);
  const editorPath = existing ? `${listPath}/${encodeURIComponent(existing.id)}` : listPath;

  if (existing && action === "delete") {
    if (method !== "POST") return methodNotAllowedResponse(["POST"]);
    await deleteTemplate(store, existing.id);
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
      const message = adminCodeMessage(code, requestIp(context.request));
      const delivery = await sendEmail(env, { to: adminEmail(env), ...message, category: "admin-code" });
      if (!delivery.ok) {
        await deleteAdminChallenge(store, challengeId);
        return htmlResponse(adminRequestPage({ state: "send-failed", authenticated }), 502);
      }
      return htmlResponse(adminRequestPage({ state: "sent", challengeId, authenticated }));
    }

    if (pathname === "/clients/admin/verify") {
      if (method !== "POST") return methodNotAllowedResponse(["POST"]);
      if (!store) return htmlResponse(adminRequestPage({ state: "storage-not-configured", authenticated }), 503);
      const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
      const challengeId = form?.get("challenge") || "";
      const code = (form?.get("code") || "").trim();
      const challenge = /^[A-Za-z0-9_-]{8,64}$/u.test(challengeId) ? await getAdminChallenge(store, challengeId) : null;
      if (!challenge) return htmlResponse(adminRequestPage({ state: "sent", challengeId, error: "That code has expired. Request a new one from the Admin button.", authenticated }), 401);

      const attempts = await recordAdminAttempt(store, challengeId, challenge);
      if (attempts > ADMIN_CODE_MAX_ATTEMPTS) {
        await deleteAdminChallenge(store, challengeId);
        return htmlResponse(adminRequestPage({ state: "sent", challengeId, error: "Too many attempts. Request a new code.", authenticated }), 429);
      }
      const matches = /^\d{6}$/u.test(code) && (await constantTimeMatches(await sha256Hex(`${code}:${challengeId}`), challenge.hash));
      if (!matches) return htmlResponse(adminRequestPage({ state: "sent", challengeId, error: "That code did not match. Check the email and try again.", authenticated }), 401);

      await deleteAdminChallenge(store, challengeId);
      return redirectResponse("/clients/admin", await createAdminSession(sessionSecret));
    }

    if (pathname === "/clients/admin/logout") {
      if (method !== "POST") return methodNotAllowedResponse(["POST"]);
      return redirectResponse("/clients", expiredAdminSession());
    }

    // Admin panel.
    if (pathname === "/clients/admin" || pathname.startsWith("/clients/admin/")) {
      if (!admin) return redirectResponse("/clients");

      if (isRead && pathname === "/clients/admin") {
        const clients = await listClients(store);
        const requested = url.searchParams.get("client");
        const selected = clients.find((entry) => entry.slug === requested) || null;
        const [billing, documents, templates, recipients] = await Promise.all([
          selected ? listBilling(store, selected.slug) : [],
          selected ? listDocuments(store, selected.slug) : [],
          listTemplates(store),
          listRecipients(store)
        ]);
        return scriptedHtmlResponse(adminDashboardPage({ clients, selected, billing, documents, templates, recipients, readiness, notice: noticeFromQuery(url), authenticated }));
      }

      if (!store) return redirectResponse("/clients/admin?notice=invalid");

      const templateMatch = pathname.match(/^\/clients\/admin\/templates(?:\/([^/]+))?(?:\/(delete))?$/u);
      if (templateMatch) return handleAdminTemplates(context, store, templateMatch[1] ? decodeSegment(templateMatch[1]) : "", templateMatch[2] || "");

      if (method === "POST" && pathname === "/clients/admin/clients") {
        const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
        const name = form?.get("name")?.trim();
        const slug = form?.get("slug")?.trim().toLowerCase();
        const clientPassword = form?.get("password") || "";
        const email = String(form?.get("email") || "").trim();
        if (!name || name.length > 120 || !isValidSlug(slug) || clientPassword.length < 10 || clientPassword.length > 120 || (email && !isValidEmail(email))) {
          return redirectResponse("/clients/admin?notice=invalid");
        }
        if (slug === DEFAULT_CLIENT_SLUG || (await getClient(store, slug))) return redirectResponse("/clients/admin?notice=client-exists");
        await putClient(store, { slug, name, email, active: true, passwordHash: await hashPassword(clientPassword), createdAt: new Date().toISOString() });
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

        if (area === "profile" && !id && !action) {
          if (method !== "POST") return methodNotAllowedResponse(["POST"]);
          const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
          const email = String(form?.get("email") || "").trim();
          if (email && !isValidEmail(email)) return redirectResponse(`${back}&notice=email-invalid`);
          if ((target.email || "") !== email) await putClient(store, { ...target, email });
          return redirectResponse(`${back}&notice=client-updated`);
        }

        if (area === "documents" && !id && !action && method === "POST") {
          const form = await readBoundedMultipart(context.request, MAX_UPLOAD_BYTES + 4096);
          const result = form
            ? await storeUpload(store, slug, form.get("file"), "admin", {
              requiresClientSignature: form.get("requiresClientSignature") === "yes",
              requiresAdminSignature: form.get("requiresAdminSignature") === "yes"
            })
            : { error: "upload-failed" };
          return redirectResponse(`${back}&notice=${result.error || "uploaded"}`);
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
          const result = await confirmReturn(env, store, item, client, url.searchParams.get("session_id") || "", origin);
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
