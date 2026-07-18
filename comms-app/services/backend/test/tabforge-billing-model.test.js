import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTabForgeProBundleCheckoutItems,
  buildTabForgeProBundleLineItems,
  buildTabForgeSubscriptionCheckoutOptions,
  buildTabForgeSyncLineItem,
  checkoutHasPositiveNetPayment,
  checkoutItemsForImmediateFulfillment,
  checkoutNetPaidCents,
  isFulfillableCheckoutPaymentStatus,
  isActiveTabForgeSubscriptionStatus,
  isManageableTabForgeSubscriptionStatus,
  isTabForgeSyncEntitlement,
  TABFORGE_SUBSCRIPTION_REVOCABLE_ENTITLEMENTS,
  TABFORGE_PAST_DUE_GRACE_DAYS,
  TABFORGE_SYNC_TRIAL_DAYS,
  tabForgePastDueSince,
  tabForgeAccountBillingStatus,
} from "../src/services/tabforgeBilling.service.js";

test("Pro checkout charges $10 once and starts a $5 monthly sync item", () => {
  const [pro, sync] = buildTabForgeProBundleLineItems();

  assert.equal(pro.quantity, 1);
  assert.equal(pro.price_data.unit_amount, 1000);
  assert.equal(pro.price_data.recurring, undefined);

  assert.equal(sync.quantity, 1);
  assert.equal(sync.price_data.unit_amount, 500);
  assert.deepEqual(sync.price_data.recurring, { interval: "month" });
  assert.equal(TABFORGE_SYNC_TRIAL_DAYS, 60);
});

test("configured Stripe Price IDs replace inline prices without changing quantity", () => {
  const [pro, sync] = buildTabForgeProBundleLineItems({
    proPriceId: "price_pro_once",
    syncPriceId: "price_sync_monthly",
  });

  assert.deepEqual(pro, { quantity: 1, price: "price_pro_once" });
  assert.deepEqual(sync, {
    quantity: 1,
    price: "price_sync_monthly",
  });
  assert.deepEqual(buildTabForgeSyncLineItem({
    syncPriceId: "price_sync_monthly",
  }), {
    quantity: 1,
    price: "price_sync_monthly",
  });
});

test("bundled checkout grants permanent Pro separately from revocable sync", () => {
  assert.deepEqual(
    buildTabForgeProBundleCheckoutItems().map((item) => [
      item.kind,
      item.entitlementSlug,
    ]),
    [
      ["product", "tabforge"],
      ["subscription", "tabforge-subscription"],
    ]
  );
  assert.equal(
    TABFORGE_SUBSCRIPTION_REVOCABLE_ENTITLEMENTS.includes("tabforge"),
    false,
    "canceling sync must never revoke permanent Pro"
  );
});

test("only the initial Pro checkout receives the 60-day trial", () => {
  const checkoutItems = buildTabForgeProBundleCheckoutItems();
  const initial = buildTabForgeSubscriptionCheckoutOptions({
    userId: "user-1",
    checkoutItems,
    initialProPurchase: true,
  });
  const resubscribe = buildTabForgeSubscriptionCheckoutOptions({
    userId: "user-1",
    checkoutItems: [checkoutItems[1]],
    initialProPurchase: false,
  });

  assert.equal(initial.subscription_data.trial_period_days, 60);
  assert.equal(
    resubscribe.subscription_data.trial_period_days,
    undefined
  );
  assert.equal(initial.payment_method_collection, "always");
  assert.equal(
    initial.subscription_data.metadata.product_slug,
    "tabforge-collections-subscription"
  );
  assert.equal(
    initial.subscription_data.metadata.initial_pro_purchase,
    "true"
  );
  assert.equal(
    resubscribe.subscription_data.metadata.initial_pro_purchase,
    "false"
  );
  assert.match(
    initial.custom_text.submit.message,
    /\$10 today.*60 days.*\$5\/month.*canceled/i
  );
  assert.match(
    resubscribe.custom_text.submit.message,
    /\$5\/month.*canceled/i
  );
});

test("Checkout fulfillment waits for payment and never grants recurring sync", () => {
  const checkoutItems = buildTabForgeProBundleCheckoutItems();
  assert.equal(isFulfillableCheckoutPaymentStatus("paid"), true);
  assert.equal(
    isFulfillableCheckoutPaymentStatus("no_payment_required"),
    true
  );
  assert.equal(isFulfillableCheckoutPaymentStatus("unpaid"), false);
  assert.equal(isFulfillableCheckoutPaymentStatus(""), false);
  assert.deepEqual(
    checkoutItemsForImmediateFulfillment(checkoutItems).map(
      (item) => item.entitlementSlug
    ),
    ["tabforge"]
  );
});

test("free or fully discounted Checkout grants the product but not a cash referral", () => {
  assert.equal(checkoutHasPositiveNetPayment({ amount_total: 1000 }), true);
  assert.equal(checkoutNetPaidCents({ amount_total: 1000 }), 1000);
  assert.equal(checkoutHasPositiveNetPayment({ amount_total: 0 }), false);
  assert.equal(
    checkoutHasPositiveNetPayment({
      amount_total: null,
      amount_paid: 0,
      payment_status: "no_payment_required",
    }),
    false
  );
  assert.equal(
    checkoutNetPaidCents({ amount_total: "invalid", amount_paid: 500 }),
    500
  );
});

test("historical subscription aliases remain recognized", () => {
  for (const slug of [
    "tabforge-subscription",
    "tabforge-collections",
    "tabforge-collections-subscription",
    "tabforge-sync-collections",
  ]) {
    assert.equal(isTabForgeSyncEntitlement(slug), true);
  }
  assert.equal(isTabForgeSyncEntitlement("tabforge"), false);
  assert.equal(isActiveTabForgeSubscriptionStatus("trialing"), true);
  assert.equal(isActiveTabForgeSubscriptionStatus("active"), true);
  assert.equal(isActiveTabForgeSubscriptionStatus("past_due"), false);
  const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
  assert.equal(
    isActiveTabForgeSubscriptionStatus("past_due", {
      pastDueSince: "2026-07-12T12:00:00.000Z",
      nowMs,
    }),
    true
  );
  assert.equal(
    isActiveTabForgeSubscriptionStatus("past_due", {
      pastDueSince: "2026-07-10T11:59:59.000Z",
      nowMs,
    }),
    false
  );
  assert.equal(TABFORGE_PAST_DUE_GRACE_DAYS, 7);
  assert.equal(isActiveTabForgeSubscriptionStatus("canceled"), false);
  assert.equal(
    isManageableTabForgeSubscriptionStatus("past_due"),
    true
  );
  assert.equal(
    isManageableTabForgeSubscriptionStatus("canceled"),
    false
  );
});

test("account status offers re-subscribe only to Pro owners without active sync", () => {
  const canceled = tabForgeAccountBillingStatus({
    entitlements: [{ product_slug: "tabforge", status: "active" }],
    hasStripeCustomer: true,
    subscription: {
      provider: "stripe",
      plan: "tabforge_private_sync",
      status: "canceled",
      current_period_start: null,
      current_period_end: null,
      raw: {},
    },
  });

  assert.equal(canceled.proOwned, true);
  assert.equal(canceled.syncActive, false);
  assert.equal(canceled.canStartSyncSubscription, true);
  assert.equal(canceled.canManageSubscription, false);
});

test("active trial exposes renewal and cancellation state for Account", () => {
  const active = tabForgeAccountBillingStatus({
    entitlements: [
      { product_slug: "tabforge", status: "active" },
      { product_slug: "tabforge-subscription", status: "active" },
    ],
    hasStripeCustomer: true,
    subscription: {
      provider: "stripe",
      plan: "tabforge_private_sync",
      status: "trialing",
      current_period_start: "2026-07-18T00:00:00.000Z",
      current_period_end: "2026-09-16T00:00:00.000Z",
      raw: {
        trial_end: 1789516800,
        cancel_at_period_end: true,
      },
    },
  });

  assert.equal(active.proOwned, true);
  assert.equal(active.syncActive, true);
  assert.equal(active.canStartSyncSubscription, false);
  assert.equal(active.canManageSubscription, true);
  assert.equal(active.subscription.cancelAtPeriodEnd, true);
  assert.equal(active.subscription.trialEndsAt, "2026-09-16T00:00:00.000Z");
  assert.equal(active.renewalPriceCents, 500);
});

test("past-due sync stays in payment grace and is managed instead of duplicated", () => {
  const pastDueSince = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const pastDue = tabForgeAccountBillingStatus({
    entitlements: [{ product_slug: "tabforge", status: "active" }],
    hasStripeCustomer: true,
    subscription: {
      provider: "stripe",
      plan: "tabforge_private_sync",
      status: "past_due",
      raw: { past_due_since: pastDueSince },
    },
  });

  assert.equal(pastDue.syncActive, true);
  assert.equal(pastDue.canStartSyncSubscription, false);
  assert.equal(pastDue.canManageSubscription, true);
  assert.equal(
    tabForgePastDueSince({ raw: { past_due_since: pastDueSince } }),
    Date.parse(pastDueSince)
  );
});

test("past-due sync becomes inactive after seven days even with a stale entitlement", () => {
  const expired = tabForgeAccountBillingStatus({
    entitlements: [
      { product_slug: "tabforge", status: "active" },
      { product_slug: "tabforge-subscription", status: "active" },
    ],
    hasStripeCustomer: true,
    subscription: {
      provider: "stripe",
      plan: "tabforge_private_sync",
      status: "past_due",
      raw: {
        past_due_since: new Date(
          Date.now() - 8 * 24 * 60 * 60 * 1000
        ).toISOString(),
      },
    },
  });

  assert.equal(expired.syncActive, false);
  assert.equal(expired.canManageSubscription, true);
  assert.equal(expired.canStartSyncSubscription, false);
});

test("an explicit non-Stripe admin entitlement remains independent of Stripe state", () => {
  const status = tabForgeAccountBillingStatus({
    entitlements: [
      { product_slug: "tabforge", status: "active" },
      {
        product_slug: "tabforge-subscription",
        status: "active",
        source: "admin",
      },
    ],
    subscription: {
      provider: "stripe",
      plan: "tabforge_private_sync",
      status: "canceled",
      raw: {},
    },
  });

  assert.equal(status.syncActive, true);
});
