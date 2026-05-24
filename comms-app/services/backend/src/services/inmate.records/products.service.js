import { db } from "../../config/db.js";

function publicProduct(row) {
  const variants = Array.isArray(row.variants)
    ? row.variants.filter(Boolean)
    : [];

  return {
    id: row.id,
    slug: row.slug,
    type: row.type,
    name: row.name,
    description: row.description || "",
    image_url: row.image_url || "",
    status: row.status,
    sort_order: Number(row.sort_order || 100),
    variants: variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      option_label: variant.option_label || variant.name,
      price_cents: Number(variant.price_cents || 0),
      currency: variant.currency || "USD",
      is_active: Boolean(variant.is_active),
      sort_order: Number(variant.sort_order || 100),
    })),
  };
}

export async function listActiveInmateRecordsProducts() {
  const products = await db("inmate_records_products as p")
    .leftJoin("inmate_records_product_variants as v", function joinVariants() {
      this.on("v.product_id", "p.id").andOn("v.is_active", db.raw("?", [true]));
    })
    .where("p.status", "active")
    .groupBy("p.id")
    .orderBy("p.sort_order", "asc")
    .select(
      "p.id",
      "p.slug",
      "p.type",
      "p.name",
      "p.description",
      "p.image_url",
      "p.status",
      "p.sort_order",
      db.raw(`
        COALESCE(
          json_agg(
            json_build_object(
              'id', v.id,
              'sku', v.sku,
              'name', v.name,
              'option_label', v.option_label,
              'price_cents', v.price_cents,
              'currency', v.currency,
              'is_active', v.is_active,
              'sort_order', v.sort_order
            )
            ORDER BY v.sort_order ASC
          ) FILTER (WHERE v.id IS NOT NULL),
          '[]'::json
        ) as variants
      `)
    );

  return products.map(publicProduct);
}

export async function getActiveInmateRecordsProductBySlug(slug) {
  const products = await listActiveInmateRecordsProducts();
  return products.find((product) => product.slug === String(slug || "")) || null;
}

export async function getActiveVariantForCheckout(variantId) {
  return db("inmate_records_product_variants as v")
    .join("inmate_records_products as p", "p.id", "v.product_id")
    .where("v.id", String(variantId || ""))
    .where("v.is_active", true)
    .where("p.status", "active")
    .select(
      "v.id as variant_id",
      "v.sku",
      "v.name as variant_name",
      "v.option_label",
      "v.price_cents",
      "v.currency",
      "v.fulfillment_provider",
      "v.fulfillment_variant_id",
      "v.fulfillment_metadata",
      "p.id as product_id",
      "p.slug as product_slug",
      "p.type as product_type",
      "p.name as product_name",
      "p.description as product_description",
      "p.image_url as product_image_url"
    )
    .first();
}
