// Rose Colored Glasses and ForgeDrop referral programmes, on the same
// milestones as TabForge: the 5th, 15th, 25th and 50th referred customer,
// then every 25th after that.
//
// Rose Colored Glasses pays $1 per referral, settled at those milestones
// ($5, $10, $10, $25, then $25 per 25). ForgeDrop pays $25, $50, $60 and $175,
// then $175 per 25.
//
// Written into the programme rows because the owner dashboard edits these rows
// and the reward engine reads them first: a row created earlier with the old
// defaults would otherwise keep them. Render applies this migration on deploy.
// Do not run it locally.
import crypto from "crypto";

const MILESTONES = [5, 15, 25, 50];

function program(amounts, recurringCents, description) {
  return {
    tiers: MILESTONES.map((requiredPurchases, index) => ({ requiredPurchases, rewardAmountCents: amounts[index] })),
    recurringTier: { startAfterPurchases: 50, everyPurchases: 25, rewardAmountCents: recurringCents },
    description,
  };
}

const PROGRAMS = {
  "rose-colored-glasses": program(
    [500, 1000, 1000, 2500],
    2500,
    "Rose Colored Glasses: $1 per referred customer, paid at the milestones: $5 at 5, $10 at 15, $10 at 25, $25 at 50, then $25 for each additional 25 referred customers who bought it."
  ),
  forgedrop: program(
    [2500, 5000, 6000, 17500],
    17500,
    "ForgeDrop: $25 at 5, $50 at 15, $60 at 25, $175 at 50, then $175 for each additional 25 referred customers who bought it."
  ),
};

export async function up(knex) {
  if (!(await knex.schema.hasTable("referral_programs"))) return;

  for (const [slug, terms] of Object.entries(PROGRAMS)) {
    const existing = await knex("referral_programs").where({ product_slug: slug }).first();
    const metadata = {
      ...(existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
      qualification: "verified_purchase",
      tiers: terms.tiers,
      recurringTier: terms.recurringTier,
      referrer_purchase_required: false,
      required_referrer_product_slug: null,
      referred_purchase_required: true,
      payout_hold_days: 10,
      payout_hold_reason: "Fraud/refund verification window before manual Cash App payout.",
      description: terms.description,
    };
    const row = {
      required_purchases: terms.tiers[0].requiredPurchases,
      reward_amount_cents: terms.tiers[0].rewardAmountCents,
      reward_type: "cashapp_manual",
      refund_hold_days: 10,
      status: "active",
      metadata,
      updated_at: knex.fn.now(),
    };
    if (existing) {
      await knex("referral_programs").where({ id: existing.id }).update(row);
    } else {
      await knex("referral_programs").insert({ id: crypto.randomUUID(), product_slug: slug, ...row });
    }
  }
}

// The programmes stay: turning them off would stop rewards people have already
// started earning towards. The owner dashboard can edit or pause them.
export async function down() {}
