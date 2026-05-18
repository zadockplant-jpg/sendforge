import Stripe from "stripe";
import { z } from "zod";
import { env } from "../../config/env.js";
import { getActiveVariantForCheckout } from "./products.service.js";
import {
  attachStripeSessionToInmateRecordsOrder,
  createPendingInmateRecordsOrder,
} from "./orders.service.js";

const CheckoutSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.number().int().min(1).max(20).default(1),
      })
    )
    .min(1)
    .max(20),
  customerEmail: z.string().email().optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

function getStripe() {
  if (!env.stripeSecretKey) return null;
  return new Stripe(env.stripeSecretKey);
}

function defaultSuccessUrl(orderId) {
  const url = new URL("/shop.html", env.inmateRecordsSiteUrl);
  url.searchParams.set("checkout", "success");
  url.searchParams.set("order", orderId);
  return url.toString();
}

function defaultCancelUrl() {
  const url = new URL("/shop.html", env.inmateRecordsSiteUrl);
  url.searchParams.set("checkout", "cancelled");
  return url.toString();
}

function validateReturnUrl(rawUrl, fallback) {
  if (!rawUrl) return fallback;

  try {
    const parsed = new URL(rawUrl);
    const allowed = new URL(env.inmateRecordsSiteUrl);

    if (parsed.origin === allowed.origin) {
      return parsed.toString();
    }
  } catch {
    // fall through
  }

  return fallback;
}

export function parseCheckoutPayload(payload) {
  return CheckoutSchema.safeParse(payload || {});
}

export async function createInmateRecordsCheckoutSession(payload) {
  const stripe = getStripe();

  if (!stripe) {
    const err = new Error("stripe_not_configured");
    err.statusCode = 500;
    throw err;
  }

  const parsed = parseCheckoutPayload(payload);
  if (!parsed.success) {
    const err = new Error("invalid_checkout_payload");
    err.statusCode = 400;
    err.details = parsed.error.flatten();
    throw err;
  }

  const checkoutItems = [];
  let subtotalCents = 0;
  let currency = "USD";

  for (const requestedItem of parsed.data.items) {
    const variant = await getActiveVariantForCheckout(requestedItem.variantId);

    if (!variant) {
      const err = new Error("variant_not_found");
      err.statusCode = 404;
      throw err;
    }

    const quantity = requestedItem.quantity;
    const unitAmount = Number(variant.price_cents || 0);
    const lineTotal = unitAmount * quantity;

    subtotalCents += lineTotal;
    currency = variant.currency || currency;

    checkoutItems.push({
      product_id: variant.product_id,
      variant_id: variant.variant_id,
      product_slug: variant.product_slug,
      product_name: variant.product_name,
      variant_name: variant.option_label || variant.variant_name,
      sku: variant.sku,
      quantity,
      unit_amount_cents: unitAmount,
      line_total_cents: lineTotal,
      currency: variant.currency || "USD",
      fulfillment_variant_id: variant.fulfillment_variant_id,
      metadata: {
        product_type: variant.product_type,
        fulfillment_provider: variant.fulfillment_provider || "printful",
        fulfillment_metadata: variant.fulfillment_metadata || {},
      },
    });
  }

  const order = await createPendingInmateRecordsOrder({
    items: checkoutItems,
    customerEmail: parsed.data.customerEmail || null,
    subtotalCents,
    totalCents: subtotalCents,
    currency,
    metadata: {
      source: "inmate_records_shop",
    },
  });

  const successUrl = validateReturnUrl(
    parsed.data.successUrl,
    defaultSuccessUrl(order.id)
  );
  const cancelUrl = validateReturnUrl(parsed.data.cancelUrl, defaultCancelUrl());

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: parsed.data.customerEmail || undefined,
    billing_address_collection: "auto",
    shipping_address_collection: {
      allowed_countries: ["US", "CA"],
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      fulfillment_type: "inmate_records_merch_order",
      inmate_records_order_id: order.id,
      inmate_records_order_number: order.order_number,
    },
    line_items: checkoutItems.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: item.currency.toLowerCase(),
        unit_amount: item.unit_amount_cents,
        product_data: {
          name: `${item.product_name} — ${item.variant_name}`,
          metadata: {
            product_slug: item.product_slug,
            variant_id: item.variant_id,
            sku: item.sku,
          },
        },
      },
    })),
  });

  await attachStripeSessionToInmateRecordsOrder({
    orderId: order.id,
    stripeCheckoutSessionId: session.id,
    stripeCustomerId: session.customer ? String(session.customer) : null,
  });

  return {
    orderId: order.id,
    orderNumber: order.order_number,
    sessionId: session.id,
    url: session.url,
  };
}
