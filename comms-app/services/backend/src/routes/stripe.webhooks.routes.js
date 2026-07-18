import crypto from "crypto";
import { Router } from "express";
import Stripe from "stripe";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import {
  grantProductEntitlement,
} from "../services/entitlement.service.js";
import {
  checkoutHasPositiveNetPayment,
  checkoutNetPaidCents,
  checkoutItemsForImmediateFulfillment,
  isActiveTabForgeSubscriptionStatus,
  isFulfillableCheckoutPaymentStatus,
  isTabForgeSyncEntitlement,
  tabForgePastDueSince,
  TABFORGE_SUBSCRIPTION_REVOCABLE_ENTITLEMENTS,
  TABFORGE_SYNC_ENTITLEMENT_SLUG,
  TABFORGE_SYNC_PRODUCT_SLUG,
} from "../services/tabforgeBilling.service.js";
import {
  disqualifyReferralPurchaseForStripe,
  recordReferralPurchase,
} from "../services/referrals/referral.service.js";
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

function tabForgeSubscriptionSourceRef(subscriptionId) {
  // Keep the historical suffix so existing live subscription entitlements and
  // new bundled-trial entitlements are revoked by the same webhook path.
  return `subscription:${subscriptionId}:tabforge-sync-collections`;
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


async function syncTabForgeSubscriptionEntitlements({
  userId,
  subscriptionId,
  status,
  sourceRef,
  pastDueSince = null,
}) {
  if (!userId || !subscriptionId) return;
  const active = isActiveTabForgeSubscriptionStatus(status, {
    pastDueSince,
  });
  const ref =
    sourceRef || tabForgeSubscriptionSourceRef(subscriptionId);

  if (active) {
    await grantProductEntitlement({
      userId,
      productSlug: TABFORGE_SYNC_ENTITLEMENT_SLUG,
      source: "stripe_subscription",
      sourceRef: ref,
      metadata: {
        subscription_id: String(subscriptionId),
        tabforge_private_sync: true,
        sync_layouts: true,
        sync_shortcuts: true,
        sync_cloud_notes: true,
        device_sync_limit: 5,
        sync_storage_safety_ceiling_gb: 20,
      },
    });
    return;
  }

  await db("product_entitlements")
    .where({ user_id: userId, source_ref: ref })
    .whereIn(
      "product_slug",
      TABFORGE_SUBSCRIPTION_REVOCABLE_ENTITLEMENTS
    )
    .update({
      status: "revoked",
      metadata: db.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({
        private_sync_canceled_at: new Date().toISOString(),
        subscription_status: String(status || "canceled"),
      })]),
      updated_at: db.fn.now(),
    });
}

async function upsertStripeSubscription(sub) {
  const customerId = stripeObjectId(sub.customer);
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

  const providerSubscriptionId = String(sub.id || "");
  if (!providerSubscriptionId) return;

  const existing = await db("subscriptions")
    .select("raw")
    .where({
      provider: "stripe",
      provider_subscription_id: providerSubscriptionId,
    })
    .first();
  const raw = { ...sub };
  if (normalizeSlug(sub.status) === "past_due") {
    const priorPastDueSince = tabForgePastDueSince(existing || {});
    const providerPastDueSince = tabForgePastDueSince({ raw });
    raw.past_due_since = new Date(
      priorPastDueSince || providerPastDueSince || Date.now()
    ).toISOString();
  } else {
    delete raw.past_due_since;
  }

  const payload = {
    provider_customer_id: customerId,
    provider_subscription_id: providerSubscriptionId,
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
    raw,
    updated_at: db.fn.now(),
  };

  await db("subscriptions")
    .insert({
      id: crypto.randomUUID(),
      user_id: userId,
      provider: "stripe",
      ...payload,
    })
    .onConflict(
      db.raw(
        "(provider, provider_subscription_id) where provider_subscription_id <> ''"
      )
    )
    .merge({
      user_id: userId,
      ...payload,
    });

  const productSlug = normalizeSlug(sub.metadata?.product_slug || sub.metadata?.entitlement_slug || "");
  const checkoutItems = parseCheckoutItems(sub.metadata?.checkout_items);
  const includesTabForgeSync =
    productSlug === TABFORGE_SYNC_PRODUCT_SLUG ||
    isTabForgeSyncEntitlement(productSlug) ||
    checkoutItems.some((item) =>
      isTabForgeSyncEntitlement(
        item?.entitlementSlug || item?.slug
      )
    );

  const initialProPurchase =
    String(sub.metadata?.initial_pro_purchase || "").toLowerCase() ===
    "true";
  const initialProReady = initialProPurchase
    ? Boolean(
        await db("product_entitlements")
          .where({
            user_id: userId,
            product_slug: "tabforge",
            status: "active",
          })
          .first()
      )
    : true;

  const subscriptionActive = isActiveTabForgeSubscriptionStatus(
    payload.status,
    { pastDueSince: tabForgePastDueSince({ raw: payload.raw }) }
  );
  if (
    includesTabForgeSync &&
    (!subscriptionActive || initialProReady)
  ) {
    await syncTabForgeSubscriptionEntitlements({
      userId,
      subscriptionId: sub.id,
      status: payload.status,
      sourceRef: tabForgeSubscriptionSourceRef(sub.id),
      pastDueSince: tabForgePastDueSince({ raw: payload.raw }),
    });
  }
}

async function markStripeSubscriptionCanceled(sub) {
  if (!sub?.id) return;
  await upsertStripeSubscription({ ...sub, status: "canceled" });
}

async function updateCheckoutAttempt(sessionId, status) {
  if (!sessionId || !status) return;
  await db("billing_checkout_attempts")
    .where({ stripe_checkout_session_id: String(sessionId) })
    .update({
      status: String(status),
      updated_at: db.fn.now(),
    });
}

function checkoutEntitlementSourceRef(session) {
  const checkoutItems = parseCheckoutItems(
    session?.metadata?.checkout_items
  );
  const includesTabForgeSync = checkoutItems.some((item) =>
    isTabForgeSyncEntitlement(item?.entitlementSlug || item?.slug)
  );
  const subscriptionId = stripeObjectId(session?.subscription);
  if (subscriptionId && includesTabForgeSync) {
    return tabForgeSubscriptionSourceRef(subscriptionId);
  }
  return String(
    stripeObjectId(session?.payment_intent) ||
      subscriptionId ||
      session?.id ||
      ""
  );
}

async function revokeFailedCheckoutEntitlements(session) {
  const sourceRef = checkoutEntitlementSourceRef(session);
  if (sourceRef) {
    await db("product_entitlements")
      .where({ source_ref: sourceRef })
      .where({ status: "active" })
      .update({
        status: "revoked",
        metadata: db.raw(
          "coalesce(metadata, '{}'::jsonb) || ?::jsonb",
          [
            JSON.stringify({
              checkout_payment_failed_at: new Date().toISOString(),
              checkout_session_id: String(session?.id || "") || null,
            }),
          ]
        ),
        updated_at: db.fn.now(),
      });
  }

  await disqualifyReferralPurchaseForStripe({
    paymentIntentId: stripeObjectId(session?.payment_intent),
    invoiceId: stripeObjectId(session?.invoice),
    reason: "payment_failed",
    providerEventId: String(session?.id || ""),
  });
}

async function cancelLocalStripeSubscription(subscriptionId, session = {}) {
  const rows = await db("subscriptions")
    .where({
      provider: "stripe",
      provider_subscription_id: String(subscriptionId),
    });

  for (const row of rows) {
    await db("subscriptions")
      .where({ id: row.id })
      .update({
        status: "canceled",
        raw: {
          ...(row.raw || {}),
          async_payment_failed: true,
          async_payment_failed_at: new Date().toISOString(),
          checkout_session_id: String(session?.id || "") || null,
        },
        updated_at: db.fn.now(),
      });
    await syncTabForgeSubscriptionEntitlements({
      userId: row.user_id,
      subscriptionId,
      status: "canceled",
    });
  }

  if (rows.length) return;
  const userId =
    session?.metadata?.user_id ||
    session?.client_reference_id ||
    (await findUserIdFromStripeCustomer(stripeObjectId(session?.customer)));
  if (userId) {
    await syncTabForgeSubscriptionEntitlements({
      userId,
      subscriptionId,
      status: "canceled",
    });
  }
}

function invoiceIsSettled(invoice) {
  if (!invoice || typeof invoice !== "object") return false;
  if (normalizeSlug(invoice.status) === "paid") return true;
  return (
    Number(invoice.amount_paid || 0) > 0 &&
    Number(invoice.amount_remaining || 0) === 0
  );
}

function isStripeResourceMissing(error) {
  return (
    Number(error?.statusCode) === 404 ||
    String(error?.code || "") === "resource_missing"
  );
}

async function handleAsyncCheckoutPaymentFailed(session, stripe) {
  await updateCheckoutAttempt(session?.id, "failed");
  const subscriptionId = stripeObjectId(session?.subscription);

  if (!subscriptionId) {
    await revokeFailedCheckoutEntitlements(session);
    return;
  }

  let current;
  try {
    current = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["latest_invoice"],
    });
  } catch (error) {
    if (!isStripeResourceMissing(error)) throw error;
    await cancelLocalStripeSubscription(subscriptionId, session);
    await revokeFailedCheckoutEntitlements(session);
    return;
  }

  // Ignore a stale failure event after a later invoice has settled.
  if (invoiceIsSettled(current.latest_invoice)) {
    await upsertStripeSubscription(current);
    await updateCheckoutAttempt(session?.id, "completed");
    return;
  }

  const status = normalizeSlug(current.status);
  const canceled = ["canceled", "incomplete_expired"].includes(status)
    ? { ...current, status: "canceled" }
    : await stripe.subscriptions.cancel(subscriptionId);
  await upsertStripeSubscription(canceled);
  await revokeFailedCheckoutEntitlements(session);
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
  subscriptionId,
  invoiceId,
  items,
  referralNetPaidCents = 0,
}) {
  for (const item of items) {
    const kind = String(item?.kind || "");
    const slug = normalizeSlug(item?.slug || "");
    const entitlementSlug = normalizeSlug(item?.entitlementSlug || slug);

    if (!entitlementSlug) continue;

    // Recurring access is never fulfilled from a Checkout event. Stripe can
    // deliver events out of order, so only the subscription's current status
    // is allowed to grant or revoke Private Sync.
    if (isTabForgeSyncEntitlement(entitlementSlug)) continue;

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

      if (
        referralNetPaidCents > 0 &&
        isReferralQualifyingPurchase(entitlementSlug)
      ) {
        await recordReferralPurchase({
          referredUserId: userId,
          productSlug: entitlementSlug,
          purchaseRef: `${sourceRef}:${entitlementSlug}`,
          metadata: {
            checkout_session_id: checkoutSessionId,
            checkout_item_kind: kind,
            quantity: quantityPurchased,
            payment_intent: paymentIntent || null,
            subscription_id: subscriptionId || null,
            invoice_id: invoiceId || null,
            initial_net_paid_cents: referralNetPaidCents,
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

    // The permanent Pro entitlement is deliberately separate from Private Sync
    // and is never revoked when the trial or subscription ends.

    if (
      referralNetPaidCents > 0 &&
      isReferralQualifyingPurchase(entitlementSlug)
    ) {
      await recordReferralPurchase({
        referredUserId: userId,
        productSlug: entitlementSlug,
        purchaseRef: `${sourceRef}:${entitlementSlug}`,
        metadata: {
          checkout_session_id: checkoutSessionId,
          checkout_item_kind: kind || null,
          checkout_item_slug: slug || entitlementSlug,
          payment_intent: paymentIntent || null,
          subscription_id: subscriptionId || null,
          invoice_id: invoiceId || null,
          initial_net_paid_cents: referralNetPaidCents,
        },
      });
    }
  }
}

async function handleCheckoutSessionCompleted(session, stripe) {
  const customerId = stripeObjectId(session.customer);
  const subscriptionId = stripeObjectId(session.subscription);
  const paymentIntentId = stripeObjectId(session.payment_intent);
  const invoiceId = stripeObjectId(session.invoice);
  const userId =
    session.metadata?.user_id ||
    session.client_reference_id ||
    (await findUserIdFromStripeCustomer(customerId));

  if (!userId) {
    return;
  }

  if (!isFulfillableCheckoutPaymentStatus(session.payment_status)) {
    await updateCheckoutAttempt(session.id, "pending_payment");
    return;
  }

  if (customerId) {
    await attachStripeCustomerToUser(userId, customerId);
  }

  const fulfillmentType = String(session.metadata?.fulfillment_type || "");
  const checkoutItems = parseCheckoutItems(session.metadata?.checkout_items);
  const checkoutIncludesTabForgeSync = checkoutItems.some((item) =>
    isTabForgeSyncEntitlement(
      item?.entitlementSlug || item?.slug
    )
  );
  const sourceRef = String(
    subscriptionId && checkoutIncludesTabForgeSync
      ? tabForgeSubscriptionSourceRef(subscriptionId)
      : paymentIntentId || subscriptionId || session.id || ""
  );
  const referralNetPaidCents = checkoutHasPositiveNetPayment(session)
    ? checkoutNetPaidCents(session)
    : 0;

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
      customerId: customerId || null,
      paymentIntent: paymentIntentId || null,
      subscriptionId: subscriptionId || null,
      invoiceId: invoiceId || null,
      items: checkoutItemsForImmediateFulfillment(checkoutItems),
      referralNetPaidCents,
    });
  } else {
    const productSlug = normalizeSlug(
      session.metadata?.product_slug || ""
    );
    if (fulfillmentType === "product_entitlement" && productSlug) {
      await grantCheckoutEntitlements({
        userId,
        sourceRef,
        checkoutSessionId: session.id,
        customerId: customerId || null,
        paymentIntent: paymentIntentId || null,
        subscriptionId: subscriptionId || null,
        invoiceId: invoiceId || null,
        items: [
          {
            kind: "product",
            slug: productSlug,
            entitlementSlug: productSlug,
            displayName: productSlug,
            quantity: 1,
          },
        ],
        referralNetPaidCents,
      });
    }
  }

  // Retrieve the subscription after permanent entitlements are committed.
  // This is authoritative even if checkout/subscription webhooks arrive out
  // of order, and a replay can never resurrect a canceled subscription.
  if (subscriptionId) {
    const current = await stripe.subscriptions.retrieve(
      subscriptionId
    );
    await upsertStripeSubscription(current);
  }

  await updateCheckoutAttempt(session.id, "completed");
}

function stripeObjectId(value) {
  if (!value) return "";
  return typeof value === "string" ? value : String(value.id || "");
}

async function handleReferralPaymentReversal({
  stripe,
  event,
  disputed = false,
}) {
  const object = event.data.object || {};
  let charge = null;
  if (event.type === "charge.refunded") {
    charge = object;
  } else {
    const chargeId = stripeObjectId(object.charge);
    if (chargeId) charge = await stripe.charges.retrieve(chargeId);
  }
  if (!charge) return;

  const fullyRefunded =
    Boolean(charge.refunded) ||
    (Number(charge.amount || 0) > 0 &&
      Number(charge.amount_refunded || 0) >= Number(charge.amount || 0));
  if (!disputed && !fullyRefunded) return;

  await disqualifyReferralPurchaseForStripe({
    paymentIntentId: stripeObjectId(charge.payment_intent),
    invoiceId: stripeObjectId(charge.invoice),
    chargeId: stripeObjectId(charge.id),
    reason: disputed ? "disputed" : "refunded",
    providerEventId: String(event.id || ""),
  });
}

async function handleStripeSubscriptionEvent(stripe, sub, deleted = false) {
  const subscriptionId = String(sub?.id || "");
  if (!subscriptionId) return;

  try {
    const current = await stripe.subscriptions.retrieve(subscriptionId);
    await upsertStripeSubscription(current);
  } catch (error) {
    if (!deleted) throw error;
    await markStripeSubscriptionCanceled(sub);
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

async function handleInvoicePaymentFailed(invoice, stripe) {
  const subscriptionId = stripeObjectId(invoice.subscription);
  if (subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(
      subscriptionId,
      { expand: ["latest_invoice"] }
    );
    await upsertStripeSubscription(subscription);
  }

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

export async function handleStripeWebhook(req, res) {
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
      case "checkout.session.async_payment_succeeded":
        await handleCheckoutSessionCompleted(event.data.object, stripe);
        break;

      case "checkout.session.async_payment_failed":
        await handleAsyncCheckoutPaymentFailed(
          event.data.object,
          stripe
        );
        break;

      case "checkout.session.expired":
        await updateCheckoutAttempt(event.data.object?.id, "expired");
        break;

      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleStripeSubscriptionEvent(
          stripe,
          event.data.object,
          false
        );
        break;

      case "customer.subscription.deleted":
        await handleStripeSubscriptionEvent(
          stripe,
          event.data.object,
          true
        );
        break;

      case "invoice.paid":
        await handleInvoicePaid(event.data.object);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object, stripe);
        break;

      case "charge.refunded":
      case "refund.updated":
        if (
          event.type === "charge.refunded" ||
          String(event.data.object?.status || "") === "succeeded"
        ) {
          await handleReferralPaymentReversal({ stripe, event });
        }
        break;

      case "charge.dispute.created":
        await handleReferralPaymentReversal({
          stripe,
          event,
          disputed: true,
        });
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
