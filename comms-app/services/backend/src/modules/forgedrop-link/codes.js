/**
 * The code relay's nameplates and sessions, in memory (ForgeDrop/docs/codes.md,
 * "Backend: the code relay").
 *
 * A code is "<nameplate>-<word>-<word>". This server hands out the nameplate,
 * a small number that only says which two computers to put in touch; the
 * words never reach it. The first desktop to claim an open nameplate
 * consumes it and gets a session with the desktop that opened it. The two
 * then run a PAKE through here that only the words can complete, so a wrong
 * guess spends the code, and nothing that passes through here can be used to
 * test a guess.
 *
 * Unlike the rest of the link, the two may belong to different accounts. A
 * session therefore remembers each party's own account and address, and
 * whatever one says is delivered into the other's own mailbox (store.js),
 * under the other's own account, where its usual poll picks it up. Nothing
 * here files a message under the sender's account, so the rule that one
 * account never reads another's mail still holds.
 *
 * A desktop that stops polling does not end its sessions: its messages wait
 * in its mailbox for a minute, as any others do, and the other side finds
 * out when a dial goes unanswered. Like store.js this is signaling, not
 * storage: a deploy drops every open code and session, and the apps make a
 * new code.
 */

import crypto from "node:crypto";
import { CODE_LIMITS, LINK_LIMITS } from "./shapes.js";

/** A desktop, as its account and address; the two together say who it is. */
const partyOf = ({ userId, address }) => ({ userId, address });
const same = (a, b) => a.userId === b.userId && a.address === b.address;

export function createCodeStore({
  deliver,
  now = Date.now,
  nameplatesPerDesktop = CODE_LIMITS.nameplatesPerDesktop,
  sessionMs = CODE_LIMITS.sessionMs,
  sessionMessages = CODE_LIMITS.sessionMessages,
  sweepEveryMs = LINK_LIMITS.sweepEveryMs,
  onError = () => {},
}) {
  /** nameplate number -> { creator, name, expiresAt } */
  const nameplates = new Map();
  /** session id -> { creator, claimer, expiresAt, sent } */
  const sessions = new Map();

  /** The entry under `key` while it lasts; one that has run out is dropped on the way. */
  function live(map, key, at) {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt > at) return entry;
    map.delete(key);
    return null;
  }

  const isParty = (session, who) => same(session.creator, who) || same(session.claimer, who);
  const otherParty = (session, who) => (same(session.creator, who) ? session.claimer : session.creator);

  function send(to, sid, type, data, at) {
    deliver(to.userId, to.address, {
      from: `code:${sid}`,
      session: sid,
      type,
      data,
      sentAt: new Date(at).toISOString(),
    });
  }

  /** 16 random bytes: 22 base64url characters, never one in use. */
  function newSessionId() {
    let sid;
    do {
      sid = crypto.randomBytes(16).toString("base64url");
    } while (sessions.has(sid));
    return sid;
  }

  function sweep() {
    const at = now();
    for (const [number, entry] of nameplates) if (entry.expiresAt <= at) nameplates.delete(number);
    for (const [sid, entry] of sessions) if (entry.expiresAt <= at) sessions.delete(sid);
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
     * Open a nameplate for `creator`, open for `minutes`: the smallest number
     * nobody has open, so codes stay short. `name`, if the desktop gave one,
     * is what a claimer is told it is called.
     */
    open(creator, { minutes, name = null }) {
      const at = now();
      let mine = 0;
      for (const [number, entry] of nameplates) {
        if (entry.expiresAt <= at) nameplates.delete(number);
        else if (same(entry.creator, creator)) mine += 1;
      }
      if (mine >= nameplatesPerDesktop) return { ok: false, error: "too_many_codes" };

      let number = 1;
      while (nameplates.has(number)) number += 1;
      const expiresAt = at + Math.round(minutes * 60_000);
      nameplates.set(number, { creator: partyOf(creator), name, expiresAt });
      return { ok: true, nameplate: String(number), expiresAt };
    },

    /**
     * Claim an open nameplate. It closes at once, whatever happens next: one
     * guess per code. The creator hears of it through its poll; the claimer
     * gets the session id in the reply.
     */
    claim(claimer, number) {
      const at = now();
      const nameplate = live(nameplates, number, at);
      // Its own code is not there to the desktop that opened it. Claiming it
      // would spend the code on a conversation with itself.
      if (!nameplate || same(nameplate.creator, claimer)) return { ok: false, error: "code_unknown" };

      nameplates.delete(number);
      const sid = newSessionId();
      sessions.set(sid, {
        creator: nameplate.creator,
        claimer: partyOf(claimer),
        expiresAt: at + sessionMs,
        sent: 0,
      });
      send(nameplate.creator, sid, "code-claimed", { nameplate: String(number) }, at);
      return { ok: true, session: sid, name: nameplate.name, creator: nameplate.creator };
    },

    /**
     * Pass a message to the other party of a session. To anyone who is not
     * one of its two parties, a session is not there. A bye ends it here too,
     * so neither side can go on talking into a session the other has left.
     */
    signal(sender, sid, type, data) {
      const at = now();
      const session = live(sessions, sid, at);
      if (!session || !isParty(session, sender)) return { ok: false, error: "code_gone" };
      if (session.sent >= sessionMessages) return { ok: false, error: "too_many_messages" };

      session.sent += 1;
      send(otherParty(session, sender), sid, type, data, at);
      if (type === "bye") sessions.delete(sid);
      return { ok: true };
    },

    /** Withdraw a code nobody has claimed yet. Only the desktop that opened it can. */
    closeNameplate(creator, number) {
      const nameplate = live(nameplates, number, now());
      if (!nameplate || !same(nameplate.creator, creator)) return { ok: false, error: "code_unknown" };
      nameplates.delete(number);
      return { ok: true };
    },

    /** End a session, from either side; the other side is told with a bye. */
    closeSession(party, sid) {
      const at = now();
      const session = live(sessions, sid, at);
      if (!session || !isParty(session, party)) return { ok: false, error: "code_gone" };
      sessions.delete(sid);
      send(otherParty(session, party), sid, "bye", {}, at);
      return { ok: true };
    },

    sweep,

    stop() {
      clearInterval(sweeper);
    },

    stats() {
      return { nameplates: nameplates.size, sessions: sessions.size };
    },
  };
}
