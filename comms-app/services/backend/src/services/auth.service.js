import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { db } from "../config/db.js";
import { env } from "../config/env.js";

export async function registerUser({ email, password }) {
  if (!env.jwtSecret) throw new Error("JWT_SECRET missing");

  const normalizedEmail = email.toLowerCase().trim();
  const hash = await bcrypt.hash(password, 12);
  const id = crypto.randomUUID();

  try {
    await db("users").insert({
      id,
      email: normalizedEmail,
      password_hash: hash,
    });
  } catch {
    throw new Error("email_in_use");
  }

  return issueToken({ id, email: normalizedEmail });
}

export async function loginUser({ email, password }) {
  if (!env.jwtSecret) throw new Error("JWT_SECRET missing");

  const normalizedEmail = email.toLowerCase().trim();
  const user = await db("users").where({ email: normalizedEmail }).first();
  if (!user) throw new Error("bad_credentials");

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new Error("bad_credentials");

  return issueToken({ id: user.id, email: normalizedEmail });
}

function issueToken({ id, email }) {
  return jwt.sign({ sub: id, email }, env.jwtSecret, {
    expiresIn: "30d",
  });
}
