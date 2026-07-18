import crypto from "crypto";

const PRICING_MODEL_EFFECTIVE = "2026-07-18";

const PRODUCTS = [
  {
    slug: "tabforge",
    name: "TabForge Pro",
    product_line: "tabforge",
    product_type: "one_time_with_subscription_trial",
    description:
      "Permanent TabForge Pro and current collections with a 60-day TabForge Private Sync trial. Private Sync then renews at $5/month until canceled.",
    price_cents: 1000,
    currency: "usd",
    entitlement_slug: "tabforge",
    status: "active",
    sort_order: 10,
    metadata: {
      display_name: "TabForge Pro",
      one_time_purchase: true,
      public_checkout: true,
      local_storage_only: false,
      device_limit: null,
      pages_included: 50,
      workspace_page_cap: 50,
      workspace_shortcut_cap: 1000,
      separate_page_purchases_required: false,
      notes_and_images_storage:
        "local_unless_private_sync_active",
      cloud_storage_included: "intermittent_layout_backup",
      private_sync_trial_days: 60,
      private_sync_renews_automatically: true,
      private_sync_renewal_price_cents: 500,
      private_sync_billing_interval: "month",
      private_sync_cancel_via_account: true,
      full_device_sync_requires_subscription: true,
      private_sync_device_limit: 5,
      pro_layout_backup: "intermittent",
      collections_included: true,
      pricing_model_effective: PRICING_MODEL_EFFECTIVE,
    },
  },
  {
    slug: "tabforge-collections-subscription",
    name: "TabForge Private Sync",
    product_line: "tabforge",
    product_type: "subscription_account_only",
    description:
      "Account-only $5/month re-subscription for TabForge Pro owners. Syncs layouts, shortcuts, and cloud notes across supported devices.",
    price_cents: 500,
    currency: "usd",
    entitlement_slug: "tabforge-subscription",
    status: "active",
    sort_order: 40,
    metadata: {
      display_name: "TabForge Private Sync",
      public_checkout: false,
      account_resubscribe_only: true,
      requires_entitlement: "tabforge",
      billing_interval: "month",
      subscription_plan: "tabforge_private_sync",
      sync_layouts: true,
      sync_shortcuts: true,
      sync_cloud_notes: true,
      device_sync_limit: 5,
      cloud_provider_status: "active_cloudflare_private_sync",
      admin_cloud_owner_email: null,
      cloud_storage_gb_limit: null,
      sync_storage_safety_ceiling_gb: 20,
      collections_included: false,
      grants_all_current_collections: false,
      grants_tabforge_pro_while_active: false,
      pack_entitlements: [],
      pricing_model_effective: PRICING_MODEL_EFFECTIVE,
    },
  },
];

function mergeMetadata(existing, next) {
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    ...next,
  };
}

async function upsertProduct(knex, product) {
  const existing = await knex("admin_products")
    .where({ slug: product.slug })
    .first();
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

export async function up(knex) {
  if (!(await knex.schema.hasTable("admin_products"))) return;
  for (const product of PRODUCTS) await upsertProduct(knex, product);
}

export async function down() {
  // Forward-only pricing policy migration. Existing purchases and billing
  // history are intentionally never rewritten by rollback.
}
