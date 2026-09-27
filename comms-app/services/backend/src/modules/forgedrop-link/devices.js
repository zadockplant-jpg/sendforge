/**
 * The account's activated DropForge machines, read from device_activations,
 * the same rows the account page's device list shows and frees; and, for the
 * person relay, the accounts they belong to.
 */

// An X25519 public key as identityProof.service.js stores a proven one.
const IDENTITY_KEY = /^[0-9a-f]{64}$/;

/**
 * Whether a device row holds a proven identity key: one the device showed it
 * holds (identityProof.service.js). Anything less is its own say-so, and
 * nothing is vouched for on its say-so.
 */
export function isProven(row) {
  return Boolean(
    row?.identity_verified_at &&
      row.identity_fingerprint &&
      typeof row.identity_public_key === "string" &&
      IDENTITY_KEY.test(row.identity_public_key)
  );
}

const provenOf = (row) => ({
  deviceId: row.device_id,
  name: row.device_name ?? null,
  identity: row.identity_public_key,
  fingerprint: row.identity_fingerprint,
});

const PROVEN_COLUMNS = [
  "device_id",
  "device_name",
  "identity_public_key",
  "identity_fingerprint",
  "identity_verified_at",
];

export function createDeviceDirectory(db, productSlug) {
  return {
    findActive(userId, deviceId) {
      return db("device_activations")
        .where({ user_id: userId, product_slug: productSlug, device_id: deviceId, status: "active" })
        .first("device_id");
    },

    listActive(userId) {
      return db("device_activations")
        .where({ user_id: userId, product_slug: productSlug, status: "active" })
        .select(
          "device_id",
          "device_name",
          "platform",
          "app_version",
          "identity_fingerprint",
          "identity_verified_at"
        );
    },

    /**
     * One desktop's name and proven identity key: { deviceId, name, identity,
     * fingerprint }. Null if its slot has been freed or it has proved no key.
     */
    async findProven(userId, deviceId) {
      const row = await db("device_activations")
        .where({ user_id: userId, product_slug: productSlug, device_id: deviceId, status: "active" })
        .first(...PROVEN_COLUMNS);
      return isProven(row) ? provenOf(row) : null;
    },

    /** The account's active desktops that have proved their identity key, as findProven gives them. */
    async listProven(userId) {
      const rows = await db("device_activations")
        .where({ user_id: userId, product_slug: productSlug, status: "active" })
        .select(...PROVEN_COLUMNS);
      return rows.filter(isProven).map(provenOf);
    },
  };
}

/**
 * SendForge accounts, as the person relay reads them: a desktop's own by its
 * id, and anyone's by the email that is their address.
 */
export function createAccountDirectory(db) {
  return {
    /** The account's email and whether it is verified; undefined if there is no such account. */
    byId(userId) {
      return db("users").where({ id: userId }).first("email", "email_verified");
    },

    /**
     * The account whose verified email is `address` (already trimmed and in
     * lower case), as { id, email }; else null. Registration stores emails
     * that way, so the match ignoring case is for rows older than that. Were
     * two accounts ever to match, the one stored exactly as the address wins,
     * and otherwise neither does: a knock never goes to a guess.
     *
     * The limit is never reached (emails are unique), so the database reads
     * as far whether or not anyone matches.
     */
    async findVerified(address) {
      const rows = await db("users")
        .whereRaw("lower(email) = ?", [address])
        .andWhere({ email_verified: true })
        .select("id", "email")
        .limit(16);
      return rows.find((row) => row.email === address) ?? (rows.length === 1 ? rows[0] : null);
    },
  };
}
