import { Router } from "express";
import crypto from "crypto";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";

export const blastsRouter = Router();

/**
 * POST /v1/blasts
 * Auth: Bearer JWT required
 * body: { name, subject, body, channels: ["sms","email"], replyMode }
 */
blastsRouter.post("/", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "missing_token" });

  const name = String(req.body?.name ?? "").trim();
  const subject = String(req.body?.subject ?? "").trim();
  const body = String(req.body?.body ?? "").trim();
  const replyMode = String(req.body?.replyMode ?? "private");
  const channels = Array.isArray(req.body?.channels) ? req.body.channels.map(String) : [];

  if (!name) return res.status(400).json({ error: "name required" });
  if (!body) return res.status(400).json({ error: "body required" });
  if (!channels.length) return res.status(400).json({ error: "channels required" });

  const id = crypto.randomUUID();

  await db("blasts").insert({
    id,
    user_id: userId,
    name,
    subject,
    body,
    channels: JSON.stringify(channels),
    reply_mode: replyMode,
    created_at: db.fn.now(),
    updated_at: db.fn.now(),
  });

  res.json({ id, name, subject, body, channels, replyMode });
});