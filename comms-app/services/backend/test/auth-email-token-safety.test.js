import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  emailDeliveryWasAmbiguous,
  restorePriorEmailTokenAfterDefinitiveFailure,
} from "../src/routes/auth.routes.js";
import { EmailSendError } from "../src/services/email.service.js";

describe("account-email token safety", () => {
  test("only ambiguous transport failures keep the rotated token", () => {
    assert.equal(
      emailDeliveryWasAmbiguous(
        new EmailSendError("network_error", "network", {
          provider: "sendgrid",
          deliveryUnknown: true,
        })
      ),
      true
    );
    assert.equal(
      emailDeliveryWasAmbiguous(
        new EmailSendError("sendgrid_401", "rejected", {
          provider: "sendgrid",
          status: 401,
        })
      ),
      false
    );
    assert.equal(emailDeliveryWasAmbiguous(new Error("template failed")), false);
  });

  test("restores the prior token only if the failed rotation is still current", async () => {
    const calls = [];
    const database = (table) => ({
      where(criteria) {
        calls.push({ table, criteria });
        return {
          async update(values) {
            calls.push({ values });
            return 1;
          },
        };
      },
    });
    const logCalls = [];

    await restorePriorEmailTokenAfterDefinitiveFailure({
      userId: "user-42",
      rotatedTokenHash: "new-token-hash",
      priorTokenHash: "old-token-hash",
      priorSentAt: "2026-07-16T12:00:00.000Z",
      requestId: "request-42",
      operation: "resend-verification",
      database,
      writeLog: (...args) => logCalls.push(args),
    });

    assert.deepEqual(calls, [
      {
        table: "users",
        criteria: {
          id: "user-42",
          verification_token_hash: "new-token-hash",
        },
      },
      {
        values: {
          verification_token_hash: "old-token-hash",
          verification_sent_at: "2026-07-16T12:00:00.000Z",
        },
      },
    ]);
    assert.deepEqual(logCalls, [
      [
        "info",
        "email_token_restore_after_send_failure",
        {
          requestId: "request-42",
          userId: "user-42",
          operation: "resend-verification",
          restored: true,
        },
      ],
    ]);
  });
});
