import axios from "axios";
import { redis } from "../config/redis.js"; // assumes you have a redis config; adjust if yours differs

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// Twilio Pricing API base
const BASE = "https://pricing.twilio.com/v1/Messaging/Countries";

// cache TTL seconds
const TTL = 3600;

function authHeader() {
  const b64 = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
  return { Authorization: `Basic ${b64}` };
}

/**
 * Returns unit price per SMS segment in USD for a destination country.
 * NOTE: This is destination pricing; carrier price can vary but this is the correct preflight.
 */
export async function getTwilioSmsUnitPriceUSD(countryCode) {
  const key = `twilio:pricing:sms:${countryCode}`;
  const cached = await redis.get(key);
  if (cached) return Number(cached);

  const url = `${BASE}/${encodeURIComponent(countryCode)}`;
  const res = await axios.get(url, { headers: authHeader() });

  // Twilio response: look for outbound sms prices
  // Structure can vary slightly; keep robust:
  const prices = res.data?.outbound_sms_prices || res.data?.outbound_sms_price || res.data?.outbound_sms_prices;
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new Error(`Twilio pricing missing outbound_sms_prices for ${countryCode}`);
  }

  // Prefer "carrier" null / generic price if present
  const unit = Number(prices[0]?.prices?.[0]?.current_price ?? prices[0]?.current_price ?? prices[0]?.price);
  if (!Number.isFinite(unit)) {
    throw new Error(`Twilio pricing parse failed for ${countryCode}`);
  }

  await redis.setex(key, TTL, String(unit));
  return unit;
}
