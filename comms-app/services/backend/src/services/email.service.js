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

/**
 * Sends verification email via SendGrid Web API.
 * Env:
 *  - SENDGRID_API_KEY
 *  - VERIFY_FROM_EMAIL
 */
export async function sendVerificationEmail({ to, verifyUrl, requestId }) {
  const fromEmail = process.env.VERIFY_FROM_EMAIL;
  const sgKey = process.env.SENDGRID_API_KEY;

  if (!fromEmail || !sgKey) {
    log("warn", "email_send_skipped_not_configured", {
      requestId,
      to: sanitizeEmail(to),
      hasFrom: Boolean(fromEmail),
      hasKey: Boolean(sgKey),
    });
    log("info", "verification_link_log_mode", { requestId, verifyUrl });
    return { ok: true, mode: "log" };
  }

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
      body: body?.slice(0, 500), // avoid huge logs
    });

    throw new EmailSendError(code, "Email send failed", {
      provider: "sendgrid",
      status: res.status,
    });
  }

  log("info", "sendgrid_sent", { requestId, to: sanitizeEmail(to) });
  return { ok: true, mode: "sendgrid" };
}