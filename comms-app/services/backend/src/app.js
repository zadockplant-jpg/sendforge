import express from "express";
import cors from "cors";

import { healthRouter } from "./routes/health.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { contactsRouter } from "./routes/contacts.routes.js";
import { groupsRouter } from "./routes/groups.routes.js";
import { templatesRouter } from "./routes/templates.routes.js";
import { blastsRouter } from "./routes/blasts.routes.js";
import { billingRouter } from "./routes/billing.routes.js";
import { webhooksRouter } from "./routes/webhooks.routes.js";
import { threadsRouter } from "./routes/threads.routes.js";
import { usageRouter } from "./routes/usage.routes.js";

// ✅ KEEP dot-based blast routes (final canonical versions)
import { blastsQuoteRouter } from "./routes/blasts.quote.routes.js";
import { blastsSendRouter } from "./routes/blasts.send.routes.js";

// ✅ Stripe webhooks
import { stripeWebhooksRouter } from "./routes/stripe.webhooks.routes.js";

export const app = express();

app.set("trust proxy", true); // important for Twilio signature behind Render

app.use(express.urlencoded({ extended: false })); // Twilio form posts
app.use(cors());

// keep rawBody for SendGrid signature verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ----- CORE ROUTES -----
app.use("/health", healthRouter);
app.use("/v1/auth", authRouter);
app.use("/v1/contacts", contactsRouter);
app.use("/v1/groups", groupsRouter);
app.use("/v1/templates", templatesRouter);
app.use("/v1/blasts", blastsRouter);
app.use("/v1/threads", threadsRouter);
app.use("/v1/billing", billingRouter);
app.use("/v1/usage", usageRouter);

// ----- BLAST QUOTE / SEND (INTL BILLING FLOW) -----
app.use("/v1/blasts/quote", blastsQuoteRouter);
app.use("/v1/blasts/send", blastsSendRouter);

// ----- WEBHOOKS -----
app.use("/v1/webhooks", webhooksRouter);        // Twilio + SendGrid
app.use("/v1/webhooks/stripe", stripeWebhooksRouter); // Stripe ONLY
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SendForge API',
    env: process.env.NODE_ENV,
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});
