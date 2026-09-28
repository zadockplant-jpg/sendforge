/**
 * Share rooms, in memory (ForgeDrop/docs/share.md).
 *
 * A signed-in DropForge owner's phone page (the website's /drop/) sends files
 * to anyone, who needs no account. It makes a room here and sends the room's
 * link from its own email or number; the link carries the room's id after the
 * "#", and the page it opens (/g/) reaches the sending page through the room,
 * as a guest under the sender's account (store.js): the id is all it signs in
 * with. The first page to offer claims the room for its clientId. From then
 * on only that page may signal through it, and the sending page may answer
 * that guest and no other. One link is one send, to one person.
 *
 * A room belongs to one phone page, its account and its "phone:<clientId>",
 * and lasts a day unless its sender ends it sooner. An account keeps so many
 * open; a new one ends the oldest, and its link stops working. What is kept
 * is what the page is shown and what it may reach: the sending page, the name
 * it gave, whether the address it was sent to is a paid account, the sender's
 * referral code, the keyed hash of that address when it is not a paid one
 * (freeTransfers.js), and the clientId that claimed it.
 *
 * One free received transfer per person: while a page holds one room for a
 * person who is not a paid account, no other room for that person (from any
 * sender) can be claimed. The rooms are indexed by that keyed hash for it.
 *
 * A room's id is the capability to join it, as a request's token is: it is
 * never logged.
 *
 * Like store.js this is signaling, not storage: a deploy drops every room,
 * and its link stops working; the sender simply sends again. What a deploy
 * must not lose, whether an address has had its free transfer, is kept in the
 * database instead.
 */

import crypto from "node:crypto";
import { LINK_LIMITS, SHARE_LIMITS } from "./shapes.js";

/** A phone page, as its account and address; the two together say who it is. */
const partyOf = ({ userId, address }) => ({ userId, address });

export function createShareStore({
  now = Date.now,
  shareMs = SHARE_LIMITS.shareMs,
  sharesPerAccount = SHARE_LIMITS.sharesPerAccount,
  sweepEveryMs = LINK_LIMITS.sweepEveryMs,
  onError = () => {},
} = {}) {
  /**
   * share id -> { id, owner (the sending page), name, paid, referral,
   *   recipient (the address's keyed hash, when not a paid account), guest
   *   (the clientId that claimed it, or null), expiresAt }
   */
  const shares = new Map();
  /** account -> ids of its open rooms, oldest first */
  const kept = new Map();
  /** a person who is not a paid account (their keyed hash) -> ids of the open rooms for them */
  const recipients = new Map();

  /** 16 random bytes, 22 base64url characters, never one in use. */
  function newId() {
    let id;
    do {
      id = crypto.randomBytes(16).toString("base64url");
    } while (shares.has(id));
    return id;
  }

  function forget(share) {
    shares.delete(share.id);
    const same = recipients.get(share.recipient);
    same?.delete(share.id);
    if (same && !same.size) recipients.delete(share.recipient);
    const ids = kept.get(share.owner.userId);
    if (!ids) return;
    const index = ids.indexOf(share.id);
    if (index >= 0) ids.splice(index, 1);
    if (!ids.length) kept.delete(share.owner.userId);
  }

  /** The room while it lasts; one that has run out is forgotten on the way. */
  function live(id, at) {
    const share = typeof id === "string" ? shares.get(id) : undefined;
    if (!share) return null;
    if (share.expiresAt > at) return share;
    forget(share);
    return null;
  }

  /**
   * Whether a page holds another open room for the person `share` is for,
   * when that person is not a paid account. A paid account's rooms never are.
   */
  function contested(share, at) {
    if (share.recipient === null) return false;
    for (const id of [...(recipients.get(share.recipient) ?? [])]) {
      if (id === share.id) continue;
      const other = live(id, at);
      if (other && other.guest !== null) return true;
    }
    return false;
  }

  function sweep() {
    const at = now();
    for (const id of [...shares.keys()]) live(id, at);
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
     * A room for `owner`, a phone page ({ userId, address: "phone:<clientId>" }),
     * for a day. One account keeps so many open; the oldest makes room, and
     * its link stops working.
     */
    create(owner, { name, paid, referral = null, recipient = null }) {
      const at = now();
      const { userId } = owner;
      for (let mine = kept.get(userId); mine && mine.length >= sharesPerAccount; mine = kept.get(userId)) {
        const oldest = shares.get(mine[0]);
        if (oldest) forget(oldest);
        else mine.shift();
      }

      const share = {
        id: newId(),
        owner: partyOf(owner),
        name,
        paid: Boolean(paid),
        referral,
        recipient: paid ? null : recipient,
        guest: null,
        expiresAt: at + shareMs,
      };
      shares.set(share.id, share);
      if (!kept.has(userId)) kept.set(userId, []);
      kept.get(userId).push(share.id);
      if (share.recipient !== null) {
        if (!recipients.has(share.recipient)) recipients.set(share.recipient, new Set());
        recipients.get(share.recipient).add(share.id);
      }
      return { share: share.id };
    },

    /** The room a link's id opens, while it lasts; else null. */
    byId(id) {
      return live(id, now());
    },

    /**
     * Whether the room is for a person who is not a paid account and a page
     * holds another open room for them now: a claim of it would be refused.
     */
    contested(id) {
      const at = now();
      const share = live(id, at);
      return Boolean(share) && contested(share, at);
    },

    /**
     * Claim a room for a page's clientId: the first to claim it has it, and
     * claiming it again is the same as once. Any other clientId is refused
     * with share_taken, and a room that is over is share_gone. A room for a
     * person who is not a paid account cannot be claimed while a page holds
     * another room for them (free_transfer_used). That is checked here, with
     * the claim, so two pages can never hold two such rooms at once.
     */
    claim(id, clientId) {
      const at = now();
      const share = live(id, at);
      if (!share) return { ok: false, error: "share_gone" };
      if (share.guest === null) {
        if (contested(share, at)) return { ok: false, error: "free_transfer_used" };
        share.guest = clientId;
      }
      return share.guest === clientId ? { ok: true } : { ok: false, error: "share_taken" };
    },

    /**
     * Whether the guest `clientId` has claimed one of the open rooms of
     * `owner`, that very phone page of that very account: the only guest a
     * phone page may address.
     */
    answers(owner, clientId) {
      const at = now();
      for (const id of [...(kept.get(owner.userId) ?? [])]) {
        const share = live(id, at);
        if (share && share.owner.address === owner.address && share.guest === clientId) return true;
      }
      return false;
    },

    /**
     * End a room. Only its own account can; for anyone else, or a room that
     * is over, nothing happens. True when it ended one.
     */
    end(userId, id) {
      const share = live(id, now());
      if (!share || share.owner.userId !== userId) return false;
      forget(share);
      return true;
    },

    sweep,

    stop() {
      clearInterval(sweeper);
    },

    stats() {
      return { shares: shares.size };
    },
  };
}
