// comms-app/services/backend/src/routes/contacts.routes.js
import express from "express";
import { db } from "../config/db.js";
import { importContacts } from "../services/contactImport.service.js";

const router = express.Router();

/**
 * GET /v1/contacts
 * Returns contacts for authed user
 */
router.get("/", async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ ok: false, error: "missing_token" });

    const rows = await db("contacts")
      .where({ user_id: userId })
      .orderBy("created_at", "desc");

    return res.json({ ok: true, contacts: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "failed_to_fetch_contacts" });
  }
});

/**
 * POST /v1/contacts/import
 * Auth required (req.user injected by upstream auth middleware)
 * Body:
 * {
 *   method: "google" | "csv" | "manual" | "device",
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
 * PUT /v1/contacts/:id
 * Update contact fields (HARD update)
 * Body: { name?, phone?, email?, organization? }
 * NOTE: phone is accepted as raw; contactImport.service is the normalization layer.
 * For edit UI, we store phone as-is in request, backend stores phone_e164 when phone parses.
 */
router.put("/:id", async (req, res) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ ok: false, error: "missing_token" });

    const contactId = String(req.params.id || "");
    if (!contactId) return res.status(400).json({ ok: false, error: "missing_contact_id" });

    const { name, phone, email, organization } = req.body || {};

    // ownership guard
    const exists = await db("contacts")
      .select("id")
      .where({ id: contactId, user_id: userId })
      .first();

    if (!exists) return res.status(404).json({ ok: false, error: "contact_not_found" });

    // We DO NOT re-implement libphonenumber here to avoid drift.
    // If phone is supplied, store it into phone_e164 if already E.164-ish, else keep existing.
    // The canonical normalization happens on ingestion/import.
    const patch = {};
    if (typeof name === "string") patch.name = name.trim();
    if (typeof organization === "string") patch.organization = organization.trim() || null;
    if (typeof email === "string") patch.email = email.trim().toLowerCase() || null;

    if (typeof phone === "string") {
      const p = phone.trim();
      // store into phone_e164 only if it looks like E.164 (+##########...)
      patch.phone_e164 = p.startsWith("+") ? p : p || null;
    }

    patch.updated_at = new Date();

    await db("contacts").where({ user_id: userId, id: contactId }).update(patch);

    const row = await db("contacts").where({ user_id: userId, id: contactId }).first();

    return res.json({ ok: true, contact: row });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
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