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
import { deviceLimitFor, seatBreakdown, setPerkSeats } from "./productSeats.service.js";
import { CLOUD_PICKUP_TIERS, monthWindow, tierFromEntitlements } from "../modules/forgedrop-pickup/plans.js";
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
          .select("device_id", "device_name", "platform", "app_version", "created_at", "last_seen_at")
          .orderBy("created_at", "asc"),
      ]);
      item.devices = devices.map((d) => ({
        deviceId: d.device_id,
        deviceName: d.device_name,
        platform: d.platform || null,
        appVersion: d.app_version,
        activatedAt: d.created_at,
        lastSeenAt: d.last_seen_at || null,
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

// -- the customer list and each account's usage -------------------------------------
//
// Everyone who owns a SendForge product, and how each one uses it, from what
// the backend already keeps for licensing and for Cloud pickup's monthly
// allowance: devices against each product's limit, slots freed and reused, an
// install active on another account as well, and bytes sent against the plan.
// Nothing new is collected, and nothing here names a file, a recipient or any
// content (the owner, 2026-09-27: no cost or privacy issue, just enough to
// improve the products and to catch accounts getting around data caps).

const OWNED_PRODUCT_SLUGS = Object.freeze([
  ...Object.keys(GRANTABLE_PRODUCTS),
  ...CLOUD_PICKUP_TIERS.map((tier) => tier.slug),
]);
const CLOUD_PICKUP_SLUGS = Object.freeze(CLOUD_PICKUP_TIERS.map((tier) => tier.slug));
const DAY_MS = 24 * 60 * 60 * 1000;
/** Share of the month's Cloud pickup allowance that gets an account flagged. */
export const PICKUP_CAP_FLAG = 0.9;
/** Slots freed within 30 days that get an account flagged. */
export const SLOT_SWAP_FLAG = 3;

function likePattern(text) {
  return `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function activeEntitlements(query, now, alias = "") {
  const column = (name) => (alias ? `${alias}.${name}` : name);
  return query
    .andWhere(column("status"), "active")
    .andWhere((qb) => qb.whereNull(column("expires_at")).orWhere(column("expires_at"), ">", now));
}

// The pickups that count against a month's allowance, counted exactly as
// forgedrop-pickup/plans.js bytesSentThisMonth counts them.
function allowancePickups(query, from, to) {
  return query
    .andWhere("created_at", ">=", from)
    .andWhere("created_at", "<", to)
    .whereNot((qb) => qb.where({ status: "cancelled" }).whereNull("uploaded_at"));
}

function pickupPlan(slugs) {
  const tier = tierFromEntitlements(slugs.map((slug) => ({ product_slug: slug })));
  return tier ? { slug: tier.slug, label: tier.label, bytes: tier.bytes } : null;
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function tally(rows, field) {
  const counts = {};
  for (const row of rows) {
    const key = row[field] || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function latest(values) {
  let best = null;
  for (const value of values) {
    if (value && (!best || new Date(value) > new Date(best))) best = value;
  }
  return best;
}

/**
 * The owner's customer list: one line per account that owns a product,
 * newest purchase first, `q` narrowing by email. Each line has the products,
 * devices in use against each limit, when a device was last seen, this
 * month's Cloud pickup against the plan, and flags for a device limit reached
 * or a pickup allowance nearly used up.
 */
export async function listProductOwners({ q = "", limit = 50, offset = 0, now = new Date() } = {}, trx = db) {
  const search = normalizeEmail(q);
  const size = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 200);
  const skip = Math.max(Math.trunc(Number(offset)) || 0, 0);
  const owners = () => {
    const query = activeEntitlements(
      trx("product_entitlements as pe").join("users as u", "u.id", "pe.user_id").whereIn("pe.product_slug", OWNED_PRODUCT_SLUGS),
      now,
      "pe",
    );
    if (search) query.andWhereRaw("lower(u.email) like ?", [likePattern(search)]);
    return query;
  };

  const counted = await owners().countDistinct({ count: "u.id" }).first();
  const rows = await owners()
    .groupBy("u.id", "u.email", "u.created_at")
    .select("u.id", "u.email", "u.created_at")
    .select(trx.raw("max(pe.granted_at) as last_purchase_at"))
    .select(trx.raw("array_agg(distinct pe.product_slug) as products"))
    .orderByRaw("max(pe.granted_at) desc nulls last, u.email asc")
    .limit(size)
    .offset(skip);

  const ids = rows.map((row) => row.id);
  const { from, to } = monthWindow(now);
  const [devices, pickups] = ids.length
    ? await Promise.all([
        trx("device_activations")
          .whereIn("user_id", ids)
          .andWhere({ status: "active" })
          .groupBy("user_id", "product_slug")
          .select("user_id", "product_slug")
          .count({ count: "id" })
          .max({ last_seen_at: "last_seen_at" }),
        allowancePickups(trx("forgedrop_pickups").whereIn("sender_user_id", ids), from, to)
          .groupBy("sender_user_id")
          .select("sender_user_id")
          .sum({ bytes: "total_bytes" })
          .count({ count: "id" }),
      ])
    : [[], []];

  const items = [];
  for (const row of rows) {
    const owned = OWNED_PRODUCT_SLUGS.filter((slug) => (row.products || []).includes(slug));
    const mine = devices.filter((d) => d.user_id === row.id);
    const deviceView = {};
    for (const slug of owned) {
      const licensed = licensedProduct(slug);
      if (!licensed) continue;
      deviceView[slug] = {
        active: Number(mine.find((d) => d.product_slug === slug)?.count || 0),
        limit: licensed.seatBased ? await deviceLimitFor(row.id, licensed, trx) : licensed.deviceLimit ?? null,
      };
    }
    const plan = pickupPlan(owned);
    const sent = pickups.find((p) => p.sender_user_id === row.id);
    const sentBytes = Number(sent?.bytes || 0);
    const flags = [];
    if (Object.values(deviceView).some((d) => d.limit && d.active >= d.limit)) flags.push("device_limit");
    if (plan && sentBytes >= plan.bytes * PICKUP_CAP_FLAG) flags.push("pickup_cap");
    items.push({
      email: row.email,
      joinedAt: row.created_at || null,
      lastPurchaseAt: row.last_purchase_at || null,
      products: owned,
      devices: deviceView,
      lastSeenAt: latest(mine.map((d) => d.last_seen_at)),
      cloudPickup: plan || sentBytes ? { plan, sentBytes, pickups: Number(sent?.count || 0) } : null,
      flags,
    });
  }
  return { items, total: Number(counted?.count || 0), limit: size, offset: skip };
}

/** How one account uses what it owns: devices, shared installs and Cloud pickup. */
async function usageView(user, products, now, trx = db) {
  const { from, to } = monthWindow(now);
  const firstMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const since90 = new Date(now.getTime() - 90 * DAY_MS);
  const [deviceRows, shared, pickupRows, monthly, open, unpicked] = await Promise.all([
    trx("device_activations")
      .where({ user_id: user.id })
      .select("product_slug", "platform", "app_version", "status", "last_seen_at", "deactivated_at"),
    // An install active on this account and on another at once.
    trx("device_activations as d")
      .join("device_activations as o", function sameInstall() {
        this.on("o.device_id", "=", "d.device_id").andOn("o.user_id", "<>", "d.user_id");
      })
      .where({ "d.user_id": user.id, "d.status": "active", "o.status": "active" })
      .groupBy("d.product_slug", "d.device_id", "d.device_name")
      .select("d.product_slug", "d.device_name")
      .countDistinct({ others: "o.user_id" }),
    activeEntitlements(trx("product_entitlements").where({ user_id: user.id }).whereIn("product_slug", CLOUD_PICKUP_SLUGS), now)
      .select("product_slug"),
    allowancePickups(trx("forgedrop_pickups").where({ sender_user_id: user.id }), firstMonth, to)
      .select(trx.raw("to_char(date_trunc('month', created_at at time zone 'UTC'), 'YYYY-MM') as month"))
      .sum({ bytes: "total_bytes" })
      .count({ count: "id" })
      .groupByRaw("1"),
    trx("forgedrop_pickups").where({ sender_user_id: user.id }).whereIn("status", ["uploading", "waiting"]).count({ count: "id" }).first(),
    trx("forgedrop_pickups")
      .where({ sender_user_id: user.id, status: "expired" })
      .andWhere("created_at", ">=", since90)
      .count({ count: "id" })
      .first(),
  ]);

  const devices = {};
  for (const product of products) {
    if (!product.devices) continue;
    const rows = deviceRows.filter((row) => row.product_slug === product.slug);
    const active = rows.filter((row) => row.status === "active");
    const freed = rows.filter((row) => row.status === "deactivated");
    devices[product.slug] = {
      active: active.length,
      limit: product.seatBased ? Number(product.seats?.total || 0) : product.deviceLimit ?? null,
      freedTotal: freed.length,
      freedLast30Days: freed.filter((row) => row.deactivated_at && new Date(row.deactivated_at) >= since30).length,
      lastSeenAt: latest(active.map((row) => row.last_seen_at)),
      platforms: tally(active, "platform"),
      appVersions: tally(active, "app_version"),
    };
  }

  const plan = pickupPlan(pickupRows.map((row) => row.product_slug));
  const months = [];
  for (let back = 2; back >= 0; back -= 1) {
    const key = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)));
    const row = monthly.find((m) => m.month === key);
    months.push({ month: key, bytes: Number(row?.bytes || 0), pickups: Number(row?.count || 0) });
  }
  const thisMonth = months[months.length - 1];
  const sharedDevices = shared.map((row) => ({
    productSlug: row.product_slug,
    deviceName: row.device_name || null,
    otherAccounts: Number(row.others || 0),
  }));

  const flags = [];
  if (Object.values(devices).some((d) => d.limit && d.active >= d.limit)) flags.push("device_limit");
  if (Object.values(devices).some((d) => d.freedLast30Days >= SLOT_SWAP_FLAG)) flags.push("slot_swaps");
  if (sharedDevices.length) flags.push("shared_device");
  if (plan && thisMonth.bytes >= plan.bytes * PICKUP_CAP_FLAG) flags.push("pickup_cap");

  return {
    devices,
    sharedDevices,
    cloudPickup: {
      plan,
      sentThisMonthBytes: thisMonth.bytes,
      pickupsThisMonth: thisMonth.pickups,
      percentOfPlan: plan ? Math.round((thisMonth.bytes / plan.bytes) * 100) : null,
      monthStartsAt: from.toISOString(),
      months,
      waitingNow: Number(open?.count || 0),
      expiredUnpickedLast90Days: Number(unpicked?.count || 0),
    },
    flags,
  };
}

export async function lookupAccount(email, trx = db, { now = new Date() } = {}) {
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
  const usage = await usageView(user, products, now, trx);

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
    usage,
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
