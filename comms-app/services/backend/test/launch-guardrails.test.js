import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { recordReferralPurchase } from "../src/services/referrals/referral.service.js";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("public Checkout surfaces allow synchronous card payments only", async () => {
  const [billing, inmate] = await Promise.all([
    source("src/routes/billing.routes.js"),
    source("src/services/inmate.records/checkout.service.js"),
  ]);

  assert.ok(
    (billing.match(/payment_method_types:\s*\["card"\]/g) || []).length >= 2,
    "catalog and donation Checkout must both force cards"
  );
  assert.match(billing, /paymentPolicy:\s*"card_only_v1"/);
  assert.match(billing, /tabforge-checkout-v4/);
  assert.match(inmate, /payment_method_types:\s*\["card"\]/);
});

test("unverified subscription activation surfaces fail closed", async () => {
  const billing = await source("src/routes/billing.routes.js");

  assert.match(billing, /manual_activation_retired/);
  assert.match(billing, /apple_receipt_ingest_unavailable/);
  assert.match(billing, /google_receipt_ingest_unavailable/);
  assert.ok(
    (billing.match(/return res\.status\(410\)/g) || []).length >= 6,
    "retired products plus all three unverified activation routes stay gone"
  );
});

test("legacy asynchronous payment failure cancels stale subscriptions and entitlements", async () => {
  const webhook = await source("src/routes/stripe.webhooks.routes.js");

  assert.match(webhook, /handleAsyncCheckoutPaymentFailed/);
  assert.match(webhook, /stripe\.subscriptions\.cancel\(subscriptionId\)/);
  assert.match(webhook, /revokeFailedCheckoutEntitlements\(session\)/);
  assert.match(webhook, /invoiceIsSettled\(current\.latest_invoice\)/);
});

test("referral invite and payout controls are durable and revalidated", async () => {
  const [account, referrals, admin, rateLimit, indexes, eligibilityMigration] = await Promise.all([
    source("src/routes/account.routes.js"),
    source("src/services/referrals/referral.service.js"),
    source("src/routes/admin.routes.js"),
    source("src/middleware/rateLimit.js"),
    source(
      "src/db/migrations/20260718_referral_invite_rate_limit_indexes_1_2_1.js"
    ),
    source(
      "src/db/migrations/20260718_tabforge_referrer_pro_eligibility_1_3_0.js"
    ),
  ]);

  assert.match(account, /toEmail:\s*z\.string\(\)\.email\(\)\.max\(320\)/);
  assert.match(account, /referral-sender:/);
  assert.match(account, /referral-destination:/);
  assert.match(account, /pg_advisory_xact_lock/);
  assert.match(account, /REFERRAL_INVITE_HOURLY_LIMIT\s*=\s*100/);
  assert.match(account, /zadockplant@gmail\.com/);
  assert.match(account, /skip:\s*referralInviteLimitsBypassedForRequest/);
  assert.match(account, /if \(!bypassLimits\)/);
  assert.match(account, /tabforge_pro_required/);
  assert.match(account, /referrerPurchaseRequired:\s*true/);
  assert.match(referrals, /whereIn\("status", \["pending", "approved"\]\)/);
  assert.match(referrals, /hasReferralProgramEligibility/);
  assert.match(referrals, /referrer_tabforge_pro_required/);
  assert.match(admin, /referral_qualification_no_longer_met/);
  assert.match(admin, /referrer_tabforge_pro_required/);
  assert.match(admin, /initial_net_paid_cents/);
  assert.match(admin, /writeAdminAudit\([\s\S]*?trx\s*\)/);
  assert.match(rateLimit, /if \(skip\?\.\(req\)\) return next\(\)/);
  assert.match(indexes, /referral_events_invite_sender_window_idx/);
  assert.match(indexes, /referral_events_invite_destination_window_idx/);
  assert.match(eligibilityMigration, /referrer_purchase_required:\s*true/);
  assert.match(eligibilityMigration, /required_referrer_product_slug:\s*"tabforge"/);
});

test("a non-positive payment cannot enter the referral purchase ledger", async () => {
  const result = await recordReferralPurchase({
    referredUserId: "user-free-promo",
    productSlug: "tabforge",
    purchaseRef: "checkout-free-promo",
    metadata: { initial_net_paid_cents: 0 },
  });

  assert.deepEqual(result, {
    recorded: false,
    reason: "no_positive_initial_payment",
  });
});

test("past-due grace migration backfills a durable start marker", async () => {
  const migration = await source(
    "src/db/migrations/20260718_tabforge_past_due_grace_1_2_1.js"
  );

  assert.match(migration, /status:\s*"past_due"/);
  assert.match(migration, /past_due_since/);
  assert.match(migration, /updated_at, current_period_end, created_at/);
});
