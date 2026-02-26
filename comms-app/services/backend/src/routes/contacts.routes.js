import { Router } from "express";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";

export const contactsRouter = Router();

/**
 * GET /v1/contacts
 */
contactsRouter.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: "missing_token" });

    const rows = await db("contacts")
      .select(
        "id",
        "name",
        db.raw("COALESCE(phone_e164, phone) as phone"),
        "email",
        "organization"
      )
      .where({ user_id: userId })
      .orderBy("created_at", "desc");

    return res.json({ ok: true, contacts: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "contacts_list_failed" });
  }
});

/**
 * DELETE /v1/contacts/:id
 */
contactsRouter.delete("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: "missing_token" });

    const id = String(req.params.id);

    const row = await db("contacts")
      .where({ id, user_id: userId })
      .first();

    if (!row) return res.status(404).json({ error: "contact_not_found" });

    // also clear group_members rows via FK? if no FK, do it explicitly:
    await db("group_members").where({ contact_id: id }).del();
    await db("contacts").where({ id }).del();

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "contact_delete_failed" });
  }
});