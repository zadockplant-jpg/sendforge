import { Router } from "express";
import crypto from "crypto";
import Stripe from "stripe";
import { z } from "zod";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { getActivePlan, grantProductEntitlement } from "../services/entitlement.service.js";

export const billingRouter = Router();

const PRODUCT_CATALOG = {
  tabforge: {
    slug: "tabforge",
    displayName: "TabForge Pro",
    mode: "payment",
    stripePriceId: env.stripePriceTabforge,
    unitAmountCents: 1000,
    defaultSuccessPath: "/products/tabforge/index.html",
    defaultCancelPath: "/products/tabforge/index.html",
  },
  "tabforge-page": {
    slug: "tabforge-page",
    displayName: "TabForge Extra Pages (Retired)",
    mode: "payment",
    unitAmountCents: 500,
    entitlementSlug: "tabforge-pages",
    quantityMin: 1,
    quantityMax: 10,
    requiresEntitlement: "tabforge",
    defaultSuccessPath: "/products/tabforge/index.html",
    defaultCancelPath: "/products/tabforge/index.html",
  },
  "tabforge-collections-subscription": {
    slug: "tabforge-collections-subscription",
    displayName: "TabForge Sync + Collections",
    mode: "subscription",
    unitAmountCents: 500,
    entitlementSlug: "tabforge-subscription",
    subscriptionPlan: "tabforge_sync_collections",
    defaultSuccessPath: "/account/index.html?purchase_context=tf-pack",
    defaultCancelPath: "/store/index.html#tabforge",
  },
  "tabforge-skin-command-center": {
    slug: "tabforge-skin-command-center",
    displayName: "TabForge Skins — Star Base",
    mode: "payment",
    unitAmountCents: 700,
    entitlementSlug: "tabforge-skin-bundle-command-center",
    singlePurchase: true,
    defaultSuccessPath: "/products/tabforge/index.html#pricing",
    defaultCancelPath: "/store/index.html#tabforge",
  },
  "tabforge-skin-creator-money": {
    slug: "tabforge-skin-creator-money",
    displayName: "TabForge Skins — Creator",
    mode: "payment",
    unitAmountCents: 700,
    entitlementSlug: "tabforge-skin-bundle-creator-money",
    singlePurchase: true,
    defaultSuccessPath: "/products/tabforge/index.html#pricing",
    defaultCancelPath: "/store/index.html#tabforge",
  },
  "tabforge-skin-wild-forge": {
    slug: "tabforge-skin-wild-forge",
    displayName: "TabForge Skins — Wild Forge",
    mode: "payment",
    unitAmountCents: 700,
    entitlementSlug: "tabforge-skin-bundle-wild-forge",
    singlePurchase: true,
    defaultSuccessPath: "/products/tabforge/index.html#pricing",
    defaultCancelPath: "/store/index.html#tabforge",
  },
  "tabforge-skin-all": {
    slug: "tabforge-skin-all",
    displayName: "TabForge Skins — All 3 Bundles",
    mode: "payment",
    unitAmountCents: 1500,
    entitlementSlug: "tabforge-skin-bundle-all",
    singlePurchase: false,
    defaultSuccessPath: "/products/tabforge/index.html#pricing",
    defaultCancelPath: "/store/index.html#tabforge",
  },
};

const TABFORGE_PACK_CATALOG = {
  builder: {
    slug: "builder",
    displayName: "Builder Pack",
    entitlementSlug: "tabforge-pack-builder",
    unitAmountCents: 500,
  },
  money: {
    slug: "money",
    displayName: "Money Pack",
    entitlementSlug: "tabforge-pack-money",
    unitAmountCents: 500,
  },
  dev: {
    slug: "dev",
    displayName: "Web / Dev Pack",
    entitlementSlug: "tabforge-pack-dev",
    unitAmountCents: 500,
  },
  media: {
    slug: "media",
    displayName: "Media Pack",
    entitlementSlug: "tabforge-pack-media",
    unitAmountCents: 500,
  },
  research: {
    slug: "research",
    displayName: "Research Pack",
    entitlementSlug: "tabforge-pack-research",
    unitAmountCents: 500,
  },
  games: {
    slug: "games",
    displayName: "Games Pack",
    entitlementSlug: "tabforge-pack-games",
    unitAmountCents: 500,
  },
};

const TABFORGE_SKIN_CART_CATALOG = {
  "command-center": {
    slug: "command-center",
    displayName: "Star Base",
    productSlug: "tabforge-skin-command-center",
    entitlementSlug: "tabforge-skin-bundle-command-center",
    unitAmountCents: 700,
  },
  "creator-money": {
    slug: "creator-money",
    displayName: "Creator",
    productSlug: "tabforge-skin-creator-money",
    entitlementSlug: "tabforge-skin-bundle-creator-money",
    unitAmountCents: 700,
  },
  "wild-forge": {
    slug: "wild-forge",
    displayName: "Wild Forge",
    productSlug: "tabforge-skin-wild-forge",
    entitlementSlug: "tabforge-skin-bundle-wild-forge",
    unitAmountCents: 700,
  },
};
const TABFORGE_ALL_SKIN_ENTITLEMENTS = Object.values(TABFORGE_SKIN_CART_CATALOG).map((skin) => skin.entitlementSlug);

const CatalogCheckoutSchema = z
  .object({
    productSlug: z.string().min(1).optional(),
    packSlugs: z.array(z.string().min(1)).max(100).optional(),
    skinSlugs: z.array(z.string().min(1)).max(3).optional(),
    quantity: z.number().int().min(1).max(10).optional(),
    successPath: z.string().optional(),
    cancelPath: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const hasProduct = Boolean(value.productSlug);
    const hasPacks = Array.isArray(value.packSlugs) && value.packSlugs.length > 0;
    const hasSkins = Array.isArray(value.skinSlugs) && value.skinSlugs.length > 0;

    if (!hasProduct && !hasPacks && !hasSkins) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productSlug"],
        message: "productSlug, packSlugs, or skinSlugs is required",
      });
    }

    const selectedGroups = [hasProduct, hasPacks, hasSkins].filter(Boolean).length;
    if (selectedGroups > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productSlug"],
        message: "Use productSlug, packSlugs, or skinSlugs in a single checkout request",
      });
    }
  });

const DonationCheckoutSchema = z.object({
  toolSlug: z.string().trim().min(1).max(120).optional(),
  defaultAmountDollars: z.coerce.number().min(1).max(500).optional(),
  successPath: z.string().optional(),
  cancelPath: z.string().optional(),
});

const IncludedPackRedeemSchema = z.object({
  packSlug: z.string().min(1),
});

const PortalSessionSchema = z.object({
  returnPath: z.string().optional(),
});

function getStripe() {
  if (!env.stripeSecretKey) return null;
  return new Stripe(env.stripeSecretKey);
}

function normalizeSlug(slug) {
  return String(slug || "")
    .trim()
    .toLowerCase();
}

function getProductDefinition(productSlug) {
  return PRODUCT_CATALOG[normalizeSlug(productSlug)] || null;
}

function getPackDefinition(packSlug) {
  return TABFORGE_PACK_CATALOG[normalizeSlug(packSlug)] || null;
}

function getSkinDefinition(skinSlug) {
  const slug = normalizeSlug(skinSlug);
  return TABFORGE_SKIN_CART_CATALOG[slug] || Object.values(TABFORGE_SKIN_CART_CATALOG).find((skin) => skin.productSlug === slug || skin.entitlementSlug === slug) || null;
}

function sanitizeRelativePath(path, fallback) {
  if (typeof path === "string" && path.startsWith("/")) {
    return path;
  }
  return fallback;
}

function buildSiteUrl(path, extraQuery = {}) {
  const url = new URL(path, env.publicSiteUrl);
  for (const [key, value] of Object.entries(extraQuery)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function uniqStrings(values = []) {
  const out = [];
  const seen = new Set();

  for (const value of values) {
    const normalized = normalizeSlug(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

function serializeCheckoutItems(items = []) {
  return JSON.stringify(items);
}

async function getUserOrFail(userId) {
  const user = await db("users").where({ id: userId }).first();
  if (!user) {
    const err = new Error("user_not_found");
    err.statusCode = 404;
    throw err;
  }
  return user;
}

async function getOrCreateStripeCustomerForUser(userId) {
  const stripe = getStripe();
  if (!stripe) {
    const err = new Error("stripe_not_configured");
    err.statusCode = 500;
    throw err;
  }

  const user = await getUserOrFail(userId);

  if (user.stripe_customer_id) {
    try {
      const customer = await stripe.customers.retrieve(user.stripe_customer_id);
      if (!customer?.deleted && user.email && customer.email !== user.email) {
        await stripe.customers.update(user.stripe_customer_id, {
          email: user.email,
          metadata: {
            ...(customer.metadata || {}),
            user_id: user.id,
          },
        });
      }
    } catch {
      // Do not block checkout if Stripe customer email refresh fails.
      // Checkout still uses the stored customer ID and webhook fulfillment remains authoritative.
    }

    return {
      user,
      customerId: user.stripe_customer_id,
    };
  }

  const customer = await stripe.customers.create({
    email: user.email,
    metadata: {
      user_id: user.id,
    },
  });

  await db("users")
    .where({ id: user.id })
    .update({
      stripe_customer_id: customer.id,
    });

  return {
    user,
    customerId: customer.id,
  };
}

async function userHasEntitlement(userId, productSlug) {
  const row = await db("product_entitlements")
    .where({
      user_id: userId,
      product_slug: normalizeSlug(productSlug),
      status: "active",
    })
    .first();

  return Boolean(row);
}

function buildLineItems({ product, packs, skins, quantity }) {
  const lineItems = [];

  if (product) {
    const itemQuantity = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;

    const priceData = {
      currency: "usd",
      unit_amount: product.unitAmountCents,
      product_data: {
        name: product.displayName,
        metadata: {
          kind: product.mode === "subscription" ? "subscription" : (product.slug === "tabforge-page" ? "page_quantity" : "product"),
          slug: product.slug,
          entitlement_slug: product.entitlementSlug || product.slug,
        },
      },
    };
    if (product.mode === "subscription") {
      priceData.recurring = { interval: "month" };
    }

    lineItems.push({
      quantity: itemQuantity,
      price_data: priceData,
    });
  }

  for (const pack of packs) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: pack.unitAmountCents,
        product_data: {
          name: `TabForge - ${pack.displayName}`,
          metadata: {
            kind: "pack",
            slug: pack.slug,
            entitlement_slug: pack.entitlementSlug,
          },
        },
      },
    });
  }

  for (const skin of skins) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: skin.unitAmountCents,
        product_data: {
          name: `TabForge Skins - ${skin.displayName}`,
          metadata: {
            kind: "skin",
            slug: skin.slug,
            entitlement_slug: skin.entitlementSlug,
          },
        },
      },
    });
  }

  return lineItems;
}

function buildCheckoutSummary({ product, packs, skins, quantity }) {
  const items = [];

  if (product) {
    const itemQuantity = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
    const kind = product.mode === "subscription" ? "subscription" : (product.slug === "tabforge-page" ? "page_quantity" : "product");

    items.push({
      kind,
      slug: product.slug,
      displayName: product.displayName,
      entitlementSlug: product.entitlementSlug || product.slug,
      unitAmountCents: product.unitAmountCents ?? null,
      quantity: itemQuantity,
    });
  }

  for (const pack of packs) {
    items.push({
      kind: "pack",
      slug: pack.slug,
      displayName: pack.displayName,
      entitlementSlug: pack.entitlementSlug,
      unitAmountCents: pack.unitAmountCents,
      quantity: 1,
    });
  }

  for (const skin of skins) {
    items.push({
      kind: "skin",
      slug: skin.slug,
      displayName: skin.displayName,
      entitlementSlug: skin.entitlementSlug,
      unitAmountCents: skin.unitAmountCents,
      quantity: 1,
    });
  }

  return items;
}

async function upsertStripeSubscriptionFromWebhook(sub) {
  const customerId = sub.customer ? String(sub.customer) : "";
  const userId =
    sub.metadata?.user_id ||
    (
      await db("users")
        .select("id")
        .where({ stripe_customer_id: customerId })
        .first()
    )?.id;

  const plan =
    sub.items?.data?.[0]?.price?.metadata?.plan ||
    sub.metadata?.plan ||
    "starter";

  const status = String(sub.status || "active");

  if (!userId) {
    return;
  }

  if (customerId) {
    await db("users")
      .where({ id: userId })
      .update({
        stripe_customer_id: customerId,
      });
  }

  const existing = await db("subscriptions")
    .where({
      provider: "stripe",
      provider_subscription_id: String(sub.id || ""),
    })
    .first();

  const payload = {
    user_id: userId,
    provider: "stripe",
    provider_customer_id: customerId,
    provider_subscription_id: String(sub.id || ""),
    plan,
    status,
    current_period_start: sub.current_period_start
      ? new Date(sub.current_period_start * 1000)
      : null,
    current_period_end: sub.current_period_end
      ? new Date(sub.current_period_end * 1000)
      : null,
    raw: sub,
    updated_at: db.fn.now(),
  };

  if (existing) {
    await db("subscriptions")
      .where({ id: existing.id })
      .update(payload);
    return;
  }

  await db("subscriptions").insert({
    id: crypto.randomUUID(),
    ...payload,
  });
}

async function cancelStripeSubscriptionFromWebhook(sub) {
  const providerSubscriptionId = String(sub.id || "");
  if (!providerSubscriptionId) return;

  await db("subscriptions")
    .where({
      provider: "stripe",
      provider_subscription_id: providerSubscriptionId,
    })
    .update({
      status: "canceled",
      raw: sub,
      updated_at: db.fn.now(),
    });
}

async function handleStripeCheckoutSessionCompleted(session) {
  const userId =
    session.metadata?.user_id ||
    session.client_reference_id ||
    (
      await db("users")
        .select("id")
        .where({ stripe_customer_id: String(session.customer || "") })
        .first()
    )?.id;

  if (!userId) {
    return;
  }

  if (session.customer) {
    await db("users")
      .where({ id: userId })
      .update({
        stripe_customer_id: String(session.customer),
      });
  }

  return;
}

/**
 * GET /v1/billing/me
 */
billingRouter.get("/me", requireAuth, async (req, res) => {
  try {
    const r = await getActivePlan(req.user.sub);
    return res.json(r);
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});

/**
 * POST /v1/billing/activate
 */
billingRouter.post("/activate", requireAuth, async (req, res) => {
  const plan = String(req.body.plan || "starter");
  const status = "active";

  try {
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);

    const [sub] = await db("subscriptions")
      .insert({
        id: crypto.randomUUID(),
        user_id: req.user.sub,
        provider: "manual",
        provider_customer_id: "",
        provider_subscription_id: "",
        plan,
        status,
        current_period_start: now,
        current_period_end: end,
        raw: { note: "manual activation" },
        updated_at: db.fn.now(),
      })
      .returning("*");

    return res.json({ ok: true, subscription: sub });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});

/**
 * POST /v1/billing/donations/checkout-session
 * Public optional donation checkout for developer tool downloads.
 * Downloads are not gated; the website starts the file first, then opens this preset $5 flow.
 */
billingRouter.post("/donations/checkout-session", async (req, res) => {
  const parsed = DonationCheckoutSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input" });
  }

  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  const amountDollars = Math.min(500, Math.max(1, Math.round(Number(parsed.data.defaultAmountDollars || 5))));
  const toolSlug = normalizeSlug(parsed.data.toolSlug || "developer-tools");
  const successPath = sanitizeRelativePath(parsed.data.successPath, "/downloads/index.html?donation=success");
  const cancelPath = sanitizeRelativePath(parsed.data.cancelPath, "/downloads/index.html?donation=cancelled");

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      submit_type: "donate",
      line_items: [
        {
          quantity: amountDollars,
          adjustable_quantity: {
            enabled: true,
            minimum: 1,
            maximum: 500,
          },
          price_data: {
            currency: "usd",
            unit_amount: 100,
            product_data: {
              name: "Optional SendForge developer tools donation",
              description: "Downloads are free. Donations help us create projects that make the world a better place.",
              metadata: {
                kind: "developer_tools_donation",
                tool_slug: toolSlug,
              },
            },
          },
        },
      ],
      success_url: buildSiteUrl(successPath, {
        donation: "success",
        session_id: "{CHECKOUT_SESSION_ID}",
      }),
      cancel_url: buildSiteUrl(cancelPath, {
        donation: "cancelled",
      }),
      metadata: {
        fulfillment_type: "optional_developer_tools_donation",
        tool_slug: toolSlug,
        default_amount_dollars: String(amountDollars),
      },
    });

    return res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (err) {
    return res.status(500).json({
      error: "donation_checkout_failed",
      message: String(err?.message || err),
    });
  }
});

/**
 * POST /v1/billing/catalog/checkout-session
 * Supports:
 * - single product checkout
 * - retired extra-page requests return an explicit error
 * - Sync + Collections subscription checkout
 * - retired collection/skin direct checkout returns explicit errors
 */
billingRouter.post("/catalog/checkout-session", requireAuth, async (req, res) => {
  const parsed = CatalogCheckoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input" });
  }

  const requestedProductSlug = parsed.data.productSlug
    ? normalizeSlug(parsed.data.productSlug)
    : "";

  const product = requestedProductSlug
    ? getProductDefinition(requestedProductSlug)
    : null;

  if (requestedProductSlug && !product) {
    return res.status(404).json({ error: "unknown_product" });
  }

  const requestedPackSlugs = uniqStrings(parsed.data.packSlugs || []);
  const unknownPackSlugs = requestedPackSlugs.filter((slug) => !getPackDefinition(slug));
  if (unknownPackSlugs.length) {
    return res.status(404).json({
      error: "unknown_pack",
      packSlugs: unknownPackSlugs,
    });
  }

  const requestedSkinSlugs = uniqStrings(parsed.data.skinSlugs || []);
  const unknownSkinSlugs = requestedSkinSlugs.filter((slug) => !getSkinDefinition(slug));
  if (unknownSkinSlugs.length) {
    return res.status(404).json({
      error: "unknown_skin_bundle",
      skinSlugs: unknownSkinSlugs,
    });
  }

  const packs = requestedPackSlugs.map((slug) => getPackDefinition(slug)).filter(Boolean);
  const skins = requestedSkinSlugs.map((slug) => getSkinDefinition(slug)).filter(Boolean);
  const quantity = Number.isInteger(parsed.data.quantity) ? parsed.data.quantity : 1;

  if (!product && packs.length === 0 && skins.length === 0) {
    return res.status(400).json({ error: "empty_checkout" });
  }

  if (packs.length > 0) {
    return res.status(410).json({
      error: "individual_collections_retired",
      message: "Individual collection purchases have been retired. Collections are included in the $5/month TabForge Sync + Collections subscription.",
    });
  }

  if (skins.length > 0 || (product?.slug || "").startsWith("tabforge-skin-")) {
    return res.status(410).json({
      error: "visual_addons_delayed",
      message: "Skin collections and icon packs are coming later as optional one-time add-ons.",
    });
  }

  if (product?.slug === "tabforge-page") {
    return res.status(410).json({
      error: "product_retired",
      message: "Extra page purchases have been retired. TabForge Pro now includes all 10 pages.",
    });
  }

  if (product?.singlePurchase || product?.slug === "tabforge" || product?.slug === "tabforge-collections-subscription") {
    const entitlementSlug = product.entitlementSlug || product.slug;
    const alreadyOwned = await userHasEntitlement(req.user.sub, entitlementSlug);
    if (alreadyOwned) {
      return res.status(409).json({
        error: "already_owned",
        message: `You already own ${product.displayName}.`,
      });
    }
  }

  if (packs.length > 0) {
    const ownedPackSlugs = [];
    for (const pack of packs) {
      const alreadyOwnsPack = await userHasEntitlement(req.user.sub, pack.entitlementSlug);
      if (alreadyOwnsPack) ownedPackSlugs.push(pack.entitlementSlug);
    }

    if (ownedPackSlugs.length > 0) {
      return res.status(409).json({
        error: "already_owned",
        message: "You already own one or more selected packs.",
        productSlugs: ownedPackSlugs,
      });
    }
  }

  if (product?.slug === "tabforge-skin-all") {
    const ownedSkinSlugs = [];
    for (const entitlementSlug of TABFORGE_ALL_SKIN_ENTITLEMENTS) {
      if (await userHasEntitlement(req.user.sub, entitlementSlug)) ownedSkinSlugs.push(entitlementSlug);
    }
    if (ownedSkinSlugs.length > 0) {
      return res.status(409).json({
        error: "already_owned",
        message: "You already own one or more selected skin bundles.",
        productSlugs: ownedSkinSlugs,
      });
    }
  }

  if (skins.length > 0) {
    const ownedSkinSlugs = [];
    for (const skin of skins) {
      const alreadyOwnsSkin = await userHasEntitlement(req.user.sub, skin.entitlementSlug);
      if (alreadyOwnsSkin) ownedSkinSlugs.push(skin.entitlementSlug);
    }
    if (ownedSkinSlugs.length > 0) {
      return res.status(409).json({
        error: "already_owned",
        message: "You already own one or more selected skin bundles.",
        productSlugs: ownedSkinSlugs,
      });
    }
  }

  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  try {
    const { user, customerId } = await getOrCreateStripeCustomerForUser(req.user.sub);

    const defaultSuccessPath = product?.defaultSuccessPath || (skins.length ? "/products/tabforge/index.html#pricing" : "/products/tabforge/index.html");
    const defaultCancelPath = product?.defaultCancelPath || (skins.length ? "/store/index.html#tabforge" : "/products/tabforge/index.html");
    const successPath = sanitizeRelativePath(parsed.data.successPath, defaultSuccessPath);
    const cancelPath = sanitizeRelativePath(parsed.data.cancelPath, defaultCancelPath);

    const checkoutItems = buildCheckoutSummary({ product, packs, skins, quantity });
    const lineItems = buildLineItems({ product, packs, skins, quantity });

    const metadata =
      checkoutItems.length === 1 &&
      checkoutItems[0].kind === "product" &&
      checkoutItems[0].slug === "tabforge"
        ? {
            user_id: user.id,
            product_slug: "tabforge",
            fulfillment_type: "product_entitlement",
          }
        : {
            user_id: user.id,
            product_slug: product?.slug || "",
            fulfillment_type: "multi_entitlement_cart",
            checkout_items: serializeCheckoutItems(checkoutItems),
          };

    const sessionConfig = {
      mode: product?.mode === "subscription" ? "subscription" : "payment",
      customer: customerId,
      client_reference_id: user.id,
      line_items: lineItems,
      allow_promotion_codes: true,
      success_url: buildSiteUrl(successPath, {
        checkout: "success",
        session_id: "{CHECKOUT_SESSION_ID}",
      }),
      cancel_url: buildSiteUrl(cancelPath, {
        checkout: "cancelled",
      }),
      metadata,
    };
    if (sessionConfig.mode === "subscription") {
      sessionConfig.subscription_data = {
        metadata: {
          user_id: user.id,
          product_slug: product?.slug || "",
          entitlement_slug: product?.entitlementSlug || product?.slug || "",
          plan: product?.subscriptionPlan || product?.slug || "subscription",
          fulfillment_type: "subscription_entitlement",
          cloud_provider_status: "stubbed_until_provider_except_admin",
          cloud_storage_gb_limit: product?.slug === "tabforge-collections-subscription" ? "20" : "",
          checkout_items: serializeCheckoutItems(checkoutItems),
        },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    return res.json({
      ok: true,
      url: session.url,
      sessionId: session.id,
      checkout: {
        items: checkoutItems,
      },
    });
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    const message = String(err?.message || err);

    return res.status(statusCode).json({
      error: statusCode === 404 ? "user_not_found" : "server_error",
      message,
    });
  }
});


/**
 * POST /v1/billing/catalog/redeem-included-pack
 * Legacy endpoint for redeeming old included-pack credits.
 */
billingRouter.post("/catalog/redeem-included-pack", requireAuth, async (req, res) => {
  const parsed = IncludedPackRedeemSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input" });
  }

  const pack = getPackDefinition(parsed.data.packSlug);
  if (!pack) {
    return res.status(404).json({ error: "unknown_pack" });
  }

  try {
    const hasPro = await userHasEntitlement(req.user.sub, "tabforge");
    if (!hasPro) {
      return res.status(403).json({
        error: "pro_required",
        message: "TabForge Pro is required before redeeming an included pack.",
      });
    }

    const alreadyOwnsPack = await userHasEntitlement(req.user.sub, pack.entitlementSlug);
    if (alreadyOwnsPack) {
      return res.status(409).json({
        error: "already_owned",
        message: "You already own this pack.",
        productSlug: pack.entitlementSlug,
      });
    }

    const credit = await db("product_entitlements")
      .where({
        user_id: req.user.sub,
        product_slug: "tabforge-included-pack-credit",
        status: "active",
      })
      .andWhere((qb) => {
        qb.whereNull("expires_at").orWhere("expires_at", ">", db.fn.now());
      })
      .first();

    if (!credit) {
      return res.status(403).json({
        error: "included_pack_credit_unavailable",
        message: "No included pack credit is available on this account.",
      });
    }

    const sourceRef = `included-pack-credit:${credit.id}:${pack.entitlementSlug}`;
    const creditMeta = credit.metadata && typeof credit.metadata === "object"
      ? credit.metadata
      : {};

    await db.transaction(async (trx) => {
      await trx("product_entitlements")
        .where({
          id: credit.id,
          user_id: req.user.sub,
          product_slug: "tabforge-included-pack-credit",
          status: "active",
        })
        .update({
          status: "redeemed",
          metadata: {
            ...creditMeta,
            redeemed_at: new Date().toISOString(),
            redeemed_pack_slug: pack.slug,
            redeemed_product_slug: pack.entitlementSlug,
          },
          updated_at: trx.fn.now(),
        });

      await grantProductEntitlement({
        userId: req.user.sub,
        productSlug: pack.entitlementSlug,
        source: "included_pack_credit",
        sourceRef,
        metadata: {
          included_with: "tabforge",
          credit_id: credit.id,
          pack_slug: pack.slug,
          pack_display_name: pack.displayName,
        },
      });
    });

    return res.json({
      ok: true,
      redeemed: {
        packSlug: pack.slug,
        productSlug: pack.entitlementSlug,
        displayName: pack.displayName,
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});

/**
 * POST /v1/billing/stripe/portal-session
 */
billingRouter.post("/stripe/portal-session", requireAuth, async (req, res) => {
  const parsed = PortalSessionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input" });
  }

  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  try {
    const user = await getUserOrFail(req.user.sub);

    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: "missing_stripe_customer" });
    }

    const returnPath = sanitizeRelativePath(
      parsed.data.returnPath,
      "/products/tabforge/index.html"
    );

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: buildSiteUrl(returnPath),
    });

    return res.json({
      ok: true,
      url: session.url,
    });
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    return res.status(statusCode).json({
      error: statusCode === 404 ? "user_not_found" : "server_error",
      message: String(err?.message || err),
    });
  }
});

/**
 * POST /v1/billing/apple/ingest
 */
billingRouter.post("/apple/ingest", requireAuth, async (req, res) => {
  const raw = req.body || {};
  const plan = String(raw.plan || "starter");

  try {
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);

    await db("subscriptions").insert({
      id: crypto.randomUUID(),
      user_id: req.user.sub,
      provider: "apple",
      provider_customer_id: "",
      provider_subscription_id: String(
        raw.originalTransactionId || raw.transactionId || ""
      ),
      plan,
      status: "trialing",
      current_period_start: now,
      current_period_end: end,
      raw,
      updated_at: db.fn.now(),
    });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});

/**
 * POST /v1/billing/google/ingest
 */
billingRouter.post("/google/ingest", requireAuth, async (req, res) => {
  const raw = req.body || {};
  const plan = String(raw.plan || "starter");

  try {
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);

    await db("subscriptions").insert({
      id: crypto.randomUUID(),
      user_id: req.user.sub,
      provider: "google",
      provider_customer_id: "",
      provider_subscription_id: String(raw.purchaseToken || ""),
      plan,
      status: "trialing",
      current_period_start: now,
      current_period_end: end,
      raw,
      updated_at: db.fn.now(),
    });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});

/**
 * STRIPE WEBHOOK (BACKWARD-COMPATIBLE)
 */
billingRouter.post("/stripe/webhook", async (req, res) => {
  const secret = env.stripeWebhookSecret;
  const stripe = getStripe();

  if (!secret || !stripe) {
    return res.status(500).send("Stripe not configured");
  }

  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleStripeCheckoutSessionCompleted(event.data.object);
        break;

      case "customer.subscription.created":
      case "customer.subscription.updated":
        await upsertStripeSubscriptionFromWebhook(event.data.object);
        break;

      case "customer.subscription.deleted":
        await cancelStripeSubscriptionFromWebhook(event.data.object);
        break;

      default:
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    return res.status(500).json({
      error: "webhook_handler_failed",
      message: String(err?.message || err),
    });
  }
});