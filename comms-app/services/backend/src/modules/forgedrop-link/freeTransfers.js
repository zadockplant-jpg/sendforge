/**
 * One free received transfer per email that is not a paid DropForge account
 * (ForgeDrop/docs/share.md, "Send to email: paid or not").
 *
 * A share room sent to an address that is not a paid account (a verified
 * account that owns DropForge) carries one free transfer. Once a transfer
 * through it has finished, either page reports it and the address's free
 * transfer is used; a new room for that address is then refused with
 * free_transfer_used. Someone who buys DropForge later is a paid account, and
 * what is kept here no longer counts.
 *
 * Unlike the rooms, this must survive a deploy, so it is kept in the
 * database: a keyed hash of the address, trimmed and in lower case, never the
 * address itself. The key is derived from JWT_SECRET the way the install
 * tokens' is (installTokens.service.js), so there is nothing new to
 * configure. Without a secret nothing is hashed: the caller answers 503
 * rather than let a transfer go uncounted.
 *
 * Migrations are run by hand, so the table makes itself the first time it is
 * needed, as download_install_tokens does.
 */

import { createHmac } from "node:crypto";

export const FREE_TRANSFERS_TABLE = "forgedrop_free_transfers";
const KEY_LABEL = "sendforge-forgedrop-free-transfer/v1";

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
    /** What an address is kept as: its keyed hash, in hex. */
    keyOf(address) {
      return createHmac("sha256", key()).update(String(address).trim().toLowerCase()).digest("hex");
    },

    /** Whether the address kept as `addressKey` has had its free transfer. */
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
