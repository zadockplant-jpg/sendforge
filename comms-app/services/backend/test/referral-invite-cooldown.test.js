import test from "node:test";
import assert from "node:assert/strict";
import {
  referralInviteCooldownRemainingMs,
} from "../src/services/emailDelivery.service.js";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");

function row({
  minutesAgo,
  status = "created",
  deliveryStatus = "pending",
}) {
  return {
    status,
    created_at: new Date(
      NOW - minutesAgo * 60 * 1000
    ).toISOString(),
    metadata: {
      email_delivery: { status: deliveryStatus },
    },
  };
}

test("pending or ambiguous sends prevent immediate duplicate retries", () => {
  assert.ok(
    referralInviteCooldownRemainingMs(
      row({ minutesAgo: 5, deliveryStatus: "pending" }),
      NOW
    ) > 0
  );
  assert.ok(
    referralInviteCooldownRemainingMs(
      row({ minutesAgo: 5, deliveryStatus: "send_error" }),
      NOW
    ) > 0
  );
  assert.equal(
    referralInviteCooldownRemainingMs(
      row({ minutesAgo: 16, deliveryStatus: "send_error" }),
      NOW
    ),
    0
  );
  assert.equal(
    referralInviteCooldownRemainingMs(
      row({ minutesAgo: 16, deliveryStatus: "not_configured" }),
      NOW
    ),
    0
  );
});

test("accepted sends enforce a full destination cooldown", () => {
  assert.ok(
    referralInviteCooldownRemainingMs(
      row({ minutesAgo: 23 * 60, deliveryStatus: "delivered" }),
      NOW
    ) > 0
  );
  assert.equal(
    referralInviteCooldownRemainingMs(
      row({ minutesAgo: 25 * 60, deliveryStatus: "delivered" }),
      NOW
    ),
    0
  );
  assert.equal(
    referralInviteCooldownRemainingMs(
      row({
        minutesAgo: 1,
        status: "cancelled",
        deliveryStatus: "accepted",
      }),
      NOW
    ),
    0
  );
});
