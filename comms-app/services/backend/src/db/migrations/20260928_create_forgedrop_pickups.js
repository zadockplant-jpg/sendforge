/**
 * ForgeDrop Cloud pickup (ForgeDrop/docs/pickup.md): files a sender's
 * computer sealed and left in Cloudflare R2 for a computer that was away, or
 * for someone without ForgeDrop.
 *
 * The server never holds a file name or a key it could use: every object is
 * sealed on the sender's computer, and `sealed_key` is the file key sealed to
 * the recipient computer's identity key. A link pickup has none; its key
 * rides in the link.
 *
 * Once a pickup's objects are deleted (picked up, cancelled, expired), its
 * row keeps only the sender's account, bytes and times, for the monthly
 * allowance: the sending desktop, both fingerprints, the recipient's account
 * and the sealed key are cleared, and its object rows go.
 *
 * Additive: two new tables, nothing else touched.
 */

export async function up(knex) {
  const hasUsers = await knex.schema.hasTable("users");
  if (!hasUsers) return;

  if (!(await knex.schema.hasTable("forgedrop_pickups"))) {
    await knex.schema.createTable("forgedrop_pickups", (t) => {
      t.uuid("id").primary();
      t.uuid("sender_user_id").notNullable();
      t.uuid("sender_device_id").nullable();
      // The sending desktop as it was when the files were left: its name for
      // the email and the recipient's list, and the identity key it had
      // proven, which the recipient checks the sealed key's MAC with.
      t.text("sender_name").nullable();
      t.text("sender_fingerprint").nullable();
      t.text("sender_identity_key").nullable();

      t.text("recipient_kind").notNullable().checkIn(["device", "link"]);
      t.uuid("recipient_user_id").nullable();
      t.text("recipient_fingerprint").nullable();

      t.text("status")
        .notNullable()
        .defaultTo("uploading")
        .checkIn(["uploading", "waiting", "picked_up", "expired", "cancelled"]);
      t.integer("object_count").notNullable();
      // Sealed bytes: the files' objects and the manifest together.
      t.bigInteger("manifest_bytes").notNullable();
      t.bigInteger("total_bytes").notNullable();
      // JSON, the file key sealed to the recipient computer (device only).
      t.text("sealed_key").nullable();

      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("uploaded_at", { useTz: true }).nullable();
      t.timestamp("expires_at", { useTz: true }).notNullable();
      t.timestamp("picked_up_at", { useTz: true }).nullable();
      t.timestamp("deleted_at", { useTz: true }).nullable();

      // GET /waiting: what is left for a computer.
      t.index(["recipient_fingerprint", "status"]);
      // The allowance: an account's pickups this month.
      t.index(["sender_user_id", "created_at"]);
      // The sweep: expired, abandoned, and deletions to try again.
      t.index(["status", "expires_at"]);
      t.index(["status", "created_at"]);
      t.index(["status", "deleted_at"]);
    });
  }

  // One row per object while it is in R2; the multipart upload id for one
  // over 64 MiB. The manifest is always one PUT, its size on the pickup.
  if (!(await knex.schema.hasTable("forgedrop_pickup_objects"))) {
    await knex.schema.createTable("forgedrop_pickup_objects", (t) => {
      t.uuid("pickup_id").notNullable().references("id").inTable("forgedrop_pickups").onDelete("CASCADE");
      t.integer("n").notNullable();
      t.bigInteger("size").notNullable();
      t.text("upload_id").nullable();
      t.bigInteger("part_size").nullable();
      t.timestamp("completed_at", { useTz: true }).nullable();
      t.primary(["pickup_id", "n"]);
    });
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("forgedrop_pickup_objects");
  await knex.schema.dropTableIfExists("forgedrop_pickups");
}
