// services/backend/src/services/phone_country.service.js
import { parsePhoneNumberFromString } from "libphonenumber-js";

export function parseE164CountryCode(e164) {
  try {
    const p = parsePhoneNumberFromString(String(e164 || ""));
    if (!p || !p.isValid()) return null;
    return p.country; // e.g. 'US', 'GB'
  } catch {
    return null;
  }
}
