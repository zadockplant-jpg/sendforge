/**
 * Requests for files, in memory (ForgeDrop/docs/people.md, "Requesting files
 * (1.9)").
 *
 * A desktop asks someone for files by the email of their SendForge account.
 * When the address is a verified account that owns DropForge, the request is
 * kept here for a day, for any number of sends, and emailed to them with a
 * link that carries its token after the "#". On a phone the link opens a page
 * that talks to the asking desktop the way the phone link does, as a guest
 * under the asking account (store.js): the token is all it signs in with.
 * What is kept is what the page is shown and what it may reach: the asking
 * desktop, its card as sendforge.app vouched for it when it asked (email,
 * name, identity key, fingerprint), the address it asked, and the message.
 *
 * Like store.js this is signaling, not storage: a deploy drops every request,
 * and its link stops working; the desktop simply asks again.
 */

import crypto from "node:crypto";
import { createEmailAllowance } from "./allowance.js";
import { LINK_LIMITS, PERSON_LIMITS } from "./shapes.js";

/** A desktop, as its account and address; the two together say who it is. */
const partyOf = ({ userId, address }) => ({ userId, address });
const keyOf = ({ userId, address }) => `${userId} ${address}`;

/** 16 random bytes: 22 base64url characters. */
const randomId = () => crypto.randomBytes(16).toString("base64url");

export function createRequestStore({
  now = Date.now,
  requestMs = PERSON_LIMITS.requestMs,
  requestsPerDesktop = PERSON_LIMITS.requestsPerDesktop,
  emailEveryMs = PERSON_LIMITS.emailEveryMs,
  emailsPerHour = PERSON_LIMITS.emailsPerHour,
  sweepEveryMs = LINK_LIMITS.sweepEveryMs,
  onError = () => {},
} = {}) {
  /** request id -> { id, token, asker, card, address, message, expiresAt } */
  const requests = new Map();
  /** token -> request id */
  const tokens = new Map();
  /** an asking desktop -> ids of the requests it keeps, oldest first */
  const kept = new Map();
  /** How often a request may email; apart from a waiting send's allowance. */
  const allowance = createEmailAllowance({ now, everyMs: emailEveryMs, perHour: emailsPerHour });

  /** 32 random bytes, 43 base64url characters: what a request's link carries. */
  function newToken() {
    let token;
    do {
      token = crypto.randomBytes(32).toString("base64url");
    } while (tokens.has(token));
    return token;
  }

  function forget(request) {
    requests.delete(request.id);
    tokens.delete(request.token);
    const key = keyOf(request.asker);
    const ids = kept.get(key);
    if (!ids) return;
    const index = ids.indexOf(request.id);
    if (index >= 0) ids.splice(index, 1);
    if (!ids.length) kept.delete(key);
  }

  /** The request while it lasts; one that has run out is forgotten on the way. */
  function live(id, at) {
    const request = requests.get(id);
    if (!request) return null;
    if (request.expiresAt > at) return request;
    forget(request);
    return null;
  }

  function sweep() {
    const at = now();
    for (const id of [...requests.keys()]) live(id, at);
    allowance.sweep();
  }

  const sweeper = setInterval(() => {
    try {
      sweep();
    } catch (error) {
      onError(error);
    }
  }, sweepEveryMs);
  sweeper.unref?.();

  return {
    /**
     * `asker` asks for files: a request id, the same way whether or not
     * anyone has the address. With `keep` (the address is a verified
     * account that owns DropForge) it is kept for a day, with a token for
     * its email's link. One desktop keeps so many; the oldest makes room,
     * and its link stops working.
     */
    ask(asker, { card, address, message = null, keep }) {
      const at = now();
      const id = randomId();
      if (!keep) return { request: id, token: null };

      const key = keyOf(asker);
      for (let mine = kept.get(key); mine && mine.length >= requestsPerDesktop; mine = kept.get(key)) {
        const oldest = requests.get(mine[0]);
        if (oldest) forget(oldest);
        else mine.shift();
      }

      const request = {
        id,
        token: newToken(),
        asker: partyOf(asker),
        card,
        address,
        message,
        expiresAt: at + requestMs,
      };
      requests.set(id, request);
      tokens.set(request.token, id);
      if (!kept.has(key)) kept.set(key, []);
      kept.get(key).push(id);
      return { request: id, token: request.token };
    },

    /** The request a link's token opens, while it lasts; else null. */
    byToken(token) {
      const id = typeof token === "string" ? tokens.get(token) : undefined;
      return id ? live(id, now()) : null;
    },

    /**
     * Whether a request may email its recipient now, and if so it is
     * counted: one per asking and asked account every 2 minutes, and 10 an
     * hour per asked account, apart from a waiting send's emails.
     */
    mayEmail(fromUserId, toUserId) {
      return allowance.may(fromUserId, toUserId);
    },

    sweep,

    stop() {
      clearInterval(sweeper);
    },

    stats() {
      return { requests: requests.size };
    },
  };
}
