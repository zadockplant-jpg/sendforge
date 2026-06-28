import crypto from "crypto";

const CURRENT_SKIN_PRODUCTS = [
  {
    slug: "tabforge-skin-command-center",
    name: "TabForge Skins — Star Base",
    entitlement_slug: "tabforge-skin-bundle-command-center",
    display_name: "Star Base",
    bundle_id: "command-center",
    sort_order: 31,
  },
  {
    slug: "tabforge-skin-creator-money",
    name: "TabForge Skins — Creator",
    entitlement_slug: "tabforge-skin-bundle-creator-money",
    display_name: "Creator",
    bundle_id: "creator-money",
    sort_order: 32,
  },
  {
    slug: "tabforge-skin-wild-forge",
    name: "TabForge Skins — Wild Forge",
    entitlement_slug: "tabforge-skin-bundle-wild-forge",
    display_name: "Wild Forge",
    bundle_id: "wild-forge",
    sort_order: 33,
  },
];

const LEGACY_ENTITLEMENT_ALIASES = [
  { from: "tabforge-skin-terminal", to: "tabforge-skin-bundle-command-center", displayName: "Star Base" },
  { from: "tabforge-skin-neon", to: "tabforge-skin-bundle-creator-money", displayName: "Creator" },
  { from: "tabforge-skin-executive", to: "tabforge-skin-bundle-wild-forge", displayName: "Wild Forge" },
  { from: "tabforge-skin-command-center", to: "tabforge-skin-bundle-command-center", displayName: "Star Base" },
  { from: "tabforge-skin-creator-money", to: "tabforge-skin-bundle-creator-money", displayName: "Creator" },
  { from: "tabforge-skin-wild-forge", to: "tabforge-skin-bundle-wild-forge", displayName: "Wild Forge" },
];

function mergeMetadata(base = {}, extra = {}) {
  return {
    ...(base && typeof base === "object" ? base : {}),
    ...(extra && typeof extra === "object" ? extra : {}),
  };
}

export async function up(knex) {
  if (await knex.schema.hasTable("admin_products")) {
    for (const product of CURRENT_SKIN_PRODUCTS) {
      const metadata = { bundle_id: product.bundle_id, display_name: product.display_name, skin_count: 7 };
      await knex("admin_products")
        .insert({
          id: crypto.randomUUID(),
          slug: product.slug,
          name: product.name,
          product_line: "tabforge",
          product_type: "add_on",
          description: `Seven TabForge workspace skins in the ${product.display_name} bundle.`,
          price_cents: 700,
          currency: "usd",
          entitlement_slug: product.entitlement_slug,
          status: "active",
          sort_order: product.sort_order,
          metadata,
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        })
        .onConflict("slug")
        .merge({
          name: product.name,
          product_line: "tabforge",
          product_type: "add_on",
          description: `Seven TabForge workspace skins in the ${product.display_name} bundle.`,
          price_cents: 700,
          currency: "usd",
          entitlement_slug: product.entitlement_slug,
          status: "active",
          sort_order: product.sort_order,
          metadata,
          updated_at: knex.fn.now(),
        });
    }
  }

  if (!(await knex.schema.hasTable("product_entitlements"))) return;

  for (const alias of LEGACY_ENTITLEMENT_ALIASES) {
    const legacyRows = await knex("product_entitlements").where({ product_slug: alias.from });
    for (const legacy of legacyRows) {
      const existing = await knex("product_entitlements")
        .where({ user_id: legacy.user_id, product_slug: alias.to })
        .first();

      const migratedMetadata = mergeMetadata(legacy.metadata, {
        display_name: alias.displayName,
        canonical_product_slug: alias.to,
        migrated_from_product_slug: alias.from,
        migrated_by: "20260625_tabforge_skin_entitlement_canonical_slugs",
        migrated_at: new Date().toISOString(),
      });

      if (existing) {
        const mergedStatus = legacy.status === "active" || existing.status === "active" ? "active" : (existing.status || legacy.status || "active");
        await knex("product_entitlements")
          .where({ id: existing.id })
          .update({
            status: mergedStatus,
            source: existing.source || legacy.source,
            source_ref: existing.source_ref || legacy.source_ref,
            expires_at: existing.expires_at || legacy.expires_at || null,
            metadata: mergeMetadata(existing.metadata, migratedMetadata),
            updated_at: knex.fn.now(),
          });
        await knex("product_entitlements").where({ id: legacy.id }).delete();
      } else {
        await knex("product_entitlements")
          .where({ id: legacy.id })
          .update({
            product_slug: alias.to,
            metadata: migratedMetadata,
            updated_at: knex.fn.now(),
          });
      }
    }
  }
}

export async function down() {
  // No-op. This migration canonicalizes historical entitlement rows so current
  // extension, website, store, and admin tooling all read the same bundle slugs.
}
