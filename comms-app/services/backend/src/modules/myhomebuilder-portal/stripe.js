import { constantTimeMatches, hmacHex } from "./security.js";
import { billingLabel, checkoutLine } from "./billing.js";
import { clientEmails } from "./email.js";

const STRIPE_API = "https://api.stripe.com/v1";
// Pinned so response shapes (latest_charge, customer_details) do not change with the account default.
export const STRIPE_API_VERSION = "2024-06-20";
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "charge.refunded",
  "charge.refund.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated"
];

export function stripeConfigured(env) {
  return typeof env.STRIPE_SECRET_KEY === "string" && env.STRIPE_SECRET_KEY.length > 0;
}

async function stripeRequest(env, method, path, params = undefined) {
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": STRIPE_API_VERSION };
  let body;
  if (params) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(params).toString();
  }
  const response = await fetch(`${STRIPE_API}${path}`, { method, headers, body });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Stripe request failed: ${payload?.error?.message || response.status}`);
  }
  return payload;
}

// successUrl must contain {CHECKOUT_SESSION_ID}; Stripe fills it in when the client returns.
export async function createCheckoutSession(env, { invoice, client, successUrl, cancelUrl }) {
  const line = checkoutLine(invoice);
  const label = `${billingLabel(invoice)} · ${invoice.title}`.slice(0, 250);
  // Checkout takes one address; the project's first is filled in and the payer can change it.
  const [customerEmail] = clientEmails(client);
  return stripeRequest(env, "POST", "/checkout/sessions", {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": invoice.currency || "usd",
    "line_items[0][price_data][unit_amount]": String(line.unitCents),
    "line_items[0][price_data][product_data][name]": line.name,
    ...(line.description ? { "line_items[0][price_data][product_data][description]": line.description } : {}),
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    client_reference_id: `${client.slug}:${invoice.id}`,
    "metadata[clientSlug]": client.slug,
    "metadata[invoiceId]": invoice.id,
    "metadata[invoiceNumber]": invoice.number,
    "payment_intent_data[description]": label,
    "payment_intent_data[metadata][clientSlug]": client.slug,
    "payment_intent_data[metadata][invoiceId]": invoice.id,
    "payment_intent_data[metadata][invoiceNumber]": invoice.number,
    success_url: successUrl,
    cancel_url: cancelUrl
  });
}

export async function retrieveCheckoutSession(env, sessionId) {
  return stripeRequest(env, "GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

// Refunds and disputes arrive as charge events. The portal reads Stripe's own copies of the
// charge, its refunds and the dispute, and finds the invoice from the payment's metadata.
export async function retrieveCharge(env, chargeId) {
  return stripeRequest(env, "GET", `/charges/${encodeURIComponent(chargeId)}`);
}

export async function retrievePaymentIntent(env, paymentIntentId) {
  return stripeRequest(env, "GET", `/payment_intents/${encodeURIComponent(paymentIntentId)}`);
}

export async function listRefunds(env, chargeId) {
  const page = await stripeRequest(env, "GET", `/refunds?charge=${encodeURIComponent(chargeId)}&limit=100`);
  return Array.isArray(page?.data) ? page.data : [];
}

export async function retrieveDispute(env, disputeId) {
  return stripeRequest(env, "GET", `/disputes/${encodeURIComponent(disputeId)}`);
}

// Closes an unfinished checkout so an edited, voided or already-paid invoice cannot be paid from it.
export async function expireCheckoutSession(env, sessionId) {
  if (!stripeConfigured(env) || typeof sessionId !== "string" || !sessionId.startsWith("cs_")) return false;
  try {
    await stripeRequest(env, "POST", `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`);
    return true;
  } catch {
    // Sessions that already completed or expired cannot be expired again.
    return false;
  }
}

// ---------- The business bank account (Financial Connections) ----------
// The admin links the account on Stripe's hosted Checkout page in setup mode, which asks for
// transactions access, so the portal needs no Stripe.js. The account is then subscribed to
// transactions, which Stripe refreshes about once a day (up to 180 days of history).

// The Stripe customer that stands for My Home Builder itself, as the account holder.
export async function createBooksCustomer(env) {
  return stripeRequest(env, "POST", "/customers", {
    name: "My Home Builder LLC (books)",
    description: "The business's own bank account, linked for bookkeeping in the client portal",
    "metadata[purpose]": "mhb-books"
  });
}

// successUrl must contain {CHECKOUT_SESSION_ID}.
export async function createBankLinkSession(env, { customerId, successUrl, cancelUrl }) {
  return stripeRequest(env, "POST", "/checkout/sessions", {
    mode: "setup",
    customer: customerId,
    "payment_method_types[0]": "us_bank_account",
    "payment_method_options[us_bank_account][verification_method]": "instant",
    "payment_method_options[us_bank_account][financial_connections][permissions][0]": "payment_method",
    "payment_method_options[us_bank_account][financial_connections][permissions][1]": "transactions",
    "payment_method_options[us_bank_account][financial_connections][prefetch][0]": "transactions",
    "metadata[purpose]": "mhb-books-bank-link",
    success_url: successUrl,
    cancel_url: cancelUrl
  });
}

// The Financial Connections account a completed bank link session set up, or null.
export async function linkedBankAccount(env, sessionId) {
  const session = await stripeRequest(env, "GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (session.mode !== "setup" || session.metadata?.purpose !== "mhb-books-bank-link" || session.status !== "complete") return null;
  const setupIntentId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  if (!setupIntentId) return null;
  const intent = await stripeRequest(env, "GET", `/setup_intents/${encodeURIComponent(setupIntentId)}?expand[]=payment_method`);
  const accountId = intent.payment_method?.us_bank_account?.financial_connections_account;
  if (typeof accountId !== "string" || !accountId.startsWith("fca_")) return null;
  return stripeRequest(env, "GET", `/financial_connections/accounts/${encodeURIComponent(accountId)}`);
}

export async function subscribeBankTransactions(env, accountId) {
  return stripeRequest(env, "POST", `/financial_connections/accounts/${encodeURIComponent(accountId)}/subscribe`, { "features[0]": "transactions" });
}

// Asks Stripe for fresh transactions. Stripe allows it only once the last refresh has finished.
export async function refreshBankTransactions(env, accountId) {
  return stripeRequest(env, "POST", `/financial_connections/accounts/${encodeURIComponent(accountId)}/refresh`, { "features[0]": "transactions" });
}

export async function disconnectBankAccount(env, accountId) {
  return stripeRequest(env, "POST", `/financial_connections/accounts/${encodeURIComponent(accountId)}/disconnect`);
}

export async function retrieveBankAccount(env, accountId) {
  return stripeRequest(env, "GET", `/financial_connections/accounts/${encodeURIComponent(accountId)}`);
}

// Every transaction Stripe holds for the account, newest first, a page of 100 at a time.
export async function listBankTransactions(env, accountId, { maxPages = 30 } = {}) {
  const found = [];
  let after = "";
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ account: accountId, limit: "100", ...(after ? { starting_after: after } : {}) });
    const result = await stripeRequest(env, "GET", `/financial_connections/transactions?${query}`);
    const rows = Array.isArray(result?.data) ? result.data : [];
    found.push(...rows);
    if (!result?.has_more || !rows.length) break;
    after = rows.at(-1).id;
  }
  return found;
}

function paymentLabel(details) {
  if (!details) return "";
  if (details.type === "card" && details.card) {
    const brand = details.card.brand ? details.card.brand.replace(/^\w/u, (letter) => letter.toUpperCase()) : "Card";
    return details.card.last4 ? `${brand} •••• ${details.card.last4}` : brand;
  }
  if (details.type === "us_bank_account" && details.us_bank_account) {
    const bank = details.us_bank_account.bank_name || "Bank account";
    return details.us_bank_account.last4 ? `${bank} •••• ${details.us_bank_account.last4}` : bank;
  }
  if (details.type === "link") return "Link";
  return details.type ? details.type.replaceAll("_", " ") : "";
}

// Best effort: the receipt still goes out without these details if Stripe cannot be reached.
export async function retrievePaymentDetails(env, paymentIntentId) {
  if (typeof paymentIntentId !== "string" || !paymentIntentId.startsWith("pi_")) return null;
  try {
    // The charge's balance transaction carries Stripe's fee, for the books.
    const intent = await stripeRequest(env, "GET", `/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge&expand[]=latest_charge.balance_transaction`);
    const charge = intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
    const fee = charge?.balance_transaction && typeof charge.balance_transaction === "object" ? charge.balance_transaction.fee : null;
    return {
      method: charge?.payment_method_details?.type || "",
      label: paymentLabel(charge?.payment_method_details),
      receiptUrl: charge?.receipt_url || "",
      ...(Number.isInteger(fee) && fee >= 0 ? { feeCents: fee } : {}),
      // When Stripe charged, for the payment's day in the books.
      ...(Number.isInteger(charge?.created) ? { chargedAt: new Date(charge.created * 1000).toISOString() } : {}),
      chargeId: typeof charge?.id === "string" ? charge.id : "",
      paymentIntentId
    };
  } catch (error) {
    console.error(JSON.stringify({ message: "stripe payment details unavailable", error: error instanceof Error ? error.message : "Unknown error" }));
    return null;
  }
}

export async function verifyWebhookSignature(payload, signatureHeader, secret, toleranceSeconds = 300) {
  if (typeof signatureHeader !== "string" || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((entry) => {
      const separator = entry.indexOf("=");
      return separator > 0 ? [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()] : [entry.trim(), ""];
    })
  );
  const timestamp = Number(parts.t);
  if (!Number.isSafeInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  const candidates = signatureHeader
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("v1="))
    .map((entry) => entry.slice(3));
  for (const candidate of candidates) {
    if (await constantTimeMatches(candidate, expected)) return true;
  }
  return false;
}
