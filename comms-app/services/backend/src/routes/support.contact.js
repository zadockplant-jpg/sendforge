import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import { sendContactFormEmail } from "../services/email.service.js";

export const contactRouter = Router();

const ContactRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(240),
  company: z.string().trim().max(180).optional().default(""),
  topic: z.string().trim().min(1).max(80).optional().default("Support"),
  message: z.string().trim().min(1).max(5000),
  website: z.string().trim().max(0).optional().default(""),
});

contactRouter.post("/", async (req, res) => {
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();

  try {
    const parsed = ContactRequestSchema.parse(req.body || {});

    // Honeypot: if a bot fills the hidden website field, silently accept.
    if (parsed.website) {
      return res.json({ ok: true });
    }

    await sendContactFormEmail({
      to: process.env.CONTACT_TO_EMAIL || process.env.SUPPORT_EMAIL || "support@sendforge.app",
      replyTo: parsed.email,
      name: parsed.name,
      email: parsed.email.toLowerCase(),
      company: parsed.company || "",
      topic: parsed.topic || "Support",
      message: parsed.message,
      requestId,
    });

    return res.json({
      ok: true,
      message: "request_sent",
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        ok: false,
        error: "invalid_request",
        issues: err.issues,
      });
    }

    return res.status(500).json({
      ok: false,
      error: "send_failed",
      message: String(err?.message || err),
    });
  }
});