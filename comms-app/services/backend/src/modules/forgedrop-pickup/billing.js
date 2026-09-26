/**
 * Cloud pickup billing, as hooks into the shared SendForge Stripe flow, the
 * way Romancing the Stone's billing.js is.
 *
 * Checkout is the shared catalog checkout, POST
 * /v1/billing/catalog/checkout-session with productSlug
 * "forgedrop-cloud-pickup-100gb" (or -250gb, -500gb, -1tb). Each tier is a
 * catalog subscription (CLOUD_PICKUP_CATALOG, spread into billing.routes.js's
 * PRODUCT_CATALOG) that Checkout prices inline at its monthly amount, so there
 * are no Stripe Price objects to make or configure. Fulfilment is the shared
 * webhook (routes/stripe.webhooks.routes.js). The parts here are the only
 * Cloud pickup ones:
 *
 *  - the catalog entries, for ForgeDrop owners only (403 forgedrop_required);
 *  - the subscription's metadata, and the words above Checkout's button;
 *  - access follows the Stripe subscription's current status and what it pays
 *    for, never a Checkout event (events arrive out of order): the tier named
 *    by the catalog metadata (entitlement_slug, slug) on the subscription
 *    item's product is granted while the subscription is active, and every
 *    other tier it granted is revoked. A cancellation, or an end without
 *    payment, removes it;
 *  - one plan per account: the same tier again is already_subscribed, and
 *    another tier opens Stripe's billing portal, never a second subscription;
 *  - a paid invoice for one of the tiers is what the affiliate share is paid
 *    on (referral.service.js recordCloudPickupShare).
 *
 * The billing routes and the webhook import this file statically, so, like
 * index.js, it imports only what app.js already depends on.
 */

import { db } from "../../config/db.js";
import { grantProductEntitlement } from "../../services/entitlement.service.js";
import { licensedProduct } from "../../services/licensedProducts.js";
import {
  isActiveTabForgeSubscriptionStatus,
  tabForgePastDueSince,
} from "../../services/tabforgeBilling.service.js";
import { log } from "../../utils/logger.js";
import { CLOUD_PICKUP_TIERS, cloudPickupTier, cloudPickupTierByKey } from "./plans.js";

/** The product family, as the first Cloud pickup subscriptions' metadata named it. */
export const CLOUD_PICKUP_PRODUCT_SLUG = "forgedrop-cloud-pickup";
/** subscriptions.plan, and the plan in the subscription's metadata. */
export const CLOUD_PICKUP_PLAN = "forgedrop_cloud_pickup";

export const CLOUD_PICKUP_SUCCESS_PATH =
  "/account/index.html?purchase_context=forgedrop-cloud-pickup#forgedrop";
export const CLOUD_PICKUP_CANCEL_PATH = "/products/forgedrop/index.html#cloud-pickup";

// A subscription in one of these can still be charged, managed or switched,
// so a second one would be a second bill.
export const CLOUD_PICKUP_LIVE_STATUSES = Object.freeze([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
]);

// The ForgeDrop link's ownership check names ForgeDrop the same way.
const FORGEDROP = licensedProduct("forgedrop");
const TIER_SLUGS = CLOUD_PICKUP_TIERS.map((tier) => tier.slug);
const norm = (value) => String(value || "").trim().toLowerCase();

function dollars(cents) {
  const value = Number(cents || 0) / 100;
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

/**
 * The four tiers as catalog products: a monthly subscription at the tier's
 * price, granting the tier's entitlement, for accounts that own ForgeDrop.
 */
export const CLOUD_PICKUP_CATALOG = Object.freeze(
  Object.fromEntries(
    CLOUD_PICKUP_TIERS.map((tier) => [
      tier.slug,
      Object.freeze({
        slug: tier.slug,
        displayName: `ForgeDrop Cloud pickup — ${tier.label}`,
        mode: "subscription",
        unitAmountCents: tier.monthlyCents,
        entitlementSlug: tier.slug,
        // Only the ForgeDrop desktop app can use a plan.
        requiresEntitlement: FORGEDROP.entitlementSlug || FORGEDROP.slug,
        requiredEntitlementError: "forgedrop_required",
        requiredEntitlementMessage: "Cloud pickup is for ForgeDrop owners.",
        accountOnly: true,
        cloudPickup: true,
        defaultSuccessPath: CLOUD_PICKUP_SUCCESS_PATH,
        defaultCancelPath: CLOUD_PICKUP_CANCEL_PATH,
      }),
    ])
  )
);

export function isCloudPickupEntitlement(slug) {
  return Boolean(cloudPickupTier(slug));
}

export function cloudPickupSubscriptionSourceRef(subscriptionId) {
  return `subscription:${subscriptionId}:${CLOUD_PICKUP_PRODUCT_SLUG}`;
}

/**
 * The catalog metadata ({ kind, slug, entitlement_slug }) of a subscription
 * item or an invoice line: on its product, where the catalog's inline
 * product_data puts it, or on its price or plan. Only what Stripe returned as
 * an object can be read; the webhook asks Stripe to expand the product.
 */
function catalogMetadata(item) {
  return [item?.price?.product, item?.plan?.product, item?.price, item?.plan]
    .map((source) => (source && typeof source === "object" ? source.metadata : null))
    .filter((metadata) => metadata && typeof metadata === "object");
}

function tierFromCatalogMetadata(metadata) {
  return cloudPickupTier(metadata.entitlement_slug) || cloudPickupTier(metadata.slug);
}

function subscriptionMetadataSaysCloudPickup(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  return (
    norm(meta.plan) === CLOUD_PICKUP_PLAN ||
    norm(meta.product_slug) === CLOUD_PICKUP_PRODUCT_SLUG ||
    isCloudPickupEntitlement(meta.product_slug) ||
    isCloudPickupEntitlement(meta.entitlement_slug)
  );
}

function tierFromSubscriptionMetadata(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  return (
    cloudPickupTier(meta.entitlement_slug) ||
    cloudPickupTier(meta.product_slug) ||
    cloudPickupTierByKey(meta.tier) ||
    null
  );
}

export function isCloudPickupSubscription(subscription) {
  if (!subscription || typeof subscription !== "object") return false;
  return (
    subscriptionMetadataSaysCloudPickup(subscription.metadata) ||
    (subscription.items?.data || []).some((item) =>
      catalogMetadata(item).some((metadata) => Boolean(tierFromCatalogMetadata(metadata)))
    )
  );
}

/**
 * The tier a subscription pays for now: the one its item's product names,
 * and only when that cannot be read, the one it was bought at, from the
 * subscription's own metadata.
 */
export function cloudPickupTierForSubscription(subscription) {
  for (const item of subscription?.items?.data || []) {
    for (const metadata of catalogMetadata(item)) {
      const tier = tierFromCatalogMetadata(metadata);
      if (tier) return tier;
    }
  }
  return subscriptionMetadataSaysCloudPickup(subscription?.metadata)
    ? tierFromSubscriptionMetadata(subscription.metadata)
    : null;
}

/**
 * Whether a paid invoice is for Cloud pickup: a line whose catalog metadata
 * names a tier, or else the subscription metadata Stripe copies onto the
 * invoice and onto its subscription lines. Null for anything else; `tier` is
 * null when only the metadata says so and it names no tier.
 */
export function cloudPickupInvoice(invoice) {
  const lines = invoice?.lines?.data || [];
  for (const line of lines) {
    for (const metadata of catalogMetadata(line)) {
      const tier = tierFromCatalogMetadata(metadata);
      if (tier) return { tier };
    }
  }
  const found = [
    invoice?.subscription_details?.metadata,
    invoice?.parent?.subscription_details?.metadata,
    ...lines.map((line) => line?.metadata),
  ].find(subscriptionMetadataSaysCloudPickup);
  return found ? { tier: tierFromSubscriptionMetadata(found) } : null;
}

/** What the subscription carries for the webhook, and what Checkout says above the button. */
export function buildCloudPickupCheckoutOptions({ userId, tier, checkoutItems = [] }) {
  return {
    subscription_data: {
      metadata: {
        user_id: String(userId || ""),
        product_slug: tier.slug,
        entitlement_slug: tier.slug,
        plan: CLOUD_PICKUP_PLAN,
        tier: tier.key,
        fulfillment_type: "subscription_entitlement",
        checkout_items: JSON.stringify(checkoutItems),
      },
    },
    payment_method_collection: "always",
    custom_text: {
      submit: {
        message: `Cloud pickup, ${tier.label} sent a month, renews automatically at ${dollars(tier.monthlyCents)}/month until canceled from your SendForge account.`,
      },
    },
  };
}

/**
 * The account's Cloud pickup subscription that is still running, if any:
 * from Stripe first, which knows one whose webhook has not arrived yet, then
 * from the subscriptions table, which knows one under a Stripe customer the
 * account no longer uses.
 */
export async function findCloudPickupSubscription({ stripe, customerId, userId, database = db }) {
  if (stripe && customerId) {
    const listed = await stripe.subscriptions.list({
      customer: String(customerId),
      status: "all",
      limit: 100,
    });
    const live = (listed?.data || []).find(
      (sub) => CLOUD_PICKUP_LIVE_STATUSES.includes(norm(sub?.status)) && isCloudPickupSubscription(sub)
    );
    if (live) return live;
  }
  if (!userId) return null;
  const row = await database("subscriptions")
    .where({ user_id: userId, provider: "stripe" })
    .whereIn("status", CLOUD_PICKUP_LIVE_STATUSES)
    .andWhere((query) =>
      query.where({ plan: CLOUD_PICKUP_PLAN }).orWhereRaw("raw->'metadata'->>'plan' = ?", [CLOUD_PICKUP_PLAN])
    )
    .orderBy("updated_at", "desc")
    .first();
  if (!row) return null;
  const raw = row.raw && typeof row.raw === "object" ? row.raw : {};
  return {
    ...raw,
    id: row.provider_subscription_id,
    status: row.status,
    customer: row.provider_customer_id || raw.customer || "",
  };
}

/**
 * Grant or revoke from the subscription's current status and tier. Called by
 * the shared webhook after it has upserted the subscriptions row, with that
 * row's copy of the subscription, which carries past_due_since: a payment
 * that is late keeps the plan for the same seven days as Private Sync.
 *
 * Only rows this subscription granted are revoked (they carry its source_ref),
 * so a tier granted by hand, or by another subscription, is never touched.
 * Returns the tier now held through this subscription, or null.
 */
export async function syncCloudPickupSubscriptionEntitlements({
  userId,
  subscription,
  database = db,
  logger = log,
}) {
  if (!userId || !subscription?.id) return null;
  const status = String(subscription.status || "");
  const active = isActiveTabForgeSubscriptionStatus(status, {
    pastDueSince: tabForgePastDueSince({ raw: subscription }),
  });
  const sourceRef = cloudPickupSubscriptionSourceRef(subscription.id);
  const tier = active ? cloudPickupTierForSubscription(subscription) : null;

  if (active && !tier) {
    // Running, and nothing on it names a tier we know: keep what it has
    // rather than guess.
    logger("warn", "forgedrop_pickup_subscription_unknown_tier", {
      userId,
      subscriptionId: String(subscription.id),
    });
    return null;
  }

  if (tier) {
    await grantProductEntitlement({
      userId,
      productSlug: tier.slug,
      source: "stripe_subscription",
      sourceRef,
      metadata: {
        subscription_id: String(subscription.id),
        subscription_status: status,
        cloud_pickup_tier: tier.key,
        monthly_bytes: tier.bytes,
      },
    });
  }

  // What this subscription granted and no longer pays for: the old tier after
  // a change, or every tier once it has ended.
  await database("product_entitlements")
    .where({ user_id: userId, source_ref: sourceRef, status: "active" })
    .whereIn(
      "product_slug",
      TIER_SLUGS.filter((slug) => slug !== tier?.slug)
    )
    .update({
      status: "revoked",
      metadata: database.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [
        JSON.stringify({
          subscription_status: status || "canceled",
          revoked_at: new Date().toISOString(),
          ...(tier ? { replaced_by: tier.slug } : {}),
        }),
      ]),
      updated_at: database.fn.now(),
    });

  return tier;
}
