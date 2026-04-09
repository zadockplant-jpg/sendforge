// src/services/email.service.js
import { log, sanitizeEmail } from "../utils/logger.js";

export class EmailSendError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "EmailSendError";
    this.code = code; // e.g. "sendgrid_401", "sendgrid_non_2xx", "network_error"
    this.details = details;
  }
}

function supportEmail() {
  return process.env.SUPPORT_EMAIL || "support@sendforge.app";
}

async function sendEmailViaSendGrid({
  to,
  subject,
  text,
  html,
  requestId,
}) {
  const fromEmail = process.env.VERIFY_FROM_EMAIL;
  const sgKey = process.env.SENDGRID_API_KEY;

  if (!fromEmail || !sgKey) {
    log("warn", "email_send_skipped_not_configured", {
      requestId,
      to: sanitizeEmail(to),
      hasFrom: Boolean(fromEmail),
      hasKey: Boolean(sgKey),
      subject,
    });
    log("info", "email_log_mode", {
      requestId,
      subject,
      to: sanitizeEmail(to),
      previewText: String(text || "").slice(0, 500),
    });
    return { ok: true, mode: "log" };
  }

  let res;
  try {
    res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sgKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail },
        subject,
        content: [
          { type: "text/plain", value: text },
          { type: "text/html", value: html },
        ],
      }),
    });
  } catch (err) {
    log("error", "sendgrid_network_error", {
      requestId,
      to: sanitizeEmail(to),
      error: String(err?.message || err),
      subject,
    });
    throw new EmailSendError("network_error", "Email provider network error", {
      provider: "sendgrid",
    });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const code = res.status === 401 ? "sendgrid_401" : "sendgrid_non_2xx";

    log("error", "sendgrid_error", {
      requestId,
      to: sanitizeEmail(to),
      status: res.status,
      body: body?.slice(0, 500),
      subject,
    });

    throw new EmailSendError(code, "Email send failed", {
      provider: "sendgrid",
      status: res.status,
    });
  }

  log("info", "sendgrid_sent", {
    requestId,
    to: sanitizeEmail(to),
    subject,
  });
  return { ok: true, mode: "sendgrid" };
}

/**
 * Sends verification email via SendGrid Web API.
 * Env:
 *  - SENDGRID_API_KEY
 *  - VERIFY_FROM_EMAIL
 */
export async function sendVerificationEmail({ to, verifyUrl, requestId }) {
  const subject = "Verify your SendForge account";

  const text = `Welcome to SendForge!

Verify your email:
${verifyUrl}

If you didn’t sign up, ignore this email.
`;

  const html = `
    <div style="font-family: system-ui;">
      <h2>Verify your SendForge account</h2>
      <p>Click below to verify:</p>
      <p>
        <a href="${verifyUrl}"
           style="padding:10px 14px;border-radius:10px;background:#1E6FE8;color:#fff;text-decoration:none;font-weight:700;">
          Verify Email
        </a>
      </p>
      <p style="font-size:12px;color:#666;">Or paste:</p>
      <p style="font-size:12px;">${verifyUrl}</p>
    </div>
  `;

  return sendEmailViaSendGrid({
    to,
    subject,
    text,
    html,
    requestId,
  });
}

export async function sendPasswordResetEmail({ to, resetUrl, requestId }) {
  const subject = "Reset your SendForge password";

  const text = `We received a request to reset your SendForge password.

Reset your password:
${resetUrl}

This link expires in 24 hours.

If you did not request this, you can ignore this email.
Need help? Contact ${supportEmail()}.
`;

  const html = `
    <div style="font-family: system-ui;">
      <h2>Reset your SendForge password</h2>
      <p>Click below to choose a new password:</p>
      <p>
        <a href="${resetUrl}"
           style="padding:10px 14px;border-radius:10px;background:#1E6FE8;color:#fff;text-decoration:none;font-weight:700;">
          Reset Password
        </a>
      </p>
      <p style="font-size:12px;color:#666;">This link expires in 24 hours.</p>
      <p style="font-size:12px;color:#666;">If you did not request this, ignore this email.</p>
      <p style="font-size:12px;color:#666;">Need help? ${supportEmail()}</p>
      <p style="font-size:12px;color:#666;">Or paste this link into your browser:</p>
      <p style="font-size:12px;">${resetUrl}</p>
    </div>
  `;

  return sendEmailViaSendGrid({
    to,
    subject,
    text,
    html,
    requestId,
  });
}

export async function sendAccountRecoveryEmail({
  to,
  requestId,
  forgotPasswordUrl,
}) {
  const subject = "SendForge account recovery help";

  const text = `We received a request to help recover access to your SendForge account.

This email address is associated with a SendForge account.

If you need to reset your password, start here:
${forgotPasswordUrl}

If you still cannot access your purchase or account, contact ${supportEmail()} and include the email address tied to your purchase.

If you did not request this, ignore this email.
`;

  const html = `
    <div style="font-family: system-ui;">
      <h2>SendForge account recovery help</h2>
      <p>This email address is associated with a SendForge account.</p>
      <p>If you need to reset your password, start here:</p>
      <p>
        <a href="${forgotPasswordUrl}"
           style="padding:10px 14px;border-radius:10px;background:#1E6FE8;color:#fff;text-decoration:none;font-weight:700;">
          Go to Forgot Password
        </a>
      </p>
      <p style="font-size:12px;color:#666;">
        If you still cannot access your purchase or account, contact ${supportEmail()}
        and include the email address tied to your purchase.
      </p>
      <p style="font-size:12px;color:#666;">If you did not request this, ignore this email.</p>
    </div>
  `;

  return sendEmailViaSendGrid({
    to,
    subject,
    text,
    html,
    requestId,
  });
}