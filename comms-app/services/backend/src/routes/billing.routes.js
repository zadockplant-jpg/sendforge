import { Router } from "express";
import crypto from "crypto";
import Stripe from "stripe";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { getActivePlan } from "../services/entitlement.service.js";

export const billingRouter = Router();

/**
 * GET /v1/billing/me
 * Returns current plan + limits + whether subscription exists
 */
billingRouter.get("/me", requireAuth, async (req, res) => {
  const r = await getActivePlan(req.user.sub);
  res.json(r);
});

/**
 * POST /v1/billing/activate (DEV / ADMIN)
 * Lets you manually set a plan while you’re building.
 * Remove for production if you want.
 */
billingRouter.post("/activate", requireAuth, async (req, res) => {
  const plan = String(req.body.plan || "starter");
  const status = "active";

  const now = new Date();
  const end = new Date(now);
  end.setMonth(end.getMonth() + 1);

  const [sub] = await db("subscriptions")
    .insert({
      id: crypto.randomUUID(),
      user_id: req.user.sub,
      provider: "manual",
      plan,
      status,
      current_period_start: now,
      current_period_end: end,
      raw: { note: "manual activation" },
      updated_at: db.fn.now(),
    })
    .returning("*");

  res.json({ ok: true, subscription: sub });
});

/**
 * POST /v1/billing/apple/ingest
 * StoreKit2: your client can POST signedTransactionInfo + productId.
 * Real cryptographic verification comes next (Bundle 4/5 depending).
 */
billingRouter.post("/apple/ingest", requireAuth, async (req, res) => {
  const raw = req.body || {};
  const plan = String(raw.plan || "starter"); // map productId -> plan later

  const now = new Date();
  const end = new Date(now);
  end.setMonth(end.getMonth() + 1);

  await db("subscriptions").insert({
    id: crypto.randomUUID(),
    user_id: req.user.sub,
    provider: "apple",
    provider_customer_id: "",
    provider_subscription_id: String(raw.originalTransactionId || raw.transactionId || ""),
    plan,
    status: "trialing", // mark trialing until verification step
    current_period_start: now,
    current_period_end: end,
    raw,
    updated_at: db.fn.now(),
  });

  res.json({ ok: true });
});

/**
 * POST /v1/billing/google/ingest
 * Play Billing: client can POST purchaseToken + productId.
 * Verification step comes next.
 */
billingRouter.post("/google/ingest", requireAuth, async (req, res) => {
  const raw = req.body || {};
  const plan = String(raw.plan || "starter"); // map productId -> plan later

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

  res.json({ ok: true });
});

/**
 * STRIPE WEBHOOK (REAL)
 * Used for Windows/web purchases, or for Android if you decide.
 * IMPORTANT: Do not surface external payment flows inside iOS app UI.
 */
billingRouter.post("/stripe/webhook", async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key) return res.status(500).send("Stripe not configured");

  const stripe = new Stripe(key);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Minimal: mark subscriptions active/canceled based on Stripe events
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
    const sub = event.data.object;

    // You MUST decide how to map Stripe customer/subscription to a user_id.
    // Common approach: store user_id in Stripe metadata on checkout/session.
    const userId = sub.metadata?.user_id;
    const plan = sub.items?.data?.[0]?.price?.metadata?.plan || "starter";
    const status = sub.status; // active, trialing, canceled, past_due...

    if (userId) {
      await db("subscriptions").insert({
        id: crypto.randomUUID(),
        user_id: userId,
        provider: "stripe",
        provider_customer_id: String(sub.customer || ""),
        provider_subscription_id: String(sub.id || ""),
        plan,
        status,
        current_period_start: new Date(sub.current_period_start * 1000),
        current_period_end: new Date(sub.current_period_end * 1000),
        raw: sub,
        updated_at: db.fn.now(),
      });
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const userId = sub.metadata?.user_id;
    if (userId) {
      await db("subscriptions")
        .where({ user_id: userId, provider: "stripe", provider_subscription_id: String(sub.id) })
        .update({ status: "canceled", updated_at: db.fn.now(), raw: sub });
    }
  }

  res.json({ received: true });
});

