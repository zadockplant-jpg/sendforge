import { Router } from "express";
import Stripe from "stripe";
import { db } from "../config/db.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export const stripeWebhooksRouter = Router();

/**
 * Stripe webhook endpoint
 * Mounted at /v1/webhooks/stripe
 */
stripeWebhooksRouter.post(
  "/stripe",
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // --- HANDLE EVENTS ---
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;

      const user = await db("users")
        .where({ stripe_customer_id: invoice.customer })
        .first();

      if (user) {
        const lines = invoice.lines?.data || [];
        const isHardcap = lines.some(l =>
          (l.description || "").includes("hardcap_accum")
        );

        const updates = {
          intl_blocked_reason: null,
        };

        // 🔒 Reset only on HARD CAP success (per your rule)
        if (isHardcap) {
          updates.intl_spend_since_charge_cents = 0;
        }

        await db("users").where({ id: user.id }).update(updates);
      }
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const user = await db("users")
        .where({ stripe_customer_id: invoice.customer })
        .first();

      if (user) {
        await db("users").where({ id: user.id }).update({
          intl_blocked_reason: "payment_failed",
        });
      }
    }

    res.json({ received: true });
  }
);
