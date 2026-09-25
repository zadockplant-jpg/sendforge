import { constantTimeMatches, hmacHex } from "./security.js";
import { checkoutLine } from "./billing.js";

const STRIPE_API = "https://api.stripe.com/v1";
// Pinned so response shapes (latest_charge, customer_details) do not change with the account default.
export const STRIPE_API_VERSION = "2024-06-20";
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed"
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
  const label = `${invoice.number} · ${invoice.title}`.slice(0, 250);
  return stripeRequest(env, "POST", "/checkout/sessions", {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": invoice.currency || "usd",
    "line_items[0][price_data][unit_amount]": String(line.unitCents),
    "line_items[0][price_data][product_data][name]": line.name,
    ...(line.description ? { "line_items[0][price_data][product_data][description]": line.description } : {}),
    ...(client.email ? { customer_email: client.email } : {}),
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
    const intent = await stripeRequest(env, "GET", `/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`);
    const charge = intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
    return {
      method: charge?.payment_method_details?.type || "",
      label: paymentLabel(charge?.payment_method_details),
      receiptUrl: charge?.receipt_url || "",
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
