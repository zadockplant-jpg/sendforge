/**
 * Device activation and per-product activation codes.
 *
 * Deliberately product-agnostic: ForgeDrop is the first product to use it, but
 * an Android client and any later licensed product reuse the same two tables
 * rather than growing their own.
 *
 * Activation codes are stored readable, not hashed, and that is deliberate.
 * The owner has to be able to read the code off their account page once per
 * machine, up to five times, months apart. A write-only code would mean
 * "regenerate and re-activate everything" every time someone reinstalls, which
 * is the kind of friction that generates support mail for a $20 product.
 *
 * The code is not a credential. It grants nothing on its own: activation still
 * requires the owning account to hold the entitlement, and a stolen code only
 * lets a thief burn slots the owner can take back from the device list. Anyone
 * who can read this table can already read `product_entitlements` and grant
 * themselves the product outright, so hashing here would protect nothing.
 */

export async function up(knex) {
  const hasUsers = await knex.schema.hasTable("users");
  if (!hasUsers) return;

  const hasCodes = await knex.schema.hasTable("product_activation_codes");
  if (!hasCodes) {
    await knex.schema.createTable("product_activation_codes", (t) => {
      t.uuid("id").primary();
      t.uuid("user_id").notNullable().index();
      t.text("product_slug").notNullable();

      // Display form, dashes and all: FD-AB3K-9X2M-PQ7R
      t.text("code").notNullable();
      // Same code with the dashes and case stripped. Lookup hits this, so a
      // user can type it however it comes out of their notes app.
      t.text("code_normalized").notNullable();

      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("rotated_at", { useTz: true }).nullable();
      t.timestamp("last_used_at", { useTz: true }).nullable();

      // One live code per user per product. Rotating replaces it in place.
      t.unique(["user_id", "product_slug"]);
      t.unique(["code_normalized"]);
    });
  }

  const hasDevices = await knex.schema.hasTable("device_activations");
  if (hasDevices) return;

  await knex.schema.createTable("device_activations", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable().index();
    t.text("product_slug").notNullable();
    t.uuid("device_id").notNullable();
    t.text("device_name").nullable();
    t.text("platform").nullable();
    t.text("app_version").nullable();

    // The app's X25519 fingerprint, shown so a user can tell two machines
    // apart in the device list. Display only - the licence is never bound to
    // it, because it is broadcast over mDNS and the user can delete it.
    t.text("identity_fingerprint").nullable();

    t.text("license_kid").nullable();
    t.timestamp("license_issued_at", { useTz: true }).nullable();
    t.timestamp("last_seen_at", { useTz: true }).nullable();

    t.text("status").notNullable().defaultTo("active");
    t.timestamp("deactivated_at", { useTz: true }).nullable();
    t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Re-activating a device already on the account must not consume a second
    // slot, so the same device_id has to collide rather than insert.
    t.unique(["user_id", "product_slug", "device_id"]);
    t.index(["user_id", "product_slug", "status"]);
    t.index(["product_slug", "status"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("device_activations");
  await knex.schema.dropTableIfExists("product_activation_codes");
}
