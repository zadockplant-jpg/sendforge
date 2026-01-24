import { db } from "../../config/db.js";
import { logMessageEvent } from "../../services/audit.service.js";
import { incrementUsage } from "../../services/entitlement.service.js";


// NOTE: Provider sending comes in Bundle 2.
// For now, we simulate “sent” so you can test end-to-end.
export async function sendOneProcessor(job) {
  const { blastRecipientId } = job.data;

  const br = await db("blast_recipients").where({ id: blastRecipientId }).first();
  if (!br) return;

  // Mark sending
  await db("blast_recipients").where({ id: br.id }).update({ status: "queued", updated_at: db.fn.now() });
  await logMessageEvent({
    userId: br.user_id,
    blastId: br.blast_id,
    blastRecipientId: br.id,
    eventType: "sending",
    payload: {},
  });

  await incrementUsage(br.user_id, blast.channel, 1);

  // Simulate delay
  await new Promise((r) => setTimeout(r, 150));

  // Mark sent (placeholder)
  await db("blast_recipients").where({ id: br.id }).update({ status: "sent", updated_at: db.fn.now() });
  await logMessageEvent({
    userId: br.user_id,
    blastId: br.blast_id,
    blastRecipientId: br.id,
    eventType: "sent",
    payload: { simulated: true },
  });

  return { ok: true };
}
