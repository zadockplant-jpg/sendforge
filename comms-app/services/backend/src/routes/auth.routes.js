import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import { db } from "../config/db.js";
import { env } from "../config/env.js";

export const authRouter = Router();

const Register = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
const Login = Register;

authRouter.post("/register", async (req, res) => {
  if (!env.jwtSecret) {
    return res.status(500).json({ error: "JWT_SECRET missing" });
  }

  const body = Register.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "invalid_input" });
  }

  const email = body.data.email.toLowerCase().trim();
  const hash = await bcrypt.hash(body.data.password, 12);
  const id = crypto.randomUUID();

  try {
    await db("users").insert({
      id,
      email,
      password_hash: hash,
    });
  } catch {
    return res.status(409).json({ error: "email_in_use" });
  }

  const token = jwt.sign(
    { sub: id, email },
    env.jwtSecret,
    { expiresIn: "30d" }
  );

  res.json({ token });
});

authRouter.post("/login", async (req, res) => {
  if (!env.jwtSecret) {
    return res.status(500).json({ error: "JWT_SECRET missing" });
  }

  const body = Login.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "invalid_input" });
  }

  const email = body.data.email.toLowerCase().trim();
  const user = await db("users").where({ email }).first();
  if (!user) {
    return res.status(401).json({ error: "bad_credentials" });
  }

  const ok = await bcrypt.compare(
    body.data.password,
    user.password_hash
  );
  if (!ok) {
    return res.status(401).json({ error: "bad_credentials" });
  }

  const token = jwt.sign(
    { sub: user.id, email },
    env.jwtSecret,
    { expiresIn: "30d" }
  );

  res.json({ token });
});
