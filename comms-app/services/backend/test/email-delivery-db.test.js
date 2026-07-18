import test from "node:test";
import assert from "node:assert/strict";
import {
  applyReferralInviteSendgridEvent,
  markReferralInviteEmailAccepted,
} from "../src/services/emailDelivery.service.js";

const REFERRAL_EVENT_ID = "5f7f0e9f-a8c4-4b0a-9d1e-4fb9c65d883a";

function clone(value) {
  return structuredClone(value);
}

function createFakeDatabase(initialRow) {
  let row = clone(initialRow);
  let lockCount = 0;
  let transactionCount = 0;
  let updateCount = 0;

  function connection(table) {
    assert.equal(table, "referral_events");
    const builder = {
      where() {
        return builder;
      },
      forUpdate() {
        lockCount += 1;
        return builder;
      },
      async first() {
        return clone(row);
      },
      update(payload) {
        row = { ...row, ...clone(payload) };
        updateCount += 1;
        const updateResult = {
          async returning() {
            return [clone(row)];
          },
          then(resolve, reject) {
            return Promise.resolve(1).then(resolve, reject);
          },
        };
        return updateResult;
      },
    };
    return builder;
  }
  connection.fn = {
    now() {
      return new Date("2026-07-16T12:00:00.000Z");
    },
  };

  const database = {
    async transaction(callback) {
      transactionCount += 1;
      return callback(connection);
    },
  };

  return {
    database,
    snapshot() {
      return {
        row: clone(row),
        lockCount,
        transactionCount,
        updateCount,
      };
    },
  };
}

function referralRow(emailDelivery) {
  return {
    id: REFERRAL_EVENT_ID,
    event_type: "invite",
    referrer_user_id: "ad09cc14-fd8b-4a89-bc2f-c3ebbdcf2547",
    metadata: {
      recipient_email: "friend@example.com",
      email_delivery: emailDelivery,
    },
  };
}

test("acceptance update locks the row and cannot regress delivered state", async () => {
  const fake = createFakeDatabase(
    referralRow({
      status: "delivered",
      sendgrid_event_ids: ["sg-event-delivered"],
      delivered_at: "2026-07-16T11:00:00.000Z",
    })
  );

  await markReferralInviteEmailAccepted({
    referralEventId: REFERRAL_EVENT_ID,
    sendResult: {
      mode: "sendgrid",
      messageId: "mail-send-request-id",
    },
    database: fake.database,
  });

  const state = fake.snapshot();
  assert.equal(state.transactionCount, 1);
  assert.equal(state.lockCount, 1);
  assert.equal(state.updateCount, 1);
  assert.equal(
    state.row.metadata.email_delivery.status,
    "delivered"
  );
  assert.deepEqual(
    state.row.metadata.email_delivery.sendgrid_event_ids,
    ["sg-event-delivered"]
  );
  assert.equal(
    state.row.metadata.email_delivery.mail_send_message_id,
    "mail-send-request-id"
  );
});

test("duplicate failure events still request suppression retry", async () => {
  const fake = createFakeDatabase(
    referralRow({
      status: "bounced",
      sendgrid_event_ids: ["sg-event-bounce"],
    })
  );

  const result = await applyReferralInviteSendgridEvent(
    {
      event: "bounce",
      sg_event_id: "sg-event-bounce",
      sf_message_kind: "referral-invite",
      sf_message_ref: REFERRAL_EVENT_ID,
    },
    fake.database
  );

  const state = fake.snapshot();
  assert.equal(result.handled, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.shouldSuppress, true);
  assert.equal(result.shouldSuppressGlobally, false);
  assert.equal(result.eventType, "bounce");
  assert.equal(result.recipientEmail, "friend@example.com");
  assert.equal(state.transactionCount, 1);
  assert.equal(state.lockCount, 1);
  assert.equal(state.updateCount, 0);
});

test("invalid correlation UUID is ignored without touching the database", async () => {
  const database = {
    transaction() {
      throw new Error("database_should_not_be_called");
    },
  };

  const result = await applyReferralInviteSendgridEvent(
    {
      event: "delivered",
      sf_message_kind: "referral-invite",
      sf_message_ref: "not-a-uuid",
    },
    database
  );

  assert.deepEqual(result, {
    handled: false,
    unmatched: true,
    invalidRef: true,
    referralEventId: "not-a-uuid",
  });
});
