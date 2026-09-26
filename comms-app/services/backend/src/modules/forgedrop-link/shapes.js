/**
 * The shapes and limits of the phone-link signaling API. The contract is
 * ForgeDrop/docs/phone-link.md, "Signaling API (backend)"; the browser app and
 * the desktop app are built against it, so these numbers are theirs as much as
 * ours.
 */

export const LINK_LIMITS = Object.freeze({
  bodyBytes: 64 * 1024,
  dataBytes: 32 * 1024,
  mailboxMessages: 32,
  messageTtlMs: 60_000,
  maxWaitSeconds: 25,
  // A desktop long-polls for 25 s at a time, so 40 s is one full poll plus
  // time to open the next. Phones get longer: mobile browsers stall
  // background tabs and change networks under them.
  desktopOnlineMs: 40_000,
  phonePresentMs: 60_000,
  licenceCacheMs: 60_000,
  // A page makes a new clientId on every load, so one account's phone
  // addresses pile up until they lapse; this bounds them.
  phonesPerAccount: 32,
  sweepEveryMs: 15_000,
  rate: Object.freeze({
    signalPerMinute: 120,
    pollPerMinute: 60,
    desktopsPerMinute: 30,
  }),
});

// What each side may send: offers go phone to desktop, answers desktop to
// phone, and either side may say bye.
export const SENDABLE_TYPES = Object.freeze({
  phone: new Set(["offer", "bye"]),
  desktop: new Set(["answer", "bye"]),
});

// Between two desktops of one account (ForgeDrop 1.4, sending over the
// internet): one dials with its connection candidates, the other answers
// with its own, and either may say bye. The data is ForgeDrop's to read;
// here it is only relayed, like SDP.
export const DESKTOP_TO_DESKTOP_TYPES = new Set(["dial", "dial-answer", "bye"]);

// Codes (ForgeDrop 1.5, ForgeDrop/docs/codes.md): sending to someone who is
// not one of your own computers. codes.js holds the nameplates and sessions.
export const CODE_LIMITS = Object.freeze({
  // A code is open for an hour unless its sender asks otherwise; a day at most.
  defaultMinutes: 60,
  minMinutes: 1,
  maxMinutes: 1440,
  nameplatesPerDesktop: 4,
  // Once a code is claimed, its two computers have an hour and 64 messages
  // to finish. An exchange usually takes fewer than ten.
  sessionMs: 60 * 60_000,
  sessionMessages: 64,
  rate: Object.freeze({
    // Per desktop.
    codeOpenPerMinute: 20,
    // Per account, whichever of its desktops claims. Any claim of someone
    // else's code could be a guess at its words, so guessing costs.
    codeClaimPerMinute: 5,
    // Per account, the same allowance as /signal, counted apart from it.
    codeSignalPerMinute: LINK_LIMITS.rate.signalPerMinute,
  }),
});

// What the two computers of a code session say to each other: the PAKE and
// its proof, then a dial and its answer as between one's own computers
// (docs/internet.md), and bye. Either side may send any of them. Here they
// are only relayed; the apps check them, and a dial is signed with the pair
// key of the identities the PAKE vouched for.
export const CODE_TYPES = new Set(["pake", "proof", "dial", "dial-answer", "bye"]);

const NAMEPLATE = /^[0-9]{1,9}$/;
const CODE_SESSION = /^[A-Za-z0-9_-]{22}$/;

/** A nameplate, "7" or 7, as a number from 1; else null. "007" is 7. */
export function parseNameplate(value) {
  let text;
  if (typeof value === "string") text = value.trim();
  else if (Number.isSafeInteger(value)) text = String(value);
  else return null;
  if (!NAMEPLATE.test(text)) return null;
  const number = Number(text);
  return number >= 1 ? number : null;
}

/** How long a code stays open: absent means an hour, out of range is clamped. */
export function parseMinutes(value) {
  if (value === undefined || value === null) return CODE_LIMITS.defaultMinutes;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(CODE_LIMITS.maxMinutes, Math.max(CODE_LIMITS.minMinutes, value));
}

/** A session id as the code relay makes them: 22 base64url characters. */
export function isCodeSession(value) {
  return typeof value === "string" && CODE_SESSION.test(value);
}

// What a desktop is polling for. Absent means an older app: the phone link.
const KNOWN_CAPS = new Set(["phone-link", "internet"]);

/** The capabilities a desktop's poll declares, or null for none given. */
export function parseCaps(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((cap) => typeof cap === "string" && KNOWN_CAPS.has(cap)))].sort();
}

/** Whether a desktop's presence says it answers phones (older apps always did). */
export function answersPhones(live) {
  return Boolean(live) && (!Array.isArray(live.caps) || live.caps.includes("phone-link"));
}

/** Whether a desktop's presence says it takes dials from its other desktops. */
export function takesDials(live) {
  return Boolean(live) && Array.isArray(live.caps) && live.caps.includes("internet");
}

const CLIENT_ID = /^[A-Za-z0-9_-]{22,64}$/;
const SESSION = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Lower-case, dashed form of any uuid Postgres would accept. Device ids reach
 * us from the licence, from Postgres and from phones; one spelling means one
 * address.
 */
export function canonicalUuid(value) {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^\{|\}$/g, "").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isClientId(value) {
  return typeof value === "string" && CLIENT_ID.test(value);
}

export function isSession(value) {
  return typeof value === "string" && SESSION.test(value);
}

/** "desktop:<uuid>" or "phone:<clientId>", else null. */
export function parseAddress(value) {
  if (typeof value !== "string") return null;
  const colon = value.indexOf(":");
  if (colon < 0) return null;
  const kind = value.slice(0, colon);
  const id = value.slice(colon + 1);
  if (kind === "desktop") {
    const deviceId = canonicalUuid(id);
    return deviceId ? { kind, id: deviceId, address: `desktop:${deviceId}` } : null;
  }
  if (kind === "phone" && isClientId(id)) return { kind, id, address: `phone:${id}` };
  return null;
}

/** Seconds to hold a poll open: absent means the most, out of range is clamped. */
export function parseWait(value, max = LINK_LIMITS.maxWaitSeconds) {
  if (value === undefined || value === null) return max;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(0, value));
}

/** Display text from a client: control characters out, cut to `max` characters. */
export function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("").trim() : text;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
