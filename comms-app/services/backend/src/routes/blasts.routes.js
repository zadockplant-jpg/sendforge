import { Router } from "express";
import crypto from "crypto";
import { db } from "../config/db.js";
import { getUserId } from "../utils/getUserId.js";

export const blastsRouter = Router();

/**
 * POST /v1/blasts
 * body: { name, subject, body, channels: ["sms","email"], replyMode }
 */
blastsRouter.post("/", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

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

/**
 * POST /v1/blasts/:id/queue
 * body: { groupIds: [], contactIds: [] }
 */
blastsRouter.post("/:id/queue", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const blastId = String(req.params.id);
  const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds.map(String) : [];
  const contactIds = Array.isArray(req.body?.contactIds) ? req.body.contactIds.map(String) : [];

  const blast = await db("blasts").where({ id: blastId, user_id: userId }).first();
  if (!blast) return res.status(404).json({ error: "Blast not found" });

  // Resolve contacts via groups + direct contactIds
  const groupMembers = groupIds.length
    ? await db("group_members").select("contact_id").whereIn("group_id", groupIds)
    : [];

  const mergedContactIds = Array.from(
    new Set([...contactIds, ...groupMembers.map((r) => r.contact_id)]),
  );

  if (!mergedContactIds.length) return res.status(400).json({ error: "No recipients" });

  // Fetch destinations
  const contacts = await db("contacts")
    .select("id", "email", "phone_e164", "name")
    .where({ user_id: userId })
    .whereIn("id", mergedContactIds);

  // Queue recipients (one row per destination per channel)
  const channels = JSON.parse(blast.channels || "[]");
  const rows = [];

  for (const c of contacts) {
    for (const ch of channels) {
      if (ch === "sms" && c.phone_e164) {
        rows.push({
          id: crypto.randomUUID(),
          user_id: userId,
          blast_id: blastId,
          channel: "sms",
          destination: c.phone_e164,
          status: "queued",
          provider: "twilio",
          provider_message_id: "",
          created_at: db.fn.now(),
          updated_at: db.fn.now(),
        });
      }
      if (ch === "email" && c.email) {
        rows.push({
          id: crypto.randomUUID(),
          user_id: userId,
          blast_id: blastId,
          channel: "email",
          destination: String(c.email).toLowerCase(),
          status: "queued",
          provider: "sendgrid",
          provider_message_id: "",
          created_at: db.fn.now(),
          updated_at: db.fn.now(),
        });
      }
    }
  }

  if (!rows.length) return res.status(400).json({ error: "Recipients missing destinations for selected channels" });

  // Insert in chunks
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    // eslint-disable-next-line no-await-in-loop
    await db("blast_recipients").insert(rows.slice(i, i + chunkSize));
  }

  res.json({ ok: true, queuedCount: rows.length });
});
