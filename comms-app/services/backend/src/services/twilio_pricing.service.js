// services/backend/src/services/twilio_pricing.service.js
import axios from "axios";

// NOTE: if you have redis, you can cache results.
// This version is “no-cache” to compile everywhere first.

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;

const BASE = "https://pricing.twilio.com/v1/Messaging/Countries";

function authHeader() {
  const b64 = Buffer.from(`${SID}:${TOKEN}`).toString("base64");
  return { Authorization: `Basic ${b64}` };
}

// Returns USD per segment (approx) for outbound SMS to that country
export async function getTwilioSmsUnitPriceUSD(countryCode) {
  const url = `${BASE}/${encodeURIComponent(countryCode)}`;
  const res = await axios.get(url, { headers: authHeader() });

  const prices = res.data?.outbound_sms_prices;
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new Error(`Twilio pricing missing outbound_sms_prices for ${countryCode}`);
  }

  // Take first available price. (Good enough for preflight guardrails.)
  const raw = prices[0]?.prices?.[0]?.current_price ?? prices[0]?.current_price;
  const unit = Number(raw);
  if (!Number.isFinite(unit)) throw new Error(`Twilio pricing parse failed for ${countryCode}`);

  return unit;
}
