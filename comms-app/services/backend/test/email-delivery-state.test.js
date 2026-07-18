import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceEmailDeliveryStatus,
  isUuidValue,
  referralDeliveryStatusForSendgridEvent,
  referralSuppressionScopeForSendgridEvent,
  sendgridCustomArg,
} from "../src/services/emailDelivery.service.js";

test("reads SendGrid custom args from supported event shapes", () => {
  assert.equal(
    sendgridCustomArg(
      { sf_message_kind: "referral-invite" },
      "sf_message_kind"
    ),
    "referral-invite"
  );
  assert.equal(
    sendgridCustomArg(
      { unique_args: { sf_message_ref: "event-1" } },
      "sf_message_ref"
    ),
    "event-1"
  );
  assert.equal(
    sendgridCustomArg(
      { custom_args: { sf_message_ref: "event-2" } },
      "sf_message_ref"
    ),
    "event-2"
  );
});

test("maps delivery and failure webhook events", () => {
  assert.equal(
    referralDeliveryStatusForSendgridEvent("processed"),
    "processed"
  );
  assert.equal(
    referralDeliveryStatusForSendgridEvent("delivered"),
    "delivered"
  );
  assert.equal(
    referralDeliveryStatusForSendgridEvent("bounce"),
    "bounced"
  );
  assert.equal(
    referralDeliveryStatusForSendgridEvent("spamreport"),
    "spamreport"
  );
  assert.equal(
    referralDeliveryStatusForSendgridEvent("group_unsubscribe"),
    "unsubscribed"
  );
  assert.equal(referralDeliveryStatusForSendgridEvent("open"), null);
});

test("delivery state advances without regressing on out-of-order events", () => {
  assert.equal(advanceEmailDeliveryStatus("pending", "accepted"), "accepted");
  assert.equal(
    advanceEmailDeliveryStatus("accepted", "processed"),
    "processed"
  );
  assert.equal(
    advanceEmailDeliveryStatus("processed", "delivered"),
    "delivered"
  );
  assert.equal(
    advanceEmailDeliveryStatus("deferred", "processed"),
    "deferred"
  );
  assert.equal(
    advanceEmailDeliveryStatus("delivered", "deferred"),
    "delivered"
  );
  assert.equal(
    advanceEmailDeliveryStatus("delivered", "bounced"),
    "bounced"
  );
  assert.equal(
    advanceEmailDeliveryStatus("send_error", "delivered"),
    "delivered"
  );
  assert.equal(
    advanceEmailDeliveryStatus("pending", "made-up-status"),
    "pending"
  );
});

test("a later configured send can advance a not-configured attempt", () => {
  assert.equal(
    advanceEmailDeliveryStatus("not_configured", "accepted"),
    "accepted"
  );
});

test("validates opaque database correlation IDs before UUID queries", () => {
  assert.equal(
    isUuidValue("5f7f0e9f-a8c4-4b0a-9d1e-4fb9c65d883a"),
    true
  );
  assert.equal(isUuidValue("not-a-uuid"), false);
  assert.equal(isUuidValue("' OR 1=1 --"), false);
});

test("global suppression is reserved for confirmed permanent signals", () => {
  assert.deepEqual(
    referralSuppressionScopeForSendgridEvent({
      event: "bounce",
      type: "blocked",
    }),
    { sender: true, global: false }
  );
  assert.deepEqual(
    referralSuppressionScopeForSendgridEvent({
      event: "bounce",
      type: "bounce",
    }),
    { sender: true, global: true }
  );
  assert.deepEqual(
    referralSuppressionScopeForSendgridEvent({
      event: "dropped",
    }),
    { sender: true, global: false }
  );
  assert.deepEqual(
    referralSuppressionScopeForSendgridEvent({
      event: "spamreport",
    }),
    { sender: true, global: true }
  );
});
