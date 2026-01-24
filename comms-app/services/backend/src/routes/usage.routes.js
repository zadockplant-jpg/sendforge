import { Router } from "express";
import crypto from "crypto";
import { db } from "../config/db.js";
import { getUserId } from "../utils/getUserId.js";

export const usageRouter = Router();

/**
 * GET /v1/usage
 */
usageRouter.get("/", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  let row = await db("usage_counters").where({ user_id: userId }).first();
  if (!row) {
    const id = crypto.randomUUID();
    await db("usage_counters").insert({ id, user_id: userId });
    row = await db("usage_counters").where({ user_id: userId }).first();
  }

  res.json({
    smsSentMonth: row.sms_sent_month,
    emailSentMonth: row.email_sent_month,
    recipientsMonth: row.recipients_month,
    monthStart: row.month_start,
  });
});
