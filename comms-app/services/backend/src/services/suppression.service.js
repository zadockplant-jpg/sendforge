import crypto from "crypto";
import { db } from "../config/db.js";

const GLOBAL_REFERRAL_SUPPRESSION_USER_ID =
  "00000000-0000-0000-0000-000000000000";

function normDestination(dest) {
  return String(dest || "").trim().toLowerCase();
}

export async function isSuppressed({ userId, channel, destination }) {
  const dest = normDestination(destination);
  if (!dest) return true; // treat empty as "blocked"
  const row = await db("suppressions").where({
    user_id: userId,
    channel,
    destination: dest,
  }).first();
  return !!row;
}

export async function addSuppression({ userId, channel, destination, reason }) {
  const dest = normDestination(destination);
  if (!dest) return;

  await db("suppressions")
    .insert({
      id: crypto.randomUUID(),
      user_id: userId,
      channel,
      destination: dest,
      reason: reason || "",
    })
    .onConflict(["user_id", "channel", "destination"])
    .merge({ reason: reason || "" });
}

export async function isReferralDestinationSuppressed(destination) {
  return isSuppressed({
    userId: GLOBAL_REFERRAL_SUPPRESSION_USER_ID,
    channel: "email",
    destination,
  });
}

export async function addReferralDestinationSuppression({
  destination,
  reason,
}) {
  return addSuppression({
    userId: GLOBAL_REFERRAL_SUPPRESSION_USER_ID,
    channel: "email",
    destination,
    reason,
  });
}

export async function createEmailUnsubscribeToken({
  userId,
  destination,
  trx = db,
}) {
  const normalizedDestination = normDestination(destination);
  if (!userId || !normalizedDestination) {
    throw new Error("invalid_unsubscribe_token_input");
  }

  const existing = await trx("unsubscribe_tokens")
    .select("token")
    .where({
      user_id: userId,
      channel: "email",
      destination: normalizedDestination,
    })
    .orderBy("created_at", "desc")
    .first();
  if (existing?.token) return existing.token;

  const token = crypto.randomUUID();
  await trx("unsubscribe_tokens").insert({
    id: crypto.randomUUID(),
    user_id: userId,
    channel: "email",
    destination: normalizedDestination,
    token,
  });
  return token;
}
