import crypto from "crypto";

const SKIN_BUNDLE_PRODUCTS = [
  {
    slug: "tabforge-skin-command-center",
    name: "TabForge Skins — Star Base",
    product_line: "tabforge",
    product_type: "extension_add_on",
    description: "Seven TabForge workspace skins in the Star Base bundle.",
    price_cents: 700,
    currency: "usd",
    entitlement_slug: "tabforge-skin-bundle-command-center",
    status: "active",
    sort_order: 120,
    metadata: {
      bundle_id: "command-center",
      bundle_size: 7,
      display_name: "Star Base",
      requires_entitlement: "tabforge",
      skins: [
        "Neon CyberForge",
        "Gamer RGB",
        "IceForge",
        "Solar Flare",
        "Retro Terminal",
        "Blueprint Builder",
        "Stealth Carbon",
      ],
    },
  },
  {
    slug: "tabforge-skin-creator-money",
    name: "TabForge Skins — Creator",
    product_line: "tabforge",
    product_type: "extension_add_on",
    description: "Seven TabForge workspace skins in the Creator bundle.",
    price_cents: 700,
    currency: "usd",
    entitlement_slug: "tabforge-skin-bundle-creator-money",
    status: "active",
    sort_order: 130,
    metadata: {
      bundle_id: "creator-money",
      bundle_size: 7,
      requires_entitlement: "tabforge",
      skins: [
        "Money Mode",
        "Creator Studio",
        "Luxury Black Card",
        "Cloud Glass",
        "Focus Minimal",
        "Vaporwave Desk",
        "Studio Midnight",
      ],
    },
  },
  {
    slug: "tabforge-skin-wild-forge",
    name: "TabForge Skins — Wild Forge",
    product_line: "tabforge",
    product_type: "extension_add_on",
    description: "Seven TabForge workspace skins in the Wild Forge bundle.",
    price_cents: 700,
    currency: "usd",
    entitlement_slug: "tabforge-skin-bundle-wild-forge",
    status: "active",
    sort_order: 140,
    metadata: {
      bundle_id: "wild-forge",
      bundle_size: 7,
      requires_entitlement: "tabforge",
      skins: [
        "Psychedelic Portal",
        "Jungle Circuit",
        "Woodsy Forge",
        "Earth Shades",
        "Ocean Forge",
        "Desert Bronze",
        "Aurora Mist",
      ],
    },
  },
];

export async function up(knex) {
  if (!(await knex.schema.hasTable("admin_products"))) return;

  for (const product of SKIN_BUNDLE_PRODUCTS) {
    await knex("admin_products")
      .insert({
        id: crypto.randomUUID(),
        ...product,
        deleted_at: null,
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
        deleted_at: null,
        updated_at: knex.fn.now(),
      });
  }
}

export async function down(knex) {
  if (!(await knex.schema.hasTable("admin_products"))) return;

  await knex("admin_products")
    .whereIn("slug", SKIN_BUNDLE_PRODUCTS.map((product) => product.slug))
    .update({
      status: "archived",
      deleted_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
}
