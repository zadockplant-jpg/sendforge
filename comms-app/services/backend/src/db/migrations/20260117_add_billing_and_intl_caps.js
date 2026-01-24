export async function up(knex) {
  const hasUsers = await knex.schema.hasTable("users");
  if (!hasUsers) return;

  // plan_tier
  if (!(await knex.schema.hasColumn("users", "plan_tier"))) {
    await knex.schema.alterTable("users", (t) => {
      t.string("plan_tier").notNullable().defaultTo("free");
    });
  }

  // billing_source
  if (!(await knex.schema.hasColumn("users", "billing_source"))) {
    await knex.schema.alterTable("users", (t) => {
      t.string("billing_source").notNullable().defaultTo("stripe");
    });
  }

  // stripe_customer_id
  if (!(await knex.schema.hasColumn("users", "stripe_customer_id"))) {
    await knex.schema.alterTable("users", (t) => {
      t.string("stripe_customer_id").nullable();
    });
  }

  // stripe_payment_method_attached
  if (!(await knex.schema.hasColumn("users", "stripe_payment_method_attached"))) {
    await knex.schema.alterTable("users", (t) => {
      t.boolean("stripe_payment_method_attached").notNullable().defaultTo(false);
    });
  }

  // intl_spend_since_charge_cents
  if (!(await knex.schema.hasColumn("users", "intl_spend_since_charge_cents"))) {
    await knex.schema.alterTable("users", (t) => {
      t.integer("intl_spend_since_charge_cents").notNullable().defaultTo(0);
    });
  }

  // intl_spend_cycle_cents
  if (!(await knex.schema.hasColumn("users", "intl_spend_cycle_cents"))) {
    await knex.schema.alterTable("users", (t) => {
      t.integer("intl_spend_cycle_cents").notNullable().defaultTo(0);
    });
  }

  // intl_blocked_reason
  if (!(await knex.schema.hasColumn("users", "intl_blocked_reason"))) {
    await knex.schema.alterTable("users", (t) => {
      t.string("intl_blocked_reason").nullable();
    });
  }
}
export async function down(knex) {
  const hasUsers = await knex.schema.hasTable("users");
  if (!hasUsers) return;

  await knex.schema.alterTable("users", (t) => {
    t.dropColumn("plan_tier");
    t.dropColumn("billing_source");
    t.dropColumn("stripe_customer_id");
    t.dropColumn("stripe_payment_method_attached");
    t.dropColumn("intl_spend_since_charge_cents");
    t.dropColumn("intl_spend_cycle_cents");
    t.dropColumn("intl_blocked_reason");
  });
}
