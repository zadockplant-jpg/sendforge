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
  // A guest is a phone's browser too, on a request's page (DropForge 1.9).
  guestPresentMs: 60_000,
  licenceCacheMs: 60_000,
  // A page makes a new clientId on every load, so one account's phone
  // addresses pile up until they lapse; this bounds them. Guests are counted
  // apart, so a request's page can never push out the account's own phones.
  phonesPerAccount: 32,
  guestsPerAccount: 32,
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

// Between two desktops of one account (DropForge 1.4, sending over the
// internet): one dials with its connection candidates, the other answers
// with its own, and either may say bye. The data is DropForge's to read;
// here it is only relayed, like SDP.
export const DESKTOP_TO_DESKTOP_TYPES = new Set(["dial", "dial-answer", "bye"]);

// Codes (DropForge 1.5, ForgeDrop/docs/codes.md): sending to someone who is
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

// People (DropForge 1.7, ForgeDrop/docs/people.md): sending to someone by the
// email of their SendForge account. people.js holds the sessions a knock opens.
export const PERSON_LIMITS = Object.freeze({
  // A knock's sessions last an hour and carry 64 messages, as a code's do.
  sessionMs: 60 * 60_000,
  sessionMessages: 64,
  // The longest an email address can be.
  emailChars: 254,
  // A send's knock waits a day for the recipient's computers (1.8), while
  // the desktop that knocked keeps polling.
  knockMs: 24 * 60 * 60_000,
  // The most knocks one desktop has kept at once, waiting or over; a new one
  // makes room by ending the oldest.
  knocksPerDesktop: 64,
  // Waiting knocks put in one poll's mailbox at most; the rest go in the next.
  knocksPerPoll: 8,
  // A waiting knock's email: at most one per sender and recipient account
  // every 2 minutes, and 10 an hour per recipient account.
  emailEveryMs: 2 * 60_000,
  emailsPerHour: 10,
  // The most files a knock can say it sends.
  maxFiles: 1_000_000,
  // A request for files (1.9) is open a day, for any number of sends; one
  // desktop keeps so many, and a new one makes room by ending the oldest.
  requestMs: 24 * 60 * 60_000,
  requestsPerDesktop: 64,
  // The longest message a request carries, in characters.
  messageChars: 1000,
  rate: Object.freeze({
    // Per account, whichever of its desktops knocks: a knock lands on someone
    // else's computers, so knocking costs.
    knockPerMinute: 10,
    // Per account, the same allowance as /signal, counted apart from it.
    personSignalPerMinute: LINK_LIMITS.rate.signalPerMinute,
    // Per client address, the approval page's two routes together: they
    // take no licence, only the token an email carried.
    invitePerMinute: 30,
    // Per account, like knocks: a request emails someone else.
    requestPerMinute: 10,
    // Per client address, a request page's three routes together; its polls
    // also per clientId, as a phone's are.
    requestPagePerMinute: 60,
  }),
});

// Why a desktop knocks: to send files, or only to say hello, which puts it in
// the other's list and opens no session.
export const KNOCK_PURPOSES = new Set(["send", "hello"]);

// How a send's knock ended (1.8), which its approval page says from then on.
export const KNOCK_OUTCOMES = new Set(["sent", "cancelled"]);

// What the two computers of a person session say to each other. "here" goes
// from the desktop knocked on to the one that knocked, filled in by this
// server; the rest are relayed as sent, like a code session's, and either
// side may send them. The knock itself is only ever this server's to send.
export const PERSON_TYPES = new Set(["here", "dial", "dial-answer", "bye"]);

// What a request's page (a guest, 1.9) says to the desktop that asked: the
// phone link's offer and bye. The desktop answers through /signal, as it
// answers a phone. A share's page (below) says the same to the sending page.
export const GUEST_TYPES = new Set(["offer", "bye"]);

// Share links (ForgeDrop/docs/share.md): a signed-in owner's phone page sends
// files to anyone, who needs no account, through a room shares.js keeps.
export const SHARE_LIMITS = Object.freeze({
  // A room is open a day, unless its sender ends it first.
  shareMs: 24 * 60 * 60_000,
  // The most rooms one account keeps open; a new one ends the oldest.
  sharesPerAccount: 10,
  // A room's name is its phone page's, cleaned as a device name is.
  nameChars: 64,
  rate: Object.freeze({
    // Per account, whichever of its phone pages creates. A room says whether
    // an address is a paid account, so creating costs.
    shareCreatePerHour: 20,
    // Per account. Ending reads the database, so it is limited like the
    // desktop list, with an allowance of its own.
    shareEndPerMinute: LINK_LIMITS.rate.desktopsPerMinute,
    // Per client address, a share page's four routes together; its polls
    // also per clientId, as a request page's are.
    sharePagePerMinute: 60,
  }),
});

// What a phone page says to the guest that claimed one of its own rooms: the
// answer to its offer, and bye. No other guest is ever reached from a phone.
export const PHONE_TO_GUEST_TYPES = new Set(["answer", "bye"]);

const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;

/** A share room's id as shares.js makes them: 16 random bytes, 22 base64url characters. */
export function isShareId(value) {
  return typeof value === "string" && SHARE_ID.test(value);
}

const NAMEPLATE = /^[0-9]{1,9}$/;
const CODE_SESSION = /^[A-Za-z0-9_-]{22}$/;

// local@domain.tld: whatever registration's own check (zod's) lets in, and a
// little more. Letters, digits and the usual punctuation before the @, with
// no leading, trailing or doubled dot; dot-separated labels after it, the
// last a top-level domain of letters, or an internationalised one (xn--).
const EMAIL =
  /^(?!\.)(?!.*\.\.)[a-z0-9!#$%&'*+/=?^_`{|}~.-]+(?<!\.)@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * A person's address as DropForge writes it, the account's email trimmed and
 * in lower case; null for anything that is not an email.
 */
export function parseEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= PERSON_LIMITS.emailChars && EMAIL.test(email) ? email : null;
}

/** A person session id, or a knock id, made as a code's is: 22 base64url characters. */
export function isPersonSession(value) {
  return typeof value === "string" && CODE_SESSION.test(value);
}

const APPROVAL_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** An approval token as people.js makes them: 32 random bytes, 43 base64url characters. */
export function isApprovalToken(value) {
  return typeof value === "string" && APPROVAL_TOKEN.test(value);
}

/** A request's token (1.9), made as an approval token is. */
export function isRequestToken(value) {
  return typeof value === "string" && APPROVAL_TOKEN.test(value);
}

/**
 * A request's message (1.9) as it is kept and emailed: trimmed, its line
 * breaks and tabs kept, other control characters and the bidirectional ones
 * (which can make text read as something it is not) taken out. Null when
 * there is none; undefined when it is not text or is over 1000 characters.
 */
export function parseMessage(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(/\p{Cc}/gu, (char) => (char === "\n" || char === "\t" ? char : ""))
    .replace(/\p{Bidi_Control}/gu, "")
    .trim();
  if (!text) return null;
  return Array.from(text).length <= PERSON_LIMITS.messageChars ? text : undefined;
}

/**
 * What a send's knock says it sends (1.8): { files, bytes }, each a whole
 * number or null when not given; null for anything else. A count is never
 * negative, and a knock says a million files at most.
 */
export function parseSummary(body) {
  const read = (value, max) => {
    if (value === undefined || value === null) return null;
    return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
  };
  const files = read(body?.files, PERSON_LIMITS.maxFiles);
  const bytes = read(body?.bytes, Number.MAX_SAFE_INTEGER);
  return files === undefined || bytes === undefined ? null : { files, bytes };
}

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
// "people" (1.7) is knocks on its account's email.
const KNOWN_CAPS = new Set(["phone-link", "internet", "people"]);

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

/** Whether a desktop's presence says it answers knocks on its account's email. */
export function takesPeople(live) {
  return Boolean(live) && Array.isArray(live.caps) && live.caps.includes("people");
}

/**
 * Whether a desktop's presence says it takes a request page's guests (1.9):
 * it says it answers phones, as an app that asks for files always does.
 */
export function takesGuests(live) {
  return Boolean(live) && Array.isArray(live.caps) && live.caps.includes("phone-link");
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

/**
 * "desktop:<uuid>", "phone:<clientId>" or "guest:<clientId>" (a request's
 * page, 1.9, which only desktops may address, or a share's page, which only
 * the phone page whose room it claimed may), else null.
 */
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
  if (kind === "guest" && isClientId(id)) return { kind, id, address: `guest:${id}` };
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
