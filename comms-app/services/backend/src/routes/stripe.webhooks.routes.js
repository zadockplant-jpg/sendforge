import crypto from "crypto";
import { Router } from "express";
import Stripe from "stripe";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import { grantProductEntitlement } from "../services/entitlement.service.js";
import { recordReferralPurchase } from "../services/referrals/referral.service.js";
import {
  markInmateRecordsOrderPaidFromStripe,
} from "../services/inmate.records/orders.service.js";
import {
  markInmateRecordsOrderReadyForManualFulfillment,
} from "../services/inmate.records/fulfillment.service.js";

export const stripeWebhooksRouter = Router();

function getStripe() {
  if (!env.stripeSecretKey) return null;
  return new Stripe(env.stripeSecretKey);
}

function normalizeSlug(slug) {
  return String(slug || "")
    .trim()
    .toLowerCase();
}

function isReferralQualifyingPurchase(entitlementSlug) {
  return normalizeSlug(entitlementSlug) === "tabforge";
}
const TABFORGE_COLLECTION_ENTITLEMENTS = [
  "tabforge-collections",
  "tabforge-pack-builder",
  "tabforge-pack-money",
  "tabforge-pack-dev",
  "tabforge-pack-media",
  "tabforge-pack-research",
];

function isCollectionsEntitlement(entitlementSlug) {
  return TABFORGE_COLLECTION_ENTITLEMENTS.includes(normalizeSlug(entitlementSlug));
}


function parseCheckoutItems(raw) {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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


async function syncTabForgeCollectionsSubscriptionEntitlements({ userId, subscriptionId, status, sourceRef }) {
  if (!userId || !subscriptionId) return;
  const active = ["active", "trialing"].includes(String(status || "").toLowerCase());
  const ref = sourceRef || `subscription:${subscriptionId}:tabforge-collections`;

  if (active) {
    for (const productSlug of TABFORGE_COLLECTION_ENTITLEMENTS) {
      await grantProductEntitlement({
        userId,
        productSlug,
        source: "stripe_subscription",
        sourceRef: ref,
        metadata: {
          subscription_id: String(subscriptionId),
          collection_subscription: true,
          grants_all_current_collections: true,
        },
      });
    }
    return;
  }

  await db("product_entitlements")
    .where({ user_id: userId, source_ref: ref })
    .whereIn("product_slug", TABFORGE_COLLECTION_ENTITLEMENTS)
    .update({
      status: "revoked",
      metadata: db.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({
        collection_subscription_canceled_at: new Date().toISOString(),
        subscription_status: String(status || "canceled"),
      })]),
      updated_at: db.fn.now(),
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
  } else {
    await db("subscriptions").insert({
      id: crypto.randomUUID(),
      user_id: userId,
      provider: "stripe",
      ...payload,
    });
  }

  const productSlug = normalizeSlug(sub.metadata?.product_slug || sub.metadata?.entitlement_slug || "");
  const checkoutItems = parseCheckoutItems(sub.metadata?.checkout_items);
  const includesCollections =
    productSlug === "tabforge-collections-subscription" ||
    productSlug === "tabforge-collections" ||
    checkoutItems.some((item) => isCollectionsEntitlement(item?.entitlementSlug || item?.slug));

  if (includesCollections) {
    await syncTabForgeCollectionsSubscriptionEntitlements({
      userId,
      subscriptionId: sub.id,
      status: payload.status,
      sourceRef: `subscription:${sub.id}:tabforge-collections`,
    });
  }
}

async function markStripeSubscriptionCanceled(sub) {
  const providerSubscriptionId = String(sub.id || "");
  if (!providerSubscriptionId) return;

  const existing = await db("subscriptions")
    .where({
      provider: "stripe",
      provider_subscription_id: providerSubscriptionId,
    })
    .first();

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

  const userId = existing?.user_id || (await findUserIdFromStripeCustomer(sub.customer));
  if (userId) {
    await syncTabForgeCollectionsSubscriptionEntitlements({
      userId,
      subscriptionId: providerSubscriptionId,
      status: "canceled",
      sourceRef: `subscription:${providerSubscriptionId}:tabforge-collections`,
    });
  }
}

async function getExistingEntitlement(userId, productSlug) {
  return db("product_entitlements")
    .where({
      user_id: userId,
      product_slug: normalizeSlug(productSlug),
    })
    .first();
}

async function grantCheckoutEntitlements({
  userId,
  sourceRef,
  checkoutSessionId,
  customerId,
  paymentIntent,
  items,
}) {
  for (const item of items) {
    const kind = String(item?.kind || "");
    const slug = normalizeSlug(item?.slug || "");
    const entitlementSlug = normalizeSlug(item?.entitlementSlug || slug);

    if (!entitlementSlug) continue;

    if (isCollectionsEntitlement(entitlementSlug)) {
      for (const collectionSlug of TABFORGE_COLLECTION_ENTITLEMENTS) {
        await grantProductEntitlement({
          userId,
          productSlug: collectionSlug,
          source: "stripe_subscription",
          sourceRef: sourceRef || `subscription:${checkoutSessionId}:tabforge-collections`,
          metadata: {
            checkout_session_id: checkoutSessionId,
            customer_id: customerId || null,
            payment_intent: paymentIntent || null,
            checkout_item_kind: kind || "subscription",
            checkout_item_slug: slug || entitlementSlug,
            checkout_item_display_name: item?.displayName || "TabForge Collections",
            collection_subscription: true,
            grants_all_current_collections: true,
          },
        });
      }
      continue;
    }

    if (entitlementSlug === "tabforge-skin-bundle-all") {
      for (const skinEntitlementSlug of [
        "tabforge-skin-bundle-command-center",
        "tabforge-skin-bundle-creator-money",
        "tabforge-skin-bundle-wild-forge",
      ]) {
        await grantProductEntitlement({
          userId,
          productSlug: skinEntitlementSlug,
          source: "stripe",
          sourceRef,
          metadata: {
            checkout_session_id: checkoutSessionId,
            customer_id: customerId || null,
            payment_intent: paymentIntent || null,
            checkout_item_kind: "skin_bundle_all",
            checkout_item_slug: slug || entitlementSlug,
            checkout_item_display_name: item?.displayName || "All TabForge Skin Bundles",
          },
        });
      }
      continue;
    }

    if (kind === "page_quantity") {
      const quantityPurchased = Math.max(1, Number(item?.quantity || 1));
      const existing = await getExistingEntitlement(userId, entitlementSlug);
      const existingMeta = existing?.metadata && typeof existing.metadata === "object"
        ? existing.metadata
        : {};
      const previousTotal = Number(existingMeta.purchased_quantity_total || 0);

      await grantProductEntitlement({
        userId,
        productSlug: entitlementSlug,
        source: "stripe",
        sourceRef,
        metadata: {
          ...existingMeta,
          checkout_session_id: checkoutSessionId,
          customer_id: customerId || null,
          payment_intent: paymentIntent || null,
          checkout_item_kind: kind,
          checkout_item_slug: slug || entitlementSlug,
          checkout_item_display_name: item?.displayName || null,
          last_quantity_purchased: quantityPurchased,
          purchased_quantity_total: previousTotal + quantityPurchased,
        },
      });

      if (isReferralQualifyingPurchase(entitlementSlug)) {
        await recordReferralPurchase({
          referredUserId: userId,
          productSlug: entitlementSlug,
          purchaseRef: `${sourceRef}:${entitlementSlug}`,
          metadata: {
            checkout_session_id: checkoutSessionId,
            checkout_item_kind: kind,
            quantity: quantityPurchased,
          },
        });
      }

      continue;
    }

    await grantProductEntitlement({
      userId,
      productSlug: entitlementSlug,
      source: "stripe",
      sourceRef,
      metadata: {
        checkout_session_id: checkoutSessionId,
        customer_id: customerId || null,
        payment_intent: paymentIntent || null,
        checkout_item_kind: kind || null,
        checkout_item_slug: slug || entitlementSlug,
        checkout_item_display_name: item?.displayName || null,
      },
    });

    // TabForge Pro now includes all 10 pages. Collections are a separate subscription,
    // so new Pro purchases no longer grant an included collection credit.

    if (isReferralQualifyingPurchase(entitlementSlug)) {
      await recordReferralPurchase({
        referredUserId: userId,
        productSlug: entitlementSlug,
        purchaseRef: `${sourceRef}:${entitlementSlug}`,
        metadata: {
          checkout_session_id: checkoutSessionId,
          checkout_item_kind: kind || null,
          checkout_item_slug: slug || entitlementSlug,
        },
      });
    }
  }
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
  const checkoutItems = parseCheckoutItems(session.metadata?.checkout_items);
  const checkoutIncludesCollections = checkoutItems.some((item) => isCollectionsEntitlement(item?.entitlementSlug || item?.slug));
  const sourceRef = String(
    session.subscription && checkoutIncludesCollections
      ? `subscription:${session.subscription}:tabforge-collections`
      : (session.payment_intent || session.subscription || session.id || "")
  );

  if (fulfillmentType === "inmate_records_merch_order") {
    const order = await markInmateRecordsOrderPaidFromStripe(session);
    if (order?.id) {
      await markInmateRecordsOrderReadyForManualFulfillment(order.id);
    }
    return;
  }

  if (fulfillmentType === "multi_entitlement_cart" && checkoutItems.length) {
    await grantCheckoutEntitlements({
      userId,
      sourceRef,
      checkoutSessionId: session.id,
      customerId: session.customer || null,
      paymentIntent: session.payment_intent || null,
      items: checkoutItems,
    });
    return;
  }

  const productSlug = normalizeSlug(session.metadata?.product_slug || "");
  if (fulfillmentType === "product_entitlement" && productSlug) {
    await grantCheckoutEntitlements({
      userId,
      sourceRef,
      checkoutSessionId: session.id,
      customerId: session.customer || null,
      paymentIntent: session.payment_intent || null,
      items: [
        {
          kind: "product",
          slug: productSlug,
          entitlementSlug: productSlug,
          displayName: productSlug,
          quantity: 1,
        },
      ],
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

stripeWebhooksRouter.post("/", handleStripeWebhook);
stripeWebhooksRouter.post("/stripe", handleStripeWebhook);