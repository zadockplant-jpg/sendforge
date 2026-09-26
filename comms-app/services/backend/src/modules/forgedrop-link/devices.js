/**
 * The account's activated ForgeDrop machines, read from device_activations,
 * the same rows the account page's device list shows and frees.
 */

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
  };
}
