import crypto from "crypto";
import { db } from "../../config/db.js";

function randomOrderNumber() {
  return `IR-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function createPendingInmateRecordsOrder({
  items,
  customerEmail = null,
  stripeCheckoutSessionId = null,
  stripeCustomerId = null,
  subtotalCents,
  totalCents,
  currency = "USD",
  metadata = {},
}) {
  const orderId = crypto.randomUUID();
  const orderNumber = randomOrderNumber();

  await db.transaction(async (trx) => {
    await trx("inmate_records_orders").insert({
      id: orderId,
      order_number: orderNumber,
      status: "pending",
      fulfillment_status: "not_submitted",
      stripe_checkout_session_id: stripeCheckoutSessionId,
      stripe_customer_id: stripeCustomerId,
      customer_email: customerEmail,
      subtotal_cents: subtotalCents,
      total_cents: totalCents,
      currency,
      metadata,
      created_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });

    for (const item of items) {
      await trx("inmate_records_order_items").insert({
        id: crypto.randomUUID(),
        order_id: orderId,
        product_id: item.product_id,
        variant_id: item.variant_id,
        product_slug: item.product_slug,
        product_name: item.product_name,
        variant_name: item.variant_name,
        sku: item.sku,
        quantity: item.quantity,
        unit_amount_cents: item.unit_amount_cents,
        line_total_cents: item.line_total_cents,
        currency: item.currency,
        fulfillment_variant_id: item.fulfillment_variant_id || null,
        metadata: item.metadata || {},
        created_at: trx.fn.now(),
      });
    }
  });

  return {
    id: orderId,
    order_number: orderNumber,
  };
}

export async function attachStripeSessionToInmateRecordsOrder({
  orderId,
  stripeCheckoutSessionId,
  stripeCustomerId = null,
}) {
  await db("inmate_records_orders")
    .where({ id: orderId })
    .update({
      stripe_checkout_session_id: stripeCheckoutSessionId,
      stripe_customer_id: stripeCustomerId,
      updated_at: db.fn.now(),
    });
}

export async function markInmateRecordsOrderPaidFromStripe(session) {
  const checkoutSessionId = String(session.id || "");
  if (!checkoutSessionId) return null;

  const order = await db("inmate_records_orders")
    .where({ stripe_checkout_session_id: checkoutSessionId })
    .first();

  if (!order) return null;

  await db("inmate_records_orders")
    .where({ id: order.id })
    .update({
      status: "paid",
      stripe_payment_intent_id: session.payment_intent
        ? String(session.payment_intent)
        : order.stripe_payment_intent_id,
      stripe_customer_id: session.customer
        ? String(session.customer)
        : order.stripe_customer_id,
      customer_email:
        session.customer_details?.email ||
        session.customer_email ||
        order.customer_email,
      shipping_address:
        session.shipping_details?.address ||
        session.customer_details?.address ||
        order.shipping_address ||
        {},
      paid_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

  return db("inmate_records_orders").where({ id: order.id }).first();
}

export async function getInmateRecordsOrderPublic(orderIdOrNumber) {
  const raw = String(orderIdOrNumber || "");

  const order = await db("inmate_records_orders")
    .where({ id: raw })
    .orWhere({ order_number: raw })
    .first();

  if (!order) return null;

  const items = await db("inmate_records_order_items")
    .where({ order_id: order.id })
    .orderBy("created_at", "asc");

  return {
    id: order.id,
    order_number: order.order_number,
    status: order.status,
    fulfillment_status: order.fulfillment_status,
    tracking_url: order.tracking_url,
    tracking_number: order.tracking_number,
    total_cents: Number(order.total_cents || 0),
    currency: order.currency || "USD",
    items: items.map((item) => ({
      product_slug: item.product_slug,
      product_name: item.product_name,
      variant_name: item.variant_name,
      quantity: Number(item.quantity || 0),
      unit_amount_cents: Number(item.unit_amount_cents || 0),
      line_total_cents: Number(item.line_total_cents || 0),
      currency: item.currency || "USD",
    })),
  };
}
