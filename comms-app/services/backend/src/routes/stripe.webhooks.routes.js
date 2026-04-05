import crypto from "crypto";
import { Router } from "express";
import Stripe from "stripe";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import { grantProductEntitlement } from "../services/entitlement.service.js";

export const stripeWebhooksRouter = Router();

function getStripe() {
  if (!env.stripeSecretKey) return null;
  return new Stripe(env.stripeSecretKey);
}

async function findUserIdFromStripeCustomer(customerId) {
  if (!customerId) return null;

  const user = await db("users")
    .select("id")
    .where({ stripe_customer_id: String(customerId) })
    .first();

  return user?.id || null;
}

async function attachStripeCustomerToUser(userId, customerId) {
  if (!userId || !customerId) return;

  await db("users")
    .where({ id: userId })
    .update({
      stripe_customer_id: String(customerId),
    });
}

async function upsertStripeSubscription(sub) {
  const customerId = sub.customer ? String(sub.customer) : "";
  const explicitUserId = sub.metadata?.user_id
    ? String(sub.metadata.user_id)
    : null;
  const userId = explicitUserId || (await findUserIdFromStripeCustomer(customerId));

  if (!userId) {
    return;
  }

  if (customerId) {
    await attachStripeCustomerToUser(userId, customerId);
  }

  const payload = {
    provider_customer_id: customerId,
    provider_subscription_id: String(sub.id || ""),
    plan:
      sub.items?.data?.[0]?.price?.metadata?.plan ||
      sub.metadata?.plan ||
      "starter",
    status: String(sub.status || "active"),
    current_period_start: sub.current_period_start
      ? new Date(sub.current_period_start * 1000)
      : null,
    current_period_end: sub.current_period_end
      ? new Date(sub.current_period_end * 1000)
      : null,
    raw: sub,
    updated_at: db.fn.now(),
  };

  const existing = await db("subscriptions")
    .where({
      provider: "stripe",
      provider_subscription_id: payload.provider_subscription_id,
    })
    .first();

  if (existing) {
    await db("subscriptions")
      .where({ id: existing.id })
      .update(payload);
    return;
  }

  await db("subscriptions").insert({
    id: crypto.randomUUID(),
    user_id: userId,
    provider: "stripe",
    ...payload,
  });
}

async function markStripeSubscriptionCanceled(sub) {
  const providerSubscriptionId = String(sub.id || "");
  if (!providerSubscriptionId) return;

  await db("subscriptions")
    .where({
      provider: "stripe",
      provider_subscription_id: providerSubscriptionId,
    })
    .update({
      status: "canceled",
      raw: sub,
      updated_at: db.fn.now(),
    });
}

async function handleCheckoutSessionCompleted(session) {
  const userId =
    session.metadata?.user_id ||
    session.client_reference_id ||
    (await findUserIdFromStripeCustomer(session.customer));

  if (!userId) {
    return;
  }

  if (session.customer) {
    await attachStripeCustomerToUser(userId, session.customer);
  }

  const fulfillmentType = String(session.metadata?.fulfillment_type || "");
  const productSlug = String(session.metadata?.product_slug || "")
    .trim()
    .toLowerCase();

  if (fulfillmentType === "product_entitlement" && productSlug) {
    await grantProductEntitlement({
      userId,
      productSlug,
      source: "stripe",
      sourceRef: String(session.payment_intent || session.id || ""),
      metadata: {
        checkout_session_id: session.id,
        customer_id: session.customer || null,
        payment_intent: session.payment_intent || null,
      },
    });
  }
}

async function handleInvoicePaid(invoice) {
  const customerId = invoice.customer ? String(invoice.customer) : "";
  if (!customerId) return;

  const user = await db("users")
    .where({ stripe_customer_id: customerId })
    .first();

  if (!user) return;

  const lines = invoice.lines?.data || [];
  const isHardcap = lines.some((line) =>
    String(line.description || "").includes("hardcap_accum")
  );

  const updates = {
    intl_blocked_reason: null,
    stripe_payment_method_attached: true,
  };

  if (isHardcap) {
    updates.intl_spend_since_charge_cents = 0;
  }

  await db("users").where({ id: user.id }).update(updates);
}

async function handleInvoicePaymentFailed(invoice) {
  const customerId = invoice.customer ? String(invoice.customer) : "";
  if (!customerId) return;

  const user = await db("users")
    .where({ stripe_customer_id: customerId })
    .first();

  if (!user) return;

  await db("users")
    .where({ id: user.id })
    .update({
      intl_blocked_reason: "payment_failed",
    });
}

async function handleStripeWebhook(req, res) {
  if (!env.stripeWebhookSecret || !env.stripeSecretKey) {
    return res.status(500).send("Stripe not configured");
  }

  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).send("Stripe not configured");
  }

  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      env.stripeWebhookSecret
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(event.data.object);
        break;

      case "customer.subscription.created":
      case "customer.subscription.updated":
        await upsertStripeSubscription(event.data.object);
        break;

      case "customer.subscription.deleted":
        await markStripeSubscriptionCanceled(event.data.object);
        break;

      case "invoice.paid":
        await handleInvoicePaid(event.data.object);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object);
        break;

      default:
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    return res.status(500).json({
      error: "webhook_handler_failed",
      message: String(err?.message || err),
    });
  }
}

/**
 * Backward-compatible routes:
 * - mounted at /v1/webhooks/stripe with POST /
 * - also supports the original POST /stripe subpath, resulting in /v1/webhooks/stripe/stripe
 */
stripeWebhooksRouter.post("/", handleStripeWebhook);
stripeWebhooksRouter.post("/stripe", handleStripeWebhook);