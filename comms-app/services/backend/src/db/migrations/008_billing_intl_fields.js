// services/backend/src/db/migrations/008_billing_intl_fields.js
export async function up(knex) {
  const hasUsers = await knex.schema.hasTable("users");
  if (!hasUsers) return;

  await knex.schema.alterTable("users", (t) => {
    t.string("plan_tier").notNullable().defaultTo("free"); // free|pro|business

    t.string("stripe_customer_id").nullable();
    t.boolean("stripe_payment_method_attached").notNullable().defaultTo(false);

    // International spend tracking (in cents)
    t.integer("intl_spend_since_charge_cents").notNullable().defaultTo(0);
    t.integer("intl_spend_cycle_cents").notNullable().defaultTo(0);

    // If payment fails, block intl sends until resolved
    t.string("intl_blocked_reason").nullable(); // e.g. payment_failed
  });
}

export async function down(knex) {
  const hasUsers = await knex.schema.hasTable("users");
  if (!hasUsers) return;

  await knex.schema.alterTable("users", (t) => {
    t.dropColumn("plan_tier");
    t.dropColumn("stripe_customer_id");
    t.dropColumn("stripe_payment_method_attached");
    t.dropColumn("intl_spend_since_charge_cents");
    t.dropColumn("intl_spend_cycle_cents");
    t.dropColumn("intl_blocked_reason");
  });
}
