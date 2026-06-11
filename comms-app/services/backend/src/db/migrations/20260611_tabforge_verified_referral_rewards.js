import crypto from "crypto";

const MIGRATION_ID = "20260611_tabforge_verified_referral_rewards";
const TABFORGE_TIERS = [
  { requiredPurchases: 5, rewardAmountCents: 1000 },
  { requiredPurchases: 15, rewardAmountCents: 2000 },
  { requiredPurchases: 50, rewardAmountCents: 7500 },
];

export async function up(knex) {
  if (!(await knex.schema.hasTable("referral_programs"))) return;

  const existingProgram = await knex("referral_programs")
    .where({ product_slug: "tabforge" })
    .first();
  const metadata = {
    ...(existingProgram?.metadata || {}),
    qualification: "verified_signup",
    tiers: TABFORGE_TIERS,
    description: "Verified SendForge account referrals earn manual Cash App payouts: $10 at 5, $20 at 15, and $75 at 50. No purchase necessary.",
  };

  await knex("referral_programs")
    .insert({
      id: existingProgram?.id || crypto.randomUUID(),
      product_slug: "tabforge",
      required_purchases: 5,
      reward_amount_cents: 1000,
      reward_type: "cashapp_manual",
      refund_hold_days: 0,
      status: "active",
      metadata,
      created_at: existingProgram?.created_at || knex.fn.now(),
      updated_at: knex.fn.now(),
    })
    .onConflict("product_slug")
    .merge({
      required_purchases: 5,
      reward_amount_cents: 1000,
      reward_type: "cashapp_manual",
      refund_hold_days: 0,
      status: "active",
      metadata,
      updated_at: knex.fn.now(),
    });

  if (!(await knex.schema.hasTable("users")) || !(await knex.schema.hasTable("referral_events"))) return;

  const referredUsers = await knex("users")
    .select("id", "email", "referred_by_user_id", "referral_code_id")
    .whereNotNull("referred_by_user_id")
    .andWhere({ email_verified: true });

  for (const referredUser of referredUsers) {
    const existingEvent = await knex("referral_events")
      .where({
        referred_user_id: referredUser.id,
        product_slug: "tabforge",
        event_type: "signup",
      })
      .first();
    if (existingEvent) continue;

    let referralCodeId = referredUser.referral_code_id || null;
    if (!referralCodeId && (await knex.schema.hasTable("referral_codes"))) {
      const code = await knex("referral_codes")
        .where({ user_id: referredUser.referred_by_user_id, status: "active" })
        .orderBy("created_at", "asc")
        .first();
      referralCodeId = code?.id || null;
    }

    await knex("referral_events").insert({
      id: crypto.randomUUID(),
      referral_code_id: referralCodeId,
      referrer_user_id: referredUser.referred_by_user_id,
      referred_user_id: referredUser.id,
      product_slug: "tabforge",
      purchase_ref: `verified-signup:${referredUser.id}`,
      event_type: "signup",
      status: "verified",
      metadata: {
        qualification: "verified_account",
        referred_email: String(referredUser.email || "").toLowerCase(),
        migration: MIGRATION_ID,
      },
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
  }

  if (!(await knex.schema.hasTable("reward_queue"))) return;

  const counts = await knex("referral_events")
    .select("referrer_user_id")
    .count({ count: "id" })
    .where({ product_slug: "tabforge", event_type: "signup", status: "verified" })
    .whereNotNull("referrer_user_id")
    .groupBy("referrer_user_id");

  for (const row of counts) {
    const verifiedCount = Number(row.count || 0);
    const referrer = await knex("users").where({ id: row.referrer_user_id }).first();
    if (!referrer) continue;

    const code = (await knex.schema.hasTable("referral_codes"))
      ? await knex("referral_codes")
          .where({ user_id: referrer.id, status: "active" })
          .orderBy("created_at", "asc")
          .first()
      : null;

    for (const tier of TABFORGE_TIERS) {
      if (verifiedCount < tier.requiredPurchases) continue;
      const tierKey = `verified_signup:${tier.requiredPurchases}`;
      const existingReward = await knex("reward_queue")
        .where({ user_id: row.referrer_user_id, product_slug: "tabforge" })
        .whereRaw("metadata->>'tier_key' = ?", [tierKey])
        .first();
      if (existingReward) continue;

      await knex("reward_queue").insert({
        id: crypto.randomUUID(),
        referral_code_id: code?.id || null,
        user_id: referrer.id,
        email: String(referrer.email || "").toLowerCase(),
        product_slug: "tabforge",
        reward_amount_cents: tier.rewardAmountCents,
        reward_type: "cashapp_manual",
        cashapp_handle: referrer.cash_app_tag || code?.cashapp_handle || null,
        status: "pending",
        metadata: {
          tier_key: tierKey,
          qualification: "verified_signup",
          tier_required_referrals: tier.requiredPurchases,
          verified_referral_count: verifiedCount,
          migration: MIGRATION_ID,
        },
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    }
  }
}

export async function down(knex) {
  if (await knex.schema.hasTable("reward_queue")) {
    await knex("reward_queue")
      .whereRaw("metadata->>'migration' = ?", [MIGRATION_ID])
      .del();
  }

  if (await knex.schema.hasTable("referral_events")) {
    await knex("referral_events")
      .whereRaw("metadata->>'migration' = ?", [MIGRATION_ID])
      .del();
  }

  if (await knex.schema.hasTable("referral_programs")) {
    await knex("referral_programs")
      .where({ product_slug: "tabforge" })
      .update({
        required_purchases: 5,
        reward_amount_cents: 1000,
        reward_type: "cashapp_manual",
        refund_hold_days: 0,
        status: "active",
        metadata: {
          qualification: "verified_purchase",
          tiers: [
            { requiredPurchases: 5, rewardAmountCents: 1000 },
            { requiredPurchases: 15, rewardAmountCents: 4000 },
            { requiredPurchases: 50, rewardAmountCents: 20000 },
          ],
          description: "Manual Cash App referral payouts at 5, 15, and 50 verified purchases.",
        },
        updated_at: knex.fn.now(),
      });
  }
}
