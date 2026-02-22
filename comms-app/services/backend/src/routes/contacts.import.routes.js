// comms-app/services/backend/src/routes/contacts.import.routes.js
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { importContacts } from "../services/contactImport.service.js";

const router = express.Router();

/**
 * POST /v1/contacts/import
 * Auth: Bearer JWT required
 * Body:
 * {
 *   method: "google" | "csv" | "device" | "manual",
 *   contacts: [{ name, phone, email, sourceMeta? }]
 * }
 */
router.post("/import", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub; // UUID from JWT
    if (!userId) {
      return res.status(401).json({ ok: false, error: "missing_token" });
    }

    const { method, contacts } = req.body || {};

    if (!method || typeof method !== "string") {
      return res.status(400).json({ ok: false, error: "invalid_method" });
    }

    if (!Array.isArray(contacts)) {
      return res.status(400).json({ ok: false, error: "contacts_must_be_array" });
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
    // Keep errors useful, but not overly leaky
    const msg = err?.message || String(err);
    return res.status(400).json({
      ok: false,
      error: msg,
    });
  }
});

export default router;