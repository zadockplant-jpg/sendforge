import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import { sendVerificationEmail } from "../services/email.service.js";

export const authRouter = Router();

const Register = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
const Login = Register;

const TOKEN_TTL_HOURS = 24;

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

  // Create verification token
  const verifyToken = crypto.randomBytes(32).toString("hex");
  const verifyTokenHash = sha256(verifyToken);

  try {
    await db("users").insert({
      id,
      email,
      password_hash: hash,
      email_verified: false,
      verification_token_hash: verifyTokenHash,
      verification_sent_at: new Date(),
      verified_at: null,
    });
  } catch {
    return res.status(409).json({ error: "email_in_use" });
  }

  // Send verification link
  const verifyUrl = `${env.publicBaseUrl}/v1/auth/verify?token=${verifyToken}`;

  try {
    await sendVerificationEmail({
      to: email,
      verifyUrl,
      publicBaseUrl: env.publicBaseUrl,
    });
  } catch (e) {
    // If email fails, keep the user, but tell client
    return res.status(500).json({ error: "verification_email_failed" });
  }

  // ✅ Option A: no token returned
  return res.status(200).json({ ok: true });
});

authRouter.post("/resend-verification", async (req, res) => {
  const schema = z.object({ email: z.string().email() });
  const body = schema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_input" });

  const email = body.data.email.toLowerCase().trim();

  const user = await db("users").where({ email }).first();
  if (!user) {
    // Don't leak whether email exists
    return res.json({ ok: true });
  }

  if (user.email_verified) {
    return res.json({ ok: true });
  }

  // Fresh token
  const verifyToken = crypto.randomBytes(32).toString("hex");
  const verifyTokenHash = sha256(verifyToken);

  await db("users")
    .where({ id: user.id })
    .update({
      verification_token_hash: verifyTokenHash,
      verification_sent_at: new Date(),
    });

  const verifyUrl = `${env.publicBaseUrl}/v1/auth/verify?token=${verifyToken}`;

  try {
    await sendVerificationEmail({
      to: email,
      verifyUrl,
      publicBaseUrl: env.publicBaseUrl,
    });
} catch (e) {
  console.error("REGISTER INSERT ERROR:", e);
  return res.status(500).json({ error: "db_insert_failed" });
}

  return res.json({ ok: true });
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

  const ok = await bcrypt.compare(body.data.password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: "bad_credentials" });
  }

  // ✅ Block login until verified
  if (!user.email_verified) {
    // Optional expiry hint (client can show resend button)
    let expired = false;
    if (user.verification_sent_at) {
      const sentAt = new Date(user.verification_sent_at).getTime();
      const now = Date.now();
      const ttlMs = TOKEN_TTL_HOURS * 60 * 60 * 1000;
      expired = now - sentAt > ttlMs;
    }
    return res.status(403).json({ error: "email_not_verified", expired });
  }

  const token = jwt.sign({ sub: user.id, email }, env.jwtSecret, {
    expiresIn: "30d",
  });

  return res.json({ token });
});

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}