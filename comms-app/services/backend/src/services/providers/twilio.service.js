import twilio from "twilio";

let client;
function getClient() {
  if (client) return client;
  client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client;
}

export async function sendSms({ to, body, statusCallbackUrl }) {
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) throw new Error("TWILIO_FROM_NUMBER missing");

  const msg = await getClient().messages.create({
    to,
    from,
    body,
    statusCallback: statusCallbackUrl || undefined,
  });

  return { providerMessageId: msg.sid };
}
