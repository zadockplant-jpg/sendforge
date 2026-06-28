import crypto from "crypto";

const TABFORGE_TIERS = [
  { requiredPurchases: 5, rewardAmountCents: 1700 },
  { requiredPurchases: 15, rewardAmountCents: 3500 },
  { requiredPurchases: 25, rewardAmountCents: 4000 },
  { requiredPurchases: 50, rewardAmountCents: 15000 },
];

const TABFORGE_RECURRING_TIER = {
  startAfterPurchases: 50,
  everyPurchases: 25,
  rewardAmountCents: 15000,
};

const PRODUCTS = [
  {
    slug: "tabforge",
    name: "TabForge Pro",
    product_line: "tabforge",
    product_type: "extension",
    description: "One-time TabForge Pro unlock. Includes all 10 pages.",
    price_cents: 1000,
    currency: "usd",
    entitlement_slug: "tabforge",
    status: "active",
    sort_order: 10,
    metadata: {
      display_name: "TabForge Pro",
      pages_included: 10,
      collections_included: false,
      price_change_effective: "2026-06-27",
    },
  },
  {
    slug: "tabforge-page",
    name: "TabForge Extra Pages",
    product_line: "tabforge",
    product_type: "retired_add_on",
    description: "Retired. TabForge Pro now includes all 10 pages.",
    price_cents: 500,
    currency: "usd",
    entitlement_slug: "tabforge-pages",
    status: "inactive",
    sort_order: 90,
    metadata: {
      retired: true,
      retired_reason: "TabForge Pro includes all 10 pages.",
      replaced_by: "tabforge",
    },
  },
  {
    slug: "tabforge-collections-subscription",
    name: "TabForge Collections",
    product_line: "tabforge",
    product_type: "subscription",
    description: "Monthly access to current TabForge shortcut collections.",
    price_cents: 800,
    currency: "usd",
    entitlement_slug: "tabforge-collections",
    status: "active",
    sort_order: 40,
    metadata: {
      display_name: "TabForge Collections",
      billing_interval: "month",
      subscription_plan: "tabforge_collections",
      grants_all_current_collections: true,
      pack_entitlements: [
        "tabforge-pack-builder",
        "tabforge-pack-money",
        "tabforge-pack-dev",
        "tabforge-pack-media",
        "tabforge-pack-research",
      ],
    },
  },
];

function mergeMetadata(existing = {}, next = {}) {
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    ...(next && typeof next === "object" ? next : {}),
  };
}

async function upsertAdminProduct(knex, product) {
  if (!(await knex.schema.hasTable("admin_products"))) return;
  const existing = await knex("admin_products").where({ slug: product.slug }).first();
  const row = {
    name: product.name,
    product_line: product.product_line,
    product_type: product.product_type,
    description: product.description,
    price_cents: product.price_cents,
    currency: product.currency,
    entitlement_slug: product.entitlement_slug,
    status: product.status,
    sort_order: product.sort_order,
    metadata: mergeMetadata(existing?.metadata, product.metadata),
    updated_at: knex.fn.now(),
  };
  if (existing) {
    await knex("admin_products").where({ id: existing.id }).update(row);
    return;
  }
  await knex("admin_products").insert({
    id: crypto.randomUUID(),
    slug: product.slug,
    ...row,
    created_at: knex.fn.now(),
  });
}

async function updateReferralProgram(knex) {
  if (!(await knex.schema.hasTable("referral_programs"))) return;
  const existing = await knex("referral_programs").where({ product_slug: "tabforge" }).first();
  const metadata = mergeMetadata(existing?.metadata, {
    qualification: "verified_purchase",
    tiers: TABFORGE_TIERS,
    recurringTier: TABFORGE_RECURRING_TIER,
    description: "TabForge Pro purchase referral payouts: $17 at 5, $35 at 15, $40 at 25, $150 at 50, then $150 for each additional 25 qualified purchases.",
    updated_by_migration: "20260627_tabforge_pricing_collections_rewards_4_0_91",
  });
  if (existing) {
    await knex("referral_programs")
      .where({ id: existing.id })
      .update({
        required_purchases: 5,
        reward_amount_cents: 1700,
        metadata,
        status: "active",
        updated_at: knex.fn.now(),
      });
    return;
  }
  await knex("referral_programs").insert({
    id: crypto.randomUUID(),
    product_slug: "tabforge",
    required_purchases: 5,
    reward_amount_cents: 1700,
    reward_type: "cashapp_manual",
    refund_hold_days: 10,
    status: "active",
    metadata,
    updated_at: knex.fn.now(),
  });
}

async function updateUnpaidRewardAmounts(knex) {
  if (!(await knex.schema.hasTable("reward_queue"))) return;
  const amounts = new Map(TABFORGE_TIERS.map((tier) => [String(tier.requiredPurchases), tier.rewardAmountCents]));
  for (const [requiredPurchases, rewardAmountCents] of amounts.entries()) {
    await knex("reward_queue")
      .where({ product_slug: "tabforge" })
      .whereIn("status", ["pending", "approved"])
      .andWhere((qb) => {
        qb.whereRaw("metadata->>'tier_required_purchases' = ?", [requiredPurchases])
          .orWhereRaw("metadata->>'tier_key' = ?", [`verified_purchase:${requiredPurchases}`]);
      })
      .update({
        reward_amount_cents: rewardAmountCents,
        metadata: knex.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({
          reward_amount_updated_by: "20260627_tabforge_pricing_collections_rewards_4_0_91",
          reward_amount_cents: rewardAmountCents,
        })]),
        updated_at: knex.fn.now(),
      });
  }
}

export async function up(knex) {
  for (const product of PRODUCTS) {
    await upsertAdminProduct(knex, product);
  }
  await updateReferralProgram(knex);
  await updateUnpaidRewardAmounts(knex);
}

export async function down() {
  // Forward-only product/pricing policy migration.
}
