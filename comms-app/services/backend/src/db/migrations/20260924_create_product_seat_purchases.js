/**
 * Seats: one row per paid purchase of a per-device product.
 *
 * Rose Colored Glasses sells one device per purchase. `product_entitlements`
 * cannot count that - it holds one row per (user, product) and a second
 * purchase merges into the first - so the number of machines an account may
 * activate is the sum of `quantity` over its active rows here.
 *
 * `purchase_ref` is the Stripe payment the seats came from, suffixed with the
 * product. Unique, so a replayed checkout webhook cannot add seats twice.
 *
 * A refund or dispute flips `status`, never deletes: the row is also the
 * record of what was sold, and a seat that silently vanished would be
 * indistinguishable from one that was never bought.
 */

export async function up(knex) {
  const hasUsers = await knex.schema.hasTable("users");
  if (!hasUsers) return;

  if (await knex.schema.hasTable("product_seat_purchases")) return;

  await knex.schema.createTable("product_seat_purchases", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable();
    t.text("product_slug").notNullable();
    t.text("purchase_ref").notNullable().unique();
    t.integer("quantity").notNullable();
    t.integer("amount_cents").notNullable().defaultTo(0);
    t.text("payment_intent").nullable().index();
    t.text("checkout_session_id").nullable();

    // active | refunded | disputed | payment_failed
    t.text("status").notNullable().defaultTo("active");
    t.timestamp("reversed_at", { useTz: true }).nullable();

    t.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(["user_id", "product_slug", "status"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("product_seat_purchases");
}
