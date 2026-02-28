import express from "express";
import { db } from "../config/db.js";
import { importContacts } from "../services/contactImport.service.js";

const router = express.Router();

/**
 * POST /v1/contacts/import
 * Auth required (req.user injected by upstream auth middleware)
 * Body:
 * {
 *   method: "google" | "csv" | "manual",
 *   contacts: [{ name, phone, email, organization?, sourceMeta? }]
 * }
 */
router.post("/import", async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ error: "missing_token" });
    }

    const { method, contacts } = req.body || {};

    if (!Array.isArray(contacts)) {
      throw new Error("contacts must be an array");
    }

    const result = await importContacts({
      userId,
      method,
      contacts,
    });

    return res.status(200).json({
      ok: true,
      ...result,
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

/**
 * DELETE /v1/contacts/:id
 * HARD delete
 * - deletes group_members rows first (manual cascade)
 * - then deletes contact
 */
router.delete("/:id", async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ error: "missing_token" });
    }

    const contactId = String(req.params.id || "");

    if (!contactId) {
      return res.status(400).json({ ok: false, error: "missing_contact_id" });
    }

    // ensure the contact belongs to user (soft guard)
    const exists = await db("contacts")
      .select("id")
      .where({ id: contactId, user_id: userId })
      .first();

    if (!exists) {
      return res.status(404).json({ ok: false, error: "contact_not_found" });
    }

    // manual cascade (do NOT assume FK cascade exists)
    await db("group_members").where({ user_id: userId, contact_id: contactId }).del();

    await db("contacts").where({ user_id: userId, id: contactId }).del();

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;