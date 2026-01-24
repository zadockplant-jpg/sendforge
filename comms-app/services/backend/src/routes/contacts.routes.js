import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

export const contactsRouter = Router();

const Create = z.object({
  name: z.string().default(""),
  email: z.string().email().optional().or(z.literal("")).transform((v) => (v ? v : null)),
  phone_e164: z.string().optional().or(z.literal("")).transform((v) => (v ? v : null)),
  tags: z.string().optional().default(""),
});

contactsRouter.get("/", requireAuth, async (req, res) => {
  const rows = await db("contacts").where({ user_id: req.user.sub }).orderBy("created_at", "desc").limit(200);
  res.json({ contacts: rows });
});

contactsRouter.post("/", requireAuth, validate(Create), async (req, res) => {
  const id = crypto.randomUUID();
  const userId = req.user.sub;
  const body = req.validatedBody;

  const row = {
    id,
    user_id: userId,
    name: body.name || "",
    email: body.email,
    phone_e164: body.phone_e164,
    tags: body.tags || "",
    updated_at: db.fn.now(),
  };

  try {
    const [created] = await db("contacts").insert(row).returning("*");
    res.json({ contact: created });
  } catch (e) {
    res.status(409).json({ error: "duplicate_contact" });
  }
});

contactsRouter.delete("/:id", requireAuth, async (req, res) => {
  await db("contacts").where({ user_id: req.user.sub, id: req.params.id }).del();
  res.json({ ok: true });
});
