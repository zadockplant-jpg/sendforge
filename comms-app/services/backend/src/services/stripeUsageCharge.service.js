import Stripe from "stripe";
import { db } from "../config/db.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Creates an immediate invoice and charges it off-session before send.
 * Returns { invoiceId } on success, throws on failure.
 */
export async function chargeInternationalNow({ userId, amountCents, description }) {
  const user = await db("users").where({ id: userId }).first();
  if (!user?.stripe_customer_id) throw new Error("missing_stripe_customer");

  // Create invoice item
  await stripe.invoiceItems.create({
    customer: user.stripe_customer_id,
    amount: amountCents,
    currency: "usd",
    description: description || "International SMS charges",
  });

  // Create + finalize + pay invoice
  const invoice = await stripe.invoices.create({
    customer: user.stripe_customer_id,
    collection_method: "charge_automatically",
    auto_advance: true,
  });

  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  const paid = await stripe.invoices.pay(finalized.id);

  if (paid.status !== "paid") throw new Error("invoice_not_paid");

  return { invoiceId: paid.id };
}
