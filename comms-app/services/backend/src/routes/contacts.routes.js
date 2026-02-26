import express from "express";
import { importContacts } from "../services/contactImport.service.js";

const router = express.Router();

/**
 * POST /v1/contacts/import
 * Body:
 * {
 *   method: "google" | "csv" | "manual",
 *   contacts: [{ name, phone, email, sourceMeta? }]
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

export default router;
