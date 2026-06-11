import crypto from "crypto";

const MIGRATION_ID = "20260613_tabforge_pro_purchase_referrals_1_3";
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
    qualification: "verified_purchase",
    tiers: TABFORGE_TIERS,
    referrer_purchase_required: false,
    referred_purchase_required: true,
    description: "The referrer does not need to purchase. Only completed TabForge Pro purchases made through a valid referral count: $10 at 5, $20 at 15, and $75 at 50.",
  };

  await knex("referral_programs")
    .insert({
      id: existingProgram?.id || crypto.randomUUID(),
      product_slug: "tabforge",
      required_purchases: 5,
      reward_amount_cents: 1000,
      reward_type: "cashapp_manual",
      refund_hold_days: existingProgram?.refund_hold_days ?? 0,
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
      status: "active",
      metadata,
      updated_at: knex.fn.now(),
    });

  if (!(await knex.schema.hasTable("referral_events"))) return;

  // Purchases made before email verification remain recorded, but do not count
  // until the purchaser verifies the same SendForge account.
  if (await knex.schema.hasTable("users")) {
    const unverifiedPurchases = await knex("referral_events as re")
      .join("users as u", "u.id", "re.referred_user_id")
      .where({
        "re.product_slug": "tabforge",
        "re.event_type": "purchase",
        "re.status": "verified",
        "u.email_verified": false,
      })
      .select("re.id");

    if (unverifiedPurchases.length) {
      await knex("referral_events")
        .whereIn("id", unverifiedPurchases.map((row) => row.id))
        .update({ status: "pending", updated_at: knex.fn.now() });
    }
  }

  if (!(await knex.schema.hasTable("reward_queue"))) return;

  // Remove only unpaid rewards created by the temporary verified-signup rule.
  // Paid history is intentionally preserved.
  await knex("reward_queue")
    .where({ product_slug: "tabforge" })
    .whereIn("status", ["pending", "approved"])
    .andWhere((builder) => {
      builder
        .whereRaw("metadata->>'qualification' = ?", ["verified_signup"])
        .orWhereRaw("metadata->>'tier_key' LIKE ?", ["verified_signup:%"]);
    })
    .del();

  // Correct unpaid purchase-qualified tier amounts without rewriting paid history.
  for (const tier of TABFORGE_TIERS) {
    await knex("reward_queue")
      .where({ product_slug: "tabforge" })
      .whereIn("status", ["pending", "approved"])
      .andWhere((builder) => {
        builder
          .whereRaw("metadata->>'tier_key' = ?", [`verified_purchase:${tier.requiredPurchases}`])
          .orWhereRaw("metadata->>'tier_required_purchases' = ?", [String(tier.requiredPurchases)]);
      })
      .update({ reward_amount_cents: tier.rewardAmountCents, updated_at: knex.fn.now() });
  }

  if (!(await knex.schema.hasTable("users"))) return;

  const counts = await knex("referral_events")
    .select("referrer_user_id")
    .countDistinct({ count: "referred_user_id" })
    .where({ product_slug: "tabforge", event_type: "purchase", status: "verified" })
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

      const tierKey = `verified_purchase:${tier.requiredPurchases}`;
      const existingReward = await knex("reward_queue")
        .where({ user_id: referrer.id, product_slug: "tabforge" })
        .andWhere((builder) => {
          builder
            .whereRaw("metadata->>'tier_key' = ?", [tierKey])
            .orWhereRaw("metadata->>'tier_required_purchases' = ?", [String(tier.requiredPurchases)]);
        })
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
          qualification: "verified_purchase",
          tier_required_purchases: tier.requiredPurchases,
          verified_purchase_count: verifiedCount,
          migration: MIGRATION_ID,
        },
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    }
  }
}

export async function down(knex) {
  if (!(await knex.schema.hasTable("referral_programs"))) return;

  const existingProgram = await knex("referral_programs")
    .where({ product_slug: "tabforge" })
    .first();
  if (!existingProgram) return;

  await knex("referral_programs")
    .where({ product_slug: "tabforge" })
    .update({
      metadata: {
        ...(existingProgram.metadata || {}),
        qualification: "verified_signup",
        tiers: TABFORGE_TIERS,
        referrer_purchase_required: false,
        referred_purchase_required: false,
        description: "Previous verified-account referral configuration.",
      },
      updated_at: knex.fn.now(),
    });
}
