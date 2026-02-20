import crypto from "crypto";
import { env } from "../config/env.js";

export async function sendVerificationEmail({
  to,
  verifyUrl,
}) {
  const fromEmail = process.env.VERIFY_FROM_EMAIL;
  const sgKey = process.env.SENDGRID_API_KEY;

  if (!fromEmail || !sgKey) {
    console.log("[email] SendGrid not configured. Verification link:");
    console.log(`to=${to}`);
    console.log(verifyUrl);
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

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
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

  if (!res.ok) {
    const body = await res.text();
    console.error("[email] SendGrid error:", res.status, body);
    throw new Error("email_send_failed");
  }

  return { ok: true, mode: "sendgrid" };
}