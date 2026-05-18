import crypto from "crypto";

const PRODUCTS = [
  {
    slug: "inmate-records-logo-sticker",
    type: "sticker",
    name: "Inmate Records Logo Sticker",
    description:
      "Die-cut Inmate Records logo sticker with a clean white border and weather-resistant label energy.",
    image_url: "/assets/inmate-records-sticker-preview.png",
    status: "active",
    sort_order: 10,
    variants: [
      {
        sku: "IR-STICKER-LOGO-STANDARD",
        name: "Standard Die-Cut",
        option_label: "Standard",
        price_cents: 499,
        currency: "USD",
        fulfillment_provider: "printful",
        fulfillment_variant_id: null,
        fulfillment_metadata: {
          product_family: "sticker",
          printful_note:
            "Set fulfillment_variant_id after final Printful product/variant is created.",
        },
        sort_order: 10,
      },
    ],
  },
  {
    slug: "inmate-records-bumper-sticker",
    type: "bumper_sticker",
    name: "Inmate Records Bumper Sticker",
    description:
      "Long-format weatherproof bumper sticker for cars, cases, toolboxes and street-level promo.",
    image_url: "/assets/inmate-records-sticker-preview.png",
    status: "active",
    sort_order: 20,
    variants: [
      {
        sku: "IR-BUMPER-STICKER-STANDARD",
        name: "Standard Bumper Sticker",
        option_label: "Standard",
        price_cents: 799,
        currency: "USD",
        fulfillment_provider: "printful",
        fulfillment_variant_id: null,
        fulfillment_metadata: {
          product_family: "bumper_sticker",
          printful_note:
            "Set fulfillment_variant_id after final Printful product/variant is created.",
        },
        sort_order: 10,
      },
    ],
  },
  {
    slug: "inmate-records-logo-tee",
    type: "tee",
    name: "Inmate Records Logo Tee",
    description:
      "Label tee with the Inmate Records logo. Built as a clean first merch drop product.",
    image_url: "/assets/inmate-records-sticker-preview.png",
    status: "active",
    sort_order: 30,
    variants: [
      {
        sku: "IR-TEE-BLACK-M",
        name: "Black / M",
        option_label: "Black / M",
        price_cents: 2999,
        currency: "USD",
        fulfillment_provider: "printful",
        fulfillment_variant_id: null,
        fulfillment_metadata: { color: "black", size: "M" },
        sort_order: 10,
      },
      {
        sku: "IR-TEE-BLACK-L",
        name: "Black / L",
        option_label: "Black / L",
        price_cents: 2999,
        currency: "USD",
        fulfillment_provider: "printful",
        fulfillment_variant_id: null,
        fulfillment_metadata: { color: "black", size: "L" },
        sort_order: 20,
      },
      {
        sku: "IR-TEE-BLACK-XL",
        name: "Black / XL",
        option_label: "Black / XL",
        price_cents: 2999,
        currency: "USD",
        fulfillment_provider: "printful",
        fulfillment_variant_id: null,
        fulfillment_metadata: { color: "black", size: "XL" },
        sort_order: 30,
      },
      {
        sku: "IR-TEE-BLACK-2XL",
        name: "Black / 2XL",
        option_label: "Black / 2XL",
        price_cents: 3199,
        currency: "USD",
        fulfillment_provider: "printful",
        fulfillment_variant_id: null,
        fulfillment_metadata: { color: "black", size: "2XL" },
        sort_order: 40,
      },
    ],
  },
  {
    slug: "inmate-records-logo-hoodie",
    type: "hoodie",
    name: "Inmate Records Logo Hoodie",
    description:
      "Heavy label hoodie for colder weather, shows and limited merch drops.",
    image_url: "/assets/inmate-records-sticker-preview.png",
    status: "active",
    sort_order: 40,
    variants: [
      {
        sku: "IR-HOODIE-BLACK-M",
        name: "Black / M",
        option_label: "Black / M",
        price_cents: 5499,
        currency: "USD",
        fulfillment_provider: "printful",
        fulfillment_variant_id: null,
        fulfillment_metadata: { color: "black", size: "M" },
        sort_order: 10,
      },
      {
        sku: "IR-HOODIE-BLACK-L",
        name: "Black / L",
        option_label: "Black / L",
        price_cents: 5499,
        currency: "USD",
        fulfillment_provider: "printful",
        fulfillment_variant_id: null,
        fulfillment_metadata: { color: "black", size: "L" },
        sort_order: 20,
      },
      {
        sku: "IR-HOODIE-BLACK-XL",
        name: "Black / XL",
        option_label: "Black / XL",
        price_cents: 5499,
        currency: "USD",
        fulfillment_provider: "printful",
        fulfillment_variant_id: null,
        fulfillment_metadata: { color: "black", size: "XL" },
        sort_order: 30,
      },
      {
        sku: "IR-HOODIE-BLACK-2XL",
        name: "Black / 2XL",
        option_label: "Black / 2XL",
        price_cents: 5799,
        currency: "USD",
        fulfillment_provider: "printful",
        fulfillment_variant_id: null,
        fulfillment_metadata: { color: "black", size: "2XL" },
        sort_order: 40,
      },
    ],
  },
  {
    slug: "inmate-records-logo-hat",
    type: "hat",
    name: "Inmate Records Logo Hat",
    description:
      "Simple Inmate Records hat concept for the first label merch catalog.",
    image_url: "/assets/inmate-records-sticker-preview.png",
    status: "active",
    sort_order: 50,
    variants: [
      {
        sku: "IR-HAT-BLACK-STANDARD",
        name: "Black / Standard",
        option_label: "Black / Standard",
        price_cents: 2999,
        currency: "USD",
        fulfillment_provider: "printful",
        fulfillment_variant_id: null,
        fulfillment_metadata: { color: "black", size: "standard" },
        sort_order: 10,
      },
    ],
  },
];

async function upsertProduct(knex, product) {
  const existing = await knex("inmate_records_products")
    .where({ slug: product.slug })
    .first();

  const payload = {
    type: product.type,
    name: product.name,
    description: product.description,
    image_url: product.image_url,
    status: product.status,
    sort_order: product.sort_order,
    updated_at: knex.fn.now(),
  };

  let productId = existing?.id;

  if (existing) {
    await knex("inmate_records_products")
      .where({ id: existing.id })
      .update(payload);
  } else {
    productId = crypto.randomUUID();

    await knex("inmate_records_products").insert({
      id: productId,
      slug: product.slug,
      ...payload,
      metadata: {},
      created_at: knex.fn.now(),
    });
  }

  for (const variant of product.variants) {
    const existingVariant = await knex("inmate_records_product_variants")
      .where({ sku: variant.sku })
      .first();

    const variantPayload = {
      product_id: productId,
      name: variant.name,
      option_label: variant.option_label,
      price_cents: variant.price_cents,
      currency: variant.currency,
      is_active: true,
      fulfillment_provider: variant.fulfillment_provider,
      fulfillment_variant_id: variant.fulfillment_variant_id,
      fulfillment_metadata: variant.fulfillment_metadata,
      sort_order: variant.sort_order,
      updated_at: knex.fn.now(),
    };

    if (existingVariant) {
      await knex("inmate_records_product_variants")
        .where({ id: existingVariant.id })
        .update(variantPayload);
    } else {
      await knex("inmate_records_product_variants").insert({
        id: crypto.randomUUID(),
        sku: variant.sku,
        ...variantPayload,
        created_at: knex.fn.now(),
      });
    }
  }
}

export async function up(knex) {
  const hasProducts = await knex.schema.hasTable("inmate_records_products");

  if (!hasProducts) {
    await knex.schema.createTable("inmate_records_products", (t) => {
      t.uuid("id").primary();
      t.text("slug").notNullable().unique();
      t.text("type").notNullable().index();
      t.text("name").notNullable();
      t.text("description").notNullable().defaultTo("");
      t.text("image_url").nullable();
      t.text("status").notNullable().defaultTo("draft").index();
      t.integer("sort_order").notNullable().defaultTo(100);
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  const hasVariants = await knex.schema.hasTable("inmate_records_product_variants");

  if (!hasVariants) {
    await knex.schema.createTable("inmate_records_product_variants", (t) => {
      t.uuid("id").primary();
      t.uuid("product_id").notNullable().references("id").inTable("inmate_records_products").onDelete("CASCADE");
      t.text("sku").notNullable().unique();
      t.text("name").notNullable();
      t.text("option_label").notNullable().defaultTo("Standard");
      t.integer("price_cents").notNullable();
      t.text("currency").notNullable().defaultTo("USD");
      t.boolean("is_active").notNullable().defaultTo(true).index();
      t.text("fulfillment_provider").notNullable().defaultTo("printful");
      t.text("fulfillment_variant_id").nullable();
      t.jsonb("fulfillment_metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.integer("sort_order").notNullable().defaultTo(100);
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index(["product_id", "is_active"]);
    });
  }

  const hasOrders = await knex.schema.hasTable("inmate_records_orders");

  if (!hasOrders) {
    await knex.schema.createTable("inmate_records_orders", (t) => {
      t.uuid("id").primary();
      t.text("order_number").notNullable().unique();
      t.text("status").notNullable().defaultTo("pending").index();
      t.text("fulfillment_status").notNullable().defaultTo("not_submitted").index();
      t.text("stripe_checkout_session_id").nullable().unique();
      t.text("stripe_payment_intent_id").nullable().index();
      t.text("stripe_customer_id").nullable().index();
      t.text("customer_email").nullable().index();
      t.integer("subtotal_cents").notNullable().defaultTo(0);
      t.integer("shipping_cents").notNullable().defaultTo(0);
      t.integer("tax_cents").notNullable().defaultTo(0);
      t.integer("total_cents").notNullable().defaultTo(0);
      t.text("currency").notNullable().defaultTo("USD");
      t.jsonb("shipping_address").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.text("fulfillment_provider").notNullable().defaultTo("printful");
      t.text("fulfillment_order_id").nullable().index();
      t.text("tracking_url").nullable();
      t.text("tracking_number").nullable();
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("paid_at", { useTz: true }).nullable();
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  const hasItems = await knex.schema.hasTable("inmate_records_order_items");

  if (!hasItems) {
    await knex.schema.createTable("inmate_records_order_items", (t) => {
      t.uuid("id").primary();
      t.uuid("order_id").notNullable().references("id").inTable("inmate_records_orders").onDelete("CASCADE");
      t.uuid("product_id").notNullable().references("id").inTable("inmate_records_products");
      t.uuid("variant_id").notNullable().references("id").inTable("inmate_records_product_variants");
      t.text("product_slug").notNullable();
      t.text("product_name").notNullable();
      t.text("variant_name").notNullable();
      t.text("sku").notNullable();
      t.integer("quantity").notNullable();
      t.integer("unit_amount_cents").notNullable();
      t.integer("line_total_cents").notNullable();
      t.text("currency").notNullable().defaultTo("USD");
      t.text("fulfillment_variant_id").nullable();
      t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index(["order_id"]);
      t.index(["product_slug"]);
    });
  }

  const hasEvents = await knex.schema.hasTable("inmate_records_fulfillment_events");

  if (!hasEvents) {
    await knex.schema.createTable("inmate_records_fulfillment_events", (t) => {
      t.uuid("id").primary();
      t.uuid("order_id").nullable().references("id").inTable("inmate_records_orders").onDelete("SET NULL");
      t.text("provider").notNullable().defaultTo("printful").index();
      t.text("event_type").notNullable().index();
      t.text("provider_event_id").nullable().index();
      t.jsonb("payload").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  for (const product of PRODUCTS) {
    await upsertProduct(knex, product);
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("inmate_records_fulfillment_events");
  await knex.schema.dropTableIfExists("inmate_records_order_items");
  await knex.schema.dropTableIfExists("inmate_records_orders");
  await knex.schema.dropTableIfExists("inmate_records_product_variants");
  await knex.schema.dropTableIfExists("inmate_records_products");
}
