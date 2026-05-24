import crypto from "crypto";
import { db } from "../../config/db.js";
import { env } from "../../config/env.js";

/**
 * Printful fulfillment is intentionally gated.
 *
 * Phase 1 creates paid orders and stores fulfillment-ready line items.
 * Phase 2 can submit to Printful after final product/variant IDs and print files
 * are locked. This prevents accidental live production orders while product art,
 * sizing, and shipping rules are still being finalized.
 */

export function isPrintfulConfigured() {
  return Boolean(env.printfulApiKey);
}

export async function recordInmateRecordsFulfillmentEvent({
  orderId = null,
  eventType,
  providerEventId = null,
  payload = {},
}) {
  await db("inmate_records_fulfillment_events").insert({
    id: crypto.randomUUID(),
    order_id: orderId,
    provider: "printful",
    event_type: eventType,
    provider_event_id: providerEventId,
    payload,
    created_at: db.fn.now(),
  });
}

export async function markInmateRecordsOrderReadyForManualFulfillment(orderId) {
  if (!orderId) return;

  await db("inmate_records_orders")
    .where({ id: orderId })
    .update({
      fulfillment_status: "ready_for_fulfillment",
      updated_at: db.fn.now(),
    });

  await recordInmateRecordsFulfillmentEvent({
    orderId,
    eventType: "ready_for_fulfillment",
    payload: {
      message:
        "Order paid. Printful auto-submit is not enabled until product variant IDs and print files are finalized.",
      printful_configured: isPrintfulConfigured(),
    },
  });
}
