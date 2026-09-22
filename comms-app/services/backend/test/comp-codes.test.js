import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  COMP_CODE_SOURCE,
  COMP_GRANT_SLUGS,
  DEFAULT_COMP_CODES,
  DEFAULT_COMP_MAX_REDEMPTIONS,
  RETIRED_COMP_CODES,
  compCodeAvailability,
  compCodePublicView,
  compCodeSignupLink,
  isCompCodeRow,
  normalizeCompCode,
} from "../src/services/compCodes.service.js";

const src = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("no shared comp code is seeded any more, and the retired one is named", () => {
  assert.deepEqual([...DEFAULT_COMP_CODES], [], "nothing ships pre-created");
  assert.ok(
    RETIRED_COMP_CODES.includes("SENDIT2026"),
    "the old shared launch code is retired on boot, not left active"
  );
  assert.equal(compCodeSignupLink("creator-abc1"), "/signup.html?ref=CREATOR-ABC1");
  assert.deepEqual([...COMP_GRANT_SLUGS], ["tabforge", "tabforge-subscription"], "Pro and Private Sync");
  assert.equal(COMP_CODE_SOURCE, "comp_code");
});

test("a code with no stated limit is good for exactly one account", () => {
  // The rule that matters: codes are issued one per person by the outreach
  // tool. A code that leaks must stop working once somebody claims it, so an
  // absent limit means one, never unlimited.
  assert.equal(DEFAULT_COMP_MAX_REDEMPTIONS, 1);
  const unstated = { code: "CREATOR-ABC1", status: "active", metadata: { kind: "comp" } };
  assert.deepEqual(compCodeAvailability(unstated, 0), { available: true, reason: null, remaining: 1 });
  assert.deepEqual(compCodeAvailability(unstated, 1), { available: false, reason: "code_exhausted", remaining: 0 });

  const nulled = { ...unstated, metadata: { kind: "comp", max_redemptions: null } };
  assert.deepEqual(compCodeAvailability(nulled, 1), { available: false, reason: "code_exhausted", remaining: 0 });

  const zero = { ...unstated, metadata: { kind: "comp", max_redemptions: 0 } };
  assert.deepEqual(compCodeAvailability(zero, 1), { available: false, reason: "code_exhausted", remaining: 0 });
});

test("codes normalise the way people type them", () => {
  assert.equal(normalizeCompCode(" #sendit2026 "), "SENDIT2026");
  assert.equal(normalizeCompCode("send it 2026!"), "SENDIT2026");
  assert.equal(normalizeCompCode(""), "");
  assert.equal(normalizeCompCode(null), "");
});

test("availability honours status, expiry and the redemption limit", () => {
  const row = { code: "CREATOR-ABC1", status: "active", metadata: { kind: "comp", max_redemptions: 1 } };
  assert.equal(isCompCodeRow(row), true);
  assert.equal(isCompCodeRow({ code: "CREATOR1", status: "active", metadata: {} }), false, "a referrer's code is not a comp code");
  assert.deepEqual(compCodeAvailability(row, 0), { available: true, reason: null, remaining: 1 });
  assert.deepEqual(compCodeAvailability(row, 1), { available: false, reason: "code_exhausted", remaining: 0 }, "spent by the first account that redeems it");
  assert.deepEqual(compCodeAvailability({ ...row, status: "inactive" }, 0), { available: false, reason: "code_inactive", remaining: null });
  assert.deepEqual(compCodeAvailability({ ...row, metadata: { kind: "comp", expires_at: "2020-01-01T00:00:00Z" } }, 0), { available: false, reason: "code_expired", remaining: null });
  const limited = { ...row, metadata: { kind: "comp", max_redemptions: 100 } };
  assert.deepEqual(compCodeAvailability(limited, 99), { available: true, reason: null, remaining: 1 });
  assert.deepEqual(compCodeAvailability(limited, 100), { available: false, reason: "code_exhausted", remaining: 0 });
  assert.deepEqual(compCodeAvailability({ code: "X", status: "active", metadata: {} }, 0), { available: false, reason: "unknown_code", remaining: null });

  const view = compCodePublicView(row, compCodeAvailability(row, 0));
  assert.deepEqual(view, { code: "CREATOR-ABC1", valid: true, reason: null, grants: ["TabForge Pro", "Private Sync"], note: null, commission: null });
  const withPlan = compCodePublicView({ ...row, metadata: { ...row.metadata, commission: { mode: "per_sale", rewardAmountCents: 500 } } }, compCodeAvailability(row, 0));
  assert.deepEqual(withPlan.commission, { mode: "per_sale", rewardAmountCents: 500 }, "the signup page can say what the affiliate earns");
});

test("the code is remembered at signup, redeemed at verification, and manageable by the owner", async () => {
  const auth = await src("../src/routes/auth.routes.js");
  assert.match(auth, /import \{ noteCompCodeForUser \} from "\.\.\/services\/compCodes\.service\.js";/);
  assert.equal((auth.match(/await noteCompCodeForUser\(\{ trx, userId: [a-z.]+, code: effectiveReferralIdentifier \}\);/g) || []).length, 2, "both signup paths remember the code");

  const verify = await src("../src/routes/verification.routes.js");
  assert.match(verify, /redeemPendingCompCodeForVerifiedUser\(user\.id\)/);
  assert.ok(verify.indexOf("email_verified: true") < verify.indexOf("redeemPendingCompCodeForVerifiedUser(user.id)"), "redeemed only after the address is verified");
  assert.match(verify, /catch \(compError\)/, "never blocks verification");

  const account = await src("../src/routes/account.routes.js");
  assert.match(account, /accountRouter\.get\("\/comp-codes\/:code", async/);
  assert.match(account, /accountRouter\.post\("\/comp-codes\/redeem", requireAuth/);

  const admin = await src("../src/routes/admin.routes.js");
  assert.match(admin, /adminRouter\.get\("\/comp-codes"/);
  assert.match(admin, /adminRouter\.post\("\/comp-codes", writeLimiter/);
  assert.match(admin, /adminRouter\.patch\("\/comp-codes\/:code", writeLimiter/);
  assert.ok(admin.indexOf("adminRouter.use(requireAdminAuth);") < admin.indexOf('adminRouter.get("/comp-codes"'));

  const server = await src("../src/server.js");
  assert.match(server, /ensureDefaultCompCodes\(\)\.catch/);

  // Comp codes never attribute a referral: the resolver requires an owner
  // with Pro, and comp rows have no owner.
  const referral = await src("../src/services/referrals/referral.service.js");
  assert.match(referral, /const user = code\.user_id\s*\?[\s\S]*?: null;\s*if \(\s*!user \|\|/);
});

test("a comp-code account is on a $5 per-sale plan that the reward engine and both dashboards read", async () => {
  const { commissionPlanForReferralCode, effectiveProgramForReferrer, tiersForVerifiedCount } = await import("../src/services/referrals/referral.service.js");
  const { compCodeCommission } = await import("../src/services/compCodes.service.js");

  const terms = { mode: "per_sale", rewardAmountCents: 500 };
  assert.deepEqual(compCodeCommission({ metadata: { kind: "comp", commission: terms } }), terms);
  assert.equal(compCodeCommission({ metadata: { kind: "comp" } }), null, "a code with no terms leaves the account on milestones");

  const affiliateCode = { code: "AFFIL1234", metadata: { commission: { ...terms, source: "comp_code", code: "CREATOR-ABC1" } } };
  assert.deepEqual(commissionPlanForReferralCode(affiliateCode), { mode: "per_sale", rewardAmountCents: 500, source: "comp_code", code: "CREATOR-ABC1" });
  assert.equal(commissionPlanForReferralCode({ code: "PLAIN1", metadata: {} }), null, "a normal referrer stays on milestones");

  const programme = { product_slug: "tabforge", status: "active", metadata: { tiers: [{ requiredPurchases: 5, rewardAmountCents: 1700 }] } };
  const effective = effectiveProgramForReferrer(programme, affiliateCode);
  assert.deepEqual(tiersForVerifiedCount(effective, 3).map((t) => [t.requiredPurchases, t.rewardAmountCents]), [[1, 500], [2, 500], [3, 500], [4, 500]], "every sale pays $5");
  assert.deepEqual(tiersForVerifiedCount(effectiveProgramForReferrer(programme, { metadata: {} }), 3).map((t) => t.requiredPurchases), [5], "the programme is untouched for everyone else");

  const referral = await src("../src/services/referrals/referral.service.js");
  assert.match(referral, /tiersForVerifiedCount\(effectiveProgramForReferrer\(program, referralCode\), verifiedCount\)/, "the queue uses the referrer's plan");
  const comp = await src("../src/services/compCodes.service.js");
  assert.match(comp, /const plan = await applyCompCodeCommission\(\{ trx, userId, compRow: row \}\);/, "redeeming applies the terms");
  const account = await src("../src/routes/account.routes.js");
  assert.match(account, /plan: referralPlan \|\| \{ mode: "milestones" \}/, "the account API says which plan");
  assert.match(account, /tiersForVerifiedCount\(effectiveProgramForReferrer\(program, code\), verifiedPurchases\)/);
  const admin = await src("../src/routes/admin.routes.js");
  assert.match(admin, /row\.plan = planByEmail\.get\(normalizeEmail\(row\.referrerEmail\)\) \|\| \{ mode: "milestones" \}/, "the owner catalogue says which plan");
});
