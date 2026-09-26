// The Rose Colored Glasses and ForgeDrop programmes the migration writes, and
// what the reward engine reads back from them.

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { attachPglite } from "./helpers/pglite-db.js";

const { db } = await import("../src/config/db.js");
const { up } = await import("../src/db/migrations/20260926_referral_programs_rcg_forgedrop.js");
const {
  PRODUCT_REFERRAL_PROGRAMS,
  getReferralProgram,
  programDescription,
  recurringTierFromProgram,
  tiersFromProgram,
  tiersForVerifiedCount,
} = await import("../src/services/referrals/referral.service.js");

let detach;
before(async () => { detach = await attachPglite(db); });
after(async () => { await detach?.(); });

const amounts = (program) => tiersFromProgram(program).map((tier) => [tier.requiredPurchases, tier.rewardAmountCents]);

test("the migration writes both programmes, over a row created earlier with the old defaults", async () => {
  // A row the old code would have created on first use: TabForge's amounts.
  await db("referral_programs").insert({ id: "00000000-0000-4000-8000-000000000001", product_slug: "forgedrop", metadata: { tiers: [{ requiredPurchases: 5, rewardAmountCents: 1700 }], note: "kept" } });
  await up(db);
  await up(db); // running it again changes nothing

  const rcg = await getReferralProgram("rose-colored-glasses");
  const drop = await getReferralProgram("forgedrop");
  assert.deepEqual(amounts(rcg), [[5, 500], [15, 1000], [25, 1000], [50, 2500]]);
  assert.deepEqual(recurringTierFromProgram(rcg), { startAfterPurchases: 50, everyPurchases: 25, rewardAmountCents: 2500 });
  assert.deepEqual(amounts(drop), [[5, 2500], [15, 5000], [25, 6000], [50, 17500]]);
  assert.deepEqual(recurringTierFromProgram(drop), { startAfterPurchases: 50, everyPurchases: 25, rewardAmountCents: 17500 });
  assert.equal(drop.metadata.note, "kept", "other settings on the row survive");
  assert.equal((await db("referral_programs").where({ product_slug: "forgedrop" })).length, 1);
});

test("the code's own defaults match the migration, and pay $1 per Rose Colored Glasses referral", () => {
  const rcg = PRODUCT_REFERRAL_PROGRAMS["rose-colored-glasses"];
  // After the 50th, every 25th pays $25: always $1 per customer.
  const tiers = tiersForVerifiedCount({ product_slug: "rose-colored-glasses", metadata: {} }, 100);
  const paidAt100 = tiers.filter((tier) => tier.requiredPurchases <= 100).reduce((sum, tier) => sum + tier.rewardAmountCents, 0);
  assert.equal(paidAt100, 100 * rcg.perReferralCents);
  assert.deepEqual(amounts({ product_slug: "tabforge", metadata: {} }), [[5, 1700], [15, 3500], [25, 4000], [50, 15000]], "TabForge is unchanged");
  assert.match(programDescription("forgedrop"), /\$25 at 5, \$50 at 15, \$60 at 25, \$175 at 50, then \$175 for each additional 25/);
  assert.match(programDescription("rose-colored-glasses"), /\$1 per referred customer/);
});
