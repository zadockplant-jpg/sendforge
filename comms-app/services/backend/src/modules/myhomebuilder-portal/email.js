import { billingLineItems, quantityText } from "./billing.js";
import { escapeHtml, formatDate, money } from "./format.js";

export const ADMIN_EMAIL = "mb@myhomebuilderllc.com";
const DEFAULT_FROM = "My Home Builder Client Portal <billing@myhomebuilderllc.com>";
const DEFAULT_CLIENT_FROM = "My Home Builder LLC <billing@myhomebuilderllc.com>";
const SENDGRID_SEND_URL = "https://api.sendgrid.com/v3/mail/send";
const SENDGRID_RETRY_DELAY_MS = 300;
const EMAIL_PATTERN = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]{2,}$/u;

export function isValidEmail(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL_PATTERN.test(value);
}

export function emailConfigured(env) {
  return typeof env.SENDGRID_API_KEY === "string" && env.SENDGRID_API_KEY.length > 0;
}

export function adminEmail(env) {
  return env.ADMIN_EMAIL || ADMIN_EMAIL;
}

// Client-facing mail is signed by the business and replies go to the builder's inbox.
export function clientSender(env) {
  return { from: env.EMAIL_CLIENT_FROM || env.EMAIL_FROM || DEFAULT_CLIENT_FROM, replyTo: env.EMAIL_REPLY_TO || adminEmail(env) };
}

// "Name <address>" or a bare address, as SendGrid's { email, name } object.
function mailbox(value) {
  const match = String(value).match(/^\s*"?([^"<>]*?)"?\s*<([^<>\s]+)>\s*$/u);
  if (!match) return { email: String(value).trim() };
  return match[1] ? { email: match[2], name: match[1] } : { email: match[2] };
}

// SendGrid queues a message when it answers 202. Rate limits and server errors get one retry;
// a network error does not, because SendGrid may already have accepted the message.
export async function sendEmail(env, { to, subject, text, html, from, replyTo, category = "portal" }) {
  if (!emailConfigured(env)) return { ok: false, reason: "email-not-configured" };

  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: mailbox(from || env.EMAIL_FROM || DEFAULT_FROM),
    subject: subject.replaceAll(/[\r\n]+/gu, " "),
    content: [{ type: "text/plain", value: text }, ...(html ? [{ type: "text/html", value: html }] : [])],
    categories: ["myhomebuilder-portal", category],
    // Pay and invoice links carry private tokens, so SendGrid must not rewrite or track them.
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false }
    }
  };
  if (replyTo) body.reply_to = mailbox(replyTo);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response;
    try {
      response = await fetch(SENDGRID_SEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (error) {
      console.error(JSON.stringify({ message: "email delivery failed", category, error: error instanceof Error ? error.message : "Unknown error" }));
      return { ok: false, reason: "email-delivery-failed" };
    }
    if (response.status === 202) return { ok: true, id: response.headers.get("X-Message-Id") || "" };

    const detail = await response.text().catch(() => "");
    if (attempt === 1 && (response.status === 429 || response.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, SENDGRID_RETRY_DELAY_MS));
      continue;
    }
    console.error(JSON.stringify({ message: "email delivery failed", category, status: response.status, detail: detail.slice(0, 300) }));
    return { ok: false, reason: "email-delivery-failed", status: response.status };
  }
  return { ok: false, reason: "email-delivery-failed" };
}

export function adminCodeMessage(code, requestedFrom) {
  return {
    subject: `${code} is your My Home Builder admin code`,
    text: [
      "A request to open the client portal admin panel was made.",
      "",
      `Verification code: ${code}`,
      "",
      "The code expires in 10 minutes and can be used once.",
      requestedFrom ? `Request origin: ${requestedFrom}` : "",
      "",
      "If you did not request this, you can ignore this message."
    ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n")
  };
}

// ---------- HTML building blocks (inline styles only; mail clients drop stylesheets) ----------

const FONT = "font-family:Arial,Helvetica,sans-serif;";
const SERIF = "font-family:Georgia,'Times New Roman',serif;";

function paragraph(html, extra = "") {
  return `<p style="margin:0 0 16px;${FONT}font-size:15px;line-height:1.6;color:#111111;${extra}">${html}</p>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 10px;"><tr>
<td bgcolor="#00212b" style="background:#00212b;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:15px 28px;${FONT}font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a></td>
</tr></table>`;
}

function textLink(href, label) {
  return `<a href="${escapeHtml(href)}" style="color:#085858;font-weight:bold;">${escapeHtml(label)}</a>`;
}

function facts(rows) {
  const cells = rows.filter(([, value]) => value).map(([label, value]) => `<tr>
<td style="padding:9px 0;border-bottom:1px solid #e6e6e6;${FONT}font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#555555;width:40%;">${escapeHtml(label)}</td>
<td style="padding:9px 0;border-bottom:1px solid #e6e6e6;${FONT}font-size:15px;color:#111111;text-align:right;">${escapeHtml(value)}</td>
</tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 6px;">${cells}</table>`;
}

function linesTable(item, totalLabel) {
  const rows = billingLineItems(item).map((line) => {
    const detail = line.quantity === 1 ? "" : `<br><span style="font-size:12px;color:#555555;">${escapeHtml(quantityText(line.quantity))} × ${money(line.unitCents, item.currency)}</span>`;
    return `<tr>
<td style="padding:10px 0;border-bottom:1px solid #e6e6e6;${FONT}font-size:14px;line-height:1.45;color:#111111;">${escapeHtml(line.description)}${detail}</td>
<td style="padding:10px 0 10px 16px;border-bottom:1px solid #e6e6e6;${FONT}font-size:14px;color:#111111;text-align:right;white-space:nowrap;vertical-align:top;">${money(line.amountCents, item.currency)}</td>
</tr>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 6px;">
<tr><td colspan="2" style="padding:0 0 8px;border-bottom:2px solid #111111;${FONT}font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#555555;">Items</td></tr>
${rows}
<tr>
<td style="padding:14px 0 0;${FONT}font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#111111;">${escapeHtml(totalLabel)}</td>
<td style="padding:14px 0 0 16px;${FONT}font-size:18px;font-weight:bold;color:#085858;text-align:right;white-space:nowrap;">${money(item.amountCents, item.currency)}</td>
</tr>
</table>`;
}

function notesBlock(item) {
  if (!item.description) return "";
  return `<div style="margin:24px 0 0;padding:16px 18px;background:#f2f2f2;${FONT}font-size:14px;line-height:1.6;color:#111111;">
<span style="display:block;margin-bottom:6px;font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#555555;">Notes and terms</span>
${escapeHtml(item.description).replaceAll("\n", "<br>")}
</div>`;
}

function layout({ title, preheader, kicker, heading, body, forClient = true }) {
  const footer = forClient
    ? `My Home Builder LLC · Muskegon, Michigan · <a href="https://myhomebuilderllc.com" style="color:#555555;">myhomebuilderllc.com</a><br>Questions? Reply to this email.`
    : "Sent by the My Home Builder client portal.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f2f2f2;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f2f2f2" style="background:#f2f2f2;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #dddddd;">
<tr><td bgcolor="#00212b" style="background:#00212b;padding:22px 32px;">
<span style="${FONT}font-size:15px;font-weight:bold;letter-spacing:3px;color:#ffffff;">MY HOME BUILDER</span><br>
<span style="${FONT}font-size:11px;letter-spacing:2px;color:#67e8f9;">MUSKEGON, MICHIGAN</span>
</td></tr>
<tr><td style="padding:34px 32px 30px;">
<p style="margin:0 0 10px;${FONT}font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#085858;">${escapeHtml(kicker)}</p>
<h1 style="margin:0 0 18px;${SERIF}font-size:28px;line-height:1.2;font-weight:normal;color:#111111;">${escapeHtml(heading)}</h1>
${body}
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #e6e6e6;${FONT}font-size:12px;line-height:1.6;color:#555555;">${footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function textLines(item, totalLabel) {
  const lines = billingLineItems(item).map((line) => {
    const detail = line.quantity === 1 ? "" : ` (${quantityText(line.quantity)} × ${money(line.unitCents, item.currency)})`;
    return `- ${line.description}${detail}: ${money(line.amountCents, item.currency)}`;
  });
  return [...lines, `${totalLabel}: ${money(item.amountCents, item.currency)}`];
}

function joinText(lines) {
  return lines.filter((line) => line !== null && line !== undefined).join("\n").replaceAll(/\n{3,}/gu, "\n\n");
}

// ---------- Messages ----------

export function billingIssuedMessage({ item, client, viewUrl, payUrl }) {
  const total = money(item.amountCents, item.currency);
  const due = formatDate(item.dueDate);
  if (item.kind === "invoice") {
    const body = [
      paragraph("Here is your invoice from My Home Builder LLC."),
      facts([["Invoice", item.number], ["Project", client.name], ["Amount due", total], ["Due", due]]),
      payUrl ? button(payUrl, `Pay ${total}`) : button(viewUrl, "View the invoice"),
      payUrl ? paragraph(`${textLink(viewUrl, "View the invoice")} &nbsp;·&nbsp; Payments are processed securely by Stripe.`, "font-size:13px;color:#555555;") : "",
      linesTable(item, "Amount due"),
      notesBlock(item)
    ].join("\n");
    return {
      subject: `Invoice ${item.number} from My Home Builder LLC`,
      html: layout({ title: `Invoice ${item.number}`, preheader: `${total} due${due ? ` ${due}` : ""} · ${item.title}`, kicker: `Invoice ${item.number}`, heading: item.title, body }),
      text: joinText([
        "Here is your invoice from My Home Builder LLC.",
        "",
        `Invoice: ${item.number}`,
        `Project: ${client.name}`,
        `Title: ${item.title}`,
        `Amount due: ${total}`,
        due ? `Due: ${due}` : null,
        "",
        ...textLines(item, "Amount due"),
        "",
        payUrl ? `Pay online: ${payUrl}` : null,
        `View the invoice: ${viewUrl}`,
        item.description ? `\nNotes and terms:\n${item.description}` : null,
        "",
        "Questions? Reply to this email.",
        "My Home Builder LLC · Muskegon, Michigan"
      ])
    };
  }

  const body = [
    paragraph("My Home Builder LLC prepared a quote for you to review."),
    facts([["Quote", item.number], ["Project", client.name], ["Quote total", total], ["Valid until", due]]),
    button(viewUrl, "Review the quote"),
    paragraph("You can accept the quote online when you are ready to move forward.", "font-size:13px;color:#555555;"),
    linesTable(item, "Quote total"),
    notesBlock(item)
  ].join("\n");
  return {
    subject: `Quote ${item.number} from My Home Builder LLC`,
    html: layout({ title: `Quote ${item.number}`, preheader: `${total} · ${item.title}`, kicker: `Quote ${item.number}`, heading: item.title, body }),
    text: joinText([
      "My Home Builder LLC prepared a quote for you to review.",
      "",
      `Quote: ${item.number}`,
      `Project: ${client.name}`,
      `Title: ${item.title}`,
      `Quote total: ${total}`,
      due ? `Valid until: ${due}` : null,
      "",
      ...textLines(item, "Quote total"),
      "",
      `Review and accept the quote: ${viewUrl}`,
      item.description ? `\nNotes and terms:\n${item.description}` : null,
      "",
      "Questions? Reply to this email.",
      "My Home Builder LLC · Muskegon, Michigan"
    ])
  };
}

export function paymentReceiptMessage({ item, client, viewUrl }) {
  const payment = item.payment || {};
  const paid = money(payment.amountCents ?? item.amountCents, item.currency);
  const paidOn = formatDate(item.paidAt);
  const method = payment.label || "";
  const body = [
    paragraph(`My Home Builder LLC received your payment for <strong>${escapeHtml(item.title)}</strong>. Thank you.`),
    facts([["Amount paid", paid], ["Paid on", paidOn], ["Payment method", method], ["Invoice", item.number], ["Project", client.name]]),
    linesTable(item, "Invoice total"),
    button(viewUrl, "View the paid invoice"),
    payment.receiptUrl ? paragraph(textLink(payment.receiptUrl, "View the Stripe payment receipt"), "font-size:13px;color:#555555;") : "",
    paragraph("Keep this email for your records.", "font-size:13px;color:#555555;")
  ].join("\n");
  return {
    subject: `Receipt for invoice ${item.number} from My Home Builder LLC`,
    html: layout({ title: `Receipt for ${item.number}`, preheader: `${paid} received${paidOn ? ` on ${paidOn}` : ""}. Thank you.`, kicker: `Receipt · Invoice ${item.number}`, heading: "Thank you for your payment.", body }),
    text: joinText([
      `My Home Builder LLC received your payment for ${item.title}. Thank you.`,
      "",
      `Amount paid: ${paid}`,
      paidOn ? `Paid on: ${paidOn}` : null,
      method ? `Payment method: ${method}` : null,
      `Invoice: ${item.number}`,
      `Project: ${client.name}`,
      "",
      ...textLines(item, "Invoice total"),
      "",
      `View the paid invoice: ${viewUrl}`,
      payment.receiptUrl ? `Stripe receipt: ${payment.receiptUrl}` : null,
      "",
      "Keep this email for your records. Questions? Reply to this email.",
      "My Home Builder LLC · Muskegon, Michigan"
    ])
  };
}

export function adminPaidMessage({ item, client, adminUrl, receiptTo }) {
  const payment = item.payment || {};
  const paid = money(payment.amountCents ?? item.amountCents, item.currency);
  const mismatch = Number.isInteger(payment.amountCents) && payment.amountCents !== item.amountCents
    ? `The amount paid differs from the current invoice total of ${money(item.amountCents, item.currency)}.`
    : "";
  const receiptLine = receiptTo ? `Receipt emailed to ${receiptTo}.` : "No client email is on file, so no receipt was emailed. Add one on the client panel and use Resend receipt.";
  const body = [
    paragraph(`${escapeHtml(client.name)} paid <strong>${escapeHtml(item.number)} · ${escapeHtml(item.title)}</strong>.`),
    facts([["Amount paid", paid], ["Paid on", formatDate(item.paidAt)], ["Payment method", payment.label || ""], ["Client", client.name]]),
    mismatch ? paragraph(escapeHtml(mismatch), "color:#085858;font-weight:bold;") : "",
    paragraph(escapeHtml(receiptLine), "font-size:13px;color:#555555;"),
    button(adminUrl, "Open in the admin panel")
  ].join("\n");
  return {
    subject: `${item.number} paid: ${paid} from ${client.name}`,
    html: layout({ title: `${item.number} paid`, preheader: `${paid} from ${client.name}`, kicker: "Payment received", heading: `${item.number} is paid.`, body, forClient: false }),
    text: joinText([
      `${client.name} paid ${item.number} · ${item.title}.`,
      "",
      `Amount paid: ${paid}`,
      `Paid on: ${formatDate(item.paidAt)}`,
      payment.label ? `Payment method: ${payment.label}` : null,
      mismatch || null,
      receiptLine,
      "",
      `Admin panel: ${adminUrl}`
    ])
  };
}

export function quoteAcceptedMessage({ item, client, adminUrl }) {
  const total = money(item.amountCents, item.currency);
  const by = item.acceptedBy ? `${item.acceptedBy} (${client.name})` : client.name;
  const body = [
    paragraph(`${escapeHtml(by)} accepted <strong>${escapeHtml(item.number)} · ${escapeHtml(item.title)}</strong>.`),
    facts([["Quote total", total], ["Accepted on", formatDate(item.acceptedAt)], ["Accepted by", item.acceptedBy || ""], ["Client", client.name]]),
    paragraph("Open the quote in the admin panel to create the invoice from it.", "font-size:13px;color:#555555;"),
    button(adminUrl, "Open the quote")
  ].join("\n");
  return {
    subject: `${item.number} accepted by ${client.name}`,
    html: layout({ title: `${item.number} accepted`, preheader: `${total} · ${item.title}`, kicker: "Quote accepted", heading: `${item.number} was accepted.`, body, forClient: false }),
    text: joinText([
      `${by} accepted ${item.number} · ${item.title}.`,
      "",
      `Quote total: ${total}`,
      `Accepted on: ${formatDate(item.acceptedAt)}`,
      "",
      "Open the quote in the admin panel to create the invoice from it:",
      adminUrl
    ])
  };
}

export function duplicatePaymentMessage({ item, client, session, adminUrl }) {
  const amount = money(Number.isInteger(session.amount_total) ? session.amount_total : item.amountCents, item.currency);
  const reference = session.payment_intent ? String(session.payment_intent) : String(session.id || "");
  const body = [
    paragraph(`Stripe received another payment of <strong>${escapeHtml(amount)}</strong> from ${escapeHtml(client.name)} for <strong>${escapeHtml(item.number)} · ${escapeHtml(item.title)}</strong>, which was already marked paid.`),
    paragraph(`Check the Stripe dashboard for payment ${escapeHtml(reference)} and refund it if it is a duplicate.`, "font-size:13px;color:#555555;"),
    button(adminUrl, "Open the invoice")
  ].join("\n");
  return {
    subject: `Check for a duplicate payment on ${item.number}`,
    html: layout({ title: `Duplicate payment on ${item.number}`, preheader: `${amount} from ${client.name}`, kicker: "Duplicate payment", heading: `${item.number} was paid again.`, body, forClient: false }),
    text: joinText([
      `Stripe received another payment of ${amount} from ${client.name} for ${item.number} · ${item.title}, which was already marked paid.`,
      `Check the Stripe dashboard for payment ${reference} and refund it if it is a duplicate.`,
      "",
      `Admin panel: ${adminUrl}`
    ])
  };
}

export function paymentFailedMessage({ item, client, adminUrl }) {
  const body = [
    paragraph(`The bank payment from ${escapeHtml(client.name)} for <strong>${escapeHtml(item.number)} · ${escapeHtml(item.title)}</strong> did not go through.`),
    paragraph("The invoice is open again, so the client can pay with another method from the same link.", "font-size:13px;color:#555555;"),
    button(adminUrl, "Open the invoice")
  ].join("\n");
  return {
    subject: `Bank payment failed for ${item.number}`,
    html: layout({ title: `Payment failed for ${item.number}`, preheader: `${client.name} · ${money(item.amountCents, item.currency)}`, kicker: "Payment failed", heading: `${item.number} is unpaid.`, body, forClient: false }),
    text: joinText([
      `The bank payment from ${client.name} for ${item.number} · ${item.title} did not go through.`,
      "The invoice is open again, so the client can pay with another method from the same link.",
      "",
      `Admin panel: ${adminUrl}`
    ])
  };
}
