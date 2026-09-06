import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { healthRouter } from "./routes/health.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { verificationRouter } from "./routes/verification.routes.js";
import { accountRouter } from "./routes/account.routes.js";
import { groupsRouter } from "./routes/groups.routes.js";
import { templatesRouter } from "./routes/templates.routes.js";
import { blastsRouter } from "./routes/blasts.routes.js";
import { billingRouter } from "./routes/billing.routes.js";
import { webhooksRouter } from "./routes/webhooks.routes.js";
import { threadsRouter } from "./routes/threads.routes.js";
import { usageRouter } from "./routes/usage.routes.js";
import contactsRoutes from "./routes/contacts.routes.js";
import { blastsQuoteRouter } from "./routes/blasts.quote.routes.js";
import { blastsSendRouter } from "./routes/blasts.send.routes.js";
import { stripeWebhooksRouter } from "./routes/stripe.webhooks.routes.js";
import { contactRouter } from "./routes/support.contact.js";
import { tabforgeConfigsRouter } from "./routes/tabforge.configs.routes.js";
import { tabforgeCloudRouter } from "./routes/tabforge.cloud.routes.js";
import { inmateRecordsStoreRouter } from "./routes/inmate.records.store.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { unsubscribeRouter } from "./routes/unsubscribe.routes.js";

import { jayjeRouter } from "./modules/jayje/index.js";

export const app = express();

app.set("trust proxy", 1);

// JayJe owns its parser, proxy boundary and error handling. Existing routes stay unchanged.
app.use("/v1/jayje", jayjeRouter);

app.use(express.urlencoded({ extended: false }));

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(
  express.json({
    limit: "25mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ----- CORE ROUTES -----
app.use("/health", healthRouter);
app.use("/v1/auth", authRouter);
app.use("/v1/auth", verificationRouter);
app.use("/v1/account", accountRouter);
app.use("/v1/contacts", contactsRoutes);
app.use("/v1/groups", groupsRouter);
app.use("/v1/templates", templatesRouter);
app.use("/v1/blasts", blastsRouter);
app.use("/v1/threads", threadsRouter);
app.use("/v1/billing", billingRouter);
app.use("/v1/usage", usageRouter);
app.use("/v1/contact", contactRouter);
app.use("/v1/tabforge/configs", tabforgeConfigsRouter);
app.use("/v1/tabforge/cloud", tabforgeCloudRouter);
app.use("/v1/inmate-records/store", inmateRecordsStoreRouter);
app.use("/v1/admin", adminRouter);
app.use("/v1/unsubscribe", unsubscribeRouter);

// ----- BLAST QUOTE / SEND -----
app.use("/v1/blasts/quote", blastsQuoteRouter);
app.use("/v1/blasts/send", blastsSendRouter);

// ----- WEBHOOKS -----
app.use("/v1/webhooks", webhooksRouter);
app.use("/v1/webhooks/stripe", stripeWebhooksRouter);

app.use((err, _req, res, next) => {
  if (err?.type === "entity.too.large" || err?.status === 413) {
    return res.status(413).json({
      error: "payload_too_large",
      message:
        "That TabForge private-sync update is too large. The local copy is safe; split or compress large note and image updates before retrying.",
    });
  }
  return next(err);
});

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "SendForge API",
    env: env.nodeEnv,
  });
});
