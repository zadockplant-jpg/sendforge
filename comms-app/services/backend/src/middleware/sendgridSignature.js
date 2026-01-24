import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

function b64ToUint8(b64) {
  return naclUtil.decodeBase64(b64);
}

// SendGrid signs: signature over (timestamp + rawBody) using Ed25519.
// Headers: X-Twilio-Email-Event-Webhook-Signature, X-Twilio-Email-Event-Webhook-Timestamp
export function verifySendgridSignature(req, res, next) {
  const sigB64 = req.header("X-Twilio-Email-Event-Webhook-Signature");
  const ts = req.header("X-Twilio-Email-Event-Webhook-Timestamp");
  if (!sigB64 || !ts) return res.status(401).json({ error: "missing_sendgrid_signature_headers" });

  const pubB64 = process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY_BASE64;
  if (!pubB64) return res.status(500).json({ error: "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY_BASE64 missing" });

  const raw = req.rawBody; // must exist (app.js verify hook)
  if (!raw) return res.status(500).json({ error: "rawBody missing (check app.js json verify)" });

  const msg = Buffer.concat([Buffer.from(ts, "utf8"), Buffer.from(raw)]);
  const sig = b64ToUint8(sigB64);
  const pub = b64ToUint8(pubB64);

  const ok = nacl.sign.detached.verify(new Uint8Array(msg), sig, pub);
  if (!ok) return res.status(401).json({ error: "invalid_sendgrid_signature" });

  next();
}
