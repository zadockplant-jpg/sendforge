const SKIN_ENTITLEMENT_ALIASES = [
  {
    oldSlug: "tabforge-skin-terminal",
    newSlug: "tabforge-skin-bundle-command-center",
    name: "TabForge Skins — Star Base",
    displayName: "Star Base",
  },
  {
    oldSlug: "tabforge-skin-neon",
    newSlug: "tabforge-skin-bundle-creator-money",
    name: "TabForge Skins — Creator",
    displayName: "Creator",
  },
  {
    oldSlug: "tabforge-skin-executive",
    newSlug: "tabforge-skin-bundle-wild-forge",
    name: "TabForge Skins — Wild Forge",
    displayName: "Wild Forge",
  },
];

const SKIN_PRODUCTS = [
  {
    slug: "tabforge-skin-command-center",
    name: "TabForge Skins — Star Base",
    entitlementSlug: "tabforge-skin-bundle-command-center",
    displayName: "Star Base",
  },
  {
    slug: "tabforge-skin-creator-money",
    name: "TabForge Skins — Creator",
    entitlementSlug: "tabforge-skin-bundle-creator-money",
    displayName: "Creator",
  },
  {
    slug: "tabforge-skin-wild-forge",
    name: "TabForge Skins — Wild Forge",
    entitlementSlug: "tabforge-skin-bundle-wild-forge",
    displayName: "Wild Forge",
  },
];

async function mergeEntitlementSlug(knex, { oldSlug, newSlug, displayName }) {
  if (!(await knex.schema.hasTable("product_entitlements"))) return;

  const oldRows = await knex("product_entitlements").where({ product_slug: oldSlug });
  for (const oldRow of oldRows) {
    const existingNew = await knex("product_entitlements")
      .where({ user_id: oldRow.user_id, product_slug: newSlug })
      .first();
    const oldMetadata = oldRow.metadata && typeof oldRow.metadata === "object" ? oldRow.metadata : {};
    const mergedMetadata = {
      ...oldMetadata,
      legacy_skin_slug: oldSlug,
      migrated_to: newSlug,
      display_name: displayName,
      migrated_at: new Date().toISOString(),
    };

    if (existingNew) {
      const existingMetadata = existingNew.metadata && typeof existingNew.metadata === "object" ? existingNew.metadata : {};
      await knex("product_entitlements")
        .where({ id: existingNew.id })
        .update({
          status: existingNew.status === "active" || oldRow.status === "active" ? "active" : existingNew.status,
          source: existingNew.source || oldRow.source,
          source_ref: existingNew.source_ref || oldRow.source_ref,
          metadata: {
            ...existingMetadata,
            legacy_skin_slug: oldSlug,
            merged_legacy_skin_slug: true,
            display_name: displayName,
          },
          updated_at: knex.fn.now(),
        });
      await knex("product_entitlements")
        .where({ id: oldRow.id })
        .update({
          status: "revoked",
          metadata: { ...mergedMetadata, revoked_after_migration: true },
          updated_at: knex.fn.now(),
        });
    } else {
      await knex("product_entitlements")
        .where({ id: oldRow.id })
        .update({
          product_slug: newSlug,
          metadata: mergedMetadata,
          updated_at: knex.fn.now(),
        });
    }
  }
}

export async function up(knex) {
  for (const alias of SKIN_ENTITLEMENT_ALIASES) {
    await mergeEntitlementSlug(knex, alias);
  }

  if (await knex.schema.hasTable("admin_products")) {
    for (const product of SKIN_PRODUCTS) {
      await knex("admin_products")
        .where({ slug: product.slug })
        .update({
          name: product.name,
          entitlement_slug: product.entitlementSlug,
          metadata: knex.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [
            JSON.stringify({ display_name: product.displayName, skin_count: 7 }),
          ]),
          updated_at: knex.fn.now(),
        });
    }
  }
}

export async function down() {
  // Intentionally no-op. We do not move active entitlements back to retired skin slugs.
}
