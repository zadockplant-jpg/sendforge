import { parsePhoneNumberFromString } from "libphonenumber-js";

// Add libphonenumber-js dependency if you don't have it:
// npm i libphonenumber-js

export function parseE164CountryCode(e164) {
  try {
    const p = parsePhoneNumberFromString(e164);
    if (!p || !p.isValid()) return null;
    return p.country; // e.g. 'US', 'CA', 'GB'
  } catch {
    return null;
  }
}
