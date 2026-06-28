import crypto from "crypto";

const ALL_SKIN_PRODUCT = {
  slug: "tabforge-skin-all",
  name: "TabForge Skins — All 3 Bundles",
  product_line: "tabforge",
  product_type: "extension_add_on",
  description: "All three TabForge skin bundles: Star Base, Creator, and Wild Forge.",
  price_cents: 1500,
  currency: "usd",
  entitlement_slug: "tabforge-skin-bundle-all",
  status: "active",
  sort_order: 150,
  metadata: {
    bundle_id: "all",
    display_name: "All 3 Bundles",
    skin_bundle_ids: ["command-center", "creator-money", "wild-forge"],
    skin_bundle_entitlements: [
      "tabforge-skin-bundle-command-center",
      "tabforge-skin-bundle-creator-money",
      "tabforge-skin-bundle-wild-forge",
    ],
    requires_entitlement: "tabforge",
  },
};

const ALL_SKIN_ENTITLEMENTS = [
  { slug: "tabforge-skin-bundle-command-center", displayName: "Star Base", bundleId: "command-center" },
  { slug: "tabforge-skin-bundle-creator-money", displayName: "Creator", bundleId: "creator-money" },
  { slug: "tabforge-skin-bundle-wild-forge", displayName: "Wild Forge", bundleId: "wild-forge" },
];

function mergeMetadata(base = {}, extra = {}) {
  return {
    ...(base && typeof base === "object" ? base : {}),
    ...(extra && typeof extra === "object" ? extra : {}),
  };
}

async function upsertAdminProduct(knex) {
  if (!(await knex.schema.hasTable("admin_products"))) return;

  const existing = await knex("admin_products").where({ slug: ALL_SKIN_PRODUCT.slug }).first();
  const row = {
    name: ALL_SKIN_PRODUCT.name,
    product_line: ALL_SKIN_PRODUCT.product_line,
    product_type: ALL_SKIN_PRODUCT.product_type,
    description: ALL_SKIN_PRODUCT.description,
    price_cents: ALL_SKIN_PRODUCT.price_cents,
    currency: ALL_SKIN_PRODUCT.currency,
    entitlement_slug: ALL_SKIN_PRODUCT.entitlement_slug,
    status: ALL_SKIN_PRODUCT.status,
    sort_order: ALL_SKIN_PRODUCT.sort_order,
    metadata: ALL_SKIN_PRODUCT.metadata,
    updated_at: knex.fn.now(),
  };

  if (existing) {
    await knex("admin_products").where({ id: existing.id }).update(row);
  } else {
    await knex("admin_products").insert({
      id: crypto.randomUUID(),
      slug: ALL_SKIN_PRODUCT.slug,
      ...row,
      created_at: knex.fn.now(),
    });
  }
}

async function expandHistoricalAllBundleEntitlements(knex) {
  if (!(await knex.schema.hasTable("product_entitlements"))) return;

  const rows = await knex("product_entitlements").where({ product_slug: ALL_SKIN_PRODUCT.entitlement_slug });
  for (const row of rows) {
    for (const bundle of ALL_SKIN_ENTITLEMENTS) {
      const existing = await knex("product_entitlements")
        .where({ user_id: row.user_id, product_slug: bundle.slug })
        .first();

      const metadata = mergeMetadata(row.metadata, {
        display_name: bundle.displayName,
        bundle_id: bundle.bundleId,
        expanded_from: ALL_SKIN_PRODUCT.entitlement_slug,
        expanded_at: new Date().toISOString(),
      });

      if (existing) {
        await knex("product_entitlements")
          .where({ id: existing.id })
          .update({
            status: row.status === "active" || existing.status === "active" ? "active" : (existing.status || row.status || "active"),
            metadata: mergeMetadata(existing.metadata, metadata),
            updated_at: knex.fn.now(),
          });
      } else {
        await knex("product_entitlements").insert({
          id: crypto.randomUUID(),
          user_id: row.user_id,
          product_slug: bundle.slug,
          status: row.status || "active",
          source: row.source || "stripe",
          source_ref: row.source_ref || null,
          expires_at: row.expires_at || null,
          metadata,
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        });
      }
    }

    await knex("product_entitlements")
      .where({ id: row.id })
      .update({
        status: "expanded",
        metadata: mergeMetadata(row.metadata, {
          expanded_to_skin_bundles: ALL_SKIN_ENTITLEMENTS.map((bundle) => bundle.slug),
          expanded_at: new Date().toISOString(),
        }),
        updated_at: knex.fn.now(),
      });
  }
}

export async function up(knex) {
  await upsertAdminProduct(knex);
  await expandHistoricalAllBundleEntitlements(knex);
}

export async function down() {
  // No-op. Keeps historical checkout/admin rows and expanded entitlements intact.
}
