/**
 * Presence, mailboxes and pending long-polls for the phone link, in memory.
 *
 * Everything is filed under the account first and the address second, and
 * every call names both. There is no lookup by address alone, so two
 * accounts whose phones happened to pick the same clientId still cannot see
 * each other's messages: isolation comes from the shape of the data, not from
 * a check someone could forget.
 *
 * SendForge runs one Render instance and this is signaling, not storage. A
 * deploy drops it all and both sides simply poll again.
 *
 * Each address holds at most one pending poll (a waiter). A waiter ends in
 * exactly one way, once:
 *   - a message arrives: it gets the mailbox;
 *   - its wait runs out, a newer poll from the same address arrives, or the
 *     address is dropped: it gets no messages;
 *   - its client hangs up: it is released and answers nothing, and anything
 *     queued stays queued for the next poll.
 * Every path clears the timer and the address's reference to it, so nothing
 * outlives the request that made it.
 */

import { LINK_LIMITS } from "./shapes.js";

const kindOf = (address) => (address.startsWith("desktop:") ? "desktop" : "phone");

export function createLinkStore({
  now = Date.now,
  messageTtlMs = LINK_LIMITS.messageTtlMs,
  mailboxSize = LINK_LIMITS.mailboxMessages,
  presentMs = { desktop: LINK_LIMITS.desktopOnlineMs, phone: LINK_LIMITS.phonePresentMs },
  phonesPerAccount = LINK_LIMITS.phonesPerAccount,
  sweepEveryMs = LINK_LIMITS.sweepEveryMs,
  onError = () => {},
} = {}) {
  /** userId -> Map(address -> endpoint) */
  const accounts = new Map();

  const lookup = (userId, address) => accounts.get(userId)?.get(address) || null;

  const isPresent = (endpoint, at) =>
    Boolean(endpoint) &&
    (endpoint.waiter !== null || at - endpoint.seenAt <= presentMs[endpoint.kind]);

  const unexpired = (endpoint, at) => {
    endpoint.mailbox = endpoint.mailbox.filter((entry) => entry.expiresAt > at);
  };

  function take(endpoint, at) {
    unexpired(endpoint, at);
    const messages = endpoint.mailbox.map((entry) => entry.message);
    endpoint.mailbox = [];
    return messages;
  }

  /** Detach a waiter and stop its timer. False if it had already ended. */
  function release(endpoint, waiter) {
    if (waiter.done) return false;
    waiter.done = true;
    clearTimeout(waiter.timer);
    if (endpoint.waiter === waiter) endpoint.waiter = null;
    return true;
  }

  function answer(respond, messages) {
    try {
      respond(messages);
    } catch (error) {
      onError(error);
    }
  }

  function settle(endpoint, waiter, messages) {
    if (release(endpoint, waiter) && waiter.isAlive()) answer(waiter.respond, messages);
  }

  function remove(userId, address) {
    const book = accounts.get(userId);
    const endpoint = book?.get(address);
    if (!endpoint) return;
    book.delete(address);
    if (!book.size) accounts.delete(userId);
    if (endpoint.waiter) settle(endpoint, endpoint.waiter, []);
  }

  function open(userId, address) {
    let book = accounts.get(userId);
    if (!book) {
      book = new Map();
      accounts.set(userId, book);
    }
    let endpoint = book.get(address);
    if (endpoint) return endpoint;

    const kind = kindOf(address);
    if (kind === "phone") {
      let phones = 0;
      let stalest = null;
      for (const [other, entry] of book) {
        if (entry.kind !== "phone") continue;
        phones += 1;
        if (!stalest || entry.seenAt < book.get(stalest).seenAt) stalest = other;
      }
      if (phones >= phonesPerAccount && stalest) remove(userId, stalest);
      // remove() may have dropped the last entry and with it the account.
      if (!accounts.has(userId)) accounts.set(userId, book);
    }
    endpoint = { kind, seenAt: -Infinity, info: null, mailbox: [], waiter: null };
    book.set(address, endpoint);
    return endpoint;
  }

  /**
   * Mark an address present now. `info` (a desktop's name, fingerprint and app
   * version) replaces what is known field by field; nulls keep the old value.
   */
  function touch(userId, address, info = null) {
    const endpoint = open(userId, address);
    endpoint.seenAt = now();
    if (info) {
      const known = { ...(endpoint.info || {}) };
      for (const [key, value] of Object.entries(info)) if (value != null) known[key] = value;
      endpoint.info = known;
    }
    return endpoint;
  }

  function sweep() {
    const at = now();
    for (const [userId, book] of accounts) {
      for (const [address, endpoint] of book) {
        unexpired(endpoint, at);
        if (!endpoint.waiter && !endpoint.mailbox.length && !isPresent(endpoint, at)) {
          book.delete(address);
        }
      }
      if (!book.size) accounts.delete(userId);
    }
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
    touch(userId, address, info = null) {
      touch(userId, address, info);
    },

    /** Online (desktop) or present (phone): polling now, or polled recently. */
    isPresent(userId, address) {
      return isPresent(lookup(userId, address), now());
    },

    /** What a present desktop last said about itself, else null. */
    presence(userId, address) {
      const endpoint = lookup(userId, address);
      return isPresent(endpoint, now()) ? { ...(endpoint.info || {}) } : null;
    },

    /**
     * Long-poll. Marks the address present, ends any older poll from it with
     * no messages, then answers at once with what is queued, or waits up to
     * `waitMs` for the first message. Returns a function that releases the
     * poll without answering; call it when the client hangs up.
     */
    poll(userId, address, { waitMs, respond, isAlive = () => true, info = null }) {
      const endpoint = touch(userId, address, info);
      if (endpoint.waiter) settle(endpoint, endpoint.waiter, []);

      const ready = take(endpoint, now());
      if (ready.length || !(waitMs > 0)) {
        answer(respond, ready);
        return () => {};
      }

      const waiter = { respond, isAlive, done: false, timer: null };
      waiter.timer = setTimeout(() => settle(endpoint, waiter, []), waitMs);
      waiter.timer.unref?.();
      endpoint.waiter = waiter;
      return () => release(endpoint, waiter);
    },

    /**
     * Queue a message, keeping the newest `mailboxSize`, and wake the pending
     * poll if there is one. A poll whose client has already gone is released
     * instead, and the message waits for the next one.
     */
    deliver(userId, address, message) {
      const at = now();
      const endpoint = open(userId, address);
      unexpired(endpoint, at);
      endpoint.mailbox.push({ message, expiresAt: at + messageTtlMs });
      if (endpoint.mailbox.length > mailboxSize) {
        endpoint.mailbox.splice(0, endpoint.mailbox.length - mailboxSize);
      }
      const waiter = endpoint.waiter;
      if (!waiter) return;
      if (waiter.isAlive()) settle(endpoint, waiter, take(endpoint, at));
      else release(endpoint, waiter);
    },

    /** Forget an address now: presence, queue and any pending poll. */
    drop(userId, address) {
      remove(userId, address);
    },

    sweep,

    stop() {
      clearInterval(sweeper);
    },

    /** Whether an address has a poll waiting. For tests and diagnostics. */
    waiting(userId, address) {
      return Boolean(lookup(userId, address)?.waiter);
    },

    stats() {
      let endpoints = 0;
      let waiters = 0;
      let messages = 0;
      for (const book of accounts.values()) {
        for (const endpoint of book.values()) {
          endpoints += 1;
          if (endpoint.waiter) waiters += 1;
          messages += endpoint.mailbox.length;
        }
      }
      return { accounts: accounts.size, endpoints, waiters, messages };
    },
  };
}
