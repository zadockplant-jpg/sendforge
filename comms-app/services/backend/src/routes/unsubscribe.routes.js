import { Router } from "express";
import { db } from "../config/db.js";
import { addSuppression } from "../services/suppression.service.js";

export const unsubscribeRouter = Router();

// GET /v1/unsubscribe?token=...
unsubscribeRouter.get("/", async (req, res) => {
  const token = String(req.query.token || "").trim();
  if (!token) return res.status(400).send("Missing token.");

  const row = await db("unsubscribe_tokens").where({ token }).first();
  if (!row) return res.status(404).send("Invalid token.");

  await addSuppression({
    userId: row.user_id,
    channel: "email",
    destination: row.destination,
    reason: "unsubscribe",
  });

  // Simple plain response (safe for app store + email clients)
  return res.status(200).send("You are unsubscribed. You will no longer receive emails from this sender.");
});
