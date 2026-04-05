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
    displayName: "TabForge",
    mode: "payment",
    stripePriceId: env.stripePriceTabforge,
    defaultSuccessPath: "/store/tabforge/index.html",
    defaultCancelPath: "/store/tabforge/index.html",
  },
};

const CatalogCheckoutSchema = z.object({
  productSlug: z.string().min(1),
  successPath: z.string().optional(),
  cancelPath: z.string().optional(),
});

const PortalSessionSchema = z.object({
  returnPath: z.string().optional(),
});

function getStripe() {
  if (!env.stripeSecretKey) return null;
  return new Stripe(env.stripeSecretKey);
}

function normalizeProductSlug(slug) {
  return String(slug || "")
    .trim()
    .toLowerCase();
}

function getProductDefinition(productSlug) {
  const slug = normalizeProductSlug(productSlug);
  return PRODUCT_CATALOG[slug] || null;
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

  const fulfillmentType = String(session.metadata?.fulfillment_type || "");
  const productSlug = String(session.metadata?.product_slug || "")
    .trim()
    .toLowerCase();

  if (fulfillmentType === "product_entitlement" && productSlug) {
    await grantProductEntitlement({
      userId,
      productSlug,
      source: "stripe",
      sourceRef: String(session.payment_intent || session.id || ""),
      metadata: {
        checkout_session_id: session.id,
        customer_id: session.customer || null,
        payment_intent: session.payment_intent || null,
      },
    });
  }
}

/**
 * GET /v1/billing/me
 * Returns current plan + limits + whether subscription exists.
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
 * Dev / admin helper while building.
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
 * POST /v1/billing/catalog/checkout-session
 * Creates a Stripe Checkout session for owned catalog products.
 */
billingRouter.post("/catalog/checkout-session", requireAuth, async (req, res) => {
  const parsed = CatalogCheckoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input" });
  }

  const product = getProductDefinition(parsed.data.productSlug);
  if (!product) {
    return res.status(404).json({ error: "unknown_product" });
  }

  if (!product.stripePriceId) {
    return res.status(500).json({
      error: "product_not_configured",
      productSlug: product.slug,
    });
  }

  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  try {
    const { user, customerId } = await getOrCreateStripeCustomerForUser(req.user.sub);

    const successPath = sanitizeRelativePath(
      parsed.data.successPath,
      product.defaultSuccessPath
    );
    const cancelPath = sanitizeRelativePath(
      parsed.data.cancelPath,
      product.defaultCancelPath
    );

    const session = await stripe.checkout.sessions.create({
      mode: product.mode,
      customer: customerId,
      client_reference_id: user.id,
      line_items: [
        {
          price: product.stripePriceId,
          quantity: 1,
        },
      ],
      allow_promotion_codes: true,
      success_url: buildSiteUrl(successPath, {
        checkout: "success",
        session_id: "{CHECKOUT_SESSION_ID}",
      }),
      cancel_url: buildSiteUrl(cancelPath, {
        checkout: "cancelled",
      }),
      metadata: {
        user_id: user.id,
        product_slug: product.slug,
        fulfillment_type: "product_entitlement",
      },
    });

    return res.json({
      ok: true,
      url: session.url,
      sessionId: session.id,
      product: {
        slug: product.slug,
        displayName: product.displayName,
      },
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
 * POST /v1/billing/stripe/portal-session
 * For recurring billing management later. Safe to expose now.
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
      "/store/tabforge/index.html"
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
 * StoreKit2 placeholder ingest.
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
 * Play Billing placeholder ingest.
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
 * Preserves existing /v1/billing/stripe/webhook behavior while also handling
 * checkout-session product entitlement fulfillment.
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