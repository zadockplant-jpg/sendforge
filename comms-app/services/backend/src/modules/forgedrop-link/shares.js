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
 * One free received transfer per person. Of the rooms for a person who is
 * not a paid account, one at a time holds them: the room claimed last. It
 * holds them only while its sender's page is there (present, as store.js
 * keeps it); meanwhile no other room for that person (from any sender) can
 * be claimed. A room whose sender went away, its connection failed or its
 * sender left without ending it, stops holding them at once, and never
 * blocks their next link. If it comes back while another room holds them,
 * its page can only take them back as a new claim would, once that room no
 * longer holds them.
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
  // Whether a sending page is there now (store.js's isPresent). A room holds
  // its person only while it is; the router passes the real one.
  present = () => true,
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
  /** a person who is not a paid account (their keyed hash) -> the room claimed for them last */
  const holders = new Map();

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
    if (share.recipient !== null && holders.get(share.recipient) === share.id) holders.delete(share.recipient);
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
   * Whether another room holds the person `share` is for, when that person
   * is not a paid account: the room claimed for them last, while it lasts and
   * its sender's page is there. A paid account's rooms never are.
   */
  function contested(share, at) {
    if (share.recipient === null) return false;
    const id = holders.get(share.recipient);
    if (id === undefined || id === share.id) return false;
    const holder = live(id, at);
    return Boolean(holder) && present(holder.owner.userId, holder.owner.address);
  }

  /**
   * Whether `clientId` claiming the room, or offering on it, takes its person:
   * the room's first claim, or, with an offer, its own page coming back to a
   * room that no longer holds them. Never for a paid account's room.
   */
  const takes = (share, clientId, offer) =>
    share.recipient !== null &&
    (share.guest === null || (offer && share.guest === clientId && holders.get(share.recipient) !== share.id));

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
      return { share: share.id };
    },

    /** The room a link's id opens, while it lasts; else null. */
    byId(id) {
      return live(id, now());
    },

    /**
     * Whether an offer from `clientId` on the room would take its person (a
     * first claim, or its page coming back to a room that lost them), and
     * so must be checked first.
     */
    taking(id, clientId) {
      const share = live(id, now());
      return Boolean(share) && takes(share, clientId, true);
    },

    /** Whether another room holds the person this room is for: taking them would be refused. */
    contested(id) {
      const at = now();
      const share = live(id, at);
      return Boolean(share) && contested(share, at);
    },

    /**
     * Claim a room for a page's clientId: the first to claim it has it, and
     * claiming it again is the same as once. Any other clientId is refused
     * with share_taken, and a room that is over is share_gone. A claim, or an
     * offer (`offer`, the default) from the page coming back to a room that
     * lost its person, takes the person, unless another room holds them
     * (free_transfer_used). That is checked here, with the claim, so two
     * rooms can never hold one person at once.
     */
    claim(id, clientId, { offer = true } = {}) {
      const at = now();
      const share = live(id, at);
      if (!share) return { ok: false, error: "share_gone" };
      if (share.guest !== null && share.guest !== clientId) return { ok: false, error: "share_taken" };
      if (takes(share, clientId, offer)) {
        if (contested(share, at)) return { ok: false, error: "free_transfer_used" };
        holders.set(share.recipient, share.id);
      }
      share.guest = clientId;
      return { ok: true };
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
