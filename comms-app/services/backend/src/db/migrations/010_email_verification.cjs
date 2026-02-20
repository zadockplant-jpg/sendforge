/**
 * 010_email_verification.cjs
 *
 * Adds email verification fields to users table.
 */

module.exports.up = async function up(knex) {
  const hasEmailVerified = await knex.schema.hasColumn("users", "email_verified");
  if (!hasEmailVerified) {
    await knex.schema.alterTable("users", (t) => {
      t.boolean("email_verified").notNullable().defaultTo(false);
    });
  }

  const hasVerifiedAt = await knex.schema.hasColumn("users", "verified_at");
  if (!hasVerifiedAt) {
    await knex.schema.alterTable("users", (t) => {
      t.timestamp("verified_at").nullable();
    });
  }

  const hasTokenHash = await knex.schema.hasColumn("users", "verification_token_hash");
  if (!hasTokenHash) {
    await knex.schema.alterTable("users", (t) => {
      t.string("verification_token_hash").nullable();
    });
  }

  const hasSentAt = await knex.schema.hasColumn("users", "verification_sent_at");
  if (!hasSentAt) {
    await knex.schema.alterTable("users", (t) => {
      t.timestamp("verification_sent_at").nullable();
    });
  }

  // Helpful index (safe attempt)
  try {
    await knex.schema.alterTable("users", (t) => {
      t.index(["verification_token_hash"], "users_verification_token_hash_idx");
    });
  } catch (_) {}
};

module.exports.down = async function down(knex) {
  // Down migrations are best-effort
  const cols = [
    "email_verified",
    "verified_at",
    "verification_token_hash",
    "verification_sent_at",
  ];

  for (const c of cols) {
    const has = await knex.schema.hasColumn("users", c);
    if (has) {
      await knex.schema.alterTable("users", (t) => t.dropColumn(c));
    }
  }
};