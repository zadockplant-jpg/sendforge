export const TABFORGE_PRO_PRODUCT_SLUG = "tabforge";
export const TABFORGE_SYNC_PRODUCT_SLUG =
  "tabforge-collections-subscription";
export const TABFORGE_SYNC_ENTITLEMENT_SLUG =
  "tabforge-subscription";
export const TABFORGE_SYNC_PLAN = "tabforge_private_sync";
export const TABFORGE_SYNC_TRIAL_DAYS = 60;
export const TABFORGE_PRO_PRICE_CENTS = 1000;
export const TABFORGE_SYNC_PRICE_CENTS = 500;
export const TABFORGE_PAST_DUE_GRACE_DAYS = 7;
export const TABFORGE_PAST_DUE_GRACE_MS =
  TABFORGE_PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000;

export const TABFORGE_SYNC_ENTITLEMENT_ALIASES = Object.freeze([
  TABFORGE_SYNC_ENTITLEMENT_SLUG,
  "tabforge-collections",
  "tabforge-collections-subscription",
  "tabforge-sync-collections",
]);

export const TABFORGE_SUBSCRIPTION_REVOCABLE_ENTITLEMENTS =
  Object.freeze([
    ...TABFORGE_SYNC_ENTITLEMENT_ALIASES,
    // Older subscriptions temporarily granted these collection packs. They
    // must still be removed when those historical subscriptions end.
    "tabforge-pack-builder",
    "tabforge-pack-money",
    "tabforge-pack-dev",
    "tabforge-pack-media",
    "tabforge-pack-research",
  ]);

export const TABFORGE_SYNC_PLAN_ALIASES = Object.freeze([
  TABFORGE_SYNC_PLAN,
  "tabforge_sync_collections",
  "tabforge_collections",
]);

export function normalizeTabForgeBillingSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function isTabForgeSyncEntitlement(value) {
  return TABFORGE_SYNC_ENTITLEMENT_ALIASES.includes(
    normalizeTabForgeBillingSlug(value)
  );
}

function billingTimestampMs(value) {
  if (value instanceof Date) {
    const result = value.getTime();
    return Number.isFinite(result) ? result : null;
  }

  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value || ""))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function tabForgePastDueSince(subscription = {}) {
  const raw =
    subscription?.raw && typeof subscription.raw === "object"
      ? subscription.raw
      : {};
  const latestInvoice =
    raw.latest_invoice && typeof raw.latest_invoice === "object"
      ? raw.latest_invoice
      : {};
  const candidates = [
    raw.past_due_since,
    subscription?.past_due_since,
    latestInvoice?.status_transitions?.finalized_at,
    latestInvoice?.attempted_at,
    latestInvoice?.created,
  ];

  for (const candidate of candidates) {
    const value = billingTimestampMs(candidate);
    if (value !== null) return value;
  }
  return null;
}

export function isActiveTabForgeSubscriptionStatus(
  value,
  { pastDueSince = null, nowMs = Date.now() } = {}
) {
  const status = normalizeTabForgeBillingSlug(value);
  if (["active", "trialing"].includes(status)) return true;
  if (status !== "past_due") return false;

  const startedAt = billingTimestampMs(pastDueSince);
  const currentTime = billingTimestampMs(nowMs);
  if (startedAt === null || currentTime === null) return false;
  return currentTime - startedAt <= TABFORGE_PAST_DUE_GRACE_MS;
}

export function isManageableTabForgeSubscriptionStatus(value) {
  return [
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "incomplete",
    "paused",
  ].includes(normalizeTabForgeBillingSlug(value));
}

export function isFulfillableCheckoutPaymentStatus(value) {
  return ["paid", "no_payment_required"].includes(
    normalizeTabForgeBillingSlug(value)
  );
}

export function checkoutNetPaidCents(checkout = {}) {
  for (const candidate of [
    checkout?.amount_total,
    checkout?.amount_paid,
    checkout?.amount_received,
  ]) {
    if (candidate === null || candidate === undefined || candidate === "") {
      continue;
    }
    const amount = Number(candidate);
    if (Number.isFinite(amount)) return Math.max(0, amount);
  }
  return 0;
}

export function checkoutHasPositiveNetPayment(checkout = {}) {
  return checkoutNetPaidCents(checkout) > 0;
}

export function checkoutItemsForImmediateFulfillment(items = []) {
  return (Array.isArray(items) ? items : []).filter(
    (item) =>
      !isTabForgeSyncEntitlement(
        item?.entitlementSlug || item?.slug
      )
  );
}

function lineItem({ priceId, unitAmountCents, name, recurring = false }) {
  const item = { quantity: 1 };
  if (priceId) {
    item.price = String(priceId);
    return item;
  }

  item.price_data = {
    currency: "usd",
    unit_amount: unitAmountCents,
    product_data: { name },
  };
  if (recurring) item.price_data.recurring = { interval: "month" };
  return item;
}

export function buildTabForgeProBundleLineItems({
  proPriceId = "",
  syncPriceId = "",
} = {}) {
  return [
    lineItem({
      priceId: proPriceId,
      unitAmountCents: TABFORGE_PRO_PRICE_CENTS,
      name: "TabForge Pro",
    }),
    lineItem({
      priceId: syncPriceId,
      unitAmountCents: TABFORGE_SYNC_PRICE_CENTS,
      name: "TabForge Private Sync",
      recurring: true,
    }),
  ];
}

export function buildTabForgeSyncLineItem({ syncPriceId = "" } = {}) {
  return lineItem({
    priceId: syncPriceId,
    unitAmountCents: TABFORGE_SYNC_PRICE_CENTS,
    name: "TabForge Private Sync",
    recurring: true,
  });
}

export function buildTabForgeProBundleCheckoutItems() {
  return [
    {
      kind: "product",
      slug: TABFORGE_PRO_PRODUCT_SLUG,
      displayName: "TabForge Pro",
      entitlementSlug: TABFORGE_PRO_PRODUCT_SLUG,
      unitAmountCents: TABFORGE_PRO_PRICE_CENTS,
      quantity: 1,
    },
    {
      kind: "subscription",
      slug: TABFORGE_SYNC_PRODUCT_SLUG,
      displayName: "TabForge Private Sync",
      entitlementSlug: TABFORGE_SYNC_ENTITLEMENT_SLUG,
      unitAmountCents: TABFORGE_SYNC_PRICE_CENTS,
      quantity: 1,
    },
  ];
}

export function buildTabForgeSubscriptionCheckoutOptions({
  userId,
  checkoutItems = [],
  initialProPurchase = false,
} = {}) {
  const subscriptionData = {
    metadata: {
      user_id: String(userId || ""),
      product_slug: TABFORGE_SYNC_PRODUCT_SLUG,
      entitlement_slug: TABFORGE_SYNC_ENTITLEMENT_SLUG,
      plan: TABFORGE_SYNC_PLAN,
      fulfillment_type: "subscription_entitlement",
      tabforge_private_sync: "true",
      sync_layouts: "true",
      sync_shortcuts: "true",
      sync_cloud_notes: "true",
      initial_pro_purchase: initialProPurchase ? "true" : "false",
      checkout_items: JSON.stringify(checkoutItems),
    },
  };
  if (initialProPurchase) {
    subscriptionData.trial_period_days = TABFORGE_SYNC_TRIAL_DAYS;
  }

  return {
    subscription_data: subscriptionData,
    payment_method_collection: "always",
    custom_text: {
      submit: {
        message: initialProPurchase
          ? "TabForge Pro is $10 today. Private Sync is free for 60 days, then renews automatically at $5/month until canceled from your SendForge account."
          : "Private Sync renews automatically at $5/month until canceled from your SendForge account.",
      },
    },
  };
}

function stripeTimestampToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

export function tabForgeAccountBillingStatus({
  entitlements = [],
  subscription = null,
  hasStripeCustomer = false,
} = {}) {
  const activeEntitlements = (Array.isArray(entitlements) ? entitlements : [])
    .filter((row) => !row?.status || row.status === "active");
  const activeSlugs = new Set(
    activeEntitlements
      .map((row) =>
        normalizeTabForgeBillingSlug(
          row?.product_slug || row?.productSlug
        )
      )
      .filter(Boolean)
  );
  const proOwned =
    activeSlugs.has(TABFORGE_PRO_PRODUCT_SLUG) ||
    activeSlugs.has("tabforge-pro");
  const syncEntitlementActive = TABFORGE_SYNC_ENTITLEMENT_ALIASES.some(
    (slug) => activeSlugs.has(slug)
  );
  const nonStripeSyncEntitlementActive = activeEntitlements.some((row) => {
    const slug = normalizeTabForgeBillingSlug(
      row?.product_slug || row?.productSlug
    );
    if (!TABFORGE_SYNC_ENTITLEMENT_ALIASES.includes(slug)) return false;
    const source = normalizeTabForgeBillingSlug(row?.source);
    const sourceRef = String(row?.source_ref || row?.sourceRef || "");
    return (
      Boolean(source) &&
      !["stripe", "stripe_subscription"].includes(source) &&
      !sourceRef.startsWith("subscription:")
    );
  });
  const pastDueSince = tabForgePastDueSince(subscription || {});
  const subscriptionActive = isActiveTabForgeSubscriptionStatus(
    subscription?.status,
    { pastDueSince }
  );
  const subscriptionManageable =
    isManageableTabForgeSubscriptionStatus(subscription?.status);
  // A Stripe subscription row is authoritative for Stripe-sourced sync. This
  // prevents a stale entitlement row from extending a past-due account beyond
  // the finite grace window. Legacy/admin entitlements without a subscription
  // remain supported.
  const syncActive =
    nonStripeSyncEntitlementActive ||
    (subscription ? subscriptionActive : syncEntitlementActive);
  const raw =
    subscription?.raw && typeof subscription.raw === "object"
      ? subscription.raw
      : {};

  return {
    proOwned,
    syncActive,
    canStartSyncSubscription:
      proOwned && !syncActive && !subscriptionManageable,
    canManageSubscription: Boolean(
      hasStripeCustomer && subscription && subscriptionManageable
    ),
    subscription: subscription
      ? {
          provider: subscription.provider,
          plan: subscription.plan,
          status: subscription.status,
          currentPeriodStart: subscription.current_period_start || null,
          currentPeriodEnd: subscription.current_period_end || null,
          trialEndsAt: stripeTimestampToIso(raw.trial_end),
          cancelAtPeriodEnd: Boolean(raw.cancel_at_period_end),
        }
      : null,
    initialTrialDays: TABFORGE_SYNC_TRIAL_DAYS,
    renewalPriceCents: TABFORGE_SYNC_PRICE_CENTS,
    renewalInterval: "month",
  };
}
