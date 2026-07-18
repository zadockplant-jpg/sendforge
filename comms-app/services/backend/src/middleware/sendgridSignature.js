import crypto from "crypto";

function decodeBase64(value, label) {
  const normalized = String(value || "").replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error(`invalid_${label}`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (!decoded.length) throw new Error(`invalid_${label}`);
  return decoded;
}

export function loadSendgridPublicKey() {
  const configured =
    process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY ||
    process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY_BASE64 ||
    "";
  const value = configured.trim().replaceAll("\\n", "\n");
  if (!value) return null;

  if (value.includes("BEGIN PUBLIC KEY")) {
    return crypto.createPublicKey(value);
  }

  return crypto.createPublicKey({
    key: decodeBase64(value, "sendgrid_public_key"),
    format: "der",
    type: "spki",
  });
}

// SendGrid signs SHA-256(timestamp + exact raw request body) with a P-256
// ECDSA key. Do not parse/re-serialize req.body before this verification.
export function verifySendgridSignature(req, res, next) {
  const signatureValue = req.header(
    "X-Twilio-Email-Event-Webhook-Signature"
  );
  const timestamp = req.header(
    "X-Twilio-Email-Event-Webhook-Timestamp"
  );
  if (!signatureValue || !timestamp) {
    return res
      .status(401)
      .json({ error: "missing_sendgrid_signature_headers" });
  }

  if (!req.rawBody) {
    return res
      .status(500)
      .json({ error: "rawBody missing (check app.js json verify)" });
  }

  let publicKey;
  try {
    publicKey = loadSendgridPublicKey();
  } catch {
    return res
      .status(500)
      .json({ error: "invalid_sendgrid_webhook_public_key" });
  }
  if (!publicKey) {
    return res
      .status(500)
      .json({ error: "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY missing" });
  }

  try {
    const signature = decodeBase64(
      signatureValue,
      "sendgrid_signature"
    );
    const signedPayload = Buffer.concat([
      Buffer.from(timestamp, "utf8"),
      Buffer.from(req.rawBody),
    ]);
    const valid = crypto.verify(
      "sha256",
      signedPayload,
      publicKey,
      signature
    );
    if (!valid) {
      return res
        .status(401)
        .json({ error: "invalid_sendgrid_signature" });
    }
  } catch {
    return res
      .status(401)
      .json({ error: "invalid_sendgrid_signature" });
  }

  return next();
}
