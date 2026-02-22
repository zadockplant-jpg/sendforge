/**
 * 011_fix_email_verification_columns.cjs
 *
 * Cleans legacy email verification schema.
 * - Drops email_verify_token
 * - Ensures verification_token_hash
 * - Ensures verification_sent_at
 * - Ensures verified_at
 */

module.exports.up = async function up(knex) {
  const hasLegacy = await knex.schema.hasColumn("users", "email_verify_token");

  if (hasLegacy) {
    await knex.schema.alterTable("users", (t) => {
      t.dropColumn("email_verify_token");
    });
  }

  const ensure = async (col, builder) => {
    const has = await knex.schema.hasColumn("users", col);
    if (!has) {
      await knex.schema.alterTable("users", builder);
    }
  };

  await ensure("verification_token_hash", (t) =>
    t.string("verification_token_hash").nullable()
  );

  await ensure("verification_sent_at", (t) =>
    t.timestamp("verification_sent_at").nullable()
  );

  await ensure("verified_at", (t) =>
    t.timestamp("verified_at").nullable()
  );
};

module.exports.down = async function down(knex) {
  // No destructive rollback for safety
};