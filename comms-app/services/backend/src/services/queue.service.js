// TEMP MVP queue stub
// This will later be replaced by Bull / Redis / worker

export async function enqueueBlast({ userId, recipients, body }) {
  // For now, just log and return a fake ID
  console.log("[QUEUE] Blast queued", {
    userId,
    recipientCount: recipients.length,
  });

  return `blast_${Date.now()}`;
}

