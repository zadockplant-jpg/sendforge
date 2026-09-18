import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  COMP_CODE_SOURCE,
  COMP_GRANT_SLUGS,
  DEFAULT_COMP_CODES,
  compCodeAvailability,
  compCodePublicView,
  compCodeSignupLink,
  isCompCodeRow,
  normalizeCompCode,
} from "../src/services/compCodes.service.js";

const src = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("SENDIT2026 ships as the launch comp code and its link goes to signup", () => {
  const launch = DEFAULT_COMP_CODES.find((c) => c.code === "SENDIT2026");
  assert.ok(launch, "the launch code is seeded");
  assert.equal(launch.maxRedemptions, null, "unlimited");
  assert.equal(compCodeSignupLink("sendit2026"), "/signup.html?ref=SENDIT2026");
  assert.deepEqual([...COMP_GRANT_SLUGS], ["tabforge", "tabforge-subscription"], "Pro and Private Sync");
  assert.equal(COMP_CODE_SOURCE, "comp_code");
});

test("codes normalise the way people type them", () => {
  assert.equal(normalizeCompCode(" #sendit2026 "), "SENDIT2026");
  assert.equal(normalizeCompCode("send it 2026!"), "SENDIT2026");
  assert.equal(normalizeCompCode(""), "");
  assert.equal(normalizeCompCode(null), "");
});

test("availability honours status, expiry and the redemption limit", () => {
  const row = { code: "SENDIT2026", status: "active", metadata: { kind: "comp", max_redemptions: null } };
  assert.equal(isCompCodeRow(row), true);
  assert.equal(isCompCodeRow({ code: "CREATOR1", status: "active", metadata: {} }), false, "a referrer's code is not a comp code");
  assert.deepEqual(compCodeAvailability(row, 9999), { available: true, reason: null, remaining: null });
  assert.deepEqual(compCodeAvailability({ ...row, status: "inactive" }, 0), { available: false, reason: "code_inactive", remaining: null });
  assert.deepEqual(compCodeAvailability({ ...row, metadata: { kind: "comp", expires_at: "2020-01-01T00:00:00Z" } }, 0), { available: false, reason: "code_expired", remaining: null });
  const limited = { ...row, metadata: { kind: "comp", max_redemptions: 100 } };
  assert.deepEqual(compCodeAvailability(limited, 99), { available: true, reason: null, remaining: 1 });
  assert.deepEqual(compCodeAvailability(limited, 100), { available: false, reason: "code_exhausted", remaining: 0 });
  assert.deepEqual(compCodeAvailability({ code: "X", status: "active", metadata: {} }, 0), { available: false, reason: "unknown_code", remaining: null });

  const view = compCodePublicView(row, compCodeAvailability(row, 0));
  assert.deepEqual(view, { code: "SENDIT2026", valid: true, reason: null, grants: ["TabForge Pro", "Private Sync"], note: null });
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
