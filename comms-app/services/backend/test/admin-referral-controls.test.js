import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  COMP_CODE_ENTITLEMENT_SOURCE,
  PERK_ENTITLEMENT_SLUGS,
  batchPayoutReference,
  commissionSummary,
  groupPerkAccounts,
  isGiftedEntitlement,
  normalizeRecurringTierInput,
  perSaleCommission,
  perkEntitlementMetadata,
  programMetadataFromInput,
} from "../src/services/adminReferralControls.service.js";
import { tiersForVerifiedCount } from "../src/services/referrals/referral.service.js";

const routesUrl = new URL("../src/routes/admin.routes.js", import.meta.url);

test("a perk account is Pro plus Private Sync, marked so it can be listed and revoked", () => {
  assert.deepEqual([...PERK_ENTITLEMENT_SLUGS], ["tabforge", "tabforge-subscription"]);
  const metadata = perkEntitlementMetadata({ adminEmail: " Zadockplant@Gmail.com ", note: "  affiliate onboarding " });
  assert.equal(metadata.perk, true);
  assert.equal(metadata.granted_by, "zadockplant@gmail.com");
  assert.equal(metadata.note, "affiliate onboarding");
  assert.match(metadata.granted_at, /^\d{4}-\d{2}-\d{2}T/);

  const accounts = groupPerkAccounts([
    { user_id: "u1", email: "a@example.com", product_slug: "tabforge", status: "active", source: "admin_perk", granted_at: "2026-09-01T00:00:00Z", metadata: { perk: true, granted_by: "owner@x", note: "creator" }, referral_code: "A1234" },
    { user_id: "u1", email: "a@example.com", product_slug: "tabforge-subscription", status: "active", source: "admin_perk", granted_at: "2026-09-01T00:00:01Z", metadata: { perk: true } },
    { user_id: "u2", email: "b@example.com", product_slug: "tabforge", status: "revoked", source: "admin_perk", granted_at: "2026-08-01T00:00:00Z", metadata: { perk: true, revoked_by: "owner@x" } },
    { user_id: "u3", email: "paid@example.com", product_slug: "tabforge", status: "active", source: "stripe", granted_at: "2026-09-10T00:00:00Z", metadata: {} },
  ]);
  assert.equal(accounts.length, 2, "a paying customer is not a perk account");
  assert.equal(accounts[0].email, "a@example.com");
  assert.deepEqual(accounts[0].products.map((p) => p.slug), ["tabforge", "tabforge-subscription"]);
  assert.equal(accounts[0].active, true);
  assert.equal(accounts[0].referralCode, "A1234");
  assert.equal(accounts[0].note, "creator");
  assert.equal(accounts[1].active, false);
});

// The owner (2026-09-27) found a TabForge Pro account with no Stripe
// payment that Perk Accounts did not list: it came from a comp code, whose
// entitlements are source "comp_code", and the list only took "admin_perk".
test("comp code activations are perk accounts too, with the code they redeemed", async () => {
  const compCodes = await readFile(new URL("../src/services/compCodes.service.js", import.meta.url), "utf8");
  assert.match(compCodes, new RegExp(`export const COMP_CODE_SOURCE = "${COMP_CODE_ENTITLEMENT_SOURCE}";`));
  const accounts = groupPerkAccounts([
    { user_id: "u4", email: "jeff@example.com", product_slug: "tabforge", status: "active", source: "comp_code", granted_at: "2026-09-20T00:00:00Z", metadata: { comp_code: "SENDIT2026" } },
    { user_id: "u4", email: "jeff@example.com", product_slug: "tabforge-subscription", status: "active", source: "comp_code", granted_at: "2026-09-20T00:00:00Z", metadata: { comp_code: "SENDIT2026" } },
    { user_id: "u5", email: "both@example.com", product_slug: "tabforge", status: "active", source: "admin_perk", granted_at: "2026-09-02T00:00:00Z", metadata: { perk: true, note: "creator" } },
    { user_id: "u5", email: "both@example.com", product_slug: "forgedrop", status: "active", source: "comp_code", granted_at: "2026-09-03T00:00:00Z", metadata: { comp_code: "INVITE-ABCD1234" } },
    { user_id: "u6", email: "revoked@example.com", product_slug: "tabforge", status: "revoked", source: "comp_code", granted_at: "2026-08-20T00:00:00Z", metadata: { comp_code: "OLD1", revoked_by: "owner@x" } },
    { user_id: "u7", email: "paid@example.com", product_slug: "tabforge", status: "active", source: "stripe", granted_at: "2026-09-10T00:00:00Z", metadata: {} },
  ]);
  assert.deepEqual(accounts.map((a) => a.email), ["jeff@example.com", "both@example.com", "revoked@example.com"], "a paying customer is still not listed");
  const [jeff, both, revoked] = accounts;
  assert.deepEqual([jeff.sources, jeff.compCode, jeff.active, jeff.products.length], [["comp_code"], "SENDIT2026", true, 2]);
  assert.deepEqual([both.sources, both.compCode, both.note], [["perk", "comp_code"], "INVITE-ABCD1234", "creator"]);
  assert.deepEqual([revoked.sources, revoked.compCode, revoked.active], [["comp_code"], "OLD1", false]);
  assert.equal(isGiftedEntitlement({ source: "stripe", metadata: {} }), false);
});

test("batch payout references stay unique per reward and default to the manual form", () => {
  assert.equal(batchPayoutReference("cashapp 2026-09-18", "r1"), "cashapp 2026-09-18:r1");
  assert.equal(batchPayoutReference("  run  7 ", "r2"), "run 7:r2");
  assert.equal(batchPayoutReference("", "r3"), "manual:r3");
  assert.equal(batchPayoutReference(null, "r4"), "manual:r4");
});

test("$5 per sale becomes a first-purchase milestone plus the same amount every sale after", () => {
  const perSale = perSaleCommission(500);
  assert.deepEqual(perSale.tiers, [{ requiredPurchases: 1, rewardAmountCents: 500 }]);
  assert.deepEqual(perSale.recurringTier, { startAfterPurchases: 1, everyPurchases: 1, rewardAmountCents: 500 });
  assert.equal(perSaleCommission(0), null);

  const metadata = programMetadataFromInput({ tiers: perSale.tiers, recurringTier: perSale.recurringTier, holdDays: 10 });
  const program = { product_slug: "tabforge", required_purchases: 1, reward_amount_cents: 500, refund_hold_days: 10, status: "active", metadata };
  // The referral service pays the third sale as the third tier.
  const tiers = tiersForVerifiedCount(program, 3);
  assert.deepEqual(tiers.map((t) => [t.requiredPurchases, t.rewardAmountCents]), [[1, 500], [2, 500], [3, 500], [4, 500]]);
  const summary = commissionSummary(program);
  assert.equal(summary.mode, "per_sale");
  assert.equal(summary.perSaleRewardCents, 500);
  assert.equal(summary.holdDays, 10);
});

test("milestone programmes keep their tiers, and null switches the recurring rule off", () => {
  const metadata = programMetadataFromInput({
    existingMetadata: { qualification: "verified_purchase", tiers: [{ requiredPurchases: 5, rewardAmountCents: 1700 }] },
    tiers: [{ requiredPurchases: 15, rewardAmountCents: 3500 }, { requiredPurchases: 5, rewardAmountCents: 1700 }, { requiredPurchases: 0, rewardAmountCents: 1 }],
    recurringTier: null,
    holdDays: 14,
  });
  assert.deepEqual(metadata.tiers, [{ requiredPurchases: 5, rewardAmountCents: 1700 }, { requiredPurchases: 15, rewardAmountCents: 3500 }], "invalid tiers are dropped and the rest sorted");
  assert.deepEqual(metadata.recurringTier, { enabled: false });
  assert.equal(metadata.payout_hold_days, 14);
  const program = { product_slug: "tabforge", status: "active", metadata };
  assert.equal(commissionSummary(program).recurringTier, null, "the built-in recurring default must not come back");
  assert.equal(commissionSummary(program).mode, "milestones");
  assert.deepEqual(tiersForVerifiedCount(program, 100).map((t) => t.requiredPurchases), [5, 15]);

  assert.equal(normalizeRecurringTierInput({ startAfterPurchases: 50, everyPurchases: 25, rewardAmountCents: 15000 }).everyPurchases, 25);
  assert.equal(normalizeRecurringTierInput({ startAfterPurchases: 0, everyPurchases: 25, rewardAmountCents: 15000 }), null);
  const untouched = programMetadataFromInput({ existingMetadata: { recurringTier: { startAfterPurchases: 50, everyPurchases: 25, rewardAmountCents: 15000 } }, tiers: [{ requiredPurchases: 5, rewardAmountCents: 1700 }] });
  assert.deepEqual(untouched.recurringTier, { startAfterPurchases: 50, everyPurchases: 25, rewardAmountCents: 15000 }, "an absent key leaves the stored rule alone");
});

test("the admin router exposes batch payouts and perk accounts on the shared status logic", async () => {
  const source = await readFile(routesUrl, "utf8");
  // `outer` lets a monthly statement run each row's change as a savepoint of its own transaction.
  assert.match(source, /async function applyRewardStatusChange\(req, rewardId, data, outer = null\)/);
  assert.match(source, /createAdminRecurringPayoutsRouter\(\{\s*applyRewardStatusChange,/);
  assert.match(source, /async function updateRewardStatus\(req, res\) \{[\s\S]*?applyRewardStatusChange\(req, req\.params\.id, parsed\.data\)/);
  assert.match(source, /adminRouter\.post\("\/rewards\/batch", writeLimiter/);
  assert.match(source, /payoutReference: status === "paid" \? batchPayoutReference\(batchReference, id\) : undefined/);
  assert.match(source, /adminRouter\.get\("\/perks"/);
  assert.match(source, /adminRouter\.post\("\/perks\/grant", writeLimiter/);
  assert.match(source, /adminRouter\.post\("\/perks\/revoke", writeLimiter/);
  assert.match(source, /source: PERK_ENTITLEMENT_SOURCE, sourceRef: req\.admin\.email/);
  assert.match(source, /perSaleRewardCents: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
  assert.match(source, /recurringTier: RecurringTierSchema\.nullable\(\)\.optional\(\)/);
  // The owner is the one administrator, fixed in the admin middleware.
  const middleware = await readFile(new URL("../src/middleware/adminAuth.js", import.meta.url), "utf8");
  assert.match(middleware, /SENDFORGE_ADMIN_EMAIL = "zadockplant@gmail\.com"/);
  assert.match(source, /function isAllowedAdmin\(email\) \{ return isSendForgeAdmin\(email\); \}/);
  // Every write on these routes still passes through the admin gates.
  assert.ok(source.indexOf("adminRouter.use(requireAdminAuth);") < source.indexOf('adminRouter.post("/rewards/batch"'));
  assert.ok(source.indexOf("adminRouter.use(requireAdminWritesEnabled);") < source.indexOf('adminRouter.post("/perks/grant"'));
});
