/**
 * A device's proven identity key (identityProof.service.js).
 *
 * `identity_fingerprint` stays what it was: the fingerprint to show. These
 * two are set only when the device has proven it holds the private half of
 * the key, and cleared if it later reports a different key without proof.
 * Additive and nullable, so every existing row simply reads as "not proven".
 */

export async function up(knex) {
  const hasKey = await knex.schema.hasColumn("device_activations", "identity_public_key");
  if (hasKey) return;
  await knex.schema.alterTable("device_activations", (t) => {
    t.text("identity_public_key").nullable();
    t.timestamp("identity_verified_at", { useTz: true }).nullable();
  });
}

export async function down(knex) {
  const hasKey = await knex.schema.hasColumn("device_activations", "identity_public_key");
  if (!hasKey) return;
  await knex.schema.alterTable("device_activations", (t) => {
    t.dropColumn("identity_public_key");
    t.dropColumn("identity_verified_at");
  });
}
