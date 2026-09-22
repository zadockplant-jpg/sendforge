import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SYNC_SHARE_PRODUCT_SLUG,
  SYNC_SHARE_RATE,
  syncShareCents,
} from "../src/services/referrals/referral.service.js";

const src = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("Private Sync pays the referrer five percent", () => {
  assert.equal(SYNC_SHARE_RATE, 0.05);
  assert.equal(SYNC_SHARE_PRODUCT_SLUG, "tabforge-subscription");
  // The $5 monthly price is the case that actually runs.
  assert.equal(syncShareCents(500), 25);
});

test("the share rounds to the nearest cent and never disappears", () => {
  assert.equal(syncShareCents(1000), 50);
  assert.equal(syncShareCents(250), 13, "12.5 rounds up");
  assert.equal(syncShareCents(230), 12, "11.5 rounds up");
  // A paid invoice always earns something. Without the floor a cheap enough
  // price would round to zero and the referrer would see nothing for a month
  // their person actually paid for.
  assert.equal(syncShareCents(1), 1);
  assert.equal(syncShareCents(9), 1);
});

test("nothing is owed on an invoice that was not paid", () => {
  assert.equal(syncShareCents(0), 0);
  assert.equal(syncShareCents(-500), 0);
  assert.equal(syncShareCents(null), 0);
  assert.equal(syncShareCents(undefined), 0);
  assert.equal(syncShareCents("not a number"), 0);
});

test("the share stops one level up and the chain is never walked", async () => {
  const referral = await src("../src/services/referrals/referral.service.js");
  const body = referral.slice(referral.indexOf("export async function recordSyncSubscriptionShare"));
  // Comments stripped, so this counts what the code does rather than what it
  // says about itself.
  const fn = body
    .slice(0, body.indexOf("\nexport async function", 1))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  assert.match(fn, /referred_by_user_id/, "it reads the account directly above");
  assert.equal(
    (fn.match(/referred_by_user_id/g) || []).length,
    1,
    "read once: reading it a second time would be a second level"
  );
  assert.doesNotMatch(fn, /while\s*\(|for\s*\(|recursion|walkUp|ancestors/i,
    "no loop up the chain, so a referrer's referrer is never paid");
  assert.match(fn, /level:\s*1/, "the queued row records that this is one level");
});

test("a replayed invoice cannot pay twice", async () => {
  const referral = await src("../src/services/referrals/referral.service.js");
  const body = referral.slice(referral.indexOf("export async function recordSyncSubscriptionShare"));
  const fn = body.slice(0, body.indexOf("\nexport async function", 1));

  assert.match(fn, /sync_share:\$\{ref\}/, "the reward is keyed on the invoice");
  assert.match(fn, /onConflict\(\["user_id", "product_slug", "reward_key"\]\)/);
  assert.match(fn, /\.ignore\(\)/, "a duplicate is dropped rather than inserted again");
  assert.match(fn, /duplicate_invoice/);
});

test("the usual guards still apply to renewals", async () => {
  const referral = await src("../src/services/referrals/referral.service.js");
  const body = referral.slice(referral.indexOf("export async function recordSyncSubscriptionShare"));
  const fn = body.slice(0, body.indexOf("\nexport async function", 1));

  assert.match(fn, /self_referral/, "you cannot pay yourself");
  assert.match(fn, /hasReferralProgramEligibility/,
    "someone who no longer owns Pro stops earning from renewals");
  assert.match(fn, /no_referrer/, "an account nobody referred owes nothing");
});

test("every paid sync invoice reaches the share, once", async () => {
  const webhook = await src("../src/routes/stripe.webhooks.routes.js");
  assert.match(webhook, /recordSyncSubscriptionShare/, "the webhook calls it");
  assert.match(webhook, /invoiceCoversTabForgeSync\(invoice\)/,
    "only Private Sync invoices pay a share");
  assert.match(webhook, /case "invoice\.paid":/, "renewals arrive on invoice.paid");
  assert.match(webhook, /invoiceRef: String\(invoice\.id \|\| ""\)/,
    "keyed on the Stripe invoice id");
});
