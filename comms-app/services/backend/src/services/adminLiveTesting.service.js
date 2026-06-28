import crypto from "crypto";

import { db } from "../config/db.js";
import { ensureReferralCodeForUser, getReferralProgram, tiersFromProgram, updateUserCashAppTag } from "./referrals/referral.service.js";

const DEFAULT_OWNER_EMAIL = "zadockplant@gmail.com";
const PRODUCT_SLUG = "tabforge";
const MAX_LIVE_TEST_COUNT = 10000;
const TEST_SOURCE = "admin_live_test";
const OWNER_ENTITLEMENT_SOURCE = "admin_owner_grant";
const TEST_ENTITLEMENT_PRESETS = [
  // Product features that are purchasable/account-visible. Extra Pages belongs
  // here, not in shortcut packs. The extension uses tabforge-pages metadata to
  // calculate extra page capacity.
  { slug: "tabforge", label: "TabForge Pro", category: "product_features", description: "Main Pro unlock. Backend device/license checks still apply." },
  { slug: "tabforge-pages", label: "Extra Pages", category: "product_features", description: "Purchased page expansion. Kept separate from shortcut packs." },

  // Shortcut pack entitlements. Keep this aligned with the active TabForge
  // extension/store unlock map. Do not list internal labels or future-only ideas.
  { slug: "tabforge-pack-builder", label: "Builder Pack", category: "shortcut_packs", description: "Construction, trades, and field tools." },
  { slug: "tabforge-pack-money", label: "Money Pack", category: "shortcut_packs", description: "Banking, budgeting, and finance shortcuts." },
  { slug: "tabforge-pack-dev", label: "Developer Pack", category: "shortcut_packs", description: "Code, docs, dashboards, and deploy tools." },
  { slug: "tabforge-pack-media", label: "Media Pack", category: "shortcut_packs", description: "Music, video, editing, and publishing." },
  { slug: "tabforge-pack-research", label: "Research Pack", category: "shortcut_packs", description: "AI, search, notes, and reference links." },

  // Skin access is sold as three purchasable bundles. Keep these slugs aligned
  // with TabForge extension/store unlock logic. Legacy admin slugs are normalized
  // below so older rows still resolve to the current bundles.
  { slug: "tabforge-skin-bundle-command-center", label: "Star Base", category: "skin_packs", description: "Seven TabForge workspace skins." },
  { slug: "tabforge-skin-bundle-creator-money", label: "Creator", category: "skin_packs", description: "Seven TabForge workspace skins." },
  { slug: "tabforge-skin-bundle-wild-forge", label: "Wild Forge", category: "skin_packs", description: "Seven TabForge workspace skins." },
];

const LEGACY_SKIN_ENTITLEMENT_ALIASES = Object.freeze({
  "tabforge-skin-terminal": "tabforge-skin-bundle-command-center",
  "tabforge-skin-neon": "tabforge-skin-bundle-creator-money",
  "tabforge-skin-executive": "tabforge-skin-bundle-wild-forge",
  "tabforge-skin-command-center": "tabforge-skin-bundle-command-center",
  "tabforge-skin-creator-money": "tabforge-skin-bundle-creator-money",
  "tabforge-skin-wild-forge": "tabforge-skin-bundle-wild-forge",
});

function canonicalEntitlementSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  return LEGACY_SKIN_ENTITLEMENT_ALIASES[slug] || slug;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function asCount(value) {
  const count = Number(value || 0);
  if (!Number.isInteger(count) || count < 0 || count > MAX_LIVE_TEST_COUNT) {
    const err = new Error("invalid_live_test_count");
    err.code = "invalid_live_test_count";
    err.statusCode = 400;
    throw err;
  }
  return count;
}

function normalizeEntitlementSlug(value) {
  const slug = canonicalEntitlementSlug(value);
  if (!/^[a-z0-9][a-z0-9-]{1,99}$/.test(slug)) {
    const err = new Error("invalid_entitlement_slug");
    err.code = "invalid_entitlement_slug";
    err.statusCode = 400;
    throw err;
  }
  if (!(slug === "tabforge" || slug.startsWith("tabforge-"))) {
    const err = new Error("test_entitlement_slug_not_allowed");
    err.code = "test_entitlement_slug_not_allowed";
    err.statusCode = 400;
    throw err;
  }
  return slug;
}

function testMetadata(session, extra = {}) {
  return {
    admin_live_test: true,
    admin_live_test_session_id: session.id,
    owner_email: session.owner_email,
    ...extra,
  };
}

function isTestMetadata(metadata) {
  return Boolean(metadata && typeof metadata === "object" && metadata.admin_live_test === true);
}

function ownerToolLogEntry(action, detail = {}) {
  return {
    at: new Date().toISOString(),
    action,
    ...detail,
  };
}

function appendOwnerToolLog(metadata = {}, entry) {
  const previous = Array.isArray(metadata.owner_tool_log) ? metadata.owner_tool_log : [];
  return {
    ...metadata,
    owner_tool_log: [entry, ...previous].slice(0, 30),
  };
}

async function appendSessionLog(trx, session, action, detail = {}) {
  const metadata = appendOwnerToolLog(session.metadata || {}, ownerToolLogEntry(action, detail));
  await trx("admin_live_test_sessions")
    .where({ id: session.id })
    .update({ metadata, updated_at: trx.fn.now() });
  return { ...session, metadata };
}

function catalogItemForSlug(slug) {
  const normalized = normalizeEntitlementSlug(slug);
  return TEST_ENTITLEMENT_PRESETS.find((item) => item.slug === normalized) || null;
}

export function liveTestingOwnerEmail() {
  return normalizeEmail(process.env.ADMIN_LIVE_TEST_OWNER_EMAIL || DEFAULT_OWNER_EMAIL);
}

export function liveTestingEnabledFor(adminEmail) {
  const enabled = String(process.env.ADMIN_LIVE_TESTING_ENABLED || "false").toLowerCase() === "true";
  return enabled && normalizeEmail(adminEmail) === liveTestingOwnerEmail();
}

export function liveTestingConfirmation() {
  return `LIVE TEST ${liveTestingOwnerEmail()}`;
}

export function ownerEntitlementCatalog() {
  const sections = [
    {
      key: "product_features",
      title: "Product features",
      description: "Account-level TabForge purchases. Extra Pages is a product feature, not a shortcut pack.",
      items: TEST_ENTITLEMENT_PRESETS.filter((item) => item.category === "product_features"),
    },
    {
      key: "shortcut_packs",
      title: "Shortcut pack entitlements",
      description: "Only pack slugs the current TabForge extension/store know how to unlock.",
      items: TEST_ENTITLEMENT_PRESETS.filter((item) => item.category === "shortcut_packs"),
    },
    {
      key: "skin_packs",
      title: "Skin pack entitlements",
      description: "Only the 3 purchasable skin packs. Individual theme pieces live inside Skin Studio.",
      items: TEST_ENTITLEMENT_PRESETS.filter((item) => item.category === "skin_packs"),
    },
  ];
  return { sections, flat: TEST_ENTITLEMENT_PRESETS };
}

async function requireOwnerUser(trx = db) {
  const email = liveTestingOwnerEmail();
  const user = await trx("users").whereRaw("lower(email) = ?", [email]).first();
  if (!user) {
    const err = new Error("live_test_owner_account_not_found");
    err.code = "live_test_owner_account_not_found";
    err.statusCode = 404;
    throw err;
  }
  return user;
}

async function currentEntitlement(trx, userId, productSlug = PRODUCT_SLUG) {
  if (!(await trx.schema.hasTable("product_entitlements"))) return null;
  return trx("product_entitlements")
    .where({ user_id: userId, product_slug: productSlug })
    .first();
}

async function ownerEntitlements(trx, owner, session) {
  if (!(await trx.schema.hasTable("product_entitlements"))) return [];
  const rows = await trx("product_entitlements")
    .where({ user_id: owner.id })
    .orderBy("product_slug", "asc");
  return rows.map((row) => {
    const metadata = row.metadata || {};
    const canonicalSlug = canonicalEntitlementSlug(row.product_slug);
    const isLegacyTest = row.source === TEST_SOURCE
      && (row.source_ref === session.id || metadata.admin_live_test_session_id === session.id);
    const isOwnerGrant = row.source === OWNER_ENTITLEMENT_SOURCE;
    const catalogItem = TEST_ENTITLEMENT_PRESETS.find((item) => item.slug === canonicalSlug) || null;
    return {
      id: row.id,
      productSlug: canonicalSlug,
      rawProductSlug: row.product_slug,
      label: catalogItem?.label || canonicalSlug,
      category: catalogItem?.category || "other",
      catalogItem: Boolean(catalogItem),
      status: row.status,
      source: row.source,
      sourceRef: row.source_ref || null,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at || null,
      isTest: Boolean(isLegacyTest),
      isOwnerGrant: Boolean(isOwnerGrant),
      canRemove: Boolean(isOwnerGrant || isLegacyTest),
      protectedRealEntitlement: Boolean(!isOwnerGrant && !isLegacyTest),
    };
  });
}

async function ensureSession(trx, owner) {
  let session = await trx("admin_live_test_sessions")
    .where({ owner_email: normalizeEmail(owner.email) })
    .forUpdate()
    .first();

  if (!session || session.status !== "active") {
    const entitlement = await currentEntitlement(trx, owner.id);
    const snapshot = {
      cashAppTag: owner.cash_app_tag || null,
      entitlement: entitlement
        ? {
            id: entitlement.id,
            status: entitlement.status,
            source: entitlement.source,
            sourceRef: entitlement.source_ref,
            expiresAt: entitlement.expires_at,
            metadata: entitlement.metadata || {},
          }
        : null,
    };

    const payload = {
      id: session?.id || crypto.randomUUID(),
      owner_user_id: owner.id,
      owner_email: normalizeEmail(owner.email),
      product_slug: PRODUCT_SLUG,
      status: "active",
      snapshot,
      metadata: {
        live_account: true,
        external_calls_disabled: true,
        max_count: MAX_LIVE_TEST_COUNT,
      },
      reset_at: null,
      updated_at: trx.fn.now(),
    };

    if (session) {
      [session] = await trx("admin_live_test_sessions")
        .where({ id: session.id })
        .update(payload)
        .returning("*");
    } else {
      [session] = await trx("admin_live_test_sessions")
        .insert(payload)
        .returning("*");
    }
  }

  return session;
}

function applyTestFilter(query, sessionId) {
  return query.whereRaw("metadata->>'admin_live_test_session_id' = ?", [String(sessionId)]);
}

function excludeTestFilter(query) {
  return query.whereRaw("coalesce(metadata->>'admin_live_test', 'false') <> 'true'");
}

async function testEvents(trx, ownerId, sessionId, eventType) {
  const query = trx("referral_events")
    .where({
      referrer_user_id: ownerId,
      product_slug: PRODUCT_SLUG,
      event_type: eventType,
    })
    .orderBy("created_at", "asc")
    .orderBy("id", "asc");
  return applyTestFilter(query, sessionId);
}

async function resizeSimpleEvents({ trx, owner, session, referralCode, eventType, status, desired }) {
  const rows = await testEvents(trx, owner.id, session.id, eventType);
  if (rows.length > desired) {
    const removeIds = rows.slice(desired).map((row) => row.id);
    await trx("referral_events").whereIn("id", removeIds).del();
    return;
  }

  const inserts = [];
  for (let index = rows.length; index < desired; index += 1) {
    const syntheticUserId = eventType === "invite" ? null : crypto.randomUUID();
    inserts.push({
      id: crypto.randomUUID(),
      referral_code_id: referralCode?.id || null,
      referrer_user_id: owner.id,
      referred_user_id: syntheticUserId,
      product_slug: PRODUCT_SLUG,
      purchase_ref: `${TEST_SOURCE}:${session.id}:${eventType}:${index + 1}`,
      event_type: eventType,
      status,
      metadata: testMetadata(session, {
        test_index: index + 1,
        recipient_email: eventType === "invite"
          ? `sendforge-live-test+${session.id.slice(0, 8)}-${index + 1}@example.invalid`
          : undefined,
        counts_toward_payout: false,
      }),
      updated_at: trx.fn.now(),
    });
  }

  for (let offset = 0; offset < inserts.length; offset += 500) {
    await trx("referral_events").insert(inserts.slice(offset, offset + 500));
  }
}

async function resizePurchaseEvents({ trx, owner, session, referralCode, verifiedDesired, refundedDesired }) {
  const rows = await testEvents(trx, owner.id, session.id, "purchase");
  const totalDesired = verifiedDesired + refundedDesired;

  if (rows.length > totalDesired) {
    const removeIds = rows.slice(totalDesired).map((row) => row.id);
    await trx("referral_events").whereIn("id", removeIds).del();
  }

  const kept = rows.slice(0, totalDesired);
  const inserts = [];
  for (let index = kept.length; index < totalDesired; index += 1) {
    inserts.push({
      id: crypto.randomUUID(),
      referral_code_id: referralCode?.id || null,
      referrer_user_id: owner.id,
      referred_user_id: crypto.randomUUID(),
      product_slug: PRODUCT_SLUG,
      purchase_ref: `${TEST_SOURCE}:${session.id}:purchase:${index + 1}`,
      event_type: "purchase",
      status: index < verifiedDesired ? "verified" : "refunded",
      metadata: testMetadata(session, {
        test_index: index + 1,
        qualification: "verified_purchase",
        synthetic_pro_purchase: true,
        external_payment_processed: false,
      }),
      updated_at: trx.fn.now(),
    });
  }

  for (let offset = 0; offset < inserts.length; offset += 500) {
    await trx("referral_events").insert(inserts.slice(offset, offset + 500));
  }

  const current = await testEvents(trx, owner.id, session.id, "purchase");
  for (let index = 0; index < current.length; index += 1) {
    const expectedStatus = index < verifiedDesired ? "verified" : "refunded";
    if (current[index].status !== expectedStatus) {
      await trx("referral_events")
        .where({ id: current[index].id })
        .update({ status: expectedStatus, updated_at: trx.fn.now() });
    }
  }
}

async function countRealVerifiedPurchases(trx, ownerId) {
  const query = trx("referral_events")
    .where({
      referrer_user_id: ownerId,
      product_slug: PRODUCT_SLUG,
      event_type: "purchase",
      status: "verified",
    });
  excludeTestFilter(query);
  const row = await query.countDistinct({ count: "referred_user_id" }).first();
  return Number(row?.count || 0);
}

async function countTestEvents(trx, ownerId, sessionId, eventType, status = null) {
  const query = trx("referral_events")
    .where({ referrer_user_id: ownerId, product_slug: PRODUCT_SLUG, event_type: eventType });
  if (status) query.andWhere({ status });
  applyTestFilter(query, sessionId);
  const row = await query.count({ count: "id" }).first();
  return Number(row?.count || 0);
}

async function testRewards(trx, ownerId, sessionId) {
  const query = trx("reward_queue")
    .where({ user_id: ownerId, product_slug: PRODUCT_SLUG })
    .orderBy("created_at", "asc");
  return applyTestFilter(query, sessionId);
}

async function reconcileTestRewards({ trx, owner, session, referralCode }) {
  const realVerifiedPurchases = await countRealVerifiedPurchases(trx, owner.id);
  const testVerifiedPurchases = await countTestEvents(trx, owner.id, session.id, "purchase", "verified");
  const effectiveVerifiedPurchases = realVerifiedPurchases + testVerifiedPurchases;
  const program = await getReferralProgram(PRODUCT_SLUG, trx);
  const tiers = tiersFromProgram(program);
  const existingTestRewards = await testRewards(trx, owner.id, session.id);

  const realRewards = await trx("reward_queue")
    .where({ user_id: owner.id, product_slug: PRODUCT_SLUG });

  for (const tier of tiers) {
    const tierReached = effectiveVerifiedPurchases >= tier.requiredPurchases;
    const existingTest = existingTestRewards.find(
      (row) => Number(row.metadata?.tier_required_purchases || 0) === tier.requiredPurchases
    );
    const existingReal = realRewards.find(
      (row) => !isTestMetadata(row.metadata)
        && Number(row.metadata?.tier_required_purchases || 0) === tier.requiredPurchases
    );

    if (!tierReached || existingReal) {
      if (existingTest) await trx("reward_queue").where({ id: existingTest.id }).del();
      continue;
    }

    if (!existingTest) {
      await trx("reward_queue").insert({
        id: crypto.randomUUID(),
        referral_code_id: referralCode?.id || null,
        user_id: owner.id,
        email: normalizeEmail(owner.email),
        product_slug: PRODUCT_SLUG,
        reward_key: `${TEST_SOURCE}:${session.id}:${tier.requiredPurchases}`,
        reward_amount_cents: tier.rewardAmountCents,
        reward_type: "cashapp_test",
        cashapp_handle: owner.cash_app_tag || referralCode?.cashapp_handle || null,
        status: "pending",
        metadata: testMetadata(session, {
          test_only: true,
          no_external_payout: true,
          tier_required_purchases: tier.requiredPurchases,
          effective_verified_purchase_count: effectiveVerifiedPurchases,
        }),
        updated_at: trx.fn.now(),
      });
    } else {
      await trx("reward_queue")
        .where({ id: existingTest.id })
        .update({
          reward_amount_cents: tier.rewardAmountCents,
          cashapp_handle: owner.cash_app_tag || referralCode?.cashapp_handle || null,
          metadata: {
            ...(existingTest.metadata || {}),
            effective_verified_purchase_count: effectiveVerifiedPurchases,
          },
          updated_at: trx.fn.now(),
        });
    }
  }

  return { realVerifiedPurchases, testVerifiedPurchases, effectiveVerifiedPurchases, tiers };
}

async function writeOwnerAccountEntitlement({ trx, owner, session, enabled, productSlug = PRODUCT_SLUG }) {
  if (!(await trx.schema.hasTable("product_entitlements"))) {
    return { supported: false, active: false, protectedRealEntitlement: false };
  }

  const slug = normalizeEntitlementSlug(productSlug);
  const existing = await currentEntitlement(trx, owner.id, slug);
  const isOwnerGrant = existing?.source === OWNER_ENTITLEMENT_SOURCE;
  const isLegacyTest = existing?.source === TEST_SOURCE
    && (existing?.source_ref === session.id || existing?.metadata?.admin_live_test_session_id === session.id);

  if (enabled) {
    // Do not overwrite a real Stripe/manual purchase or manual admin grant. Those
    // entitlements already behave as owned=true and remain under the normal
    // backend/device-limit enforcement path.
    if (existing && !isOwnerGrant && !isLegacyTest) {
      return {
        supported: true,
        active: existing.status === "active",
        protectedRealEntitlement: true,
        source: existing.source,
      };
    }

    const catalogItem = catalogItemForSlug(slug);
    const metadata = {
      ...(existing?.metadata || {}),
      owned: true,
      admin_owner_grant: true,
      owner_email: normalizeEmail(owner.email),
      granted_by_admin_panel: true,
      device_limits_still_enforced: true,
      catalog_label: catalogItem?.label || slug,
      catalog_category: catalogItem?.category || "custom",
      previous_source: existing?.source || null,
      previous_status: existing?.status || null,
      updated_at: new Date().toISOString(),
    };

    if (slug === "tabforge-pages") {
      metadata.purchased_quantity_total = Math.max(1, Number(metadata.purchased_quantity_total || 1));
      metadata.last_quantity_purchased = Math.max(1, Number(metadata.last_quantity_purchased || 1));
    }

    if (existing) {
      await trx("product_entitlements")
        .where({ id: existing.id })
        .update({
          source: OWNER_ENTITLEMENT_SOURCE,
          source_ref: liveTestingOwnerEmail(),
          status: "active",
          expires_at: null,
          metadata,
          updated_at: trx.fn.now(),
        });
    } else {
      await trx("product_entitlements").insert({
        id: crypto.randomUUID(),
        user_id: owner.id,
        product_slug: slug,
        source: OWNER_ENTITLEMENT_SOURCE,
        source_ref: liveTestingOwnerEmail(),
        status: "active",
        expires_at: null,
        metadata,
        updated_at: trx.fn.now(),
      });
    }
    await appendSessionLog(trx, session, "owner_entitlement_enabled", { slug, label: catalogItemForSlug(slug)?.label || slug });
    return { supported: true, active: true, protectedRealEntitlement: false, source: OWNER_ENTITLEMENT_SOURCE, productSlug: slug };
  }

  if (existing && !isOwnerGrant && !isLegacyTest) {
    const err = new Error("real_entitlement_protected");
    err.code = "real_entitlement_protected";
    err.statusCode = 409;
    throw err;
  }
  if (existing && (isOwnerGrant || isLegacyTest)) {
    await trx("product_entitlements")
      .where({ id: existing.id })
      .update({
        status: "revoked",
        metadata: {
          ...(existing.metadata || {}),
          owned: false,
          revoked_by_admin_panel: true,
          revoked_at: new Date().toISOString(),
        },
        updated_at: trx.fn.now(),
      });
  }
  await appendSessionLog(trx, session, "owner_entitlement_disabled", { slug, label: catalogItemForSlug(slug)?.label || slug });
  return { supported: true, active: false, protectedRealEntitlement: false, source: OWNER_ENTITLEMENT_SOURCE, productSlug: slug };
}

async function liveStateFromTransaction(trx, owner, session) {
  const referralCode = await ensureReferralCodeForUser(owner, trx);
  const [testInvites, testVerifiedAccounts, testQualifiedPurchases, testRefundedPurchases, rewards, entitlement, entitlements] = await Promise.all([
    countTestEvents(trx, owner.id, session.id, "invite"),
    countTestEvents(trx, owner.id, session.id, "signup", "verified"),
    countTestEvents(trx, owner.id, session.id, "purchase", "verified"),
    countTestEvents(trx, owner.id, session.id, "purchase", "refunded"),
    testRewards(trx, owner.id, session.id),
    currentEntitlement(trx, owner.id),
    ownerEntitlements(trx, owner, session),
  ]);

  const realVerifiedPurchases = await countRealVerifiedPurchases(trx, owner.id);
  const program = await getReferralProgram(PRODUCT_SLUG, trx);
  const payoutHoldDays = Number.isInteger(Number(program?.refund_hold_days)) ? Number(program.refund_hold_days) : 10;
  const tiers = tiersFromProgram(program).map((tier) => ({
    ...tier,
    reached: realVerifiedPurchases + testQualifiedPurchases >= tier.requiredPurchases,
    remaining: Math.max(0, tier.requiredPurchases - realVerifiedPurchases - testQualifiedPurchases),
    payoutHoldDays,
  }));

  return {
    enabled: true,
    liveAccount: true,
    ownerEmail: normalizeEmail(owner.email),
    ownerUserId: owner.id,
    productSlug: PRODUCT_SLUG,
    session: {
      id: session.id,
      status: session.status,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    },
    account: {
      emailVerified: Boolean(owner.email_verified),
      cashAppTag: owner.cash_app_tag || null,
      referralCode: referralCode?.code || null,
      tabforgeProEntitlementActive: Boolean(entitlement?.status === "active"),
      tabforgeProEntitlementSource: entitlement?.source || null,
      realEntitlementProtected: Boolean(entitlement && ![TEST_SOURCE, OWNER_ENTITLEMENT_SOURCE].includes(entitlement.source)),
    },
    counts: {
      testInvites,
      testVerifiedAccounts,
      testQualifiedPurchases,
      testRefundedPurchases,
      realVerifiedPurchases,
      effectiveVerifiedPurchases: realVerifiedPurchases + testQualifiedPurchases,
    },
    tiers,
    testRewards: rewards.map((row) => ({
      id: row.id,
      status: row.status,
      rewardAmountCents: row.reward_amount_cents,
      cashAppHandle: row.cashapp_handle,
      payoutReference: row.payout_reference || null,
      tierRequiredPurchases: Number(row.metadata?.tier_required_purchases || 0),
      metadata: row.metadata || {},
    })),
    entitlementCatalog: ownerEntitlementCatalog(),
    entitlementPresets: TEST_ENTITLEMENT_PRESETS,
    entitlements,
    ownerToolLogs: Array.isArray(session.metadata?.owner_tool_log) ? session.metadata.owner_tool_log : [],
    safety: {
      ownerOnly: true,
      targetAccountFixed: true,
      emailsDisabled: true,
      stripeDisabled: true,
      cashAppTransferDisabled: true,
      referralTestRowsTagged: true,
      ownerEntitlementWritesAreReal: true,
      maxCount: MAX_LIVE_TEST_COUNT,
    },
  };
}

export async function getLiveTestState() {
  return db.transaction(async (trx) => {
    const owner = await requireOwnerUser(trx);
    const session = await ensureSession(trx, owner);
    return liveStateFromTransaction(trx, owner, session);
  });
}

export async function applyLiveTestState({ invites, verifiedAccounts, qualifiedPurchases, refundedPurchases, cashAppTag, proEntitlement }) {
  const desired = {
    invites: asCount(invites),
    verifiedAccounts: asCount(verifiedAccounts),
    qualifiedPurchases: asCount(qualifiedPurchases),
    refundedPurchases: asCount(refundedPurchases),
  };

  // Create the session and capture the pre-test snapshot before changing any
  // live account value such as the Cash App tag.
  const prepared = await db.transaction(async (trx) => {
    const owner = await requireOwnerUser(trx);
    const session = await ensureSession(trx, owner);
    return { ownerId: owner.id, sessionId: session.id };
  });

  if (cashAppTag !== undefined) {
    await updateUserCashAppTag({ userId: prepared.ownerId, cashAppTag });
  }

  return db.transaction(async (trx) => {
    let owner = await requireOwnerUser(trx);
    const session = await trx("admin_live_test_sessions")
      .where({ id: prepared.sessionId, status: "active" })
      .forUpdate()
      .first();
    if (!session) {
      const err = new Error("live_test_session_not_found");
      err.code = "live_test_session_not_found";
      err.statusCode = 409;
      throw err;
    }
    const referralCode = await ensureReferralCodeForUser(owner, trx);

    await resizeSimpleEvents({
      trx,
      owner,
      session,
      referralCode,
      eventType: "invite",
      status: "sent",
      desired: desired.invites,
    });
    await resizeSimpleEvents({
      trx,
      owner,
      session,
      referralCode,
      eventType: "signup",
      status: "verified",
      desired: desired.verifiedAccounts,
    });
    await resizePurchaseEvents({
      trx,
      owner,
      session,
      referralCode,
      verifiedDesired: desired.qualifiedPurchases,
      refundedDesired: desired.refundedPurchases,
    });

    if (proEntitlement !== undefined) {
      await writeOwnerAccountEntitlement({ trx, owner, session, enabled: Boolean(proEntitlement) });
    }

    owner = await trx("users").where({ id: owner.id }).first();
    await reconcileTestRewards({ trx, owner, session, referralCode });
    await trx("admin_live_test_sessions")
      .where({ id: session.id })
      .update({
        metadata: {
          ...(session.metadata || {}),
          desired,
          last_applied_at: new Date().toISOString(),
        },
        updated_at: trx.fn.now(),
      });

    const updatedSession = await trx("admin_live_test_sessions").where({ id: session.id }).first();
    return liveStateFromTransaction(trx, owner, updatedSession);
  });
}

export async function stepLiveTestState({ action, quantity = 1 }) {
  const delta = Number(quantity);
  if (!Number.isInteger(delta) || delta < -MAX_LIVE_TEST_COUNT || delta > MAX_LIVE_TEST_COUNT) {
    const err = new Error("invalid_live_test_quantity");
    err.code = "invalid_live_test_quantity";
    err.statusCode = 400;
    throw err;
  }

  const state = await getLiveTestState();
  const counts = state.counts;
  const next = {
    invites: counts.testInvites,
    verifiedAccounts: counts.testVerifiedAccounts,
    qualifiedPurchases: counts.testQualifiedPurchases,
    refundedPurchases: counts.testRefundedPurchases,
  };

  const fieldMap = {
    invite: "invites",
    verify: "verifiedAccounts",
    purchase: "qualifiedPurchases",
    refund: "refundedPurchases",
  };
  const field = fieldMap[action];
  if (!field) {
    const err = new Error("invalid_live_test_action");
    err.code = "invalid_live_test_action";
    err.statusCode = 400;
    throw err;
  }
  next[field] = Math.max(0, Math.min(MAX_LIVE_TEST_COUNT, next[field] + delta));
  return applyLiveTestState(next);
}

export async function updateLiveTestRewardStatus({ rewardId, status, note = null }) {
  const allowed = new Set(["pending", "approved", "paid", "rejected"]);
  if (!allowed.has(status)) {
    const err = new Error("invalid_reward_status");
    err.code = "invalid_reward_status";
    err.statusCode = 400;
    throw err;
  }

  return db.transaction(async (trx) => {
    const owner = await requireOwnerUser(trx);
    const session = await ensureSession(trx, owner);
    const reward = await trx("reward_queue").where({ id: rewardId, user_id: owner.id }).first();
    if (!reward || reward.metadata?.admin_live_test_session_id !== session.id) {
      const err = new Error("live_test_reward_not_found");
      err.code = "live_test_reward_not_found";
      err.statusCode = 404;
      throw err;
    }

    if (["approved", "paid"].includes(status) && !owner.cash_app_tag) {
      const err = new Error("cash_app_tag_required");
      err.code = "cash_app_tag_required";
      err.statusCode = 409;
      throw err;
    }

    const update = {
      status,
      admin_note: note || `LIVE TEST ONLY — no Cash App transfer was sent (${status}).`,
      cashapp_handle: owner.cash_app_tag || null,
      updated_at: trx.fn.now(),
    };

    if (status === "approved") {
      update.approved_by = owner.id;
      update.approved_at = trx.fn.now();
      update.paid_by = null;
      update.paid_at = null;
      update.payout_reference = null;
    } else if (status === "paid") {
      update.approved_by = reward.approved_by || owner.id;
      update.approved_at = reward.approved_at || trx.fn.now();
      update.paid_by = owner.id;
      update.paid_at = trx.fn.now();
      update.payout_reference = `test:${session.id}:${reward.id}:${Date.now()}`;
    } else if (status === "pending") {
      update.approved_by = null;
      update.approved_at = null;
      update.paid_by = null;
      update.paid_at = null;
      update.payout_reference = null;
    }

    await trx("reward_queue").where({ id: reward.id }).update(update);
    await appendSessionLog(trx, session, "test_reward_status_changed", { rewardId: reward.id, status });
    const updatedSession = await trx("admin_live_test_sessions").where({ id: session.id }).first();
    return liveStateFromTransaction(trx, owner, updatedSession);
  });
}

export async function setOwnerAccountEntitlement({ productSlug, enabled }) {
  const slug = normalizeEntitlementSlug(productSlug);
  return db.transaction(async (trx) => {
    const owner = await requireOwnerUser(trx);
    const session = await ensureSession(trx, owner);
    await writeOwnerAccountEntitlement({ trx, owner, session, enabled: Boolean(enabled), productSlug: slug });
    const updatedOwner = await trx("users").where({ id: owner.id }).first();
    const updatedSession = await trx("admin_live_test_sessions").where({ id: session.id }).first();
    return liveStateFromTransaction(trx, updatedOwner, updatedSession);
  });
}

export async function resetLiveTestState({ restoreCashAppTag = true } = {}) {
  const cleanup = await db.transaction(async (trx) => {
    const owner = await requireOwnerUser(trx);
    const session = await ensureSession(trx, owner);

    const rewardQuery = trx("reward_queue")
      .where({ user_id: owner.id, product_slug: PRODUCT_SLUG });
    applyTestFilter(rewardQuery, session.id);
    await rewardQuery.del();

    const eventQuery = trx("referral_events")
      .where({ referrer_user_id: owner.id, product_slug: PRODUCT_SLUG });
    applyTestFilter(eventQuery, session.id);
    await eventQuery.del();

    if (await trx.schema.hasTable("product_entitlements")) {
      await trx("product_entitlements")
        .where({ user_id: owner.id, source: TEST_SOURCE, source_ref: session.id })
        .del();
    }

    await trx("admin_live_test_sessions")
      .where({ id: session.id })
      .update({ status: "reset", reset_at: trx.fn.now(), updated_at: trx.fn.now() });

    return {
      ownerId: owner.id,
      snapshotCashAppTag: session.snapshot?.cashAppTag ?? null,
    };
  });

  if (restoreCashAppTag) {
    await updateUserCashAppTag({
      userId: cleanup.ownerId,
      cashAppTag: cleanup.snapshotCashAppTag,
    });
  }

  return db.transaction(async (trx) => {
    const owner = await requireOwnerUser(trx);
    const nextSession = await ensureSession(trx, owner);
    return liveStateFromTransaction(trx, owner, nextSession);
  });
}

