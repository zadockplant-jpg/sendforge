import sgMail from "@sendgrid/mail";

let configured = false;
function ensure() {
  if (configured) return;
  if (!process.env.SENDGRID_API_KEY) throw new Error("SENDGRID_API_KEY missing");
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  configured = true;
}

export async function sendEmail({ to, subject, html, unsubscribeUrl }) {
  ensure();

  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  const fromName = process.env.SENDGRID_FROM_NAME || "Comms";
  if (!fromEmail) throw new Error("SENDGRID_FROM_EMAIL missing");

  const msg = {
    to,
    from: { email: fromEmail, name: fromName },
    subject,
    html,
    headers: {},
  };

  // Nice-to-have compliance headers (safe to keep)
  if (unsubscribeUrl) {
    msg.headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
    msg.headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const [resp] = await sgMail.send(msg);
  const providerMessageId = resp?.headers?.["x-message-id"] || "";
  return { providerMessageId };
}
