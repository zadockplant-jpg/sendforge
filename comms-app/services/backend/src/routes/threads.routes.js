import { Router } from "express";
import { db } from "../config/db.js";
import { getUserId } from "../utils/getUserId.js";

export const threadsRouter = Router();

/**
 * GET /v1/threads
 * Returns latest threads for user.
 */
threadsRouter.get("/", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const rows = await db("threads")
    .select("id", "channel", "peer", "title", "last_message_at", "created_at")
    .where({ user_id: userId })
    .orderBy("last_message_at", "desc")
    .limit(200);

  res.json({ threads: rows });
});

/**
 * GET /v1/threads/:id/messages
 * Returns messages for thread, newest last.
 */
threadsRouter.get("/:id/messages", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const threadId = String(req.params.id);
  const thread = await db("threads").where({ id: threadId, user_id: userId }).first();
  if (!thread) return res.status(404).json({ error: "Thread not found" });

  const rows = await db("messages")
    .select("id", "direction", "channel", "from", "to", "body", "provider", "provider_message_id", "created_at")
    .where({ thread_id: threadId, user_id: userId })
    .orderBy("created_at", "asc")
    .limit(500);

  res.json({ thread, messages: rows });
});
