import crypto from "crypto";

const SKIN_BUNDLES = [
  {
    slug: "tabforge-skin-command-center",
    name: "TabForge Skins — Star Base",
    product_line: "tabforge",
    product_type: "add_on",
    description: "Seven TabForge workspace skins in the Star Base bundle.",
    price_cents: 700,
    currency: "usd",
    entitlement_slug: "tabforge-skin-bundle-command-center",
    status: "active",
    sort_order: 31,
    metadata: { bundle_id: "command-center", display_name: "Star Base", skin_count: 7 },
  },
  {
    slug: "tabforge-skin-creator-money",
    name: "TabForge Skins — Creator",
    product_line: "tabforge",
    product_type: "add_on",
    description: "Seven TabForge workspace skins in the Creator bundle.",
    price_cents: 700,
    currency: "usd",
    entitlement_slug: "tabforge-skin-bundle-creator-money",
    status: "active",
    sort_order: 32,
    metadata: { bundle_id: "creator-money", display_name: "Creator", skin_count: 7 },
  },
  {
    slug: "tabforge-skin-wild-forge",
    name: "TabForge Skins — Wild Forge",
    product_line: "tabforge",
    product_type: "add_on",
    description: "Seven TabForge workspace skins in the Wild Forge bundle.",
    price_cents: 700,
    currency: "usd",
    entitlement_slug: "tabforge-skin-bundle-wild-forge",
    status: "active",
    sort_order: 33,
    metadata: { bundle_id: "wild-forge", display_name: "Wild Forge", skin_count: 7 },
  },
];

export async function up(knex) {
  if (!(await knex.schema.hasTable("admin_products"))) return;

  for (const product of SKIN_BUNDLES) {
    await knex("admin_products")
      .insert({
        id: crypto.randomUUID(),
        ...product,
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      })
      .onConflict("slug")
      .merge({
        name: product.name,
        product_line: product.product_line,
        product_type: product.product_type,
        description: product.description,
        price_cents: product.price_cents,
        currency: product.currency,
        entitlement_slug: product.entitlement_slug,
        status: product.status,
        sort_order: product.sort_order,
        metadata: product.metadata,
        updated_at: knex.fn.now(),
      });
  }
}

export async function down(knex) {
  if (!(await knex.schema.hasTable("admin_products"))) return;
  await knex("admin_products").whereIn("slug", SKIN_BUNDLES.map((product) => product.slug)).delete();
}
