// comms-app/services/backend/src/routes/groups.routes.js
import { Router } from "express";
import crypto from "crypto";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";

export const groupsRouter = Router();

/**
 * Helpers
 */

async function resolveSnapshotGroupIds(userId, groupIds) {
  // Returns DISTINCT snapshot group IDs including:
  // - any selected snapshot groups
  // - any snapshot descendants of selected meta groups (meta_group_links recursion)
  const rows = await db.raw(
    `
    WITH RECURSIVE descendants AS (
      SELECT g.id, g.type
      FROM groups g
      WHERE g.user_id = ? AND g.id = ANY(?)

      UNION ALL

      SELECT child.id, child.type
      FROM meta_group_links l
      JOIN groups parent ON parent.id = l.parent_group_id
      JOIN groups child ON child.id = l.child_group_id
      JOIN descendants d ON d.id = parent.id
      WHERE parent.user_id = ?
    )
    SELECT DISTINCT id
    FROM descendants
    WHERE type = 'snapshot'
    `,
    [userId, groupIds, userId],
  );

  return (rows?.rows || []).map((r) => r.id);
}

async function resolveContactsForGroup(userId, groupId) {
  // Decide if group is snapshot or meta
  const g = await db("groups").where({ id: groupId, user_id: userId }).first();
  if (!g) return null;

  const type = g.type || "snapshot";

  let snapshotIds = [];
  if (type === "snapshot") {
    snapshotIds = [groupId];
  } else {
    snapshotIds = await resolveSnapshotGroupIds(userId, [groupId]);
  }

  if (!snapshotIds.length) return { group: g, contacts: [] };

  const rows = await db("group_members as gm")
    .join("contacts as c", "c.id", "gm.contact_id")
    .select("c.id", "c.name", "c.phone_e164 as phone", "c.email", "c.organization")
    .where("c.user_id", userId)
    .whereIn("gm.group_id", snapshotIds);

  // de-dupe contacts across overlapping snapshot groups in meta groups
  const seen = new Set();
  const out = [];
  for (const c of rows) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }

  return { group: g, contacts: out };
}

/**
 * GET /v1/groups
 * Auth required
 * Returns groups with members (for now) + memberCount.
 */
groupsRouter.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: "missing_token" });

    const groups = await db("groups")
      .select("id", "name", "type")
      .where({ user_id: userId })
      .orderBy("created_at", "desc");

    const result = [];
    for (const g of groups) {
      const resolved = await resolveContactsForGroup(userId, g.id);
      const contacts = resolved?.contacts || [];
      result.push({
        id: g.id,
        name: g.name,
        type: g.type || "snapshot",
        memberCount: contacts.length,
        members: contacts,
      });
    }

    return res.json({ ok: true, groups: result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "groups_list_failed" });
  }
});

/**
 * POST /v1/groups
 * Body: { name, type?: "snapshot"|"meta" }
 */
groupsRouter.post("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: "missing_token" });

    const name = String(req.body?.name ?? "").trim();
    const type = String(req.body?.type ?? "snapshot");

    if (!name) return res.status(400).json({ error: "name_required" });
    if (!["snapshot", "meta"].includes(type)) return res.status(400).json({ error: "invalid_type" });

    const id = crypto.randomUUID();

    await db("groups").insert({
      id,
      user_id: userId,
      name,
      type,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    return res.json({ ok: true, group: { id, name, type, memberCount: 0, members: [] } });
  } catch (e) {
  console.error("GROUP CREATE ERROR:", e);
  return res.status(500).json({
    ok: false,
    error: e.message || "group_create_failed"
  });

  }
});

/**
 * PUT /v1/groups/:id/members
 * Snapshot groups only.
 * Body: { memberIds: ["contactId", ...] }
 */
groupsRouter.put("/:id/members", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: "missing_token" });

    const groupId = String(req.params.id);
    const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds.map(String) : [];

    const g = await db("groups").where({ id: groupId, user_id: userId }).first();
    if (!g) return res.status(404).json({ error: "group_not_found" });

    const type = g.type || "snapshot";
    if (type !== "snapshot") return res.status(400).json({ error: "meta_group_membership_is_dynamic" });

    // Replace membership
    await db("group_members").where({ group_id: groupId }).del();

    if (memberIds.length) {
      // Only allow contacts owned by user
      const validContacts = await db("contacts")
        .select("id")
        .where({ user_id: userId })
        .whereIn("id", memberIds);

      const validIds = validContacts.map((c) => c.id);

      const rows = validIds.map((contactId) => ({
  id: crypto.randomUUID(),
  user_id: userId,
  group_id: groupId,
  contact_id: contactId,
  created_at: db.fn.now(),
}));

      if (rows.length) await db("group_members").insert(rows);
    }

    const resolved = await resolveContactsForGroup(userId, groupId);
    return res.json({
      ok: true,
      group: {
        id: g.id,
        name: g.name,
        type,
        memberCount: resolved?.contacts?.length || 0,
        members: resolved?.contacts || [],
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "members_update_failed" });
  }
});

/**
 * PUT /v1/groups/:id/meta-links
 * Meta groups only.
 * Body: { childGroupIds: ["groupId", ...] }
 * Allows meta groups containing other meta groups.
 */
groupsRouter.put("/:id/meta-links", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: "missing_token" });

    const parentId = String(req.params.id);
    const childGroupIds = Array.isArray(req.body?.childGroupIds) ? req.body.childGroupIds.map(String) : [];

    const parent = await db("groups").where({ id: parentId, user_id: userId }).first();
    if (!parent) return res.status(404).json({ error: "group_not_found" });
    if ((parent.type || "snapshot") !== "meta") return res.status(400).json({ error: "not_a_meta_group" });

    // Ensure all children exist and belong to user
    const children = childGroupIds.length
      ? await db("groups").select("id").where({ user_id: userId }).whereIn("id", childGroupIds)
      : [];
    const validChildIds = children.map((c) => c.id);

    // Replace links
    await db("meta_group_links").where({ parent_group_id: parentId }).del();

    if (validChildIds.length) {
      const rows = validChildIds.map((cid) => ({
        parent_group_id: parentId,
        child_group_id: cid,
        created_at: db.fn.now(),
      }));
      await db("meta_group_links").insert(rows);
    }

    return res.json({ ok: true, childGroupIds: validChildIds });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "meta_links_update_failed" });
  }
});

/**
 * GET /v1/groups/:id/meta-links
 */
groupsRouter.get("/:id/meta-links", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: "missing_token" });

    const parentId = String(req.params.id);
    const parent = await db("groups").where({ id: parentId, user_id: userId }).first();
    if (!parent) return res.status(404).json({ error: "group_not_found" });
    if ((parent.type || "snapshot") !== "meta") return res.status(400).json({ error: "not_a_meta_group" });

    const links = await db("meta_group_links as l")
      .join("groups as g", "g.id", "l.child_group_id")
      .select("g.id", "g.name", "g.type")
      .where("l.parent_group_id", parentId)
      .where("g.user_id", userId)
      .orderBy("g.name", "asc");

    return res.json({ ok: true, children: links });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "meta_links_fetch_failed" });
  }
});