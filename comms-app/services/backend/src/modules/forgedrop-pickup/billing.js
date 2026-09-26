/**
 * Cloud pickup billing, as hooks into the shared SendForge Stripe flow, the
 * way Romancing the Stone's billing.js is.
 *
 * Checkout is POST /v1/billing/forgedrop-pickup/checkout-session in
 * routes/billing.routes.js, which shares the Stripe customer, the open-session
 * reuse and the return URLs with the catalog checkout. Fulfilment is the
 * shared webhook (routes/stripe.webhooks.routes.js). The parts here are the
 * only Cloud pickup ones:
 *
 *  - a monthly subscription on the tier's own Stripe price (plans.js), with
 *    the account and the tier in its metadata;
 *  - access follows the Stripe subscription's current status and price, never
 *    a Checkout event (events arrive out of order): the tier of the price it
 *    is on now is granted while it is active, and every other tier it granted
 *    is revoked. A switch in the billing portal moves the entitlement to the
 *    new tier; a cancellation, or an end without payment, removes it;
 *  - one plan per account: another tier, while subscribed, is a switch in
 *    Stripe's billing portal, not a second subscription;
 *  - a paid invoice on one of the four prices is what the affiliate share is
 *    paid on (referral.service.js recordCloudPickupShare).
 *
 * The billing routes and the webhook import this file statically, so, like
 * index.js, it imports only what app.js already depends on.
 */

import { db } from "../../config/db.js";
import { grantProductEntitlement } from "../../services/entitlement.service.js";
import {
  isActiveTabForgeSubscriptionStatus,
  tabForgePastDueSince,
} from "../../services/tabforgeBilling.service.js";
import { log } from "../../utils/logger.js";
import {
  CLOUD_PICKUP_TIERS,
  cloudPickupPriceId,
  cloudPickupTier,
  cloudPickupTierByKey,
  tierForStripePrice,
} from "./plans.js";

/** The product: checkout attempts, subscription metadata and the affiliate share. */
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

const TIER_SLUGS = CLOUD_PICKUP_TIERS.map((tier) => tier.slug);
const norm = (value) => String(value || "").trim().toLowerCase();
const stripeId = (value) => (typeof value === "string" ? value : String(value?.id || ""));

function dollars(cents) {
  const value = Number(cents || 0) / 100;
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

export function isCloudPickupEntitlement(slug) {
  return Boolean(cloudPickupTier(slug));
}

export function cloudPickupSubscriptionSourceRef(subscriptionId) {
  return `subscription:${subscriptionId}:${CLOUD_PICKUP_PRODUCT_SLUG}`;
}

/** The price of a subscription item or an invoice line, in the shapes Stripe's API versions use. */
function priceIdOf(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.price === "string") return item.price;
  return String(item.price?.id || item.plan?.id || item.pricing?.price_details?.price || "");
}

function metadataSaysCloudPickup(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  return (
    norm(meta.plan) === CLOUD_PICKUP_PLAN ||
    norm(meta.product_slug) === CLOUD_PICKUP_PRODUCT_SLUG ||
    isCloudPickupEntitlement(meta.entitlement_slug)
  );
}

function tierFromMetadata(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  return cloudPickupTier(meta.entitlement_slug) || cloudPickupTierByKey(meta.tier) || null;
}

export function isCloudPickupSubscription(subscription, environment = process.env) {
  if (!subscription || typeof subscription !== "object") return false;
  return (
    metadataSaysCloudPickup(subscription.metadata) ||
    (subscription.items?.data || []).some((item) => Boolean(tierForStripePrice(priceIdOf(item), environment)))
  );
}

/**
 * The tier a subscription pays for now: the tier of its price, and only when
 * that is none of the four, the one it was bought at. A switch in the billing
 * portal changes the price, never the metadata.
 */
export function cloudPickupTierForSubscription(subscription, environment = process.env) {
  for (const item of subscription?.items?.data || []) {
    const tier = tierForStripePrice(priceIdOf(item), environment);
    if (tier) return tier;
  }
  return metadataSaysCloudPickup(subscription?.metadata) ? tierFromMetadata(subscription.metadata) : null;
}

/**
 * Whether a paid invoice is for Cloud pickup: a line on one of the four
 * prices, or else the subscription metadata Stripe copies onto the invoice
 * and onto its subscription lines. Null for anything else; `tier` is null
 * when only the metadata says so and it names no tier.
 */
export function cloudPickupInvoice(invoice, environment = process.env) {
  const lines = invoice?.lines?.data || [];
  for (const line of lines) {
    const tier = tierForStripePrice(priceIdOf(line), environment);
    if (tier) return { tier };
  }
  const found = [
    invoice?.subscription_details?.metadata,
    invoice?.parent?.subscription_details?.metadata,
    ...lines.map((line) => line?.metadata),
  ].find(metadataSaysCloudPickup);
  return found ? { tier: tierFromMetadata(found) } : null;
}

/** The checkout's one item, as the catalog checkout lists its items. */
export function buildCloudPickupCheckoutItem(tier) {
  return {
    kind: "subscription",
    slug: CLOUD_PICKUP_PRODUCT_SLUG,
    displayName: `ForgeDrop Cloud pickup — ${tier.label}`,
    entitlementSlug: tier.slug,
    tier: tier.key,
    unitAmountCents: tier.monthlyCents,
    quantity: 1,
  };
}

/** What the subscription carries for the webhook, and what Checkout says above the button. */
export function buildCloudPickupCheckoutOptions({ userId, tier, checkoutItems = [] }) {
  return {
    subscription_data: {
      metadata: {
        user_id: String(userId || ""),
        product_slug: CLOUD_PICKUP_PRODUCT_SLUG,
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
export async function findCloudPickupSubscription({
  stripe,
  customerId,
  userId,
  database = db,
  environment = process.env,
}) {
  if (stripe && customerId) {
    const listed = await stripe.subscriptions.list({
      customer: String(customerId),
      status: "all",
      limit: 100,
    });
    const live = (listed?.data || []).find(
      (sub) => CLOUD_PICKUP_LIVE_STATUSES.includes(norm(sub?.status)) && isCloudPickupSubscription(sub, environment)
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

function isStripeInvalidRequest(error) {
  return (
    error?.type === "StripeInvalidRequestError" ||
    error?.rawType === "invalid_request_error" ||
    error?.raw?.type === "invalid_request_error"
  );
}

/**
 * Another tier, for an account that already has one, goes through Stripe's
 * billing portal: straight to the page that confirms the new price, where
 * Stripe shows the proration and takes the payment. The portal only offers a
 * price listed in its settings ("Customers can switch plans", with the four
 * Cloud pickup prices); until they are listed Stripe refuses that deep link,
 * and the portal's front page opens instead, where the plan can still be
 * managed or cancelled. The webhook moves the entitlement once it changes.
 */
export async function openCloudPickupPlanChange({
  stripe,
  customerId,
  subscription,
  priceId,
  returnUrl,
  doneUrl,
  logger = log,
}) {
  const items = subscription?.items?.data || [];
  const itemId = items.length === 1 ? String(items[0]?.id || "") : "";
  if (itemId && stripeId(subscription.customer) === String(customerId)) {
    try {
      return await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
        flow_data: {
          type: "subscription_update_confirm",
          subscription_update_confirm: {
            subscription: String(subscription.id),
            items: [{ id: itemId, price: priceId, quantity: 1 }],
          },
          after_completion: { type: "redirect", redirect: { return_url: doneUrl } },
        },
      });
    } catch (error) {
      if (!isStripeInvalidRequest(error)) throw error;
      logger("warn", "forgedrop_pickup_plan_switch_unavailable", {
        customerId,
        subscriptionId: String(subscription.id),
        message: String(error?.message || error).slice(0, 300),
      });
    }
  }
  return stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
}

/**
 * Grant or revoke from the subscription's current status and price. Called by
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
  environment = process.env,
  logger = log,
}) {
  if (!userId || !subscription?.id) return null;
  const status = String(subscription.status || "");
  const active = isActiveTabForgeSubscriptionStatus(status, {
    pastDueSince: tabForgePastDueSince({ raw: subscription }),
  });
  const sourceRef = cloudPickupSubscriptionSourceRef(subscription.id);
  const tier = active ? cloudPickupTierForSubscription(subscription, environment) : null;

  if (active && !tier) {
    // Running, on a price that is none of the four and bought at no tier we
    // know: keep what it has rather than guess.
    logger("warn", "forgedrop_pickup_subscription_unknown_price", {
      userId,
      subscriptionId: String(subscription.id),
      priceIds: (subscription.items?.data || []).map(priceIdOf),
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
        stripe_price_id: cloudPickupPriceId(tier, environment) || null,
      },
    });
  }

  // What this subscription granted and no longer pays for: the old tier after
  // a switch, or every tier once it has ended.
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
