/**
 * Romancing the Stone billing, as hooks into the shared SendForge Stripe flow.
 *
 * Checkout goes through the existing POST /v1/billing/catalog/checkout-session
 * with productSlug "romancing-the-stone" (subscription) or
 * "romancing-the-stone-permanent" (one-time). Fulfilment goes through the
 * existing webhook handler; the functions here are the only RTS-specific parts:
 *
 *  - the subscription checkout: $30 today (the first six months) plus a $5/month
 *    price with a six-month trial, so renewal starts when the included time ends;
 *  - subscription access follows the Stripe subscription's current status only,
 *    never a Checkout event (events arrive out of order);
 *  - buying the permanent licence stops an existing subscription from renewing.
 */

import { db } from "../../config/db.js";
import { grantProductEntitlement } from "../../services/entitlement.service.js";
import {
  isActiveTabForgeSubscriptionStatus,
  tabForgePastDueSince,
} from "../../services/tabforgeBilling.service.js";
import { log } from "../../utils/logger.js";
import { sharedLicenseCache } from "./license.js";
import {
  getRtsConfig,
  RTS_APP_PATH,
  RTS_INCLUDED_DAYS,
  RTS_PERMANENT_ENTITLEMENT,
  RTS_PERMANENT_PRODUCT_SLUG,
  RTS_RENEWAL_PRICE_CENTS,
  RTS_START_PRICE_CENTS,
  RTS_SUBSCRIPTION_ENTITLEMENT,
  RTS_SUBSCRIPTION_PLAN,
  RTS_SUBSCRIPTION_PRODUCT_SLUG,
  RTS_PERMANENT_PRICE_CENTS,
  RTS_DEVICE_LIMIT,
} from "./config.js";

const norm = (value) => String(value || "").trim().toLowerCase();

export const RTS_CATALOG = Object.freeze({
  [RTS_SUBSCRIPTION_PRODUCT_SLUG]: Object.freeze({
    slug: RTS_SUBSCRIPTION_PRODUCT_SLUG,
    displayName: "Romancing the Stone",
    mode: "subscription",
    unitAmountCents: RTS_START_PRICE_CENTS,
    entitlementSlug: RTS_SUBSCRIPTION_ENTITLEMENT,
    rts: true,
    defaultSuccessPath: `${RTS_APP_PATH}?checkout=success#plans`,
    defaultCancelPath: `${RTS_APP_PATH}?checkout=cancelled#plans`,
  }),
  [RTS_PERMANENT_PRODUCT_SLUG]: Object.freeze({
    slug: RTS_PERMANENT_PRODUCT_SLUG,
    displayName: "Romancing the Stone — Permanent License",
    mode: "payment",
    unitAmountCents: RTS_PERMANENT_PRICE_CENTS,
    entitlementSlug: RTS_PERMANENT_ENTITLEMENT,
    singlePurchase: true,
    rts: true,
    defaultSuccessPath: `${RTS_APP_PATH}?checkout=success#plans`,
    defaultCancelPath: `${RTS_APP_PATH}?checkout=cancelled#plans`,
  }),
});

export function isRtsProductSlug(slug) {
  return Boolean(RTS_CATALOG[norm(slug)]);
}

export function isRtsSubscriptionEntitlement(slug) {
  return norm(slug) === RTS_SUBSCRIPTION_ENTITLEMENT;
}

export function isRtsSubscription(sub) {
  const metadata = sub?.metadata || {};
  return (
    norm(metadata.plan) === RTS_SUBSCRIPTION_PLAN ||
    norm(metadata.product_slug) === RTS_SUBSCRIPTION_PRODUCT_SLUG ||
    isRtsSubscriptionEntitlement(metadata.entitlement_slug)
  );
}

export function rtsSubscriptionSourceRef(subscriptionId) {
  return `subscription:${subscriptionId}:romancing-the-stone`;
}

/** $30 once (the first six months) and $5/month after the included time. */
export function buildRtsSubscriptionLineItems() {
  return [
    {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: RTS_START_PRICE_CENTS,
        product_data: {
          name: "Romancing the Stone — first 6 months",
          metadata: { kind: "product", slug: RTS_SUBSCRIPTION_PRODUCT_SLUG },
        },
      },
    },
    {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: RTS_RENEWAL_PRICE_CENTS,
        recurring: { interval: "month" },
        product_data: {
          name: "Romancing the Stone subscription",
          metadata: {
            kind: "subscription",
            slug: RTS_SUBSCRIPTION_PRODUCT_SLUG,
            entitlement_slug: RTS_SUBSCRIPTION_ENTITLEMENT,
          },
        },
      },
    },
  ];
}

export function buildRtsSubscriptionCheckoutOptions({ userId, checkoutItems = [] } = {}) {
  return {
    subscription_data: {
      trial_period_days: RTS_INCLUDED_DAYS,
      metadata: {
        user_id: String(userId || ""),
        product_slug: RTS_SUBSCRIPTION_PRODUCT_SLUG,
        entitlement_slug: RTS_SUBSCRIPTION_ENTITLEMENT,
        plan: RTS_SUBSCRIPTION_PLAN,
        fulfillment_type: "subscription_entitlement",
        checkout_items: JSON.stringify(checkoutItems),
      },
    },
    payment_method_collection: "always",
    custom_text: {
      submit: {
        message:
          "Romancing the Stone is $30 today, which includes your first 6 months. After that it renews automatically at $5/month until canceled from your SendForge account.",
      },
    },
  };
}

/**
 * Return URLs when the app is hosted somewhere other than the storefront.
 * Returns null to keep the storefront-relative URLs the catalog built.
 */
export function rtsCheckoutReturnUrls(environment = process.env) {
  const { appUrl } = getRtsConfig(environment);
  if (!appUrl) return null;
  const success = new URL(appUrl);
  success.searchParams.set("checkout", "success");
  success.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
  success.hash = "plans";
  const cancel = new URL(appUrl);
  cancel.searchParams.set("checkout", "cancelled");
  cancel.hash = "plans";
  // Stripe needs the literal placeholder, not its URL-encoded form.
  return {
    success_url: success.toString().replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}"),
    cancel_url: cancel.toString(),
  };
}

/** Anything that would make a new subscription checkout a duplicate. */
export async function rtsExistingLicense(userId, database = db) {
  const entitlement = await database("product_entitlements")
    .where({ user_id: userId, status: "active" })
    .whereIn("product_slug", [RTS_SUBSCRIPTION_ENTITLEMENT, RTS_PERMANENT_ENTITLEMENT])
    .andWhere((query) => query.whereNull("expires_at").orWhere("expires_at", ">", database.fn.now()))
    .first();
  if (entitlement) {
    return entitlement.product_slug === RTS_PERMANENT_ENTITLEMENT ? "permanent" : "subscription";
  }
  // A subscription whose webhook has not landed yet still counts.
  const subscription = await database("subscriptions")
    .where({ user_id: userId, provider: "stripe", plan: RTS_SUBSCRIPTION_PLAN })
    .whereIn("status", ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"])
    .first();
  return subscription ? "subscription" : null;
}

/**
 * Grant or revoke subscription access from the subscription's current status.
 * Called by the shared webhook after it has upserted the subscriptions row.
 */
export async function syncRtsSubscriptionEntitlement({ userId, subscription, database = db }) {
  if (!userId || !subscription?.id) return;
  const status = String(subscription.status || "");
  const pastDueSince = tabForgePastDueSince({ raw: subscription });
  const active = isActiveTabForgeSubscriptionStatus(status, { pastDueSince });
  const sourceRef = rtsSubscriptionSourceRef(subscription.id);
  sharedLicenseCache.clear(userId);

  if (active) {
    await grantProductEntitlement({
      userId,
      productSlug: RTS_SUBSCRIPTION_ENTITLEMENT,
      source: "stripe_subscription",
      sourceRef,
      metadata: {
        subscription_id: String(subscription.id),
        subscription_status: status,
        device_limit: RTS_DEVICE_LIMIT,
      },
    });
    return;
  }

  await database("product_entitlements")
    .where({ user_id: userId, product_slug: RTS_SUBSCRIPTION_ENTITLEMENT, source_ref: sourceRef })
    .update({
      status: "revoked",
      metadata: database.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [
        JSON.stringify({ subscription_status: status || "canceled", revoked_at: new Date().toISOString() }),
      ]),
      updated_at: database.fn.now(),
    });
}

/**
 * After a permanent licence is paid for, an existing subscription must not
 * keep charging $5/month. A subscription in good standing is set to end with
 * its current period (or its included months); one that is behind on payment
 * is canceled now, so Stripe stops retrying the unpaid invoice.
 *
 * Stripe is asked directly as well as the local table, so a subscription whose
 * webhook has not arrived yet is not missed. Errors propagate: the webhook then
 * answers 500 and Stripe retries, and every step here is safe to repeat.
 */
export async function afterRtsPermanentPurchase({ userId, stripe, customerId = "", database = db }) {
  if (!userId) return 0;
  sharedLicenseCache.clear(userId);
  if (!stripe) return 0;
  const LIVE = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];
  const found = new Map();
  const rows = await database("subscriptions")
    .where({ user_id: userId, provider: "stripe", plan: RTS_SUBSCRIPTION_PLAN })
    .whereIn("status", LIVE);
  for (const row of rows) {
    if (row.provider_subscription_id) found.set(row.provider_subscription_id, row.status);
  }
  if (customerId && stripe.subscriptions.list) {
    const listed = await stripe.subscriptions.list({ customer: String(customerId), status: "all", limit: 100 });
    for (const sub of listed?.data || []) {
      if (isRtsSubscription(sub) && LIVE.includes(String(sub.status))) found.set(sub.id, String(sub.status));
    }
  }
  let stopped = 0;
  for (const [id, status] of found) {
    if (["active", "trialing"].includes(status)) {
      await stripe.subscriptions.update(id, {
        cancel_at_period_end: true,
        metadata: { superseded_by: RTS_PERMANENT_ENTITLEMENT },
      });
    } else {
      await stripe.subscriptions.cancel(id);
    }
    stopped += 1;
    log("info", "rts_subscription_superseded", { userId, subscriptionId: id, status });
  }
  return stopped;
}

export function checkoutIncludesRtsPermanent(items = []) {
  return (Array.isArray(items) ? items : []).some(
    (item) => norm(item?.entitlementSlug || item?.slug) === RTS_PERMANENT_ENTITLEMENT
  );
}
