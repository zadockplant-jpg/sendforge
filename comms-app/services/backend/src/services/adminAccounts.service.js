/**
 * The owner's per-person view: type an email, see everything that account
 * has - products, gifts, devices, referral code and terms, who referred them,
 * what they have earned - and change it in place. An email with no account
 * gets a personal invite link instead, to send to an affiliate or a friend.
 */

import { db } from "../config/db.js";
import { grantProductEntitlement, revokeProductEntitlement } from "./entitlement.service.js";
import {
  GRANTABLE_PRODUCTS,
  createPersonalInvite,
  listInvitesForEmail,
} from "./compCodes.service.js";
import {
  PERK_ENTITLEMENT_SOURCE,
  isPerkEntitlement,
  perkEntitlementMetadata,
} from "./adminReferralControls.service.js";
import { licensedProduct } from "./licensedProducts.js";
import { seatBreakdown, setPerkSeats } from "./productSeats.service.js";
import {
  AFFILIATE_PER_SALE_CENTS,
  PER_SALE_RATE_PRODUCTS,
  canHoldReferralCode,
  commissionPlanForReferralCode,
  ensureAffiliateReferralCode,
  ensureReferralCodeForUser,
  customPerSaleCentsForCode,
  perSaleCentsForCode,
  hasReferralProgramEligibility,
  renameReferralCode,
  setReferralTerms,
} from "./referrals/referral.service.js";

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function adminError(statusCode, error) {
  return Object.assign(new Error(error), { statusCode });
}

async function activeReferralCode(userId, trx = db) {
  return trx("referral_codes")
    .where({ user_id: userId, status: "active" })
    .orderBy("created_at", "asc")
    .first();
}

async function productRows(user, trx = db) {
  const entitlements = await trx("product_entitlements")
    .where({ user_id: user.id })
    .whereIn("product_slug", Object.keys(GRANTABLE_PRODUCTS));
  const bySlug = new Map(entitlements.map((row) => [row.product_slug, row]));

  const out = [];
  for (const [slug, name] of Object.entries(GRANTABLE_PRODUCTS)) {
    const row = bySlug.get(slug) || null;
    const active =
      Boolean(row) &&
      row.status === "active" &&
      (!row.expires_at || new Date(row.expires_at).getTime() > Date.now());
    const licensed = licensedProduct(slug);
    const item = {
      slug,
      name,
      owned: active,
      status: row?.status || null,
      source: row?.source || null,
      gift: Boolean(row) && (isPerkEntitlement(row) || row.source === "comp_code"),
      grantedAt: row?.granted_at || null,
      expiresAt: row?.expires_at || null,
      seatBased: Boolean(licensed?.seatBased),
    };
    if (licensed) {
      const [devices] = await Promise.all([
        trx("device_activations")
          .where({ user_id: user.id, product_slug: slug, status: "active" })
          .select("device_id", "device_name", "app_version", "created_at")
          .orderBy("created_at", "asc"),
      ]);
      item.devices = devices.map((d) => ({
        deviceId: d.device_id,
        deviceName: d.device_name,
        appVersion: d.app_version,
        activatedAt: d.created_at,
      }));
      if (licensed.seatBased) item.seats = await seatBreakdown(user.id, slug, trx);
      else item.deviceLimit = licensed.deviceLimit;
    }
    out.push(item);
  }
  return out;
}

async function referralView(user, trx = db) {
  const code = await activeReferralCode(user.id, trx);
  const [tabforgeEligible, canHold, referrer, referredCount, rewards] = await Promise.all([
    hasReferralProgramEligibility(user.id, "tabforge", trx),
    canHoldReferralCode(user.id, trx),
    user.referred_by_user_id
      ? trx("users").select("email").where({ id: user.referred_by_user_id }).first()
      : null,
    trx("users").where({ referred_by_user_id: user.id }).count({ count: "id" }).first(),
    trx("reward_queue")
      .select("status")
      .sum({ cents: "reward_amount_cents" })
      .count({ count: "id" })
      .where({ user_id: user.id })
      .groupBy("status"),
  ]);

  const plan = commissionPlanForReferralCode(code);
  // Per product: the owner's own per-sale rate, if any; the affiliate level
  // an affiliate gets without one; and what this person is paid per sale
  // (null means the product's milestones).
  const flatRates = {};
  for (const slug of PER_SALE_RATE_PRODUCTS) {
    const custom = customPerSaleCentsForCode(code, slug);
    flatRates[slug] = {
      cents: custom,
      custom: custom !== null,
      affiliateCents: AFFILIATE_PER_SALE_CENTS[slug] ?? null,
      effectiveCents: perSaleCentsForCode(code, slug),
    };
  }
  const byStatus = {};
  for (const row of rewards) {
    byStatus[row.status] = { count: Number(row.count || 0), cents: Number(row.cents || 0) };
  }

  return {
    code: code?.code || null,
    affiliate: Boolean(code?.metadata?.affiliate),
    canHoldCode: canHold,
    tabforgeEligible,
    tabforgePerSaleCents: plan?.rewardAmountCents ?? null,
    flatRates,
    referredBy: referrer?.email || null,
    referredAccounts: Number(referredCount?.count || 0),
    rewards: byStatus,
    cashAppTag: user.cash_app_tag || null,
  };
}

export async function lookupAccount(email, trx = db) {
  const address = normalizeEmail(email);
  if (!address.includes("@")) throw adminError(400, "invalid_email");

  const user = await trx("users").where({ email: address }).first();
  if (!user) {
    return { registered: false, email: address, invites: await listInvitesForEmail(address, trx) };
  }

  const [products, referral, redeemedCodes] = await Promise.all([
    productRows(user, trx),
    referralView(user, trx),
    trx("product_entitlements")
      .where({ user_id: user.id, source: "comp_code" })
      .select(trx.raw("distinct metadata->>'comp_code' as code")),
  ]);

  return {
    registered: true,
    email: user.email,
    user: {
      id: user.id,
      email: user.email,
      emailVerified: Boolean(user.email_verified),
      createdAt: user.created_at || null,
      hasStripeCustomer: Boolean(user.stripe_customer_id),
    },
    products,
    referral,
    codesRedeemed: redeemedCodes.map((row) => row.code).filter(Boolean),
  };
}

async function requireUser(email, trx = db) {
  const user = await trx("users").where({ email: normalizeEmail(email) }).first();
  if (!user) throw adminError(404, "user_not_found");
  return user;
}

/**
 * Give or take back one product. Only gifts can be taken back here: a
 * purchase is undone by a refund in Stripe, which the webhook follows.
 * For Rose Colored Glasses, `devices` is how many PCs the gift covers.
 */
export async function setProductGift({ email, productSlug, grant, devices, note, adminEmail }, trx = db) {
  const slug = String(productSlug || "").trim().toLowerCase();
  if (!GRANTABLE_PRODUCTS[slug]) throw adminError(404, "unknown_product");
  const user = await requireUser(email, trx);
  const existing = await trx("product_entitlements").where({ user_id: user.id, product_slug: slug }).first();
  const product = licensedProduct(slug);

  if (grant) {
    const alreadyOwned = existing && existing.status === "active";
    // A buyer who is also given extra devices keeps their purchase as the
    // record of ownership; only the gifted seats are added.
    if (!alreadyOwned || isPerkEntitlement(existing) || existing.source === "comp_code") {
      await grantProductEntitlement({
        userId: user.id,
        productSlug: slug,
        source: PERK_ENTITLEMENT_SOURCE,
        sourceRef: adminEmail,
        metadata: perkEntitlementMetadata({ adminEmail, note }),
      });
    }
    if (product?.seatBased) {
      await setPerkSeats({ userId: user.id, productSlug: slug, seats: Math.max(1, Number(devices) || 1), grantedBy: adminEmail, note }, trx);
    }
    await ensureReferralCodeForUser(user, trx);
  } else {
    if (existing && existing.status === "active" && !isPerkEntitlement(existing) && existing.source !== "comp_code") {
      if (product?.seatBased) {
        // Bought, with gifted devices on top: remove only the gift.
        await setPerkSeats({ userId: user.id, productSlug: slug, seats: 0, grantedBy: adminEmail }, trx);
        return lookupAccount(user.email, trx);
      }
      throw adminError(409, "purchased_not_a_gift");
    }
    if (product?.seatBased) {
      await setPerkSeats({ userId: user.id, productSlug: slug, seats: 0, grantedBy: adminEmail }, trx);
      const { paid } = await seatBreakdown(user.id, slug, trx);
      if (paid > 0) return lookupAccount(user.email, trx);
    }
    if (existing) {
      await revokeProductEntitlement(user.id, slug, {
        ...(existing.metadata || {}),
        perk: true,
        revoked_by: adminEmail,
        revoked_at: new Date().toISOString(),
      });
    }
  }
  return lookupAccount(user.email, trx);
}

/**
 * Referral code and terms for one person. Making someone an affiliate gives
 * them a code even when they own nothing.
 */
export async function setAccountReferral(
  { email, code, affiliate, tabforgePerSaleCents, flatRates },
  trx = db
) {
  const user = await requireUser(email, trx);
  let row = await activeReferralCode(user.id, trx);
  if (affiliate || !row) {
    row = affiliate || !(await canHoldReferralCode(user.id, trx))
      ? await ensureAffiliateReferralCode(user, { source: "admin" }, trx)
      : await ensureReferralCodeForUser(user, trx);
  }
  if (!row) throw adminError(409, "no_referral_code");

  if (affiliate === false && row.metadata?.affiliate) {
    const metadata = { ...(row.metadata || {}) };
    delete metadata.affiliate;
    [row] = await trx("referral_codes").where({ id: row.id }).update({ metadata, updated_at: trx.fn.now() }).returning("*");
  }
  if (tabforgePerSaleCents !== undefined || flatRates) {
    row = await setReferralTerms(row, { tabforgePerSaleCents, flatRates }, trx);
  }
  if (code) row = await renameReferralCode(row, code, trx);
  return lookupAccount(user.email, trx);
}

export async function inviteEmail(input, trx = db) {
  const address = normalizeEmail(input.email);
  if (await trx("users").where({ email: address }).first()) throw adminError(409, "already_registered");
  const { row, link } = await createPersonalInvite({ ...input, email: address }, trx);
  return { code: row.code, link, lookup: await lookupAccount(address, trx) };
}
