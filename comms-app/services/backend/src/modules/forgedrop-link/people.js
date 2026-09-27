/**
 * The person relay's sessions and waiting knocks, in memory
 * (ForgeDrop/docs/people.md, "Backend: the person relay" and "Waiting, and
 * the email (1.8)").
 *
 * From ForgeDrop 1.7 a person's address is the email of the SendForge account
 * their ForgeDrop is activated with. A desktop knocks on an address; each of
 * that account's desktops taking people (router.js finds them) is told who is
 * knocking and gets a session of its own with the knocker. Unlike a code,
 * nothing here proves who is who: sendforge.app vouches for it. The router
 * reads each side's verified email and proven identity key from the database
 * and hands them to the other side, in the knock and in the "here" that
 * answers it; this store only carries what it is given. After that it is a
 * code session's path: a dial signed with the pair key of those two keys,
 * which only the two computers can compute.
 *
 * As with codes, the two may belong to different accounts. A session
 * remembers each party's own account and address, and whatever one says is
 * delivered into the other's own mailbox (store.js), under the other's own
 * account, where its usual poll picks it up. A "hello" knock keeps no session
 * at all: it only tells the desktops knocked on who said hello, and nothing
 * can be said back on it.
 *
 * From 1.8 a send to someone's account also waits. For up to a day, while the
 * desktop that knocked keeps polling, the knock goes again to each of the
 * recipient's desktops that comes online taking people (the router checks its
 * slot and key first), each time with a session of its own. It holds an
 * approval token, which the recipient's email carries as a link: the page it
 * opens asks, and approving tells the recipient's desktops, which then take
 * the files the knock said without a prompt. The desktop that knocked ends it,
 * sent or cancelled, and the page says which from then on.
 *
 * Like store.js this is signaling, not storage: a deploy drops every session
 * and knock, and the sender simply knocks again.
 */

import crypto from "node:crypto";
import { LINK_LIMITS, PERSON_LIMITS } from "./shapes.js";

/** A desktop, as its account and address; the two together say who it is. */
const partyOf = ({ userId, address }) => ({ userId, address });
const same = (a, b) => a.userId === b.userId && a.address === b.address;
const keyOf = ({ userId, address }) => `${userId} ${address}`;

/** 16 random bytes: 22 base64url characters. */
const randomId = () => crypto.randomBytes(16).toString("base64url");

const HOUR_MS = 60 * 60_000;

export function createPeopleStore({
  deliver,
  // Whether a desktop is polling now (store.js). A waiting knock lasts only
  // while the desktop that knocked does.
  present = () => true,
  now = Date.now,
  sessionMs = PERSON_LIMITS.sessionMs,
  sessionMessages = PERSON_LIMITS.sessionMessages,
  knockMs = PERSON_LIMITS.knockMs,
  knocksPerDesktop = PERSON_LIMITS.knocksPerDesktop,
  knocksPerPoll = PERSON_LIMITS.knocksPerPoll,
  emailEveryMs = PERSON_LIMITS.emailEveryMs,
  emailsPerHour = PERSON_LIMITS.emailsPerHour,
  // A knock made just before its desktop's first poll is not abandoned yet.
  graceMs = LINK_LIMITS.desktopOnlineMs,
  sweepEveryMs = LINK_LIMITS.sweepEveryMs,
  onError = () => {},
}) {
  /** session id -> { sender, recipient, knock, expiresAt, sent } */
  const sessions = new Map();
  /**
   * knock id -> a send's knock, while it waits and, once over, for its page:
   * { id, sender, card, recipient (the account knocked on), files, bytes,
   *   token, approved, outcome, createdAt, expiresAt, delivered (the
   *   recipient's desktops that have had it since they came online),
   *   sessions (its sessions' ids) }
   */
  const knocks = new Map();
  /** approval token -> knock id */
  const tokens = new Map();
  /** recipient account -> ids of the knocks waiting for its desktops, oldest first */
  const waiting = new Map();
  /** a desktop that knocked -> ids of the knocks it keeps, oldest first */
  const kept = new Map();
  /** "sender recipient" accounts -> when the last email between them went */
  const lastEmail = new Map();
  /** recipient account -> when its emails of the last hour went */
  const emails = new Map();

  const isParty = (session, who) => same(session.sender, who) || same(session.recipient, who);
  const otherParty = (session, who) => (same(session.sender, who) ? session.recipient : session.sender);

  function send(to, sid, type, data, at) {
    deliver(to.userId, to.address, {
      from: `person:${sid}`,
      session: sid,
      type,
      data,
      sentAt: new Date(at).toISOString(),
    });
  }

  /** A session id never in use. */
  function newSessionId() {
    let sid;
    do {
      sid = randomId();
    } while (sessions.has(sid));
    return sid;
  }

  /** 32 random bytes, 43 base64url characters: what an approval link carries. */
  function newToken() {
    let token;
    do {
      token = crypto.randomBytes(32).toString("base64url");
    } while (tokens.has(token));
    return token;
  }

  function endSession(sid) {
    const session = sessions.get(sid);
    if (!session) return;
    sessions.delete(sid);
    knocks.get(session.knock)?.sessions.delete(sid);
  }

  /** The session while it lasts; one that has run out is dropped on the way. */
  function live(sid, at) {
    const session = sessions.get(sid);
    if (!session) return null;
    if (session.expiresAt > at) return session;
    endSession(sid);
    return null;
  }

  function stopWaiting(knock) {
    const ids = waiting.get(knock.recipient);
    if (!ids) return;
    ids.delete(knock.id);
    if (!ids.size) waiting.delete(knock.recipient);
  }

  function forgetKnock(knock) {
    stopWaiting(knock);
    knocks.delete(knock.id);
    tokens.delete(knock.token);
    const key = keyOf(knock.sender);
    const ids = kept.get(key);
    if (!ids) return;
    const index = ids.indexOf(knock.id);
    if (index >= 0) ids.splice(index, 1);
    if (!ids.length) kept.delete(key);
  }

  /**
   * A kept knock while it lasts: a day from the knock, and while it waits,
   * only while the desktop that knocked is still polling (or knocked a
   * moment ago, before its first poll). Else it is forgotten on the way.
   */
  function liveKnock(id, at) {
    const knock = knocks.get(id);
    if (!knock) return null;
    if (
      knock.expiresAt > at &&
      (knock.outcome || present(knock.sender.userId, knock.sender.address) || at - knock.createdAt <= graceMs)
    ) {
      return knock;
    }
    forgetKnock(knock);
    return null;
  }

  const knockData = (knock) => ({
    purpose: "send",
    ...knock.card,
    files: knock.files,
    bytes: knock.bytes,
    approved: knock.approved,
  });

  /** Knock on one of the recipient's desktops, with a session of its own. */
  function knockOn(knock, recipient, at) {
    const sid = newSessionId();
    sessions.set(sid, {
      sender: knock.sender,
      recipient: partyOf(recipient),
      knock: knock.id,
      expiresAt: at + sessionMs,
      sent: 0,
    });
    knock.sessions.add(sid);
    knock.delivered.add(recipient.address);
    send(recipient, sid, "knock", knockData(knock), at);
  }

  /** Tell each of the recipient's desktops still in a session of the knock that it is over. */
  function byeAll(knock, at) {
    for (const sid of knock.sessions) {
      const session = live(sid, at);
      if (!session) continue;
      endSession(sid);
      send(session.recipient, sid, "bye", {}, at);
    }
  }

  const describe = (knock) => ({
    status: knock.outcome ?? (knock.approved ? "approved" : "waiting"),
    from: knock.card.email,
    name: knock.card.name ?? null,
    files: knock.files,
    bytes: knock.bytes,
  });

  const byToken = (token, at) => {
    const id = typeof token === "string" ? tokens.get(token) : undefined;
    return id ? liveKnock(id, at) : null;
  };

  function sweep() {
    const at = now();
    for (const [sid, session] of sessions) if (session.expiresAt <= at) endSession(sid);
    for (const id of [...knocks.keys()]) liveKnock(id, at);
    for (const [pair, when] of lastEmail) if (at - when >= emailEveryMs) lastEmail.delete(pair);
    for (const [userId, times] of emails) {
      const recent = times.filter((when) => at - when < HOUR_MS);
      if (recent.length) emails.set(userId, recent);
      else emails.delete(userId);
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
    /**
     * Knock for `sender` on each of `recipients`, telling each what `card`
     * vouches for about the sender (its email, name, identity key and
     * fingerprint). Each is knocked on with a session id of its own; for a
     * "send" the session is kept for the two to talk on, for a "hello" it is
     * not. The knock id comes back the same way whether or not there was
     * anyone to knock on, and rides in each "here" to say which knock it
     * answers.
     *
     * A send given `waitFor` ({ userId, files, bytes }: the account knocked
     * on and what the knock says it sends) is kept waiting for that
     * account's desktops (1.8), and also comes back with the approval token
     * for its email. One desktop keeps so many knocks at once; the oldest
     * makes room, and its desktops still in a session are told bye.
     */
    knock(sender, { purpose, card, recipients, waitFor = null }) {
      const at = now();
      const id = randomId();
      if (purpose !== "send" || !waitFor) {
        for (const recipient of recipients) {
          const sid = newSessionId();
          if (purpose === "send") {
            sessions.set(sid, {
              sender: partyOf(sender),
              recipient: partyOf(recipient),
              knock: id,
              expiresAt: at + sessionMs,
              sent: 0,
            });
          }
          send(recipient, sid, "knock", { purpose, ...card }, at);
        }
        return { knock: id, token: null };
      }

      const key = keyOf(sender);
      for (let mine = kept.get(key); mine && mine.length >= knocksPerDesktop; mine = kept.get(key)) {
        const oldest = knocks.get(mine[0]);
        if (!oldest) {
          mine.shift();
          continue;
        }
        byeAll(oldest, at);
        forgetKnock(oldest);
      }

      const knock = {
        id,
        sender: partyOf(sender),
        card,
        recipient: waitFor.userId,
        files: waitFor.files ?? null,
        bytes: waitFor.bytes ?? null,
        token: newToken(),
        approved: false,
        outcome: null,
        createdAt: at,
        expiresAt: at + knockMs,
        delivered: new Set(),
        sessions: new Set(),
      };
      knocks.set(id, knock);
      tokens.set(knock.token, id);
      if (!kept.has(key)) kept.set(key, []);
      kept.get(key).push(id);
      if (!waiting.has(knock.recipient)) waiting.set(knock.recipient, new Set());
      waiting.get(knock.recipient).add(id);
      for (const recipient of recipients) knockOn(knock, recipient, at);
      return { knock: id, token: knock.token };
    },

    /** Whether any knock waits for the account's desktops: all that a poll asks when none does. */
    waitsFor(userId) {
      return waiting.has(userId);
    },

    /**
     * A desktop that was not polling until now: every knock waiting for its
     * account is due to it again, even one it had before it went.
     */
    cameOnline(userId, address) {
      for (const id of waiting.get(userId) ?? []) knocks.get(id)?.delivered.delete(address);
    },

    /**
     * The knocks waiting for `party`'s account that it has not had since it
     * came online, oldest first and a few at a time, marked as its own so
     * that a second poll does not take them too. Never a knock of its own.
     * The router checks the desktop's slot and key, then hands them to
     * deliverWaiting, or back to releaseWaiting.
     */
    claimWaiting(party) {
      const ids = waiting.get(party.userId);
      if (!ids) return [];
      const at = now();
      const due = [];
      for (const id of [...ids]) {
        if (due.length >= knocksPerPoll) break;
        const knock = liveKnock(id, at);
        if (!knock || knock.delivered.has(party.address) || same(knock.sender, party)) continue;
        knock.delivered.add(party.address);
        due.push(id);
      }
      return due;
    },

    /** Knock on `party` with the knocks it claimed, those still waiting. */
    deliverWaiting(party, due) {
      const at = now();
      for (const id of due) {
        const knock = liveKnock(id, at);
        if (knock && !knock.outcome) knockOn(knock, party, at);
      }
    },

    /** Give back knocks `party` claimed but was not knocked on with, for a later poll. */
    releaseWaiting(party, due) {
      for (const id of due) knocks.get(id)?.delivered.delete(party.address);
    },

    /**
     * The desktop that knocked is done with a send, "sent" or "cancelled":
     * it stops waiting, its desktops still in a session are told bye, and
     * its page says how it ended. Only that desktop can; for anyone else, or
     * a knock nobody waited on, nothing happens.
     */
    end(sender, id, outcome) {
      const at = now();
      const knock = liveKnock(id, at);
      if (!knock || knock.outcome || !same(knock.sender, sender)) return;
      knock.outcome = outcome;
      stopWaiting(knock);
      byeAll(knock, at);
      // All its page needs from here on.
      knock.card = { email: knock.card.email, name: knock.card.name };
      knock.delivered.clear();
    },

    /**
     * What an approval link's page shows: { ok, invite: { status, from,
     * name, files, bytes } }, or { ok: false, error: "invite_gone" }. Looks
     * only.
     */
    invite(token) {
      const knock = byToken(token, now());
      return knock ? { ok: true, invite: describe(knock) } : { ok: false, error: "invite_gone" };
    },

    /**
     * Approve a waiting knock by its token: each of its sessions still open
     * is told "approved", and from now on it is delivered saying so. Twice
     * is the same as once. A knock that is over cannot be.
     */
    approve(token) {
      const at = now();
      const knock = byToken(token, at);
      if (!knock) return { ok: false, error: "invite_gone" };
      if (knock.outcome) return { ok: false, error: "invite_over" };
      if (!knock.approved) {
        knock.approved = true;
        for (const sid of knock.sessions) {
          const session = live(sid, at);
          if (session) send(session.recipient, sid, "approved", {}, at);
        }
      }
      return { ok: true, invite: describe(knock) };
    },

    /**
     * Whether a waiting knock may email its recipient now, and if so it is
     * counted: one per sender and recipient account every 2 minutes, and 10
     * an hour per recipient account.
     */
    mayEmail(fromUserId, toUserId) {
      const at = now();
      const pair = `${fromUserId} ${toUserId}`;
      if (at - (lastEmail.get(pair) ?? -Infinity) < emailEveryMs) return false;
      const recent = (emails.get(toUserId) ?? []).filter((when) => at - when < HOUR_MS);
      if (recent.length >= emailsPerHour) {
        emails.set(toUserId, recent);
        return false;
      }
      recent.push(at);
      emails.set(toUserId, recent);
      lastEmail.set(pair, at);
      return true;
    },

    /**
     * Which side of a live session `party` is on, "sender" or "recipient",
     * and the knock that opened it; null to anyone who is not one of its two
     * parties. Asked before anything is looked up for a "here".
     */
    role(party, sid) {
      const session = live(sid, now());
      if (!session || !isParty(session, party)) return null;
      return { role: same(session.recipient, party) ? "recipient" : "sender", knock: session.knock };
    },

    /**
     * Pass a message to the other party of a session. To anyone who is not
     * one of its two parties, a session is not there. Only the desktop
     * knocked on says "here". A bye ends it here too, so neither side can go
     * on talking into a session the other has left.
     */
    signal(sender, sid, type, data) {
      const at = now();
      const session = live(sid, at);
      if (!session || !isParty(session, sender)) return { ok: false, error: "person_gone" };
      if (type === "here" && !same(session.recipient, sender)) return { ok: false, error: "bad_type" };
      if (session.sent >= sessionMessages) return { ok: false, error: "too_many_messages" };

      session.sent += 1;
      send(otherParty(session, sender), sid, type, data, at);
      if (type === "bye") endSession(sid);
      return { ok: true };
    },

    /** End a session, from either side; the other side is told with a bye. */
    closeSession(party, sid) {
      const at = now();
      const session = live(sid, at);
      if (!session || !isParty(session, party)) return { ok: false, error: "person_gone" };
      endSession(sid);
      send(otherParty(session, party), sid, "bye", {}, at);
      return { ok: true };
    },

    /**
     * End a session without a word to the other side: for a desktop knocked
     * on that sendforge.app can no longer vouch for, whose knocker has not
     * heard from it and never will.
     */
    forget(party, sid) {
      const session = live(sid, now());
      if (!session || !isParty(session, party)) return { ok: false, error: "person_gone" };
      endSession(sid);
      return { ok: true };
    },

    sweep,

    stop() {
      clearInterval(sweeper);
    },

    stats() {
      let waitingKnocks = 0;
      for (const ids of waiting.values()) waitingKnocks += ids.size;
      return { sessions: sessions.size, knocks: knocks.size, waiting: waitingKnocks };
    },
  };
}
