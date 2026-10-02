// DropForge's referral rate: $10 on every sale, for every account (the owner,
// 2026-10-02: "Earn $10 per Referral", chosen as $10 for every owner, paid per
// sale). The DropForge app's button says it; this keeps it true.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isForgeDropAffiliateCode,
  perSaleCentsForCode,
  PER_SALE_CENTS,
} from "../src/services/referrals/referral.service.js";

test("every account earns $10 per DropForge sale unless the owner set its rate", () => {
  assert.equal(PER_SALE_CENTS.forgedrop, 1000);
  assert.equal(perSaleCentsForCode(null, "forgedrop"), 1000, "no code row yet: still $10");
  assert.equal(perSaleCentsForCode({ status: "active", metadata: {} }, "forgedrop"), 1000);
  assert.equal(perSaleCentsForCode({ status: "active", metadata: { affiliate: true } }, "forgedrop"), 1000);
  assert.equal(perSaleCentsForCode({ metadata: { flat_rates: { forgedrop: 1500 } } }, "forgedrop"), 1500,
    "the owner's own rate on a code wins");
  assert.equal(perSaleCentsForCode({ metadata: { flat_rates: { forgedrop: 0 } } }, "forgedrop"), 0,
    "and zero still means this person earns nothing on DropForge");
});

test("other products keep their programmes, and Cloud pickup's share still needs the affiliate level", () => {
  assert.equal(perSaleCentsForCode({ status: "active", metadata: {} }, "rose-colored-glasses"), null,
    "Rose Colored Glasses stays on its milestones");
  assert.equal(perSaleCentsForCode({ status: "active", metadata: {} }, "tabforge"), null);
  assert.equal(isForgeDropAffiliateCode({ status: "active", metadata: {} }), false);
  assert.equal(isForgeDropAffiliateCode({ status: "active", metadata: { affiliate: true } }), true);
});
