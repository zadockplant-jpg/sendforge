// comms-app/services/backend/src/routes/contacts.routes.js
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { importContacts } from "../services/contactImport.service.js";
import { db } from "../config/db.js";

const router = express.Router();

/**
 * GET /v1/contacts
 * Auth required
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId)
      return res.status(401).json({ ok: false, error: "missing_token" });

    const rows = await db("contacts")
      .where({ user_id: userId })
      .orderBy("created_at", "desc");

    return res.json({ ok: true, contacts: rows });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "failed_to_fetch_contacts" });
  }
});

/**
 * POST /v1/contacts/import
 * Auth required
 * Body:
 * {
 *   method: "google" | "csv" | "device" | "manual",
 *   contacts: [{ name, phone, email, organization? }]
 * }
 */
router.post("/import", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId)
      return res.status(401).json({ ok: false, error: "missing_token" });

    const { method, contacts } = req.body || {};

    if (!method || typeof method !== "string") {
      return res.status(400).json({ ok: false, error: "invalid_method" });
    }
    if (!Array.isArray(contacts)) {
      return res.status(400).json({ ok: false, error: "contacts_must_be_array" });
    }

    const result = await importContacts({ userId, method, contacts });

    return res.status(200).json({
      ok: true,
      ...result,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    return res.status(400).json({ ok: false, error: msg });
  }
});

/**
 * PUT /v1/contacts/:id
 * Auth required
 * Body: { name?, email?, phone?, organization? }
 *
 * NOTE:
 * - We accept phone as raw input; if it isn't E.164, we store it into `phone`
 *   and leave `phone_e164` unchanged unless the client provides E.164.
 * - Canonical E.164 normalization happens on ingestion/import.
 */
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId)
      return res.status(401).json({ ok: false, error: "missing_token" });

    const contactId = String(req.params.id || "");
    if (!contactId)
      return res.status(400).json({ ok: false, error: "missing_contact_id" });

    // ownership guard
    const exists = await db("contacts")
      .select("id")
      .where({ id: contactId, user_id: userId })
      .first();

    if (!exists)
      return res.status(404).json({ ok: false, error: "contact_not_found" });

    const { name, email, phone, organization } = req.body || {};

    const patch = {};
    if (typeof name === "string") patch.name = name.trim();
    if (typeof organization === "string")
      patch.organization = organization.trim() || null;

    if (typeof email === "string") {
      const e = email.trim().toLowerCase();
      patch.email = e || null;
    }

    if (typeof phone === "string") {
      const p = phone.trim();
      if (!p) {
        patch.phone = null;
        // do not blank phone_e164 automatically
      } else if (p.startsWith("+")) {
        // treat as E.164
        patch.phone_e164 = p;
        patch.phone = null;
      } else {
        // store raw (UI convenience), keep phone_e164 as-is
        patch.phone = p;
      }
    }

    patch.updated_at = new Date();

    await db("contacts").where({ user_id: userId, id: contactId }).update(patch);

    const row = await db("contacts")
      .where({ user_id: userId, id: contactId })
      .first();

    return res.json({ ok: true, contact: row });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * DELETE /v1/contacts/:id
 * Auth required
 * HARD delete
 * - deletes group_members rows first (manual cascade)
 * - then deletes contact
 */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId)
      return res.status(401).json({ ok: false, error: "missing_token" });

    const contactId = String(req.params.id || "");
    if (!contactId)
      return res.status(400).json({ ok: false, error: "missing_contact_id" });

    const exists = await db("contacts")
      .select("id")
      .where({ id: contactId, user_id: userId })
      .first();

    if (!exists)
      return res.status(404).json({ ok: false, error: "contact_not_found" });

    await db("group_members")
      .where({ user_id: userId, contact_id: contactId })
      .del();

    await db("contacts").where({ user_id: userId, id: contactId }).del();

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;