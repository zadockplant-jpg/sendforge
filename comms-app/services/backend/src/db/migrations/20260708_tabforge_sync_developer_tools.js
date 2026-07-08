import crypto from "crypto";

const PRODUCT_UPDATES = [
  {
    slug: "tabforge",
    name: "TabForge Pro",
    product_line: "tabforge",
    product_type: "extension",
    description: "One-time TabForge Pro unlock with local storage for notes and images on 1 device.",
    price_cents: 1000,
    currency: "usd",
    entitlement_slug: "tabforge",
    status: "active",
    sort_order: 10,
    metadata: {
      display_name: "TabForge Pro",
      one_time_purchase: true,
      local_storage_only: true,
      device_limit: 1,
      notes_and_images_storage: "local",
      pages_included: 10,
      cloud_storage_included: false,
      collections_included: false,
      pricing_model_effective: "2026-07-08",
    },
  },
  {
    slug: "tabforge-collections-subscription",
    name: "TabForge Sync + Collections",
    product_line: "tabforge",
    product_type: "subscription",
    description: "Monthly TabForge subscription profile with Pro while active, current collections, 20GB cloud-storage profile, and sync across up to 5 devices once cloud hosting is live once cloud provider hosting is wired.",
    price_cents: 500,
    currency: "usd",
    entitlement_slug: "tabforge-subscription",
    status: "active",
    sort_order: 40,
    metadata: {
      display_name: "TabForge Sync + Collections",
      billing_interval: "month",
      subscription_plan: "tabforge_sync_collections",
      grants_tabforge_pro_while_active: true,
      grants_all_current_collections: true,
      cloud_storage_gb_limit: 20,
      cloud_provider_status: "stubbed_until_provider_except_admin",
      admin_cloud_owner_email: "zadockplant@gmail.com",
      device_sync_limit: 5,
      collections_included: true,
      pricing_model_effective: "2026-07-08",
      pack_entitlements: [
        "tabforge-pack-builder",
        "tabforge-pack-money",
        "tabforge-pack-dev",
        "tabforge-pack-media",
        "tabforge-pack-research",
      ],
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
      pricing_model_effective: "2026-07-08",
    },
  },
];

const DELAYED_VISUAL_ADD_ON_SLUGS = [
  "tabforge-skin-command-center",
  "tabforge-skin-creator-money",
  "tabforge-skin-wild-forge",
  "tabforge-skin-all",
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

async function markVisualAddOnsDelayed(knex) {
  if (!(await knex.schema.hasTable("admin_products"))) return;

  for (const slug of DELAYED_VISUAL_ADD_ON_SLUGS) {
    const existing = await knex("admin_products").where({ slug }).first();
    if (!existing) continue;
    await knex("admin_products")
      .where({ id: existing.id })
      .update({
        status: "inactive",
        product_type: "future_one_time_add_on",
        description: "Delayed. This visual add-on will return later as an optional one-time purchase.",
        metadata: mergeMetadata(existing.metadata, {
          delayed: true,
          delayed_reason: "Skins and icon packs are postponed while the core pricing model is simplified.",
          future_purchase_model: "one_time_add_on",
          checkout_active: false,
          pricing_model_effective: "2026-07-08",
        }),
        updated_at: knex.fn.now(),
      });
  }
}

export async function up(knex) {
  for (const product of PRODUCT_UPDATES) {
    await upsertAdminProduct(knex, product);
  }
  await markVisualAddOnsDelayed(knex);
}

export async function down() {
  // Forward-only pricing/catalog policy migration.
}
