import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { healthRouter } from "./routes/health.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { verificationRouter } from "./routes/verification.routes.js"; // ✅ NEW
import { groupsRouter } from "./routes/groups.routes.js";
import { templatesRouter } from "./routes/templates.routes.js";
import { blastsRouter } from "./routes/blasts.routes.js";
import { billingRouter } from "./routes/billing.routes.js";
import { webhooksRouter } from "./routes/webhooks.routes.js";
import { threadsRouter } from "./routes/threads.routes.js";
import { usageRouter } from "./routes/usage.routes.js";
import contactsImportRoutes from "./routes/contacts.import.routes.js";
import { blastsQuoteRouter } from "./routes/blasts.quote.routes.js";
import { blastsSendRouter } from "./routes/blasts.send.routes.js";
import { stripeWebhooksRouter } from "./routes/stripe.webhooks.routes.js";

export const app = express();

app.set("trust proxy", 1);

app.use(express.urlencoded({ extended: false }));

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

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
app.use("/v1/auth", verificationRouter); // ✅ NEW: /v1/auth/verify
app.use("/v1/contacts", contactsImportRoutes);
app.use("/v1/groups", groupsRouter);
app.use("/v1/templates", templatesRouter);
app.use("/v1/blasts", blastsRouter);
app.use("/v1/threads", threadsRouter);
app.use("/v1/billing", billingRouter);
app.use("/v1/usage", usageRouter);

// ----- BLAST QUOTE / SEND -----
app.use("/v1/blasts/quote", blastsQuoteRouter);
app.use("/v1/blasts/send", blastsSendRouter);

// ----- WEBHOOKS -----
app.use("/v1/webhooks", webhooksRouter);
app.use("/v1/webhooks/stripe", stripeWebhooksRouter);

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "SendForge API",
    env: process.env.NODE_ENV,
  });
});