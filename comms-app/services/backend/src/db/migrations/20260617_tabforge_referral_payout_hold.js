import crypto from "crypto";

const TABFORGE_TIERS = [
  { requiredPurchases: 5, rewardAmountCents: 1000 },
  { requiredPurchases: 15, rewardAmountCents: 2000 },
  { requiredPurchases: 50, rewardAmountCents: 7500 },
];

export async function up(knex) {
  const exists = await knex.schema.hasTable("referral_programs");
  if (!exists) return;

  const now = knex.fn.now();
  const existing = await knex("referral_programs").where({ product_slug: "tabforge" }).first();
  const metadata = {
    ...(existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
    qualification: "verified_purchase",
    tiers: TABFORGE_TIERS,
    payout_hold_days: 10,
    payout_hold_reason: "Fraud/refund verification window before manual Cash App payout.",
    updated_by_migration: "20260617_tabforge_referral_payout_hold",
  };

  if (existing) {
    await knex("referral_programs")
      .where({ id: existing.id })
      .update({
        required_purchases: 5,
        reward_amount_cents: 1000,
        reward_type: existing.reward_type || "cashapp_manual",
        refund_hold_days: 10,
        status: existing.status || "active",
        metadata,
        updated_at: now,
      });
    return;
  }

  await knex("referral_programs").insert({
    id: crypto.randomUUID(),
    product_slug: "tabforge",
    required_purchases: 5,
    reward_amount_cents: 1000,
    reward_type: "cashapp_manual",
    refund_hold_days: 10,
    status: "active",
    metadata,
    created_at: now,
    updated_at: now,
  });
}

export async function down(knex) {
  const exists = await knex.schema.hasTable("referral_programs");
  if (!exists) return;
  const row = await knex("referral_programs").where({ product_slug: "tabforge" }).first();
  if (!row) return;
  await knex("referral_programs")
    .where({ id: row.id })
    .update({
      refund_hold_days: 0,
      metadata: {
        ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
        payout_hold_days: 0,
        reverted_by_migration: "20260617_tabforge_referral_payout_hold",
      },
      updated_at: knex.fn.now(),
    });
}
