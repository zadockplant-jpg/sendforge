/**
 * The person relay's sessions, in memory (ForgeDrop/docs/people.md, "Backend:
 * the person relay").
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
 * Like store.js this is signaling, not storage: a deploy drops every session,
 * and the sender simply knocks again.
 */

import crypto from "node:crypto";
import { LINK_LIMITS, PERSON_LIMITS } from "./shapes.js";

/** A desktop, as its account and address; the two together say who it is. */
const partyOf = ({ userId, address }) => ({ userId, address });
const same = (a, b) => a.userId === b.userId && a.address === b.address;

/** 16 random bytes: 22 base64url characters. */
const randomId = () => crypto.randomBytes(16).toString("base64url");

export function createPeopleStore({
  deliver,
  now = Date.now,
  sessionMs = PERSON_LIMITS.sessionMs,
  sessionMessages = PERSON_LIMITS.sessionMessages,
  sweepEveryMs = LINK_LIMITS.sweepEveryMs,
  onError = () => {},
}) {
  /** session id -> { sender, recipient, knock, expiresAt, sent } */
  const sessions = new Map();

  /** The session while it lasts; one that has run out is dropped on the way. */
  function live(sid, at) {
    const session = sessions.get(sid);
    if (!session) return null;
    if (session.expiresAt > at) return session;
    sessions.delete(sid);
    return null;
  }

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

  function sweep() {
    const at = now();
    for (const [sid, session] of sessions) if (session.expiresAt <= at) sessions.delete(sid);
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
     */
    knock(sender, { purpose, card, recipients }) {
      const at = now();
      const knock = randomId();
      for (const recipient of recipients) {
        const sid = newSessionId();
        if (purpose === "send") {
          sessions.set(sid, {
            sender: partyOf(sender),
            recipient: partyOf(recipient),
            knock,
            expiresAt: at + sessionMs,
            sent: 0,
          });
        }
        send(recipient, sid, "knock", { purpose, ...card }, at);
      }
      return knock;
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
      if (type === "bye") sessions.delete(sid);
      return { ok: true };
    },

    /** End a session, from either side; the other side is told with a bye. */
    closeSession(party, sid) {
      const at = now();
      const session = live(sid, at);
      if (!session || !isParty(session, party)) return { ok: false, error: "person_gone" };
      sessions.delete(sid);
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
      sessions.delete(sid);
      return { ok: true };
    },

    sweep,

    stop() {
      clearInterval(sweeper);
    },

    stats() {
      return { sessions: sessions.size };
    },
  };
}
