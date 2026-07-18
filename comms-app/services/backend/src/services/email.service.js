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

function accountFromEmail() {
  // REFERRAL_FROM_EMAIL is the current known-good authenticated identity.
  // ACCOUNT_FROM_EMAIL can take over after its own reputation is validated.
  return (
    process.env.ACCOUNT_FROM_EMAIL ||
    process.env.REFERRAL_FROM_EMAIL ||
    process.env.SENDGRID_FROM_EMAIL ||
    process.env.VERIFY_FROM_EMAIL ||
    ""
  );
}

function accountFromName() {
  return (
    process.env.ACCOUNT_FROM_NAME ||
    process.env.SENDGRID_FROM_NAME ||
    "SendForge"
  );
}

function referralComplianceDetails() {
  const businessAddress = String(
    process.env.REFERRAL_BUSINESS_ADDRESS || ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  const privacyPolicyUrl = String(
    process.env.PRIVACY_POLICY_URL || ""
  ).trim();

  let validPrivacyUrl = false;
  try {
    const parsed = new URL(privacyPolicyUrl);
    validPrivacyUrl = parsed.protocol === "https:";
  } catch {
    validPrivacyUrl = false;
  }

  if (!businessAddress || !validPrivacyUrl) {
    throw new EmailSendError(
      "referral_compliance_not_configured",
      "Referral sender address and privacy policy are required"
    );
  }
  return { businessAddress, privacyPolicyUrl };
}

const SENDGRID_PROVIDER_RETRY_LIMIT = 1;
const SENDGRID_DEFAULT_RETRY_DELAY_MS = 250;
const SENDGRID_MAX_RETRY_DELAY_MS = 5000;

function isRetryableSendgridStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function sendgridRetryDelayMs(response) {
  const retryAfterHeader = response?.headers?.get?.("retry-after");
  const retryAfter = Number(retryAfterHeader);
  if (
    retryAfterHeader !== null &&
    retryAfterHeader !== undefined &&
    retryAfterHeader !== "" &&
    Number.isFinite(retryAfter) &&
    retryAfter >= 0
  ) {
    return Math.min(
      Math.round(retryAfter * 1000),
      SENDGRID_MAX_RETRY_DELAY_MS
    );
  }
  return SENDGRID_DEFAULT_RETRY_DELAY_MS;
}

function waitForRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
  messageKind = "transactional",
  messageRef = null,
  messageCategory = "sendforge-transactional",
  disableSubscriptionTracking = true,
  unsubscribeUrl = null,
  unsubscribeGroupId = null,
}) {
  const senderEmail = fromEmail || accountFromEmail();
  const senderName = fromName || accountFromName();
  const sgKey = process.env.SENDGRID_API_KEY;

  if (!senderEmail || !sgKey) {
    log("warn", "email_send_skipped_not_configured", {
      requestId,
      to: sanitizeEmail(to),
      hasFrom: Boolean(senderEmail),
      hasKey: Boolean(sgKey),
      subject,
    });
    if (process.env.NODE_ENV === "production") {
      throw new EmailSendError(
        "email_not_configured",
        "Email provider is not configured",
        { provider: "sendgrid" }
      );
    }
    log("info", "email_log_mode", {
      requestId,
      subject,
      to: sanitizeEmail(to),
      previewText: String(text || "").slice(0, 500),
    });
    return { ok: true, mode: "log", status: "not_configured", messageId: null };
  }

  const customArgs = {
    sf_message_kind: String(messageKind || "transactional").slice(0, 100),
  };
  if (messageRef) customArgs.sf_message_ref = String(messageRef).slice(0, 200);
  if (requestId) customArgs.sf_request_id = String(requestId).slice(0, 200);

  const personalization = {
    to: [{ email: to }],
    custom_args: customArgs,
  };
  if (unsubscribeUrl) {
    personalization.headers = {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }

  const body = {
    personalizations: [personalization],
    from: { email: senderEmail, name: senderName },
    subject,
    content: [
      { type: "text/plain", value: text },
      { type: "text/html", value: html },
    ],
    categories: [
      String(messageCategory || "sendforge-transactional").slice(0, 100),
      customArgs.sf_message_kind,
    ],
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      ...(disableSubscriptionTracking
        ? { subscription_tracking: { enable: false } }
        : {}),
    },
  };

  if (replyTo) {
    body.reply_to = { email: replyTo };
  }
  const groupId = Number(unsubscribeGroupId);
  if (Number.isInteger(groupId) && groupId > 0) {
    body.asm = { group_id: groupId };
  }

  let res = null;
  let attempt = 0;
  while (attempt <= SENDGRID_PROVIDER_RETRY_LIMIT) {
    attempt += 1;
    try {
      res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${sgKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      // Never retry an ambiguous network failure. The provider may have
      // accepted the first request before our connection failed; retrying here
      // can send duplicate account or referral messages.
      log("error", "sendgrid_network_error", {
        requestId,
        to: sanitizeEmail(to),
        error: String(err?.message || err),
        subject,
        attempt,
      });
      throw new EmailSendError(
        "network_error",
        "Email provider network error",
        { provider: "sendgrid", deliveryUnknown: true }
      );
    }

    // SendGrid Mail Send documents 202 as its accepted response. Do not treat
    // an unexpected 200/201/204 as proof that the message entered its queue.
    if (res.status === 202) break;

    const bodyText = await res.text().catch(() => "");
    const canRetry =
      isRetryableSendgridStatus(res.status) &&
      attempt <= SENDGRID_PROVIDER_RETRY_LIMIT;
    if (canRetry) {
      const delayMs = sendgridRetryDelayMs(res);
      log("warn", "sendgrid_retryable_response", {
        requestId,
        to: sanitizeEmail(to),
        status: res.status,
        subject,
        attempt,
        delayMs,
      });
      await waitForRetry(delayMs);
      continue;
    }

    const code =
      res.status === 401
        ? "sendgrid_401"
        : res.status >= 200 && res.status <= 299
          ? "sendgrid_unexpected_2xx"
          : "sendgrid_non_2xx";
    log("error", "sendgrid_error", {
      requestId,
      to: sanitizeEmail(to),
      status: res.status,
      body: bodyText?.slice(0, 500),
      subject,
      attempt,
    });
    throw new EmailSendError(code, "Email send failed", {
      provider: "sendgrid",
      status: res.status,
    });
  }

  const messageId = res.headers.get("x-message-id") || null;
  log("info", "sendgrid_accepted", {
    requestId,
    to: sanitizeEmail(to),
    subject,
    messageId,
    messageKind: customArgs.sf_message_kind,
    messageRef: customArgs.sf_message_ref || null,
    fromEmail: senderEmail,
    fromName: senderName,
  });
  return {
    ok: true,
    mode: "sendgrid",
    status: "accepted",
    messageId,
  };
}

/**
 * Sends verification email via SendGrid Web API.
 * Env:
 *  - SENDGRID_API_KEY
 *  - ACCOUNT_FROM_EMAIL (falls back to the authenticated referral identity)
 */
export async function sendVerificationEmail({
  to,
  verifyUrl,
  requestId,
  userId = null,
}) {
  const subject = "Verify your SendForge email";
  const safeUrl = escapeHtml(verifyUrl);

  const text = `Verify your email to finish setting up your SendForge account.

Verify your email:
${verifyUrl}

This link expires in 24 hours. After verification, you can sign in and open your TabForge referral dashboard.

If you did not create this account, ignore this email.`;

  const html = `
    <div style="margin:0;padding:24px;background:#f5f7fb;color:#172033;font-family:Arial,sans-serif;line-height:1.55;">
      <div style="max-width:580px;margin:0 auto;padding:28px;border:1px solid #dce3ee;border-radius:16px;background:#ffffff;">
        <p style="margin:0 0 8px;color:#52627a;font-size:13px;font-weight:700;">SENDFORGE ACCOUNT</p>
        <h1 style="margin:0 0 12px;font-size:27px;line-height:1.15;color:#172033;">Verify your email</h1>
        <p style="margin:0 0 22px;color:#52627a;">Finish setting up your account and unlock your TabForge referral dashboard.</p>
        <p style="margin:0 0 22px;">
          <a href="${safeUrl}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#1e6fe8;color:#ffffff;text-decoration:none;font-weight:700;">Verify email</a>
        </p>
        <p style="margin:0 0 8px;color:#66758c;font-size:12px;">This link expires in 24 hours.</p>
        <p style="margin:0;color:#66758c;font-size:12px;word-break:break-all;">Or paste this link into your browser:<br>${safeUrl}</p>
        <hr style="margin:24px 0;border:0;border-top:1px solid #e3e8f0;">
        <p style="margin:0;color:#7b8799;font-size:12px;">If you did not create this account, you can ignore this email.</p>
      </div>
    </div>
  `;

  return sendEmailViaSendGrid({
    to,
    subject,
    text,
    html,
    requestId,
    fromEmail: accountFromEmail(),
    fromName: accountFromName(),
    messageKind: "account-verification",
    messageRef: userId || requestId,
    disableSubscriptionTracking: true,
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
    messageKind: "password-reset",
    messageRef: requestId,
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
    messageKind: "account-recovery",
    messageRef: requestId,
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
    messageKind: "contact-form",
    messageRef: requestId,
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
    messageKind: "admin-mfa",
    messageRef: requestId,
  });
}


export async function sendReferralInviteEmail({
  to,
  fromEmail,
  referralUrl,
  productName = "TabForge",
  requestId,
  referralEventId = null,
  unsubscribeUrl,
}) {
  if (!unsubscribeUrl) {
    throw new EmailSendError(
      "referral_unsubscribe_missing",
      "Referral unsubscribe URL is required"
    );
  }
  const { businessAddress, privacyPolicyUrl } =
    referralComplianceDetails();
  const referrerEmail = fromEmail || null;
  const referralFromEmail =
    process.env.REFERRAL_FROM_EMAIL ||
    process.env.SENDGRID_FROM_EMAIL ||
    accountFromEmail();
  const referralFromName =
    process.env.REFERRAL_FROM_NAME || accountFromName();

  const safeProduct = escapeHtml(productName);
  const safeFrom = escapeHtml(referrerEmail || "a TabForge user");
  const safeUrl = escapeHtml(referralUrl);
  const subject = `Promotional: A ${productName} referral invitation`;

  const text = `This is a promotional referral message from SendForge.

${referrerEmail || "Someone you know"} invited you to ${productName} Pro.

Open the private invitation:
${referralUrl}

This invitation does not create an account or enroll you in anything. If you were not expecting it, you can ignore this message.

Stop future SendForge referral invitations:
${unsubscribeUrl}

SendForge · ${businessAddress}
Privacy policy: ${privacyPolicyUrl}

Need help? Contact ${supportEmail()}.`;

  const html = `
    <div style="margin:0;padding:24px;background:#f5f7fb;color:#172033;font-family:Arial,sans-serif;line-height:1.55;">
      <div style="max-width:600px;margin:0 auto;padding:28px;border:1px solid #dce3ee;border-radius:16px;background:#ffffff;">
        <p style="margin:0 0 8px;color:#52627a;font-size:13px;font-weight:700;">SENDFORGE</p>
        <h1 style="margin:0 0 12px;font-size:27px;line-height:1.15;color:#172033;">A ${safeProduct} invitation</h1>
        <p style="margin:0 0 12px;color:#66758c;font-size:13px;font-weight:700;">This is a promotional referral message from SendForge.</p>
        <p style="margin:0 0 22px;color:#52627a;"><strong>${safeFrom}</strong> invited you to ${safeProduct} Pro.</p>
        <p style="margin:0 0 22px;">
          <a href="${safeUrl}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#1e6fe8;color:#ffffff;text-decoration:none;font-weight:700;">Open invitation</a>
        </p>
        <p style="margin:0 0 8px;color:#66758c;font-size:12px;word-break:break-all;">Or paste this link into your browser:<br>${safeUrl}</p>
        <hr style="margin:24px 0;border:0;border-top:1px solid #e3e8f0;">
        <p style="margin:0 0 8px;color:#7b8799;font-size:12px;">This invitation does not create an account or enroll you in anything. If you were not expecting it, you can ignore it. Need help? Contact ${escapeHtml(supportEmail())}.</p>
        <p style="margin:0 0 10px;color:#52627a;font-size:14px;"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#36506f;font-weight:700;text-decoration:underline;">Stop future SendForge referral invitations</a></p>
        <p style="margin:0;color:#7b8799;font-size:12px;">SendForge · ${escapeHtml(businessAddress)} · <a href="${escapeHtml(privacyPolicyUrl)}" style="color:#52627a;">Privacy policy</a></p>
      </div>
    </div>
  `;

  return sendEmailViaSendGrid({
    to,
    subject,
    text,
    html,
    requestId,
    fromEmail: referralFromEmail,
    fromName: referralFromName,
    messageKind: "referral-invite",
    messageRef: referralEventId || requestId,
    messageCategory: "sendforge-referral",
    unsubscribeUrl,
    unsubscribeGroupId: process.env.SENDGRID_REFERRAL_UNSUBSCRIBE_GROUP_ID,
    // Referral mail has a per-sender app unsubscribe, so global provider
    // suppression must not interfere with security/account messages.
    disableSubscriptionTracking: true,
  });
}
