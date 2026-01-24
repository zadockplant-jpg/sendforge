import twilio from "twilio";
import { env } from "../config/env.js";

// Verifies X-Twilio-Signature against full webhook URL + params
export function verifyTwilioSignature(req, res, next) {
  const sig = req.header("X-Twilio-Signature");
  if (!sig) return res.status(401).json({ error: "missing_twilio_signature" });

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return res.status(500).json({ error: "TWILIO_AUTH_TOKEN missing" });

  // Twilio signs the full URL that Twilio hits (must match PUBLIC_BASE_URL in prod)
  const base = process.env.PUBLIC_BASE_URL || env.publicBaseUrl;
  const url = `${base}${req.originalUrl}`;

  const params = req.body || {};
  const ok = twilio.validateRequest(authToken, sig, url, params);

  if (!ok) return res.status(401).json({ error: "invalid_twilio_signature" });
  next();
}
