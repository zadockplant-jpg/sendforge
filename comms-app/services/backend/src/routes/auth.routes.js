// src/routes/auth.routes.js
import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import { sendVerificationEmail, EmailSendError } from "../services/email.service.js";
import { log, getRequestId, sanitizeEmail } from "../utils/logger.js";

export const authRouter = Router();

const Register = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const Login = Register;

const TOKEN_TTL_HOURS = 24;

// Helpers
function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function isPgUniqueViolation(err) {
  // Postgres unique violation code
  return err && (err.code === "23505" || err?.errno === "23505");
}

function isMissingColumn(err) {
  // undefined_column is 42703
  return err && err.code === "42703";
}

function isUndefinedTable(err) {
  // undefined_table is 42P01
  return err && err.code === "42P01";
}

/**
 * POST /v1/auth/register
 *
 * Behavior (anti-lockout, security-safe):
 * - If email NEW: create unverified user + send verification email
 * - If email EXISTS & verified: 409 {error:"account_exists"} (generic)
 * - If email EXISTS & NOT verified: refresh token + resend verification, return 200 ok
 *
 * Email send failures:
 * - User remains unverified, token stored (so resend works)
 * - Response: 202 { ok:true, email_send:"failed", can_resend:true }
 */
authRouter.post("/register", async (req, res) => {
  const requestId = getRequestId(req);

  if (!env.jwtSecret) {
    log("error", "register_missing_jwt_secret", { requestId });
    return res.status(500).json({ error: "server_misconfigured" });
  }

  const parsed = Register.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input" });
  }

  const email = parsed.data.email.toLowerCase().trim();
  const password = parsed.data.password;

  const verifyToken = crypto.randomBytes(32).toString("hex");
  const verifyTokenHash = sha256(verifyToken);
  const now = new Date();

  // verify URL points to backend verify endpoint (publicBaseUrl is the backend base)
  const verifyUrl = `${env.publicBaseUrl}/v1/auth/verify?token=${verifyToken}`;

  log("info", "register_attempt", { requestId, email: sanitizeEmail(email) });

  try {
    // One transaction for DB writes
    const result = await db.transaction(async (trx) => {
      const existing = await trx("users").where({ email }).first();

      if (existing) {
        if (existing.email_verified) {
          return { kind: "exists_verified", userId: existing.id };
        }

        // Existing but not verified: refresh token + sent_at
        await trx("users")
          .where({ id: existing.id })
          .update({
            verification_token_hash: verifyTokenHash,
            verification_sent_at: now,
            // do NOT change password here
          });

        return { kind: "exists_unverified", userId: existing.id };
      }

      // Create new user
      const id = crypto.randomUUID();
      const hash = await bcrypt.hash(password, 12);

      await trx("users").insert({
        id,
        email,
        password_hash: hash,
        email_verified: false,
        verification_token_hash: verifyTokenHash,
        verification_sent_at: now,
        verified_at: null,
      });

      return { kind: "created", userId: id };
    });

    // After DB commit: send email (external side effect)
    try {
      await sendVerificationEmail({
        to: email,
        verifyUrl,
        requestId,
      });
    } catch (e) {
      // Email failure should not lock out user. They can resend.
      const code =
        e instanceof EmailSendError ? e.code : "email_send_failed_unknown";

      log("error", "register_email_send_failed", {
        requestId,
        email: sanitizeEmail(email),
        code,
      });

      // Still “successful registration” from DB perspective, but email failed.
      // Return 202 Accepted so UI can show “We couldn’t send; tap to resend.”
      return res.status(202).json({
        ok: true,
        status: result.kind, // created | exists_unverified | exists_verified
        email_send: "failed",
        can_resend: result.kind !== "exists_verified",
        error: "verification_email_failed",
      });
    }

    // Email sent OK
    if (result.kind === "exists_verified") {
      // Someone attempted to register an already-verified account
      // You can choose 409 or 200. 409 is fine and common.
      return res.status(409).json({ ok: false, error: "account_exists" });
    }

    return res.status(200).json({
      ok: true,
      status: result.kind, // created | exists_unverified
      email_send: "ok",
    });
  } catch (err) {
    // Deterministic error mapping + real logging
    log("error", "register_db_error", {
      requestId,
      email: sanitizeEmail(email),
      code: err?.code,
      message: String(err?.message || err),
    });

    // If schema mismatch, tell us explicitly (no masking)
    if (isUndefinedTable(err) || isMissingColumn(err)) {
      return res.status(500).json({
        ok: false,
        error: "db_schema_mismatch",
      });
    }

    // Only map unique violations to “account exists”
    if (isPgUniqueViolation(err)) {
      return res.status(409).json({ ok: false, error: "account_exists" });
    }

    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/**
 * POST /v1/auth/resend-verification
 * Body: { email }
 *
 * Response should not leak existence:
 * - Always { ok:true }
 */
authRouter.post("/resend-verification", async (req, res) => {
  const requestId = getRequestId(req);

  const schema = z.object({ email: z.string().email() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });

  const email = parsed.data.email.toLowerCase().trim();

  const verifyToken = crypto.randomBytes(32).toString("hex");
  const verifyTokenHash = sha256(verifyToken);
  const now = new Date();
  const verifyUrl = `${env.publicBaseUrl}/v1/auth/verify?token=${verifyToken}`;

  try {
    const user = await db("users").where({ email }).first();

    // Do not leak whether email exists
    if (!user) {
      log("info", "resend_no_user", { requestId, email: sanitizeEmail(email) });
      return res.json({ ok: true });
    }

    if (user.email_verified) {
      log("info", "resend_already_verified", {
        requestId,
        userId: user.id,
      });
      return res.json({ ok: true });
    }

    await db("users")
      .where({ id: user.id })
      .update({
        verification_token_hash: verifyTokenHash,
        verification_sent_at: now,
      });

    try {
      await sendVerificationEmail({ to: email, verifyUrl, requestId });
    } catch (e) {
      log("error", "resend_email_send_failed", {
        requestId,
        email: sanitizeEmail(email),
        code: e?.code,
      });
      // Still return ok:true to prevent enumeration.
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (err) {
    log("error", "resend_server_error", {
      requestId,
      code: err?.code,
      message: String(err?.message || err),
    });
    // Avoid enumeration; still ok:true
    return res.json({ ok: true });
  }
});

/**
 * POST /v1/auth/login
 * - Blocks login if not verified (Option A)
 */
authRouter.post("/login", async (req, res) => {
  const requestId = getRequestId(req);

  if (!env.jwtSecret) {
    log("error", "login_missing_jwt_secret", { requestId });
    return res.status(500).json({ error: "server_misconfigured" });
  }

  const parsed = Login.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input" });
  }

  const email = parsed.data.email.toLowerCase().trim();
  const password = parsed.data.password;

  try {
    const user = await db("users").where({ email }).first();
    if (!user) {
      // Don’t reveal whether account exists
      return res.status(401).json({ error: "bad_credentials" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "bad_credentials" });
    }

    if (!user.email_verified) {
      // Token expiry hint for UI (safe)
      let expired = false;
      if (user.verification_sent_at) {
        const sentAt = new Date(user.verification_sent_at).getTime();
        const ttlMs = TOKEN_TTL_HOURS * 60 * 60 * 1000;
        expired = Date.now() - sentAt > ttlMs;
      }
      return res.status(403).json({ error: "email_not_verified", expired });
    }

    const token = jwt.sign({ sub: user.id, email }, env.jwtSecret, {
      expiresIn: "30d",
    });

    return res.json({ token });
  } catch (err) {
    log("error", "login_server_error", {
      requestId,
      email: sanitizeEmail(email),
      code: err?.code,
      message: String(err?.message || err),
    });
    return res.status(500).json({ error: "server_error" });
  }
});