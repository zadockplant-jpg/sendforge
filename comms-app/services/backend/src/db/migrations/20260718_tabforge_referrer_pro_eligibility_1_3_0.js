import crypto from "crypto";

const MIGRATION_ID = "20260718_tabforge_referrer_pro_eligibility_1_3_0";
const TABFORGE_TIERS = [
  { requiredPurchases: 5, rewardAmountCents: 1700 },
  { requiredPurchases: 15, rewardAmountCents: 3500 },
  { requiredPurchases: 25, rewardAmountCents: 4000 },
  { requiredPurchases: 50, rewardAmountCents: 15000 },
];
const RECURRING_TIER = {
  startAfterPurchases: 50,
  everyPurchases: 25,
  rewardAmountCents: 15000,
};

export async function up(knex) {
  if (!(await knex.schema.hasTable("referral_programs"))) return;

  const existing = await knex("referral_programs")
    .where({ product_slug: "tabforge" })
    .first();
  const metadata = {
    ...(existing?.metadata || {}),
    qualification: "verified_purchase",
    tiers: TABFORGE_TIERS,
    recurringTier: RECURRING_TIER,
    referrer_purchase_required: true,
    required_referrer_product_slug: "tabforge",
    referred_purchase_required: true,
    description:
      "The referrer must own TabForge Pro. Only completed TabForge Pro purchases made through the referral link count: $17 at 5, $35 at 15, $40 at 25, $150 at 50, then $150 for each additional 25 qualified purchases.",
    policy_migration: MIGRATION_ID,
  };

  await knex("referral_programs")
    .insert({
      id: existing?.id || crypto.randomUUID(),
      product_slug: "tabforge",
      required_purchases: 5,
      reward_amount_cents: 1700,
      reward_type: existing?.reward_type || "cashapp_manual",
      refund_hold_days: existing?.refund_hold_days ?? 10,
      status: "active",
      metadata,
      created_at: existing?.created_at || knex.fn.now(),
      updated_at: knex.fn.now(),
    })
    .onConflict("product_slug")
    .merge({
      required_purchases: 5,
      reward_amount_cents: 1700,
      status: "active",
      metadata,
      updated_at: knex.fn.now(),
    });
}

export async function down(knex) {
  if (!(await knex.schema.hasTable("referral_programs"))) return;

  const existing = await knex("referral_programs")
    .where({ product_slug: "tabforge" })
    .first();
  if (!existing) return;

  await knex("referral_programs")
    .where({ product_slug: "tabforge" })
    .update({
      metadata: {
        ...(existing.metadata || {}),
        referrer_purchase_required: false,
        required_referrer_product_slug: null,
        referred_purchase_required: true,
        description:
          "The referrer may participate without purchasing. Only completed TabForge Pro purchases made through the referral link count.",
        policy_migration: null,
      },
      updated_at: knex.fn.now(),
    });
}
