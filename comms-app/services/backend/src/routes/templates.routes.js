import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

export const templatesRouter = Router();

const Create = z.object({
  name: z.string().min(1),
  channel: z.enum(["sms", "email"]),
  subject: z.string().optional().default(""),
  body: z.string().min(1),
});

templatesRouter.get("/", requireAuth, async (req, res) => {
  const templates = await db("templates").where({ user_id: req.user.sub }).orderBy("created_at", "desc");
  res.json({ templates });
});

templatesRouter.post("/", requireAuth, validate(Create), async (req, res) => {
  const id = crypto.randomUUID();
  try {
    const [t] = await db("templates")
      .insert({ id, user_id: req.user.sub, ...req.validatedBody })
      .returning("*");
    res.json({ template: t });
  } catch {
    res.status(409).json({ error: "template_name_exists" });
  }
});

