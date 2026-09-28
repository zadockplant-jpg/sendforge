// The owner renamed ForgeDrop to DropForge (2026-09-27): the programme names
// the owner dashboard shows as stored are renamed, and only where they still
// hold the wording an earlier migration wrote.

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

const { db } = await import("../src/config/db.js");
const { attachPglite } = await import("./helpers/pglite-db.js");
const { up: referralProgramsUp } = await import("../src/db/migrations/20260926_referral_programs_rcg_forgedrop.js");
const { up: recurringPayoutsUp } = await import("../src/db/migrations/20260929_recurring_affiliate_payouts.js");
const rename = await import("../src/db/migrations/20260930_dropforge_program_names.js");

before(async () => {
  await attachPglite(db);
});

after(async () => {
  await db.destroy();
});

const description = async (slug) => (await db("referral_programs").where({ product_slug: slug }).first()).metadata.description;
const label = async (slug) => (await db("subscription_share_programs").where({ program_slug: slug }).first()).label;

test("the stored programme names say DropForge, and running it again changes nothing", async () => {
  await referralProgramsUp(db);
  await recurringPayoutsUp(db);
  assert.equal(await description("forgedrop"), rename.OLD_REFERRAL_DESCRIPTION, "as the earlier migration wrote it");
  assert.equal(await label("forgedrop-cloud-pickup"), rename.OLD_SHARE_LABEL);
  const roseBefore = await description("rose-colored-glasses");

  await rename.up(db);
  assert.equal(await description("forgedrop"), rename.NEW_REFERRAL_DESCRIPTION);
  assert.equal(await label("forgedrop-cloud-pickup"), rename.NEW_SHARE_LABEL);
  assert.equal(await description("rose-colored-glasses"), roseBefore, "other programmes untouched");
  assert.equal(await label("tabforge-subscription"), "TabForge Private Sync");
  const tiers = (await db("referral_programs").where({ product_slug: "forgedrop" }).first()).metadata.tiers;
  assert.deepEqual(tiers.map((tier) => tier.rewardAmountCents), [2500, 5000, 6000, 17500], "the terms stay");

  await rename.up(db);
  assert.equal(await description("forgedrop"), rename.NEW_REFERRAL_DESCRIPTION);
});

test("wording the owner edited in the dashboard is left as it is", async () => {
  const row = await db("referral_programs").where({ product_slug: "forgedrop" }).first();
  await db("referral_programs").where({ id: row.id }).update({ metadata: { ...row.metadata, description: "My own words about ForgeDrop." } });
  await db("subscription_share_programs").where({ program_slug: "forgedrop-cloud-pickup" }).update({ label: "Pickup (ForgeDrop)" });
  await rename.up(db);
  assert.equal(await description("forgedrop"), "My own words about ForgeDrop.");
  assert.equal(await label("forgedrop-cloud-pickup"), "Pickup (ForgeDrop)");
});
