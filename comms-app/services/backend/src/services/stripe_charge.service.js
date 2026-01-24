// services/backend/src/services/stripe_charge.service.js
import Stripe from "stripe";
import { db } from "../config/db.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function chargeIntlNow({ userId, amountCents, reason }) {
  const user = await db("users").where({ id: userId }).first();
  if (!user?.stripe_customer_id) throw new Error("missing_stripe_customer");

  // 1) invoice item
  await stripe.invoiceItems.create({
    customer: user.stripe_customer_id,
    amount: amountCents,
    currency: "usd",
    description: `International SMS precharge (${reason || "intl"})`,
  });

  // 2) invoice
  const invoice = await stripe.invoices.create({
    customer: user.stripe_customer_id,
    collection_method: "charge_automatically",
    auto_advance: true,
  });

  // 3) finalize + pay
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  const paid = await stripe.invoices.pay(finalized.id);

  if (paid.status !== "paid") throw new Error("invoice_not_paid");

  return { invoiceId: paid.id };
}
