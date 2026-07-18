import { db } from "../config/db.js";

const EVENT_TO_STATUS = Object.freeze({
  processed: "processed",
  deferred: "deferred",
  delivered: "delivered",
  bounce: "bounced",
  dropped: "dropped",
  spamreport: "spamreport",
  unsubscribe: "unsubscribed",
  group_unsubscribe: "unsubscribed",
});

const STATUS_RANK = Object.freeze({
  pending: 0,
  send_error: 1,
  not_configured: 1,
  accepted: 2,
  processed: 3,
  deferred: 4,
  delivered: 5,
  bounced: 6,
  dropped: 6,
  spamreport: 7,
  unsubscribed: 7,
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const REFERRAL_INVITE_AMBIGUITY_COOLDOWN_MS =
  15 * 60 * 1000;
export const REFERRAL_INVITE_DELIVERY_COOLDOWN_MS =
  24 * 60 * 60 * 1000;
const COOLDOWN_DELIVERY_STATUSES = new Set([
  "accepted",
  "processed",
  "deferred",
  "delivered",
  "bounced",
  "dropped",
  "spamreport",
  "unsubscribed",
]);

function cleanProviderText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function deliveryMetadata(row) {
  const metadata =
    row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const emailDelivery =
    metadata.email_delivery && typeof metadata.email_delivery === "object"
      ? metadata.email_delivery
      : {};
  return { metadata, emailDelivery };
}

export function sendgridCustomArg(event, key) {
  if (!event || !key) return "";
  const direct = event[key];
  if (direct !== undefined && direct !== null) return String(direct);
  const nested = event.unique_args?.[key] ?? event.custom_args?.[key];
  return nested === undefined || nested === null ? "" : String(nested);
}

export function referralDeliveryStatusForSendgridEvent(eventType) {
  return EVENT_TO_STATUS[String(eventType || "").toLowerCase()] || null;
}

export function referralSuppressionScopeForSendgridEvent(event) {
  const eventType = String(event?.event || "").toLowerCase();
  const bounceType = String(event?.type || "").toLowerCase();
  return {
    sender: [
      "bounce",
      "dropped",
      "spamreport",
      "unsubscribe",
      "group_unsubscribe",
    ].includes(eventType),
    global:
      ["spamreport", "unsubscribe", "group_unsubscribe"].includes(
        eventType
      ) ||
      (eventType === "bounce" && bounceType === "bounce"),
  };
}

export function isUuidValue(value) {
  return UUID_PATTERN.test(String(value || "").trim());
}

export function referralInviteCooldownRemainingMs(
  row,
  nowMs = Date.now()
) {
  if (!row || ["cancelled", "expired"].includes(row.status)) return 0;
  const createdAt = new Date(row.created_at).getTime();
  if (!Number.isFinite(createdAt)) return 0;

  const deliveryStatus = String(
    row.metadata?.email_delivery?.status || ""
  );
  const hasDeliveryCooldown =
    ["sent", "claimed"].includes(row.status) ||
    COOLDOWN_DELIVERY_STATUSES.has(deliveryStatus);
  const cooldownMs = hasDeliveryCooldown
    ? REFERRAL_INVITE_DELIVERY_COOLDOWN_MS
    : REFERRAL_INVITE_AMBIGUITY_COOLDOWN_MS;
  return Math.max(0, createdAt + cooldownMs - nowMs);
}

export function advanceEmailDeliveryStatus(currentStatus, candidateStatus) {
  const current = String(currentStatus || "pending");
  const candidate = String(candidateStatus || "");
  if (
    !candidate ||
    !Object.prototype.hasOwnProperty.call(STATUS_RANK, candidate)
  ) {
    return current;
  }
  const currentRank = STATUS_RANK[current] ?? 0;
  const candidateRank = STATUS_RANK[candidate];
  return candidateRank >= currentRank ? candidate : current;
}

export async function markReferralInviteEmailAccepted({
  referralEventId,
  sendResult,
  trx = null,
  database = db,
}) {
  const updateLockedRow = async (connection) => {
    const row = await connection("referral_events")
      .where({ id: referralEventId, event_type: "invite" })
      .forUpdate()
      .first();
    if (!row) return null;

    const { metadata, emailDelivery } = deliveryMetadata(row);
    const candidateStatus =
      sendResult?.mode === "sendgrid" ? "accepted" : "not_configured";
    const status = advanceEmailDeliveryStatus(
      emailDelivery.status,
      candidateStatus
    );
    const now = new Date().toISOString();
    const [updated] = await connection("referral_events")
      .where({ id: row.id })
      .update({
        metadata: {
          ...metadata,
          email_delivery: {
            ...emailDelivery,
            provider: "sendgrid",
            status,
            mail_send_message_id:
              sendResult?.messageId ||
              emailDelivery.mail_send_message_id ||
              null,
            accepted_at:
              candidateStatus === "accepted"
                ? emailDelivery.accepted_at || now
                : emailDelivery.accepted_at || null,
            updated_at: now,
          },
        },
        updated_at: connection.fn.now(),
      })
      .returning("*");
    return updated || null;
  };

  return trx
    ? updateLockedRow(trx)
    : database.transaction(updateLockedRow);
}

export async function markReferralInviteEmailFailed({
  referralEventId,
  error,
  trx = null,
  database = db,
}) {
  const updateLockedRow = async (connection) => {
    const row = await connection("referral_events")
      .where({ id: referralEventId, event_type: "invite" })
      .forUpdate()
      .first();
    if (!row) return null;

    const { metadata, emailDelivery } = deliveryMetadata(row);
    const now = new Date().toISOString();
    const candidateStatus =
      error?.code === "email_not_configured"
        ? "not_configured"
        : "send_error";
    const [updated] = await connection("referral_events")
      .where({ id: row.id })
      .update({
        metadata: {
          ...metadata,
          email_delivery: {
            ...emailDelivery,
            provider: "sendgrid",
            // A network error can be ambiguous: a later signed webhook is
            // allowed to advance this state to processed or delivered.
            status: advanceEmailDeliveryStatus(
              emailDelivery.status,
              candidateStatus
            ),
            transport_error_code: cleanProviderText(
              error?.code || "email_send_failed",
              100
            ),
            transport_error_at: now,
            updated_at: now,
          },
        },
        updated_at: connection.fn.now(),
      })
      .returning("*");
    return updated || null;
  };

  return trx
    ? updateLockedRow(trx)
    : database.transaction(updateLockedRow);
}

export async function applyReferralInviteSendgridEvent(
  event,
  database = db
) {
  const kind = sendgridCustomArg(event, "sf_message_kind");
  const referralEventId = sendgridCustomArg(event, "sf_message_ref");
  if (kind !== "referral-invite" || !referralEventId) {
    return { handled: false };
  }
  if (!isUuidValue(referralEventId)) {
    return {
      handled: false,
      unmatched: true,
      invalidRef: true,
      referralEventId,
    };
  }

  return database.transaction(async (trx) => {
    const row = await trx("referral_events")
      .where({ id: referralEventId, event_type: "invite" })
      .forUpdate()
      .first();
    if (!row) return { handled: false, unmatched: true, referralEventId };

    const { metadata, emailDelivery } = deliveryMetadata(row);
    const sendgridEventId = cleanProviderText(event.sg_event_id, 200);
    const eventType = cleanProviderText(event.event, 100).toLowerCase();
    const suppressionScope =
      referralSuppressionScopeForSendgridEvent(event);
    const seenEventIds = Array.isArray(emailDelivery.sendgrid_event_ids)
      ? emailDelivery.sendgrid_event_ids.map(String)
      : [];
    if (sendgridEventId && seenEventIds.includes(sendgridEventId)) {
      return {
        handled: true,
        duplicate: true,
        referralEventId,
        status: emailDelivery.status || "pending",
        eventType,
        shouldSuppress: suppressionScope.sender,
        shouldSuppressGlobally: suppressionScope.global,
        referrerUserId: row.referrer_user_id,
        recipientEmail: metadata.recipient_email || "",
      };
    }

    const candidateStatus = referralDeliveryStatusForSendgridEvent(eventType);
    const nextStatus = advanceEmailDeliveryStatus(
      emailDelivery.status,
      candidateStatus
    );
    const receivedAt = new Date().toISOString();
    const timestampValue = Number(event.timestamp);
    const timestampDate =
      String(event.timestamp ?? "").trim() &&
      Number.isFinite(timestampValue) &&
      timestampValue > 0
        ? new Date(timestampValue * 1000)
        : null;
    const eventAt =
      timestampDate && Number.isFinite(timestampDate.getTime())
        ? timestampDate.toISOString()
        : receivedAt;
    const reason = cleanProviderText(event.reason);
    const response = cleanProviderText(event.response);
    const nextDelivery = {
      ...emailDelivery,
      provider: "sendgrid",
      status: nextStatus,
      provider_message_id:
        cleanProviderText(event.sg_message_id, 250) ||
        emailDelivery.provider_message_id ||
        null,
      last_event: eventType || emailDelivery.last_event || null,
      last_event_at: eventAt,
      ...(reason ? { reason } : {}),
      ...(response ? { response } : {}),
      sendgrid_event_ids: sendgridEventId
        ? [...seenEventIds, sendgridEventId].slice(-25)
        : seenEventIds,
      updated_at: receivedAt,
    };
    if (eventType === "delivered") nextDelivery.delivered_at = eventAt;
    if (["bounce", "dropped", "spamreport"].includes(eventType)) {
      nextDelivery.failed_at = eventAt;
    }
    if (["unsubscribe", "group_unsubscribe"].includes(eventType)) {
      nextDelivery.unsubscribed_at = eventAt;
    }

    await trx("referral_events")
      .where({ id: row.id })
      .update({
        metadata: { ...metadata, email_delivery: nextDelivery },
        updated_at: trx.fn.now(),
      });

    return {
      handled: true,
      duplicate: false,
      referralEventId,
      status: nextStatus,
      eventType,
      shouldSuppress: suppressionScope.sender,
      shouldSuppressGlobally: suppressionScope.global,
      referrerUserId: row.referrer_user_id,
      recipientEmail: metadata.recipient_email || "",
    };
  });
}
