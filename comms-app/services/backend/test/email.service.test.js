import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  EmailSendError,
  sendReferralInviteEmail,
  sendVerificationEmail,
} from "../src/services/email.service.js";

const ENV_KEYS = [
  "NODE_ENV",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "SENDGRID_REFERRAL_UNSUBSCRIBE_GROUP_ID",
  "VERIFY_FROM_EMAIL",
  "ACCOUNT_FROM_EMAIL",
  "ACCOUNT_FROM_NAME",
  "REFERRAL_FROM_EMAIL",
  "REFERRAL_FROM_NAME",
  "REFERRAL_BUSINESS_ADDRESS",
  "PRIVACY_POLICY_URL",
  "SUPPORT_EMAIL",
];

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]])
);
const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;

function clearEmailEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function restoreEmailEnv() {
  clearEmailEnv();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
}

function configureProvider() {
  process.env.NODE_ENV = "test";
  process.env.SENDGRID_API_KEY = "SG.test-only";
  process.env.REFERRAL_FROM_EMAIL = "referrals@sendforge.app";
  process.env.REFERRAL_FROM_NAME = "SendForge Rewards";
  process.env.SENDGRID_REFERRAL_UNSUBSCRIBE_GROUP_ID = "4242";
  process.env.REFERRAL_BUSINESS_ADDRESS =
    "123 Test Street, Test City, NY 10001";
  process.env.PRIVACY_POLICY_URL =
    "https://sendforge.app/privacy.html";
  process.env.ACCOUNT_FROM_NAME = "SendForge";
  process.env.SUPPORT_EMAIL = "support@sendforge.app";
}

function sendgridResponse({
  ok = true,
  status = 202,
  messageId = "sg-test-message-id",
  responseText = "",
  retryAfter = null,
} = {}) {
  return {
    ok,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-message-id"
          ? messageId
          : String(name).toLowerCase() === "retry-after"
            ? retryAfter
            : null;
      },
    },
    async text() {
      return responseText;
    },
  };
}

function captureFetch(response = sendgridResponse()) {
  const responses = Array.isArray(response) ? response : [response];
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  return calls;
}

function contentValue(payload, type) {
  return payload.content.find((part) => part.type === type)?.value;
}

beforeEach(() => {
  clearEmailEnv();
  configureProvider();
  console.log = () => {};
});

afterEach(() => {
  restoreEmailEnv();
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
});

describe("SendForge transactional SendGrid payloads", { concurrency: false }, () => {
  test("verification uses the known-good sender and a neutral, correlated payload", async () => {
    const calls = captureFetch();
    const verifyUrl =
      "https://sendforge.app/auth/verify-email/verify-token-123";

    const result = await sendVerificationEmail({
      to: "new-user@example.com",
      verifyUrl,
      requestId: "request-verify-123",
      userId: "user-42",
    });

    assert.deepEqual(result, {
      ok: true,
      mode: "sendgrid",
      status: "accepted",
      messageId: "sg-test-message-id",
    });
    assert.equal(calls.length, 1);

    const [{ url, init, body }] = calls;
    assert.equal(url, "https://api.sendgrid.com/v3/mail/send");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer SG.test-only");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.headers.Accept, "application/json");
    assert.ok(init.signal instanceof AbortSignal);

    assert.deepEqual(body.from, {
      email: "referrals@sendforge.app",
      name: "SendForge",
    });
    assert.equal(body.subject, "Verify your SendForge email");
    assert.doesNotMatch(body.subject, /\$|earn|cash|reward/i);

    const text = contentValue(body, "text/plain");
    const html = contentValue(body, "text/html");
    assert.ok(text, "plain-text verification body is required");
    assert.ok(html, "HTML verification body is required");
    assert.ok(text.includes(verifyUrl), "plain text keeps the exact URL");
    assert.ok(html.includes(verifyUrl), "HTML keeps the exact URL");
    assert.doesNotMatch(`${text}\n${html}`, /cash app|real money|\$17/i);

    assert.deepEqual(body.personalizations[0].custom_args, {
      sf_message_kind: "account-verification",
      sf_message_ref: "user-42",
      sf_request_id: "request-verify-123",
    });
    assert.deepEqual(body.categories, [
      "sendforge-transactional",
      "account-verification",
    ]);
    assert.deepEqual(body.tracking_settings, {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
    });
  });

  test("referral clearly discloses promotion and keeps exact correlation", async () => {
    const calls = captureFetch();
    const referralUrl =
      "https://tabforge.app/referral/invite-token-456";
    const unsubscribeUrl =
      "https://api.sendforge.app/v1/unsubscribe?token=unsubscribe-456";

    await sendReferralInviteEmail({
      to: "friend@example.com",
      fromEmail: "inviter@example.com",
      referralUrl,
      productName: "TabForge",
      requestId: "request-referral-123",
      referralEventId: "5f7f0e9f-a8c4-4b0a-9d1e-4fb9c65d883a",
      unsubscribeUrl,
    });

    assert.equal(calls.length, 1);
    const { body } = calls[0];

    assert.deepEqual(body.from, {
      email: "referrals@sendforge.app",
      name: "SendForge Rewards",
    });
    assert.equal(body.reply_to, undefined);
    assert.equal(
      body.subject,
      "Promotional: A TabForge referral invitation"
    );
    assert.doesNotMatch(body.subject, /\$|earn|cash|reward/i);

    const text = contentValue(body, "text/plain");
    const html = contentValue(body, "text/html");
    assert.ok(text, "plain-text referral body is required");
    assert.ok(html, "HTML referral body is required");
    assert.ok(text.includes(referralUrl), "plain text keeps the exact URL");
    assert.ok(html.includes(referralUrl), "HTML keeps the exact URL");
    assert.ok(text.includes(unsubscribeUrl));
    assert.ok(html.includes(unsubscribeUrl.replaceAll("&", "&amp;")));
    assert.match(text, /123 Test Street, Test City, NY 10001/);
    assert.match(html, /123 Test Street, Test City, NY 10001/);
    assert.match(text, /https:\/\/sendforge\.app\/privacy\.html/);
    assert.match(html, /https:\/\/sendforge\.app\/privacy\.html/);
    assert.deepEqual(body.personalizations[0].headers, {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    assert.deepEqual(body.asm, { group_id: 4242 });

    assert.match(text, /does not create an account or enroll you/i);
    assert.match(html, /does not create an account or enroll you/i);
    assert.match(
      text,
      /This is a promotional referral message from SendForge\./
    );
    assert.match(
      html,
      /This is a promotional referral message from SendForge\./
    );
    assert.match(html, /Cash App rewards/);
    assert.match(html, /Simple rewards\. Real money\./);
    assert.match(html, /Own TabForge Pro\. Earn \$17 when 5 friends buy\./);
    assert.match(text, /Referral rewards are available only to TabForge Pro owners\./);
    assert.match(html, /The referrer must own TabForge Pro\./);
    assert.doesNotMatch(html, /do not have to buy|does not need to purchase/i);
    assert.match(html, /2 themed visual layouts to choose from\./);
    assert.match(html, /Intuitive, powerful built-in notepad\./);
    assert.match(html, /Easily store your bookmarks on customizable pages\./);
    assert.match(
      html,
      /2 months of cross-device syncing keeps notes accessible everywhere\./
    );
    assert.doesNotMatch(html, /36 shortcuts|included collection adds 36/i);
    assert.match(html, /Open My Private Invitation/);
    assert.match(html, /\$150/);

    assert.deepEqual(body.personalizations[0].custom_args, {
      sf_message_kind: "referral-invite",
      sf_message_ref: "5f7f0e9f-a8c4-4b0a-9d1e-4fb9c65d883a",
      sf_request_id: "request-referral-123",
    });
    assert.deepEqual(body.categories, [
      "sendforge-referral",
      "referral-invite",
    ]);
    assert.deepEqual(body.tracking_settings.click_tracking, {
      enable: false,
      enable_text: false,
    });
    assert.deepEqual(body.tracking_settings.open_tracking, { enable: false });
    assert.deepEqual(body.tracking_settings.subscription_tracking, {
      enable: false,
    });
  });
});

describe("SendForge transport failures", { concurrency: false }, () => {
  test("referral sending fails closed without a per-sender unsubscribe URL", async () => {
    const calls = captureFetch();

    await assert.rejects(
      sendReferralInviteEmail({
        to: "friend@example.com",
        fromEmail: "inviter@example.com",
        referralUrl: "https://tabforge.app/referral/token-no-unsubscribe",
        productName: "TabForge",
        requestId: "request-no-unsubscribe",
        referralEventId: "event-no-unsubscribe",
      }),
      (error) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "referral_unsubscribe_missing");
        return true;
      }
    );
    assert.equal(calls.length, 0);
  });

  test("referral sending fails closed without sender compliance details", async () => {
    const calls = captureFetch();
    delete process.env.REFERRAL_BUSINESS_ADDRESS;

    await assert.rejects(
      sendReferralInviteEmail({
        to: "friend@example.com",
        fromEmail: "inviter@example.com",
        referralUrl: "https://tabforge.app/referral/token-no-address",
        productName: "TabForge",
        requestId: "request-no-address",
        referralEventId: "event-no-address",
        unsubscribeUrl:
          "https://api.sendforge.app/v1/unsubscribe?token=no-address",
      }),
      (error) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(
          error.code,
          "referral_compliance_not_configured"
        );
        return true;
      }
    );
    assert.equal(calls.length, 0);
  });

  test("production fails closed when the provider is not configured", async () => {
    clearEmailEnv();
    process.env.NODE_ENV = "production";

    await assert.rejects(
      sendVerificationEmail({
        to: "new-user@example.com",
        verifyUrl: "https://sendforge.app/auth/verify-email/token",
        requestId: "request-no-config",
        userId: "user-no-config",
      }),
      (error) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "email_not_configured");
        assert.deepEqual(error.details, { provider: "sendgrid" });
        return true;
      }
    );
  });

  test("maps a SendGrid 401 to sendgrid_401 without leaking its response", async () => {
    captureFetch(
      sendgridResponse({
        ok: false,
        status: 401,
        messageId: null,
        responseText: '{"errors":[{"message":"authorization required"}]}',
      })
    );

    await assert.rejects(
      sendVerificationEmail({
        to: "new-user@example.com",
        verifyUrl: "https://sendforge.app/auth/verify-email/token-401",
        requestId: "request-401",
      }),
      (error) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "sendgrid_401");
        assert.equal(error.message, "Email send failed");
        assert.deepEqual(error.details, {
          provider: "sendgrid",
          status: 401,
        });
        assert.doesNotMatch(String(error), /authorization required/);
        return true;
      }
    );
  });

  test("retries one explicit provider 5xx, then maps it to sendgrid_non_2xx", async () => {
    const calls = captureFetch(
      sendgridResponse({
        ok: false,
        status: 503,
        messageId: null,
        responseText: "temporarily unavailable",
      })
    );

    await assert.rejects(
      sendReferralInviteEmail({
        to: "friend@example.com",
        fromEmail: "inviter@example.com",
        referralUrl: "https://tabforge.app/referral/token-503",
        productName: "TabForge",
        requestId: "request-503",
        referralEventId: "event-503",
        unsubscribeUrl:
          "https://api.sendforge.app/v1/unsubscribe?token=unsubscribe-503",
      }),
      (error) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "sendgrid_non_2xx");
        assert.deepEqual(error.details, {
          provider: "sendgrid",
          status: 503,
        });
        return true;
      }
    );
    assert.equal(calls.length, 2);
  });

  test("retries a 429 once and accepts a subsequent 202", async () => {
    const calls = captureFetch([
      sendgridResponse({
        ok: false,
        status: 429,
        messageId: null,
        responseText: "rate limited",
        retryAfter: "0",
      }),
      sendgridResponse({
        status: 202,
        messageId: "sg-after-retry",
      }),
    ]);

    const result = await sendVerificationEmail({
      to: "new-user@example.com",
      verifyUrl: "https://sendforge.app/auth/verify-email/token-429",
      requestId: "request-429",
    });

    assert.equal(calls.length, 2);
    assert.equal(result.status, "accepted");
    assert.equal(result.messageId, "sg-after-retry");
  });

  test("rejects an unexpected successful HTTP status instead of claiming acceptance", async () => {
    const calls = captureFetch(
      sendgridResponse({ ok: true, status: 200, messageId: null })
    );

    await assert.rejects(
      sendVerificationEmail({
        to: "new-user@example.com",
        verifyUrl: "https://sendforge.app/auth/verify-email/token-200",
        requestId: "request-200",
      }),
      (error) => {
        assert.equal(error.code, "sendgrid_unexpected_2xx");
        assert.equal(error.details.status, 200);
        return true;
      }
    );
    assert.equal(calls.length, 1);
  });

  test("maps thrown fetch errors to a provider-safe network_error", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("socket contained a secret provider detail");
    };

    await assert.rejects(
      sendVerificationEmail({
        to: "new-user@example.com",
        verifyUrl: "https://sendforge.app/auth/verify-email/token-network",
        requestId: "request-network",
      }),
      (error) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "network_error");
        assert.equal(error.message, "Email provider network error");
        assert.deepEqual(error.details, {
          provider: "sendgrid",
          deliveryUnknown: true,
        });
        assert.doesNotMatch(String(error), /secret provider detail/);
        return true;
      }
    );
    assert.equal(fetchCalls, 1);
  });
});
