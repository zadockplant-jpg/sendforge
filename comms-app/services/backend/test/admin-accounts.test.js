// The owner's per-email admin: look someone up, give and take back products,
// set their referral terms, and invite an email that has no account yet.
// Real services against PGlite.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";

import { attachPglite } from "./helpers/pglite-db.js";

const { db } = await import("../src/config/db.js");
const {
  inviteEmail,
  lookupAccount,
  setAccountReferral,
  setProductGift,
} = await import("../src/services/adminAccounts.service.js");
const { redeemCompCodeForUser, redeemPendingCompCodeForVerifiedUser, noteCompCodeForUser } = await import(
  "../src/services/compCodes.service.js"
);
const { canHoldReferralCode, recordFlatProductReferral } = await import(
  "../src/services/referrals/referral.service.js"
);
const { deviceLimitFor } = await import("../src/services/productSeats.service.js");
const { licensedProduct } = await import("../src/services/licensedProducts.js");
const { SENDFORGE_ADMIN_EMAIL, isSendForgeAdmin } = await import("../src/middleware/adminAuth.js");

const ADMIN = "zadockplant@gmail.com";
const RCG = "rose-colored-glasses";
let detach;

before(async () => {
  detach = await attachPglite(db);
});
after(async () => detach?.());

async function signUp(email, extra = {}) {
  const id = randomUUID();
  await db("users").insert({ id, email, ...extra });
  return id;
}

const product = (view, slug) => view.products.find((p) => p.slug === slug);

test("zadockplant@gmail.com is the one administrator, with no override", async () => {
  assert.equal(SENDFORGE_ADMIN_EMAIL, "zadockplant@gmail.com");
  assert.equal(isSendForgeAdmin(" ZadockPlant@Gmail.com "), true);
  assert.equal(isSendForgeAdmin("admin@example.com"), false);
  assert.equal(isSendForgeAdmin(""), false);

  const middleware = await readFile(new URL("../src/middleware/adminAuth.js", import.meta.url), "utf8");
  const routes = await readFile(new URL("../src/routes/admin.routes.js", import.meta.url), "utf8");
  // Every admin request re-checks it, not only the sign-in.
  assert.match(middleware, /if \(!isSendForgeAdmin\(user\.email\)\)/);
  assert.doesNotMatch(routes + middleware, /process\.env\.ADMIN_(ALLOWED_EMAILS|EMAIL)/, "no environment variable can add an administrator");
});

test("an email with no account is not a lookup error: it gets an invite", async () => {
  const view = await lookupAccount("Friend@Example.com");
  assert.deepEqual(view, { registered: false, email: "friend@example.com", invites: [] });

  const invite = await inviteEmail({
    email: "friend@example.com",
    grants: [RCG, "forgedrop", "not-a-product"],
    rcgDevices: 3,
    tabforgePerSaleCents: 500,
    flatRates: { [RCG]: 200 },
    note: "podcast host",
    createdBy: ADMIN,
  });
  assert.match(invite.code, /^INVITE-[0-9A-F]{8}$/);
  assert.equal(invite.link, `/signup.html?ref=${invite.code}&email=friend%40example.com`);
  const [listed] = invite.lookup.invites;
  assert.deepEqual(listed.grants, [RCG, "forgedrop"], "unknown products are dropped");
  assert.equal(listed.rcgDevices, 3);

  await assert.rejects(inviteEmail({ email: "friend@example.com", grants: [] }).then(() => signUp("x@y.z")).then(() => inviteEmail({ email: "x@y.z" })), /already_registered/);
});

test("the invite is spent by the invited address alone, at email verification", async () => {
  const { code } = await inviteEmail({ email: "pal@example.com", grants: [RCG], rcgDevices: 2, flatRates: { [RCG]: 150 }, createdBy: ADMIN });

  // Someone else who got hold of the link gets nothing.
  const stranger = await signUp("stranger@example.com");
  const refused = await redeemCompCodeForUser({ userId: stranger, code });
  assert.equal(refused.reason, "code_for_another_email");

  // The invited address signs up through the link and verifies.
  const pal = await signUp("pal@example.com", { email_verified: true });
  assert.equal(await noteCompCodeForUser({ userId: pal, code }), true);
  const redeemed = await redeemPendingCompCodeForVerifiedUser(pal);
  assert.equal(redeemed.granted, true);
  assert.deepEqual(redeemed.products, [RCG]);

  const view = await lookupAccount("pal@example.com");
  const rcg = product(view, RCG);
  assert.equal(rcg.owned, true);
  assert.equal(rcg.gift, true);
  assert.deepEqual(rcg.seats, { paid: 0, perk: 2, total: 2 });
  assert.equal(await deviceLimitFor(pal, licensedProduct(RCG)), 2);
  assert.equal(view.referral.flatRates[RCG].cents, 150);
  assert.ok(view.referral.code, "they can refer from day one");

  // Spent: a second go does nothing, and the invite shows as redeemed.
  assert.equal((await redeemCompCodeForUser({ userId: pal, code })).reason, "already_redeemed");
  const [invite] = (await lookupAccount("nobody-else@example.com")).invites;
  assert.equal(invite, undefined);
});

test("gifts can be given and taken back; purchases cannot be taken back here", async () => {
  const kim = await signUp("kim@example.com");
  let view = await setProductGift({ email: "kim@example.com", productSlug: "forgedrop", grant: true, adminEmail: ADMIN });
  assert.equal(product(view, "forgedrop").owned, true);
  assert.equal(product(view, "forgedrop").deviceLimit, 5);

  view = await setProductGift({ email: "kim@example.com", productSlug: "forgedrop", grant: false, adminEmail: ADMIN });
  assert.equal(product(view, "forgedrop").owned, false);

  // A bought product is not the dashboard's to take.
  await db("product_entitlements").insert({ id: randomUUID(), user_id: kim, product_slug: "tabforge", source: "stripe", status: "active" });
  await assert.rejects(
    setProductGift({ email: "kim@example.com", productSlug: "tabforge", grant: false, adminEmail: ADMIN }),
    /purchased_not_a_gift/
  );

  // Extra Rose Colored Glasses devices on top of a purchase: only the gift goes.
  await db("product_entitlements").insert({ id: randomUUID(), user_id: kim, product_slug: RCG, source: "stripe", status: "active" });
  await db("product_seat_purchases").insert({ id: randomUUID(), user_id: kim, product_slug: RCG, purchase_ref: `pi_kim:${RCG}`, quantity: 1, amount_cents: 500, status: "active" });
  view = await setProductGift({ email: "kim@example.com", productSlug: RCG, grant: true, devices: 4, adminEmail: ADMIN });
  assert.deepEqual(product(view, RCG).seats, { paid: 1, perk: 4, total: 5 });
  assert.equal(product(view, RCG).source, "stripe", "the purchase stays the record of ownership");
  view = await setProductGift({ email: "kim@example.com", productSlug: RCG, grant: false, adminEmail: ADMIN });
  assert.deepEqual(product(view, RCG).seats, { paid: 1, perk: 0, total: 1 });
  assert.equal(product(view, RCG).owned, true);

  await assert.rejects(setProductGift({ email: "nobody@example.com", productSlug: RCG, grant: true, adminEmail: ADMIN }), /user_not_found/);
});

test("referral terms: an affiliate who owns nothing, a vanity code, and a custom rate that really pays", async () => {
  const aff = await signUp("affiliate@example.com");
  assert.equal(await canHoldReferralCode(aff), false);

  let view = await setAccountReferral({ email: "affiliate@example.com", affiliate: true, code: "SUNNY", flatRates: { [RCG]: 300 }, tabforgePerSaleCents: 700 });
  assert.equal(view.referral.code, "SUNNY");
  assert.equal(view.referral.affiliate, true);
  assert.equal(view.referral.tabforgePerSaleCents, 700);
  assert.equal(view.referral.flatRates[RCG].cents, 300);
  assert.equal(view.referral.flatRates[RCG].custom, true);
  assert.equal(await canHoldReferralCode(aff), true);

  // Someone they refer buys: the $3 rate is what queues.
  const code = await db("referral_codes").where({ code: "SUNNY" }).first();
  const buyer = await signUp("buyer@example.com", { referred_by_user_id: aff, referral_code_id: code.id });
  const paid = await recordFlatProductReferral({ referredUserId: buyer, productSlug: RCG, purchaseRef: "pi_buyer:rcg", netPaidCents: 500, metadata: { payment_intent: "pi_buyer" } });
  assert.equal(paid.recorded, true);
  assert.equal(paid.amountCents, 300);

  // Back to standard terms.
  view = await setAccountReferral({ email: "affiliate@example.com", flatRates: { [RCG]: null }, tabforgePerSaleCents: null });
  assert.equal(view.referral.flatRates[RCG].cents, 100);
  assert.equal(view.referral.tabforgePerSaleCents, null);
  assert.equal(view.referral.referredAccounts, 1);

  await assert.rejects(setAccountReferral({ email: "affiliate@example.com", code: "no spaces!" }), /invalid_referral_code/);
  await signUp("other@example.com");
  await setAccountReferral({ email: "other@example.com", affiliate: true });
  await assert.rejects(setAccountReferral({ email: "other@example.com", code: "SUNNY" }), /referral_code_taken/);
});
