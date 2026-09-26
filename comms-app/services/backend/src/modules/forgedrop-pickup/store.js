/**
 * The pickup rows (migration 20260928_create_forgedrop_pickups.js), and the
 * device and account rows a pickup is checked against.
 */

export const PICKUPS = "forgedrop_pickups";
export const OBJECTS = "forgedrop_pickup_objects";

export const CLOSED_STATUSES = Object.freeze(["picked_up", "expired", "cancelled"]);

// What a row keeps once it is over: the sender's account, bytes and times,
// for the allowance. Everything that says which computer sent what to whom
// goes, with the key.
export const SCRUBBED = Object.freeze({
  sender_device_id: null,
  sender_name: null,
  sender_fingerprint: null,
  sender_identity_key: null,
  recipient_user_id: null,
  recipient_fingerprint: null,
  sealed_key: null,
});

export function createPickupStore(db, { productSlug = "forgedrop" } = {}) {
  return {
    /**
     * An active desktop's name and, if it proved holding it, its identity
     * key and fingerprint (identityProof.service.js). Null if the slot has
     * been freed.
     */
    async device(userId, deviceId) {
      const row = await db("device_activations")
        .where({ user_id: userId, product_slug: productSlug, device_id: deviceId, status: "active" })
        .first("device_name", "identity_fingerprint", "identity_public_key", "identity_verified_at");
      if (!row) return null;
      const proven = Boolean(row.identity_verified_at && row.identity_fingerprint && row.identity_public_key);
      return {
        name: row.device_name ?? null,
        fingerprint: proven ? row.identity_fingerprint : null,
        identityKey: proven ? row.identity_public_key : null,
      };
    },

    /**
     * The active ForgeDrop desktop that proved it holds the key behind this
     * fingerprint. A key activated on two accounts is the same computer;
     * the latest proof names the account.
     */
    provenDevice(fingerprint) {
      return db("device_activations")
        .where({ product_slug: productSlug, identity_fingerprint: fingerprint, status: "active" })
        .whereNotNull("identity_verified_at")
        .orderBy("identity_verified_at", "desc")
        .first("user_id", "device_id");
    },

    account(userId) {
      return db("users").where({ id: userId }).first("email", "email_verified");
    },

    find(id) {
      return db(PICKUPS).where({ id }).first();
    },

    insert(trx, row) {
      return trx(PICKUPS).insert(row);
    },

    async insertObjects(rows) {
      for (let at = 0; at < rows.length; at += 1000) {
        await db(OBJECTS).insert(rows.slice(at, at + 1000));
      }
    },

    objects(id) {
      return db(OBJECTS).where({ pickup_id: id }).orderBy("n", "asc");
    },

    completed(id, n, at) {
      return db(OBJECTS).where({ pickup_id: id, n }).update({ completed_at: at });
    },

    /** Change a pickup only if it is still `from`; false if it was not. */
    async transition(id, from, patch) {
      const changed = await db(PICKUPS).where({ id, status: from }).update(patch);
      return Number(changed) > 0;
    },

    /** Its objects are gone from R2. */
    async deleted(id, at) {
      await db(OBJECTS).where({ pickup_id: id }).del();
      await db(PICKUPS).where({ id }).update({ deleted_at: at });
    },

    waitingFor(fingerprint, at) {
      return db(PICKUPS)
        .where({ recipient_fingerprint: fingerprint, recipient_kind: "device", status: "waiting" })
        .andWhere("expires_at", ">", at)
        .orderBy("created_at", "asc")
        .limit(500);
    },

    // ----------------------------------------------------------- the sweep

    expired(at, limit) {
      return db(PICKUPS).where({ status: "waiting" }).andWhere("expires_at", "<=", at).limit(limit).select("id");
    },

    staleUploads(startedBefore, limit) {
      return db(PICKUPS)
        .where({ status: "uploading" })
        .andWhere("created_at", "<=", startedBefore)
        .limit(limit)
        .select("id");
    },

    /** Over, but deleting its objects failed last time. */
    undeleted(limit) {
      return db(PICKUPS).whereIn("status", CLOSED_STATUSES).whereNull("deleted_at").limit(limit).select("id");
    },

    /**
     * Deleted while its upload links still worked, now that they no longer
     * do: created between `since` and `before` (a link lasts `linkSeconds`).
     */
    deletedEarly(since, before, linkSeconds, limit) {
      return db(PICKUPS)
        .whereIn("status", CLOSED_STATUSES)
        .andWhere("created_at", ">", since)
        .andWhere("created_at", "<=", before)
        .whereNotNull("deleted_at")
        .whereRaw("deleted_at < created_at + (? * interval '1 second')", [linkSeconds])
        .limit(limit)
        .select("id");
    },
  };
}
