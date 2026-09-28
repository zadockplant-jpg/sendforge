/**
 * One free received transfer per person whose email is not a paid DropForge
 * account (ForgeDrop/docs/share.md, "Send to email: paid or not").
 *
 * A share room sent to an address that is not a paid account (a verified
 * account that owns DropForge) carries one free transfer. Once a transfer
 * through it has finished, either page reports it and that person's free
 * transfer is used: a new room for them is refused with free_transfer_used,
 * and so is the first offer on a room made for them before. Someone who buys
 * DropForge later is a paid account, and what is kept here no longer counts.
 *
 * A person is their address as personOf writes it, so the aliases of one
 * mailbox count once. Only the free transfer counts people that way; whether
 * an address is a paid account is asked of it as typed.
 *
 * Unlike the rooms, this must survive a deploy, so it is kept in the
 * database: a keyed hash of the person, never the address itself. The key is
 * derived from JWT_SECRET the way the install tokens' is
 * (installTokens.service.js), so there is nothing new to configure. Without a
 * secret nothing is hashed: the caller answers 503 rather than let a transfer
 * go uncounted.
 *
 * Migrations are run by hand, so the table makes itself the first time it is
 * needed, as download_install_tokens does.
 */

import { createHmac } from "node:crypto";

export const FREE_TRANSFERS_TABLE = "forgedrop_free_transfers";
const KEY_LABEL = "sendforge-forgedrop-free-transfer/v1";
const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/**
 * The person an address stands for, as free transfers count them: trimmed
 * and in lower case, without a "+tag" after the name, and at Gmail without
 * the dots in the name, googlemail.com being gmail.com. So
 * "Jo.Ann+photos@GoogleMail.com" is "joann@gmail.com", and
 * "jo.ann+work@example.com" is "jo.ann@example.com".
 */
export function personOf(address) {
  const text = String(address).trim().toLowerCase();
  const at = text.lastIndexOf("@");
  if (at < 0) return text;
  let name = text.slice(0, at);
  let domain = text.slice(at + 1);
  const plus = name.indexOf("+");
  if (plus >= 0) name = name.slice(0, plus);
  if (GMAIL.has(domain)) {
    name = name.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${name}@${domain}`;
}

export async function createFreeTransfersTable(knex) {
  if (await knex.schema.hasTable(FREE_TRANSFERS_TABLE)) return;
  await knex.schema.createTable(FREE_TRANSFERS_TABLE, (t) => {
    t.text("address_hash").primary();
    t.timestamp("used_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

/**
 * `secret` returns the server secret the key is derived from, read on each
 * use so it is never parsed at import time.
 */
export function createFreeTransfers({ db, secret, now = Date.now }) {
  let tableReady = null;
  function ensureTable() {
    tableReady ||= createFreeTransfersTable(db).catch((error) => {
      tableReady = null;
      throw error;
    });
    return tableReady;
  }

  function key() {
    const seed = String(secret?.() || "");
    if (!seed) throw new Error("JWT_SECRET is required for free transfers");
    return createHmac("sha256", seed).update(KEY_LABEL).digest();
  }

  return {
    /** What an address is kept as: the keyed hash of the person it stands for, in hex. */
    keyOf(address) {
      return createHmac("sha256", key()).update(personOf(address)).digest("hex");
    },

    /** Whether the person kept as `addressKey` has had their free transfer. */
    async used(addressKey) {
      await ensureTable();
      const row = await db(FREE_TRANSFERS_TABLE).where({ address_hash: addressKey }).first("address_hash");
      return Boolean(row);
    },

    /** Its free transfer is used. Twice is the same as once: the first time stays. */
    async use(addressKey) {
      await ensureTable();
      await db(FREE_TRANSFERS_TABLE)
        .insert({ address_hash: addressKey, used_at: new Date(now()) })
        .onConflict("address_hash")
        .ignore();
    },
  };
}
