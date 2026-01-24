import crypto from "crypto";
import { db } from "../config/db.js";

export async function upsertThread({ userId, channel, peer, title = "" }) {
  const existing = await db("threads").where({ user_id: userId, channel, peer }).first();
  if (existing) return existing;

  const id = crypto.randomUUID();
  const [row] = await db("threads")
    .insert({
      id,
      user_id: userId,
      channel,
      peer,
      title,
      last_message_at: db.fn.now(),
    })
    .returning("*");
  return row;
}

export async function insertMessage({
  userId,
  threadId,
  direction,
  channel,
  from,
  to,
  body,
  provider,
  providerMessageId = "",
}) {
  const id = crypto.randomUUID();
  await db("messages").insert({
    id,
    user_id: userId,
    thread_id: threadId,
    direction,
    channel,
    from,
    to,
    body,
    provider,
    provider_message_id: providerMessageId,
  });

  await db("threads").where({ id: threadId }).update({ last_message_at: db.fn.now() });

  return id;
}
