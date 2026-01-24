import crypto from "crypto";
import { db } from "../config/db.js";

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
