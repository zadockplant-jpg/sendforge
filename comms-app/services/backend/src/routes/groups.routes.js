import { Router } from "express";
import crypto from "crypto";
import { db } from "../config/db.js";
import { getUserId } from "../utils/getUserId.js";

export const groupsRouter = Router();

/**
 * GET /v1/groups
 */
groupsRouter.get("/", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const groups = await db("groups")
    .select("id", "name", "reply_mode", "created_at")
    .where({ user_id: userId })
    .orderBy("created_at", "desc")
    .limit(500);

  // member counts (cheap + useful)
  const counts = await db("group_members")
    .select("group_id")
    .count("* as member_count")
    .whereIn("group_id", groups.map((g) => g.id))
    .groupBy("group_id");

  const countMap = new Map(counts.map((c) => [c.group_id, Number(c.member_count)]));

  res.json({
    groups: groups.map((g) => ({
      ...g,
      member_count: countMap.get(g.id) ?? 0,
    })),
  });
});

/**
 * POST /v1/groups
 * body: { name, replyMode }
 */
groupsRouter.post("/", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const name = String(req.body?.name ?? "").trim();
  const replyMode = String(req.body?.replyMode ?? "private"); // private|group

  if (!name) return res.status(400).json({ error: "name required" });

  const id = crypto.randomUUID();
  await db("groups").insert({
    id,
    user_id: userId,
    name,
    reply_mode: replyMode,
    created_at: db.fn.now(),
  });

  res.json({ id, name, reply_mode: replyMode });
});

/**
 * POST /v1/groups/:id/members
 * body: { memberIds: ["contactId", ...] }
 */
groupsRouter.post("/:id/members", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const groupId = String(req.params.id);
  const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds.map(String) : [];

  const group = await db("groups").where({ id: groupId, user_id: userId }).first();
  if (!group) return res.status(404).json({ error: "Group not found" });

  await db.transaction(async (trx) => {
    await trx("group_members").where({ group_id: groupId }).del();
    if (memberIds.length) {
      await trx("group_members").insert(
        memberIds.map((cid) => ({
          group_id: groupId,
          contact_id: cid,
          created_at: trx.fn.now(),
        })),
      );
    }
  });

  res.json({ ok: true, groupId, memberCount: memberIds.length });
});
