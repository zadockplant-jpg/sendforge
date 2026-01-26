import express from "express";
import { importContacts } from "../services/contactImport.service.js";

const router = express.Router();

/**
 * POST /v1/contacts/import
 * Body:
 * {
 *   method: "google" | "csv" | "device" | "manual",
 *   contacts: [{ name, phone, email, sourceMeta? }]
 * }
 *
 * For now: accepts payload + validates + inserts/upserts.
 * OAuth/CSV parsing/permissions happen BEFORE this endpoint later.
 */
router.post("/import", async (req, res) => {
  try {
    // Temporary: allow dev without auth middleware
    const userId =
      req.header("x-user-id") ||
      req.body.userId ||
      "dev-user";

    const { method, contacts } = req.body || {};

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

export default router;
