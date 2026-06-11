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

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendEmailViaSendGrid({
  to,
  subject,
  text,
  html,
  requestId,
  replyTo = null,
  fromEmail = null,
  fromName = null,
}) {
  const senderEmail = fromEmail || process.env.VERIFY_FROM_EMAIL || process.env.SENDGRID_FROM_EMAIL;
  const senderName = fromName || null;
  const sgKey = process.env.SENDGRID_API_KEY;

  if (!senderEmail || !sgKey) {
    log("warn", "email_send_skipped_not_configured", {
      requestId,
      to: sanitizeEmail(to),
      hasFrom: Boolean(senderEmail),
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

  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: senderName ? { email: senderEmail, name: senderName } : { email: senderEmail },
    subject,
    content: [
      { type: "text/plain", value: text },
      { type: "text/html", value: html },
    ],
  };

  if (replyTo) {
    body.reply_to = { email: replyTo };
  }

  let res;
  try {
    res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sgKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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
    const bodyText = await res.text().catch(() => "");
    const code = res.status === 401 ? "sendgrid_401" : "sendgrid_non_2xx";

    log("error", "sendgrid_error", {
      requestId,
      to: sanitizeEmail(to),
      status: res.status,
      body: bodyText?.slice(0, 500),
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
  const subject = "Verify your email — start free with TabForge Basic";
  const safeUrl = escapeHtml(verifyUrl);

  const text = `Welcome to TabForge.

Verify your email to finish creating your free account and start with TabForge Basic.

Basic gives you 18 shortcuts, easy bookmark organization, simple intuitive use, no popups, and no subscription.

After verification, you can upgrade only if you need more. TabForge Pro unlocks 36 shortcuts, and new Pro purchases include one Curated Pack Credit that can add 36 more shortcuts.

Verify your email:
${verifyUrl}

No popups. No subscriptions. Pay for what you need and keep it forever.

If you did not sign up, ignore this email.`;

  const html = `
    <div style="margin:0;padding:0;background:#07090f;color:#eef3ff;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.55;">
      <div style="max-width:660px;margin:0 auto;padding:28px 18px;">
        <div style="border:1px solid rgba(77,143,255,.28);border-radius:24px;background:linear-gradient(135deg,rgba(77,143,255,.18),rgba(44,224,183,.08));box-shadow:0 24px 70px rgba(0,0,0,.35);overflow:hidden;">
          <div style="padding:28px 26px 18px;">
            <div style="display:inline-block;padding:6px 10px;border-radius:999px;background:rgba(44,224,183,.12);border:1px solid rgba(44,224,183,.26);color:#8ff7df;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">TabForge account</div>
            <h1 style="margin:16px 0 10px;font-size:30px;line-height:1.08;color:#ffffff;">Verify your email and start free</h1>
            <p style="margin:0;color:#c7d3ee;font-size:16px;">Create your free account and try TabForge Basic with 18 shortcuts.</p>
          </div>
          <div style="padding:0 26px 22px;">
            <div style="display:grid;gap:10px;">
              <div style="border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:12px 14px;background:rgba(255,255,255,.03);color:#dce6ff;">✓ Easy bookmark organization</div>
              <div style="border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:12px 14px;background:rgba(255,255,255,.03);color:#dce6ff;">✓ Simple, intuitive use</div>
              <div style="border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:12px 14px;background:rgba(255,255,255,.03);color:#dce6ff;">✓ No popups. No subscriptions. Buy what you need and keep it forever.</div>
            </div>
          </div>
          <div style="padding:0 26px 30px;text-align:center;">
            <a href="${safeUrl}" style="display:inline-block;padding:14px 20px;border-radius:14px;background:#4d8fff;color:#fff;text-decoration:none;font-weight:900;box-shadow:0 14px 30px rgba(77,143,255,.32);">Verify email</a>
            <p style="margin:14px 0 0;color:#98a7c7;font-size:12px;word-break:break-all;">Or paste this link into your browser:<br>${safeUrl}</p>
          </div>
        </div>
        <p style="margin:16px 4px 0;color:#7381a1;font-size:12px;">If you did not create this account, you can ignore this email.</p>
      </div>
    </div>
  `;

  return sendEmailViaSendGrid({
    to,
    subject,
    text,
    html,
    requestId,
    fromName: "TabForge",
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

export async function sendContactFormEmail({
  to,
  replyTo,
  name,
  email,
  company = "",
  topic = "Support",
  message,
  requestId,
}) {
  const subject = String(topic || "Support").trim() || "Support";

  const text = `New SendForge contact request

Topic: ${topic}
Name: ${name}
Email: ${email}
Company: ${company || "N/A"}

Message:
${message}
`;

  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; color: #111;">
      <h2>New SendForge contact request</h2>

      <p><strong>Topic:</strong> ${escapeHtml(topic)}</p>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
      <p><strong>Company:</strong> ${escapeHtml(company || "N/A")}</p>

      <hr style="border:none;border-top:1px solid #ddd;margin:18px 0"/>

      <h3>Message</h3>
      <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
    </div>
  `;

  return sendEmailViaSendGrid({
    to,
    replyTo,
    subject,
    text,
    html,
    requestId,
    fromEmail: process.env.CONTACT_FROM_EMAIL || process.env.SENDGRID_FROM_EMAIL || process.env.VERIFY_FROM_EMAIL,
    fromName: process.env.CONTACT_FROM_NAME || process.env.SENDGRID_FROM_NAME || "SendForge",
  });
}
export async function sendAdminMfaCodeEmail({ to, code, requestId }) {
  const subject = "SendForge admin login code";
  const text = `Your SendForge admin login code is ${code}.

This code expires in 5 minutes.

If you did not request this, secure your account immediately.`;
  const html = `
    <div style="font-family: system-ui; line-height: 1.5;">
      <h2>SendForge admin login</h2>
      <p>Your admin login code is:</p>
      <p style="font-size:28px;font-weight:800;letter-spacing:4px;">${escapeHtml(code)}</p>
      <p>This code expires in 5 minutes.</p>
      <p style="font-size:12px;color:#666;">If you did not request this, secure your account immediately.</p>
    </div>
  `;

  return sendEmailViaSendGrid({
    to,
    subject,
    text,
    html,
    requestId,
    fromEmail: process.env.ADMIN_FROM_EMAIL || process.env.SENDGRID_FROM_EMAIL || process.env.VERIFY_FROM_EMAIL,
    fromName: process.env.ADMIN_FROM_NAME || process.env.SENDGRID_FROM_NAME || "SendForge Admin",
  });
}


export async function sendReferralInviteEmail({ to, fromEmail, referralUrl, productName = "TabForge", requestId }) {
  const safeProduct = escapeHtml(productName);
  const safeFrom = escapeHtml(fromEmail || "a TabForge user");
  const safeUrl = escapeHtml(referralUrl);
  const subject = `Earn $10, $20, or $75 with ${productName}`;

  const text = `Earn Cash App rewards with ${productName}

${fromEmail || "A TabForge user"} invited you to check out ${productName}.

Create a SendForge account and get your personal referral link.

Share your link with friends and earn simple Cash App payouts:
- 5 verified referrals = $10
- 15 verified referrals = $20
- 50 verified referrals = $75

Each milestone creates its own payout. No purchase necessary.

${productName} Pro is a product worth sharing:
- 36 organized shortcuts
- One bonus Curated Pack Credit adds 36 more shortcuts
- Easy bookmark organization
- Simple, intuitive use
- No popups
- No subscriptions
- Pay once and keep it forever

Create your SendForge account and get your referral link:
${referralUrl}

Verified accounts only. Duplicate, fake, or self-referred accounts do not count.
Need help? Contact ${supportEmail()}.`;

  const html = `
    <div style="margin:0;padding:0;background:#05070d;color:#eef3ff;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.55;">
      <div style="max-width:680px;margin:0 auto;padding:28px 18px;">
        <div style="border:1px solid rgba(44,224,183,.36);border-radius:28px;background:radial-gradient(circle at top left,rgba(44,224,183,.22),transparent 36%),radial-gradient(circle at top right,rgba(77,143,255,.20),transparent 38%),linear-gradient(135deg,#0b1220,#081019 58%,#07120f);box-shadow:0 30px 90px rgba(0,0,0,.45);overflow:hidden;">
          <div style="padding:32px 28px 20px;text-align:center;">
            <div style="display:inline-block;padding:8px 13px;border-radius:999px;background:rgba(44,224,183,.14);border:1px solid rgba(44,224,183,.38);color:#8ff7df;font-size:12px;font-weight:900;letter-spacing:.10em;text-transform:uppercase;">
              Cash App referral rewards
            </div>
            <h1 style="margin:18px 0 10px;font-size:40px;line-height:1.02;color:#ffffff;letter-spacing:-.035em;">
              5 referrals = $10.
            </h1>
            <p style="margin:0 auto;max-width:560px;color:#c7d3ee;font-size:18px;">
              Keep sharing: 15 referrals earns $20, and 50 earns $75.
            </p>
          </div>

          <div style="padding:0 28px 22px;">
            <div style="border:1px solid rgba(44,224,183,.30);border-radius:20px;background:linear-gradient(135deg,rgba(44,224,183,.14),rgba(77,143,255,.08));padding:20px;">
              <h2 style="margin:0 0 12px;color:#ffffff;font-size:23px;text-align:center;">It really is this simple</h2>
              <div style="display:grid;gap:9px;">
                <div style="border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:12px 14px;background:rgba(255,255,255,.04);color:#dce6ff;"><strong style="color:#8ff7df;">1.</strong> Create your SendForge account.</div>
                <div style="border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:12px 14px;background:rgba(255,255,255,.04);color:#dce6ff;"><strong style="color:#8ff7df;">2.</strong> Copy your personal referral link and share it.</div>
                <div style="border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:12px 14px;background:rgba(255,255,255,.04);color:#dce6ff;"><strong style="color:#8ff7df;">3.</strong> Friends create and verify accounts — your Cash App rewards unlock automatically.</div>
              </div>
              <table role="presentation" width="100%" cellspacing="8" cellpadding="0" style="margin-top:14px;border-collapse:separate;">
                <tr>
                  <td style="width:33.33%;border:1px solid rgba(44,224,183,.30);border-radius:14px;padding:12px 8px;background:rgba(44,224,183,.10);text-align:center;color:#ffffff;"><strong style="display:block;font-size:20px;">5</strong><span style="font-size:12px;color:#aeeedc;">referrals</span><strong style="display:block;margin-top:4px;font-size:18px;">$10</strong></td>
                  <td style="width:33.33%;border:1px solid rgba(77,143,255,.30);border-radius:14px;padding:12px 8px;background:rgba(77,143,255,.10);text-align:center;color:#ffffff;"><strong style="display:block;font-size:20px;">15</strong><span style="font-size:12px;color:#b9ccff;">referrals</span><strong style="display:block;margin-top:4px;font-size:18px;">$20</strong></td>
                  <td style="width:33.33%;border:1px solid rgba(255,255,255,.18);border-radius:14px;padding:12px 8px;background:rgba(255,255,255,.06);text-align:center;color:#ffffff;"><strong style="display:block;font-size:20px;">50</strong><span style="font-size:12px;color:#dce6ff;">referrals</span><strong style="display:block;margin-top:4px;font-size:18px;">$75</strong></td>
                </tr>
              </table>
              <p style="margin:14px 0 0;color:#ffffff;font-size:17px;font-weight:900;text-align:center;">Each milestone is a separate payout. No purchase necessary.</p>
            </div>
          </div>

          <div style="padding:0 28px 22px;">
            <div style="border-radius:20px;background:rgba(77,143,255,.12);border:1px solid rgba(77,143,255,.30);padding:20px;">
              <h2 style="margin:0 0 8px;color:#ffffff;font-size:22px;">${safeProduct} Pro is worth sharing</h2>
              <p style="margin:0 0 13px;color:#c7d3ee;">
                A clean, simple new-tab workspace that keeps the sites people use every day organized and one click away.
              </p>
              <div style="display:grid;gap:9px;">
                <div style="border:1px solid rgba(255,255,255,.08);border-radius:13px;padding:11px 13px;background:rgba(0,0,0,.12);color:#dce6ff;">✓ Pro unlocks 36 organized shortcuts.</div>
                <div style="border:1px solid rgba(255,255,255,.08);border-radius:13px;padding:11px 13px;background:rgba(0,0,0,.12);color:#dce6ff;">✓ A bonus Curated Pack Credit adds 36 more shortcuts — up to 72 from the start.</div>
                <div style="border:1px solid rgba(255,255,255,.08);border-radius:13px;padding:11px 13px;background:rgba(0,0,0,.12);color:#dce6ff;">✓ Easy bookmark organization. Simple, intuitive use.</div>
                <div style="border:1px solid rgba(255,255,255,.08);border-radius:13px;padding:11px 13px;background:rgba(0,0,0,.12);color:#dce6ff;">✓ No popups. No subscriptions. Pay once and keep it forever.</div>
              </div>
            </div>
          </div>

          <div style="padding:0 28px 32px;text-align:center;">
            <p style="margin:0 0 16px;color:#aebcda;font-size:14px;">Invited by ${safeFrom}</p>
            <a href="${safeUrl}" style="display:inline-block;padding:16px 24px;border-radius:16px;background:linear-gradient(135deg,#4d8fff,#2ce0b7);color:#061019;text-decoration:none;font-weight:950;box-shadow:0 16px 36px rgba(44,224,183,.28);">
              Create My SendForge Account
            </a>
            <p style="margin:14px 0 0;color:#98a7c7;font-size:12px;word-break:break-all;">Or paste this link into your browser:<br>${safeUrl}</p>
          </div>
        </div>

        <p style="margin:16px 4px 0;color:#7381a1;font-size:12px;">
          Verified accounts only. Duplicate, fake, or self-referred accounts do not count. Need help? Contact ${escapeHtml(supportEmail())}.
        </p>
      </div>
    </div>
  `;

  return sendEmailViaSendGrid({
    to,
    subject,
    text,
    html,
    requestId,
    replyTo: fromEmail || null,
    fromName: productName,
  });
}
