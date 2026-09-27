// Recurring affiliate payouts: the owner's side of the subscription shares.
//
// An affiliate earns a share of every paid invoice of the subscriptions they
// referred: TabForge Private Sync and DropForge Cloud pickup. Each invoice is
// one reward_queue row (referral.service.js recordSyncSubscriptionShare and
// recordCloudPickupShare). This module groups those rows into one statement
// per affiliate per calendar month (UTC, by when the invoice was paid), which
// the owner approves and pays with one Cash App transfer, and keeps the
// settings behind it: each programme's rate and switch, per-affiliate rates,
// the minimum payout and the payout day.
//
// Nothing runs on a timer. Statements are computed from reward_queue when the
// dashboard asks, walking each affiliate's months in order:
//
//  - a month still running is "open", and holds whatever is due so far;
//  - a finished month whose total is under the minimum payout is
//    "carried_over": its invoices move into the next month's statement;
//  - otherwise it is "pending" until the owner approves, pays or rejects it.
//
// Only a statement the owner acted on is stored (affiliate_payout_statements).
// A paid or rejected statement is closed: invoices it could not pay, such as
// ones still inside their review period, and invoices that arrive for its
// month later, move to the next month's statement. Rows paid, approved or
// rejected through a statement carry its id in their metadata
// (statement_id), so they stay with it whatever month they came from.

import crypto from "crypto";
import { db } from "../../config/db.js";
import { batchPayoutReference } from "../adminReferralControls.service.js";
import {
  TABFORGE_SYNC_PLAN_ALIASES,
  TABFORGE_SYNC_PRICE_CENTS,
  TABFORGE_SYNC_PRODUCT_SLUG,
  isTabForgeSyncEntitlement,
} from "../tabforgeBilling.service.js";
// A namespace import: only the tier table is read, and only when a
// subscription's own price cannot be.
import * as pickupPlans from "../../modules/forgedrop-pickup/plans.js";
import {
  CLOUD_PICKUP_SHARE_PRODUCT_SLUG,
  SYNC_SHARE_PRODUCT_SLUG,
  cashAppTagKey,
  isSubscriptionShareReward,
  normalizeCashAppTag,
  normalizeEmail,
  rewardPayoutEligibility,
} from "./referral.service.js";
import {
  DEFAULT_SHARE_RATE_BPS,
  MAX_SHARE_RATE_BPS,
  SHARE_OVERRIDES_TABLE,
  SHARE_PROGRAMS_TABLE,
  effectiveShareRate,
  shareCentsAt,
  shareTableReady,
  validShareRateBps,
} from "./shareRates.js";

export const PAYOUT_SETTINGS_TABLE = "affiliate_payout_settings";
export const STATEMENTS_TABLE = "affiliate_payout_statements";
export const DEFAULT_PAYOUT_SETTINGS = Object.freeze({ minimumPayoutCents: 0, payoutDay: 15 });
export const MAX_MINIMUM_PAYOUT_CENTS = 100000000;

// The subscription programmes that pay affiliates a share, and the gate each
// one's payout checks (rewardPayoutEligibility), named the way the approval
// route names it when it refuses.
export const SUBSCRIPTION_SHARE_PROGRAMS = Object.freeze([
  Object.freeze({
    slug: SYNC_SHARE_PRODUCT_SLUG,
    label: "TabForge Private Sync",
    kind: "sync_share",
    gate: "The referrer must own TabForge Pro.",
    gateError: "referrer_tabforge_pro_required",
  }),
  Object.freeze({
    slug: CLOUD_PICKUP_SHARE_PRODUCT_SLUG,
    label: "DropForge Cloud pickup",
    kind: "cloud_pickup_share",
    gate: "The referrer must be at the DropForge affiliate level.",
    gateError: "referrer_not_forgedrop_affiliate",
  }),
]);
const PROGRAM_SLUGS = SUBSCRIPTION_SHARE_PROGRAMS.map((program) => program.slug);
const PROGRAM_KINDS = SUBSCRIPTION_SHARE_PROGRAMS.map((program) => program.kind);
const PROGRAM_BY_SLUG = new Map(SUBSCRIPTION_SHARE_PROGRAMS.map((program) => [program.slug, program]));

export function shareProgram(slug) {
  return PROGRAM_BY_SLUG.get(String(slug || "").trim().toLowerCase()) || null;
}

export const STATEMENT_STATUSES = Object.freeze(["open", "pending", "approved", "paid", "carried_over", "rejected", "canceled"]);
const SETTLED_ROW_STATUSES = new Set(["paid", "rejected", "canceled"]);
const CLOSED_RECORD_STATUSES = new Set(["paid", "rejected"]);

export function recurringPayoutError(statusCode, error, extra = {}) {
  const err = new Error(error);
  err.statusCode = statusCode;
  err.responseBody = { error, ...extra };
  return err;
}

const metadataOf = (row) => (row?.metadata && typeof row.metadata === "object" ? row.metadata : {});
const sumCents = (rows) => rows.reduce((total, row) => total + Number(row.reward_amount_cents || 0), 0);
const isoOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

// ------------------------------------------------------------------ months

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The UTC calendar month holding a moment, as YYYY-MM. */
export function monthOf(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function nextMonth(month) {
  const [year, mon] = String(month).split("-").map(Number);
  return mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
}

/**
 * The next payout run on or after today (UTC), on the payout day of the
 * month, and the month whose statements it pays: the one before it.
 */
export function nextPayoutRun(payoutDay, now = new Date()) {
  const day = validPayoutDay(payoutDay) ?? DEFAULT_PAYOUT_SETTINGS.payoutDay;
  const today = new Date(now);
  let run = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), day));
  if (today.getUTCDate() > day) run = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, day));
  const paysMonth = monthOf(new Date(Date.UTC(run.getUTCFullYear(), run.getUTCMonth() - 1, 1)));
  return { date: run.toISOString().slice(0, 10), paysMonth };
}

function validPayoutDay(value) {
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 28 ? day : null;
}

function validMinimumCents(value) {
  const cents = Number(value);
  return Number.isInteger(cents) && cents >= 0 && cents <= MAX_MINIMUM_PAYOUT_CENTS ? cents : null;
}

// ---------------------------------------------------------------- settings

const RECURRING_TABLES = [SHARE_PROGRAMS_TABLE, SHARE_OVERRIDES_TABLE, PAYOUT_SETTINGS_TABLE, STATEMENTS_TABLE];

async function recurringTablesReady(trx) {
  for (const table of RECURRING_TABLES) {
    if (!(await shareTableReady(trx, table))) return false;
  }
  return true;
}

async function requireRecurringTables(trx) {
  if (!(await recurringTablesReady(trx))) throw recurringPayoutError(503, "recurring_payouts_not_migrated");
}

async function loadPayoutSettings(trx, now, ready) {
  const row = ready ? await trx(PAYOUT_SETTINGS_TABLE).where({ id: "default" }).first() : null;
  const minimumPayoutCents = validMinimumCents(row?.minimum_payout_cents) ?? DEFAULT_PAYOUT_SETTINGS.minimumPayoutCents;
  const payoutDay = validPayoutDay(row?.payout_day) ?? DEFAULT_PAYOUT_SETTINGS.payoutDay;
  const run = nextPayoutRun(payoutDay, now);
  return {
    minimumPayoutCents,
    payoutDay,
    nextRunDate: run.date,
    nextRunPaysMonth: run.paysMonth,
    updatedAt: isoOrNull(row?.updated_at),
  };
}

/** Each programme's rate and switch, and the payout settings. */
export async function loadShareSettings(trx = db, now = new Date()) {
  const ready = await recurringTablesReady(trx);
  const rows = ready ? await trx(SHARE_PROGRAMS_TABLE) : [];
  const bySlug = new Map(rows.map((row) => [row.program_slug, row]));
  const programs = SUBSCRIPTION_SHARE_PROGRAMS.map((program) => {
    const row = bySlug.get(program.slug) || null;
    const rate = effectiveShareRate({ programRow: row });
    return {
      slug: program.slug,
      label: program.label,
      gate: program.gate,
      rateBps: rate.programRateBps,
      enabled: rate.enabled,
      updatedAt: isoOrNull(row?.updated_at),
    };
  });
  return { ready, programs, payout: await loadPayoutSettings(trx, now, ready) };
}

/** Sets a programme's rate and/or switch. Nothing is written when nothing changes. */
export async function updateProgramShare(trx, slug, { rateBps, enabled } = {}, adminUserId = null) {
  await requireRecurringTables(trx);
  const program = shareProgram(slug);
  if (!program) throw recurringPayoutError(404, "unknown_share_program");
  if (rateBps !== undefined && validShareRateBps(rateBps) === null) throw recurringPayoutError(400, "invalid_share_rate");

  const before = await trx(SHARE_PROGRAMS_TABLE).where({ program_slug: program.slug }).forUpdate().first();
  const next = {
    rate_bps: rateBps === undefined ? validShareRateBps(before?.rate_bps) ?? DEFAULT_SHARE_RATE_BPS : Number(rateBps),
    enabled: enabled === undefined ? (before ? before.enabled !== false : true) : Boolean(enabled),
  };
  if (before && Number(before.rate_bps) === next.rate_bps && (before.enabled !== false) === next.enabled) {
    return { before, after: before, changed: false };
  }
  const [after] = before
    ? await trx(SHARE_PROGRAMS_TABLE)
        .where({ program_slug: program.slug })
        .update({ ...next, updated_by: adminUserId, updated_at: trx.fn.now() })
        .returning("*")
    : await trx(SHARE_PROGRAMS_TABLE)
        .insert({ program_slug: program.slug, label: program.label, ...next, updated_by: adminUserId })
        .returning("*");
  return { before: before || null, after, changed: true };
}

/** Sets the minimum payout and/or the payout day. Nothing is written when nothing changes. */
export async function updatePayoutSettings(trx, { minimumPayoutCents, payoutDay } = {}, adminUserId = null) {
  await requireRecurringTables(trx);
  if (minimumPayoutCents !== undefined && validMinimumCents(minimumPayoutCents) === null) {
    throw recurringPayoutError(400, "invalid_minimum_payout");
  }
  if (payoutDay !== undefined && validPayoutDay(payoutDay) === null) throw recurringPayoutError(400, "invalid_payout_day");

  const before = await trx(PAYOUT_SETTINGS_TABLE).where({ id: "default" }).forUpdate().first();
  const next = {
    minimum_payout_cents: minimumPayoutCents === undefined
      ? validMinimumCents(before?.minimum_payout_cents) ?? DEFAULT_PAYOUT_SETTINGS.minimumPayoutCents
      : Number(minimumPayoutCents),
    payout_day: payoutDay === undefined
      ? validPayoutDay(before?.payout_day) ?? DEFAULT_PAYOUT_SETTINGS.payoutDay
      : Number(payoutDay),
  };
  if (before && Number(before.minimum_payout_cents) === next.minimum_payout_cents && Number(before.payout_day) === next.payout_day) {
    return { before, after: before, changed: false };
  }
  const [after] = before
    ? await trx(PAYOUT_SETTINGS_TABLE)
        .where({ id: "default" })
        .update({ ...next, updated_by: adminUserId, updated_at: trx.fn.now() })
        .returning("*")
    : await trx(PAYOUT_SETTINGS_TABLE).insert({ id: "default", ...next, updated_by: adminUserId }).returning("*");
  return { before: before || null, after, changed: true };
}

// --------------------------------------------------------------- overrides

function overrideView(row) {
  return {
    userId: row.user_id,
    email: row.email || null,
    programSlug: row.program_slug,
    programLabel: shareProgram(row.program_slug)?.label || row.program_slug,
    rateBps: Number(row.rate_bps),
    note: row.note || null,
    updatedAt: isoOrNull(row.updated_at),
  };
}

export async function listShareOverrides(trx = db) {
  if (!(await shareTableReady(trx, SHARE_OVERRIDES_TABLE))) return [];
  const rows = await trx(`${SHARE_OVERRIDES_TABLE} as o`)
    .leftJoin("users as u", "o.user_id", "u.id")
    .select("o.*", "u.email as email")
    .orderBy([{ column: "u.email", order: "asc" }, { column: "o.program_slug", order: "asc" }]);
  return rows.map(overrideView);
}

/** One affiliate's own rate on a programme; 0 means they earn nothing on it. */
export async function setShareOverride(trx, { userId, programSlug, rateBps, note } = {}, adminUserId = null) {
  await requireRecurringTables(trx);
  const program = shareProgram(programSlug);
  if (!program) throw recurringPayoutError(404, "unknown_share_program");
  if (validShareRateBps(rateBps) === null) throw recurringPayoutError(400, "invalid_share_rate");
  const user = await trx("users").where({ id: userId }).first();
  if (!user) throw recurringPayoutError(404, "user_not_found");

  const cleanNote = note === undefined ? undefined : String(note || "").trim() || null;
  const before = await trx(SHARE_OVERRIDES_TABLE).where({ user_id: user.id, program_slug: program.slug }).forUpdate().first();
  if (before && Number(before.rate_bps) === Number(rateBps) && (cleanNote === undefined || (before.note || null) === cleanNote)) {
    return { before, after: before, changed: false };
  }
  const values = { rate_bps: Number(rateBps), updated_by: adminUserId, updated_at: trx.fn.now() };
  if (cleanNote !== undefined) values.note = cleanNote;
  const [after] = before
    ? await trx(SHARE_OVERRIDES_TABLE).where({ id: before.id }).update(values).returning("*")
    : await trx(SHARE_OVERRIDES_TABLE)
        .insert({ id: crypto.randomUUID(), user_id: user.id, program_slug: program.slug, note: cleanNote ?? null, ...values })
        .returning("*");
  return { before: before || null, after, changed: true };
}

/** Back to the programme's rate. */
export async function clearShareOverride(trx, { userId, programSlug } = {}) {
  await requireRecurringTables(trx);
  const program = shareProgram(programSlug);
  if (!program) throw recurringPayoutError(404, "unknown_share_program");
  const before = await trx(SHARE_OVERRIDES_TABLE).where({ user_id: userId, program_slug: program.slug }).forUpdate().first();
  if (!before) return { before: null, changed: false };
  await trx(SHARE_OVERRIDES_TABLE).where({ id: before.id }).delete();
  return { before, changed: true };
}

// ------------------------------------------------------------ affiliates

async function activeClaims(trx, userIds) {
  const claims = new Map();
  if (!userIds.length || !(await shareTableReady(trx, "cash_app_tag_claims"))) return claims;
  const rows = await trx("cash_app_tag_claims").whereIn("user_id", userIds).where({ status: "active" });
  for (const row of rows) {
    if (!claims.has(row.user_id)) claims.set(row.user_id, new Set());
    claims.get(row.user_id).add(String(row.normalized_tag || "").toLowerCase());
  }
  return claims;
}

function tagClaimed(claims, userId, tag) {
  const key = cashAppTagKey(tag);
  return Boolean(key && claims.get(userId)?.has(key));
}

async function firstActiveCodes(trx, userIds) {
  const codes = new Map();
  if (!userIds.length) return codes;
  const rows = await trx("referral_codes").whereIn("user_id", userIds).where({ status: "active" }).orderBy("created_at", "asc");
  for (const row of rows) if (!codes.has(row.user_id)) codes.set(row.user_id, row.code);
  return codes;
}

async function affiliateInfo(trx, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const users = ids.length ? await trx("users").whereIn("id", ids).select("id", "email", "cash_app_tag") : [];
  const claims = await activeClaims(trx, ids);
  const codes = await firstActiveCodes(trx, ids);
  const info = new Map();
  for (const user of users) {
    const tag = normalizeCashAppTag(user.cash_app_tag);
    info.set(user.id, {
      userId: user.id,
      email: user.email || null,
      cashAppTag: tag,
      cashAppTagClaimed: tagClaimed(claims, user.id, tag),
      referralCode: codes.get(user.id) || null,
      claims: claims.get(user.id) || new Set(),
    });
  }
  return info;
}

async function eligibilityFor(trx, pairs) {
  const eligible = new Map();
  for (const [userId, slug] of pairs) {
    const key = `${userId}:${slug}`;
    if (!eligible.has(key)) eligible.set(key, await rewardPayoutEligibility(userId, slug, trx));
  }
  return eligible;
}

/**
 * An affiliate by email or referral code, with each programme's rate for
 * them: the programme's, their own if the owner set one, and whether they
 * pass the programme's gate.
 */
export async function findAffiliate(query, trx = db) {
  const raw = String(query || "").trim();
  if (!raw) throw recurringPayoutError(400, "query_required");
  let user = null;
  if (raw.includes("@")) {
    user = await trx("users").where({ email: normalizeEmail(raw) }).first();
  } else {
    const code = await trx("referral_codes")
      .where({ code: raw.replace(/^#/, "").toUpperCase() })
      .orderByRaw("case when status = 'active' then 0 else 1 end")
      .first();
    if (code?.user_id) user = await trx("users").where({ id: code.user_id }).first();
  }
  if (!user) throw recurringPayoutError(404, "user_not_found");
  return affiliateRates(user.id, trx);
}

export async function affiliateRates(userId, trx = db) {
  const info = (await affiliateInfo(trx, [userId])).get(userId);
  if (!info) throw recurringPayoutError(404, "user_not_found");
  const ready = await recurringTablesReady(trx);
  const programRows = ready ? await trx(SHARE_PROGRAMS_TABLE) : [];
  const overrideRows = ready ? await trx(SHARE_OVERRIDES_TABLE).where({ user_id: userId }) : [];
  const eligible = await eligibilityFor(trx, PROGRAM_SLUGS.map((slug) => [userId, slug]));
  const referred = await trx("users")
    .where({ referred_by_user_id: userId })
    .whereNot({ id: userId })
    .count({ count: "id" })
    .first();
  const { claims, ...affiliate } = info;
  return {
    affiliate,
    referredAccounts: Number(referred?.count || 0),
    programs: SUBSCRIPTION_SHARE_PROGRAMS.map((program) => {
      const rate = effectiveShareRate({
        programRow: programRows.find((row) => row.program_slug === program.slug) || null,
        overrideRow: overrideRows.find((row) => row.program_slug === program.slug) || null,
      });
      return {
        slug: program.slug,
        label: program.label,
        gate: program.gate,
        enabled: rate.enabled,
        programRateBps: rate.programRateBps,
        overrideBps: rate.overrideBps,
        rateBps: rate.rateBps,
        rateSource: rate.source,
        eligible: eligible.get(`${userId}:${program.slug}`),
      };
    }),
  };
}

// -------------------------------------------------------------- statements

/** When the share's invoice was paid: recorded on the row, else when the row was made. */
function invoicePaidAt(row, now) {
  const recorded = Date.parse(metadataOf(row).invoice_paid_at || "");
  if (Number.isFinite(recorded)) return new Date(recorded);
  const created = new Date(row.created_at);
  return Number.isFinite(created.getTime()) ? created : new Date(now);
}

function rowRateBps(row) {
  const meta = metadataOf(row);
  const bps = validShareRateBps(meta.share_rate_bps);
  if (bps !== null) return bps;
  const fraction = Number(meta.share_rate);
  return Number.isFinite(fraction) && fraction >= 0 ? Math.round(fraction * 10000) : null;
}

async function loadShareRows(trx, { userId = null, now }) {
  const query = trx("reward_queue as r")
    .select("r.*")
    .whereIn("r.product_slug", PROGRAM_SLUGS)
    .whereRaw(`r.metadata->>'kind' in (${PROGRAM_KINDS.map(() => "?").join(", ")})`, PROGRAM_KINDS)
    .orderBy([{ column: "r.created_at", order: "asc" }, { column: "r.id", order: "asc" }]);
  if (userId) query.where("r.user_id", userId);
  const rows = await query;
  return rows
    .filter((row) => isSubscriptionShareReward(row) && metadataOf(row).admin_live_test !== true && row.user_id)
    .map((row) => {
      const paidAt = invoicePaidAt(row, now);
      return { ...row, invoicePaidAt: paidAt.toISOString(), invoiceMonth: monthOf(paidAt) };
    });
}

async function loadStatementRecords(trx, { userId = null } = {}) {
  if (!(await shareTableReady(trx, STATEMENTS_TABLE))) return [];
  const query = trx(STATEMENTS_TABLE);
  if (userId) query.where({ user_id: userId });
  return query;
}

/**
 * One affiliate's statements, month by month. Pure: rows (with invoiceMonth),
 * the owner's statement records, the minimum payout and the current month in;
 * statements with their open (unsettled) and settled rows out.
 */
export function buildAffiliateStatements({ userId, rows, records, minimumPayoutCents = 0, currentMonth }) {
  const recordsByMonth = new Map(records.map((record) => [record.month, record]));
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const statements = new Map();
  const statementFor = (month) => {
    if (!statements.has(month)) {
      statements.set(month, {
        userId,
        month,
        record: recordsByMonth.get(month) || null,
        open: [],
        settled: [],
        carriedIn: [],
        carriedOut: [],
        carriedOver: false,
        inProgress: false,
      });
    }
    return statements.get(month);
  };
  const floating = new Map();
  const pinned = new Map();
  const push = (map, month, row) => {
    if (!map.has(month)) map.set(month, []);
    map.get(month).push(row);
  };
  let firstMonth = currentMonth;
  let lastMonth = currentMonth;
  const touch = (month) => {
    if (month < firstMonth) firstMonth = month;
    if (month > lastMonth) lastMonth = month;
  };

  for (const row of rows) {
    const record = recordsById.get(metadataOf(row).statement_id) || null;
    if (SETTLED_ROW_STATUSES.has(row.status)) {
      // Settled through a statement: shown on it. Settled one at a time from
      // the payout queue: shown on its invoice's month.
      const month = record ? record.month : row.invoiceMonth;
      statementFor(month).settled.push(row);
      touch(month);
    } else if (record?.status === "approved") {
      push(pinned, record.month, row);
      touch(record.month);
    } else {
      push(floating, row.invoiceMonth, row);
      touch(row.invoiceMonth);
    }
  }
  for (const record of records) touch(record.month);

  let carry = [];
  for (let month = firstMonth; month <= lastMonth || carry.length; month = nextMonth(month)) {
    const candidates = [...carry, ...(floating.get(month) || [])];
    const pins = pinned.get(month) || [];
    const record = recordsByMonth.get(month) || null;
    if (!candidates.length && !pins.length && !record && !statements.has(month)) continue;
    const statement = statementFor(month);
    statement.carriedIn = carry;
    if (record && CLOSED_RECORD_STATUSES.has(record.status)) {
      statement.carriedOut = candidates;
      carry = candidates;
      continue;
    }
    statement.open = [...pins, ...candidates];
    carry = [];
    if (record?.status === "approved") continue;
    if (month >= currentMonth) {
      statement.inProgress = true;
      continue;
    }
    if (statement.open.length && sumCents(statement.open) < minimumPayoutCents) {
      statement.carriedOver = true;
      carry = statement.open;
    }
  }
  return [...statements.values()];
}

export function statementStatus(statement) {
  if (statement.record?.status === "paid") return "paid";
  if (statement.record?.status === "rejected") return "rejected";
  if (!statement.open.length) {
    if (statement.settled.some((row) => row.status === "paid")) return "paid";
    if (statement.settled.some((row) => row.status === "rejected")) return "rejected";
    return "canceled";
  }
  if (statement.record?.status === "approved") return "approved";
  if (statement.inProgress) return "open";
  if (statement.carriedOver) return "carried_over";
  if (statement.open.every((row) => row.status === "approved")) return "approved";
  return "pending";
}

const STATUS_ORDER = { pending: 0, approved: 1, open: 2, carried_over: 3, paid: 4, rejected: 5, canceled: 6 };

/**
 * Why a row cannot be approved or paid now, checked in the order the approval
 * route checks: the programme's gate, a Cash App tag, the tag's claim, then
 * the review period. Null when it can.
 */
function rowProblem(row, { affiliate, eligible, hold }) {
  if (!eligible.get(`${row.user_id}:${row.product_slug}`)) return shareProgram(row.product_slug)?.gateError || "referrer_not_eligible";
  const handle = normalizeCashAppTag(row.cashapp_handle) || affiliate?.cashAppTag || null;
  if (!handle) return "cash_app_tag_required";
  if (!affiliate?.claims?.has(cashAppTagKey(handle))) return "cash_app_tag_not_owned_by_reward_user";
  if (!hold.payout_hold_complete) return "payout_hold_not_complete";
  return null;
}

function rowView(row, statementMonth, context) {
  const meta = metadataOf(row);
  const hold = context.holdInfo(row);
  const open = !SETTLED_ROW_STATUSES.has(row.status);
  const program = shareProgram(row.product_slug);
  return {
    id: row.id,
    programSlug: row.product_slug,
    programLabel: program?.label || row.product_slug,
    status: row.status,
    amountCents: Number(row.reward_amount_cents || 0),
    rateBps: rowRateBps(row),
    netPaidCents: Number(meta.net_paid_cents || 0),
    subscriberUserId: meta.subscriber_user_id || null,
    subscriberEmail: meta.subscriber_email || null,
    invoiceRef: meta.invoice_ref || null,
    invoicePaidAt: row.invoicePaidAt,
    invoiceMonth: row.invoiceMonth,
    carried: row.invoiceMonth !== statementMonth,
    ready: open ? Boolean(hold.payout_hold_complete) : null,
    readyAt: open ? hold.payout_ready_at : null,
    problem: open ? rowProblem(row, { ...context, hold }) : null,
    payoutReference: row.payout_reference || null,
    paidAt: isoOrNull(row.paid_at),
    adminNote: row.admin_note || null,
  };
}

function statementView(statement, context) {
  const affiliate = context.affiliates.get(statement.userId) || null;
  const status = statementStatus(statement);
  const counted = [...statement.open, ...statement.settled.filter((row) => row.status !== "canceled")];
  const rowContext = { ...context, affiliate };
  const openViews = statement.open.map((row) => rowView(row, statement.month, rowContext));
  const settledViews = statement.settled.map((row) => rowView(row, statement.month, rowContext));
  // Under the minimum, nothing on it is paid now: a finished month carries
  // over, and the running month waits to reach it. An approved statement was
  // the owner's call, so the minimum no longer applies to it.
  const belowMinimum =
    (status === "open" || status === "carried_over") &&
    statement.record?.status !== "approved" &&
    sumCents(statement.open) < context.minimumPayoutCents;
  const payable = belowMinimum ? [] : openViews.filter((row) => !row.problem);
  const notReady = openViews.filter((row) => row.ready === false);
  const problemCounts = {};
  for (const row of openViews) if (row.problem) problemCounts[row.problem] = (problemCounts[row.problem] || 0) + 1;
  const byProgram = SUBSCRIPTION_SHARE_PROGRAMS.map((program) => {
    const rows = counted.filter((row) => row.product_slug === program.slug);
    return { slug: program.slug, label: program.label, invoiceCount: rows.length, totalCents: sumCents(rows) };
  }).filter((entry) => entry.invoiceCount);
  const record = statement.record;
  const sum = (views) => views.reduce((total, row) => total + row.amountCents, 0);
  return {
    key: `${statement.month}:${statement.userId}`,
    month: statement.month,
    userId: statement.userId,
    email: affiliate?.email || null,
    cashAppTag: affiliate?.cashAppTag || null,
    cashAppTagClaimed: Boolean(affiliate?.cashAppTagClaimed),
    referralCode: affiliate?.referralCode || null,
    status,
    subscriberCount: new Set(counted.map((row) => metadataOf(row).subscriber_user_id || row.id)).size,
    invoiceCount: counted.length,
    totalCents: sumCents(counted),
    owedCents: sumCents(statement.open),
    belowMinimum,
    payableCents: sum(payable),
    paidCents: sumCents(statement.settled.filter((row) => row.status === "paid")),
    rejectedCents: sumCents(statement.settled.filter((row) => row.status === "rejected")),
    notReadyCount: notReady.length,
    notReadyCents: sum(notReady),
    nextReadyAt: notReady.map((row) => row.readyAt).filter(Boolean).sort()[0] || null,
    problemCounts,
    carriedInCount: statement.carriedIn.length,
    carriedInCents: sumCents(statement.carriedIn),
    carriedOutCount: statement.carriedOut.length,
    carriedOutCents: sumCents(statement.carriedOut),
    carriedToMonth: status === "carried_over" || statement.carriedOut.length ? nextMonth(statement.month) : null,
    byProgram,
    record: record
      ? {
          id: record.id,
          status: record.status,
          totalCents: Number(record.total_cents || 0),
          payoutReference: record.payout_reference || null,
          note: record.note || null,
          approvedAt: isoOrNull(record.approved_at),
          paidAt: isoOrNull(record.paid_at),
          rejectedAt: isoOrNull(record.rejected_at),
        }
      : null,
    rows: [...openViews, ...settledViews].sort(
      (a, b) =>
        String(a.invoicePaidAt).localeCompare(String(b.invoicePaidAt)) ||
        String(a.invoiceRef || "").localeCompare(String(b.invoiceRef || "")) ||
        String(a.id).localeCompare(String(b.id))
    ),
  };
}

/**
 * Every statement, or one affiliate's, computed now. `holdInfoWith(programs)`
 * returns the review-period check the approval route uses, so "ready" here
 * means exactly what the route will accept.
 */
async function computeStatements(trx, { userId = null, now = new Date(), holdInfoWith }) {
  if (typeof holdInfoWith !== "function") throw new Error("holdInfoWith is required");
  const settings = await loadShareSettings(trx, now);
  const currentMonth = monthOf(now);
  const rows = await loadShareRows(trx, { userId, now });
  const records = await loadStatementRecords(trx, { userId });
  const programs = await trx("referral_programs");
  const holdInfo = holdInfoWith(programs);

  const rowsByUser = new Map();
  for (const row of rows) {
    if (!rowsByUser.has(row.user_id)) rowsByUser.set(row.user_id, []);
    rowsByUser.get(row.user_id).push(row);
  }
  const recordsByUser = new Map();
  for (const record of records) {
    if (!recordsByUser.has(record.user_id)) recordsByUser.set(record.user_id, []);
    recordsByUser.get(record.user_id).push(record);
  }
  const userIds = [...new Set([...rowsByUser.keys(), ...recordsByUser.keys()])];
  const affiliates = await affiliateInfo(trx, userIds);
  const eligible = await eligibilityFor(
    trx,
    [...new Set(rows.map((row) => `${row.user_id}|${row.product_slug}`))].map((pair) => pair.split("|"))
  );

  const raw = [];
  for (const id of userIds) {
    raw.push(
      ...buildAffiliateStatements({
        userId: id,
        rows: rowsByUser.get(id) || [],
        records: recordsByUser.get(id) || [],
        minimumPayoutCents: settings.payout.minimumPayoutCents,
        currentMonth,
      })
    );
  }
  const context = { affiliates, eligible, holdInfo, minimumPayoutCents: settings.payout.minimumPayoutCents };
  return { settings, currentMonth, raw, views: raw.map((statement) => statementView(statement, context)) };
}

export async function listStatements({ month = null, status = null, userId = null, now = new Date(), holdInfoWith } = {}, trx = db) {
  if (month && !MONTH_PATTERN.test(month)) throw recurringPayoutError(400, "invalid_month");
  if (status && !STATEMENT_STATUSES.includes(status)) throw recurringPayoutError(400, "invalid_status");
  const { settings, currentMonth, views } = await computeStatements(trx, { userId, now, holdInfoWith });
  const counts = Object.fromEntries(STATEMENT_STATUSES.map((key) => [key, views.filter((view) => view.status === key).length]));
  const months = [...new Set(views.map((view) => view.month))].sort().reverse();
  const statements = views
    .filter((view) => (!month || view.month === month) && (!status || view.status === status))
    .sort(
      (a, b) =>
        b.month.localeCompare(a.month) ||
        (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
        String(a.email || "").localeCompare(String(b.email || ""))
    );
  // Owed and payable count each invoice once: a carried-over statement's
  // invoices are also on the statement they moved to.
  const live = statements.filter((view) => ["open", "pending", "approved"].includes(view.status));
  return {
    currentMonth,
    months,
    counts,
    payout: settings.payout,
    programs: settings.programs,
    statements,
    totals: {
      owedCents: live.reduce((total, view) => total + view.owedCents, 0),
      payableCents: live.reduce((total, view) => total + view.payableCents, 0),
      paidCents: statements.reduce((total, view) => total + view.paidCents, 0),
    },
  };
}

// ---------------------------------------------------- statement actions

/**
 * The statement an action is for, with the affiliate's account row locked so
 * two actions on their statements run one after the other.
 */
async function lockStatement(ctx, { month, userId }) {
  if (!MONTH_PATTERN.test(String(month || ""))) throw recurringPayoutError(400, "invalid_month");
  await requireRecurringTables(ctx.trx);
  const user = await ctx.trx("users").where({ id: userId }).forUpdate().first();
  if (!user) throw recurringPayoutError(404, "user_not_found");
  const { settings, raw, views } = await computeStatements(ctx.trx, { userId, now: ctx.now, holdInfoWith: ctx.holdInfoWith });
  const index = views.findIndex((view) => view.month === month);
  if (index < 0) throw recurringPayoutError(404, "statement_not_found");
  const view = views[index];
  if (["paid", "rejected", "canceled"].includes(view.status)) {
    throw recurringPayoutError(409, "statement_closed", { status: view.status });
  }
  return { user, settings, statement: raw[index], view };
}

function refuseUnderMinimum({ statement, view, settings }) {
  if (statement.record?.status === "approved") return;
  if (view.owedCents < settings.payout.minimumPayoutCents) {
    throw recurringPayoutError(409, "below_minimum_payout", {
      owedCents: view.owedCents,
      minimumPayoutCents: settings.payout.minimumPayoutCents,
      carriedToMonth: nextMonth(view.month),
    });
  }
}

async function tagWithStatement(trx, rowId, recordId, month) {
  await trx("reward_queue")
    .where({ id: rowId })
    .update({
      metadata: trx.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [
        JSON.stringify({ statement_id: recordId, statement_month: month }),
      ]),
    });
}

/**
 * Applies one reward status change through the approval route's own rules,
 * as a savepoint inside the statement's transaction: a row that is refused
 * rolls back alone and is reported, and the rest go ahead.
 */
async function applyToRows(ctx, rows, data, { recordId, month }) {
  const changed = [];
  const refused = [];
  for (const row of rows) {
    try {
      const payload = typeof data === "function" ? data(row) : data;
      await ctx.applyRewardStatusChange(ctx.req, row.id, payload, ctx.trx);
      await tagWithStatement(ctx.trx, row.id, recordId, month);
      changed.push(row);
    } catch (err) {
      const known = ctx.rewardStatusErrorPayload(err);
      if (!known) throw err;
      refused.push({
        id: row.id,
        amountCents: Number(row.reward_amount_cents || 0),
        error: known.body?.error || "refused",
        payoutReadyAt: known.body?.payoutReadyAt || null,
        detail: known.body || null,
      });
    }
  }
  return { changed, refused };
}

async function saveRecord(trx, statement, recordId, values) {
  if (statement.record) {
    const [row] = await trx(STATEMENTS_TABLE)
      .where({ id: statement.record.id })
      .update({ ...values, updated_at: trx.fn.now() })
      .returning("*");
    return row;
  }
  const [row] = await trx(STATEMENTS_TABLE)
    .insert({ id: recordId, user_id: statement.userId, month: statement.month, ...values })
    .returning("*");
  return row;
}

/**
 * Approves every invoice on a statement that can be approved now. Invoices
 * still inside their review period stay pending and are reported as not
 * ready; the statement is approved as long as one invoice was.
 */
export async function approveStatement(ctx, { month, userId }) {
  const locked = await lockStatement(ctx, { month, userId });
  refuseUnderMinimum(locked);
  const { statement, view } = locked;
  const recordId = statement.record?.id || crypto.randomUUID();
  const already = statement.open.filter((row) => row.status === "approved");
  const { changed, refused } = await applyToRows(
    ctx,
    statement.open.filter((row) => row.status !== "approved"),
    { status: "approved" },
    { recordId, month }
  );
  for (const row of already) await tagWithStatement(ctx.trx, row.id, recordId, month);
  const approved = [...already, ...changed];
  const notReady = refused.filter((row) => row.error === "payout_hold_not_complete");
  const failed = refused.filter((row) => row.error !== "payout_hold_not_complete");
  if (!approved.length) throw recurringPayoutError(409, "nothing_to_approve", { notReady, failed });

  const record = await saveRecord(ctx.trx, statement, recordId, {
    status: "approved",
    total_cents: sumCents(approved),
    reward_ids: JSON.stringify(approved.map((row) => row.id)),
    approved_by: ctx.req.admin?.sub || null,
    approved_at: statement.record?.approved_at || ctx.trx.fn.now(),
    metadata: JSON.stringify({ not_ready: notReady, refused: failed }),
  });
  return { before: view, record, approved: approved.map((row) => row.id), notReady, failed };
}

/**
 * Marks a statement paid under ONE payout reference: every invoice on it is
 * paid in this one transaction, each through the approval route's rules
 * (review period over, the programme's gate, the claimed Cash App tag), and
 * each row's reference is the statement's plus the row id, since references
 * are unique per row. Invoices that cannot be paid are reported and move to
 * the next month's statement; nothing is written unless one invoice is paid.
 */
export async function payStatement(ctx, { month, userId, payoutReference }) {
  const reference = String(payoutReference || "").trim().replace(/\s+/g, " ");
  if (!reference) throw recurringPayoutError(400, "payout_reference_required");
  const locked = await lockStatement(ctx, { month, userId });
  refuseUnderMinimum(locked);
  const { statement, view } = locked;
  const recordId = statement.record?.id || crypto.randomUUID();
  const { changed, refused } = await applyToRows(
    ctx,
    statement.open,
    (row) => ({ status: "paid", payoutReference: batchPayoutReference(reference, row.id) }),
    { recordId, month }
  );
  if (!changed.length) throw recurringPayoutError(409, "nothing_paid", { failed: refused });

  const record = await saveRecord(ctx.trx, statement, recordId, {
    status: "paid",
    total_cents: sumCents(changed),
    reward_ids: JSON.stringify(changed.map((row) => row.id)),
    payout_reference: reference,
    approved_by: statement.record?.approved_by || ctx.req.admin?.sub || null,
    approved_at: statement.record?.approved_at || ctx.trx.fn.now(),
    paid_by: ctx.req.admin?.sub || null,
    paid_at: ctx.trx.fn.now(),
    metadata: JSON.stringify({ unpaid: refused, unpaid_moved_to: refused.length ? nextMonth(month) : null }),
  });
  return {
    before: view,
    record,
    paid: changed.map((row) => row.id),
    paidCents: sumCents(changed),
    failed: refused,
    carriedToMonth: refused.length ? nextMonth(month) : null,
  };
}

/** Rejects every unpaid invoice on a statement, with the owner's note on each. */
export async function rejectStatement(ctx, { month, userId, note }) {
  const text = String(note || "").trim();
  if (!text) throw recurringPayoutError(400, "rejection_note_required");
  const locked = await lockStatement(ctx, { month, userId });
  const { statement, view } = locked;
  const recordId = statement.record?.id || crypto.randomUUID();
  const { changed, refused } = await applyToRows(ctx, statement.open, { status: "rejected", adminNote: text }, { recordId, month });
  if (!changed.length) throw recurringPayoutError(409, "nothing_to_reject", { failed: refused });

  const record = await saveRecord(ctx.trx, statement, recordId, {
    status: "rejected",
    total_cents: sumCents(changed),
    reward_ids: JSON.stringify(changed.map((row) => row.id)),
    note: text,
    rejected_by: ctx.req.admin?.sub || null,
    rejected_at: ctx.trx.fn.now(),
    metadata: JSON.stringify({ refused }),
  });
  return { before: view, record, rejected: changed.map((row) => row.id), failed: refused };
}

// ---------------------------------------------------------------- overview

const PAYING_STATUSES = new Set(["active", "past_due"]);
const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"];
const CLOUD_PICKUP_PLAN = "forgedrop_cloud_pickup";

const norm = (value) => String(value || "").trim().toLowerCase();

/** Which share programme a subscriptions row pays into, or null. */
export function subscriptionShareProgram(subscription) {
  const raw = subscription?.raw && typeof subscription.raw === "object" ? subscription.raw : {};
  const meta = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {};
  const names = [subscription?.plan, meta.plan, meta.product_slug, meta.entitlement_slug].map(norm).filter(Boolean);
  if (names.some((name) => name === CLOUD_PICKUP_PLAN || name === CLOUD_PICKUP_SHARE_PRODUCT_SLUG || name.startsWith(`${CLOUD_PICKUP_SHARE_PRODUCT_SLUG}-`))) {
    return CLOUD_PICKUP_SHARE_PRODUCT_SLUG;
  }
  if (names.some((name) => TABFORGE_SYNC_PLAN_ALIASES.includes(name) || isTabForgeSyncEntitlement(name) || name === TABFORGE_SYNC_PRODUCT_SLUG)) {
    return SYNC_SHARE_PRODUCT_SLUG;
  }
  return null;
}

function pickupTier(raw) {
  const meta = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {};
  const byKey = typeof pickupPlans.cloudPickupTierByKey === "function" ? pickupPlans.cloudPickupTierByKey(meta.tier) : null;
  const bySlug = typeof pickupPlans.cloudPickupTier === "function"
    ? pickupPlans.cloudPickupTier(meta.entitlement_slug) || pickupPlans.cloudPickupTier(meta.product_slug)
    : null;
  return byKey || bySlug || null;
}

const PER_MONTH = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 };

/**
 * What a subscription bills a month: its Stripe items' prices when the row
 * has them, else the plan's list price ($5 for Private Sync, the tier's price
 * for Cloud pickup). Coupons are not taken off: an estimate at list price.
 */
export function subscriptionMonthlyCents(subscription, programSlug = subscriptionShareProgram(subscription)) {
  const raw = subscription?.raw && typeof subscription.raw === "object" ? subscription.raw : {};
  let total = 0;
  let priced = false;
  for (const item of raw.items?.data || []) {
    const price = item?.price || item?.plan || null;
    const unit = Number(price?.unit_amount ?? price?.amount);
    if (!price || !Number.isFinite(unit) || unit < 0) continue;
    const quantity = Number(item.quantity ?? 1);
    const interval = String(price.recurring?.interval || price.interval || "month");
    const every = Math.max(1, Number(price.recurring?.interval_count || price.interval_count || 1) || 1);
    total += (unit * (Number.isFinite(quantity) && quantity > 0 ? quantity : 1) * (PER_MONTH[interval] ?? 1)) / every;
    priced = true;
  }
  if (priced) return Math.round(total);
  if (programSlug === SYNC_SHARE_PRODUCT_SLUG) return TABFORGE_SYNC_PRICE_CENTS;
  if (programSlug === CLOUD_PICKUP_SHARE_PRODUCT_SLUG) return Number(pickupTier(raw)?.monthlyCents || 0);
  return 0;
}

/**
 * For each affiliate, the live subscriptions of the customers they referred
 * (the account directly above the subscriber, as the share recorders read
 * it), per programme, and the share those will pay each month at the rate
 * the affiliate is on now. Trials pay nothing until they end; a subscription
 * set to cancel at the end of its period will not bill again.
 */
export async function recurringOverview({ now = new Date() } = {}, trx = db) {
  const settings = await loadShareSettings(trx, now);
  const empty = { generatedAt: new Date(now).toISOString(), programs: settings.programs, affiliates: [], totals: { affiliates: 0, payingSubscriptions: 0, trialSubscriptions: 0, expectedMonthlyShareCents: 0, byProgram: [] } };
  if (!(await shareTableReady(trx, "subscriptions"))) return empty;

  const subscriptions = await trx("subscriptions as s")
    .join("users as u", "s.user_id", "u.id")
    .select(
      "s.id",
      "s.user_id",
      "s.plan",
      "s.status",
      "s.current_period_end",
      "s.raw",
      "u.email as subscriber_email",
      "u.referred_by_user_id as affiliate_user_id"
    )
    .whereNotNull("u.referred_by_user_id")
    .whereRaw("u.referred_by_user_id <> u.id")
    .whereIn("s.status", LIVE_SUBSCRIPTION_STATUSES);
  const live = subscriptions
    .map((subscription) => ({ ...subscription, programSlug: subscriptionShareProgram(subscription) }))
    .filter((subscription) => subscription.programSlug);
  if (!live.length) return empty;

  const affiliateIds = [...new Set(live.map((subscription) => subscription.affiliate_user_id))];
  const affiliates = await affiliateInfo(trx, affiliateIds);
  const ready = await recurringTablesReady(trx);
  const programRows = ready ? await trx(SHARE_PROGRAMS_TABLE) : [];
  const overrideRows = ready ? await trx(SHARE_OVERRIDES_TABLE).whereIn("user_id", affiliateIds) : [];
  const eligible = await eligibilityFor(
    trx,
    [...new Set(live.map((subscription) => `${subscription.affiliate_user_id}|${subscription.programSlug}`))].map((pair) => pair.split("|"))
  );

  const result = [];
  for (const affiliateId of affiliateIds) {
    const info = affiliates.get(affiliateId);
    const mine = live.filter((subscription) => subscription.affiliate_user_id === affiliateId);
    const programs = SUBSCRIPTION_SHARE_PROGRAMS.map((program) => {
      const subs = mine.filter((subscription) => subscription.programSlug === program.slug);
      if (!subs.length) return null;
      const rate = effectiveShareRate({
        programRow: programRows.find((row) => row.program_slug === program.slug) || null,
        overrideRow: overrideRows.find((row) => row.user_id === affiliateId && row.program_slug === program.slug) || null,
      });
      const isEligible = Boolean(eligible.get(`${affiliateId}:${program.slug}`));
      const payRate = isEligible ? rate.rateBps : 0;
      const subscribers = subs.map((subscription) => {
        const monthlyCents = subscriptionMonthlyCents(subscription, program.slug);
        const ending = subscription.raw?.cancel_at_period_end === true;
        const trial = subscription.status === "trialing";
        return {
          subscriberEmail: subscription.subscriber_email || null,
          status: subscription.status,
          trial,
          ending,
          tier: program.slug === CLOUD_PICKUP_SHARE_PRODUCT_SLUG ? pickupTier(subscription.raw || {})?.label || null : null,
          monthlyCents,
          shareCents: ending ? 0 : shareCentsAt(monthlyCents, payRate),
          currentPeriodEnd: isoOrNull(subscription.current_period_end),
        };
      });
      const paying = subscribers.filter((row) => PAYING_STATUSES.has(row.status) && !row.ending);
      const trials = subscribers.filter((row) => row.trial && !row.ending);
      return {
        slug: program.slug,
        label: program.label,
        eligible: isEligible,
        enabled: rate.enabled,
        rateBps: rate.rateBps,
        rateSource: rate.source,
        payingSubscriptions: paying.length,
        trialSubscriptions: trials.length,
        endingSubscriptions: subscribers.filter((row) => row.ending).length,
        monthlyRevenueCents: paying.reduce((total, row) => total + row.monthlyCents, 0),
        expectedMonthlyShareCents: paying.reduce((total, row) => total + row.shareCents, 0),
        afterTrialsShareCents: trials.reduce((total, row) => total + row.shareCents, 0),
        subscribers,
      };
    }).filter(Boolean);
    result.push({
      userId: affiliateId,
      email: info?.email || null,
      cashAppTag: info?.cashAppTag || null,
      cashAppTagClaimed: Boolean(info?.cashAppTagClaimed),
      referralCode: info?.referralCode || null,
      programs,
      expectedMonthlyShareCents: programs.reduce((total, program) => total + program.expectedMonthlyShareCents, 0),
      afterTrialsShareCents: programs.reduce((total, program) => total + program.afterTrialsShareCents, 0),
    });
  }
  result.sort((a, b) => b.expectedMonthlyShareCents - a.expectedMonthlyShareCents || String(a.email || "").localeCompare(String(b.email || "")));

  const byProgram = SUBSCRIPTION_SHARE_PROGRAMS.map((program) => {
    const entries = result.flatMap((affiliate) => affiliate.programs.filter((entry) => entry.slug === program.slug));
    return {
      slug: program.slug,
      label: program.label,
      payingSubscriptions: entries.reduce((total, entry) => total + entry.payingSubscriptions, 0),
      trialSubscriptions: entries.reduce((total, entry) => total + entry.trialSubscriptions, 0),
      expectedMonthlyShareCents: entries.reduce((total, entry) => total + entry.expectedMonthlyShareCents, 0),
    };
  });
  return {
    generatedAt: new Date(now).toISOString(),
    programs: settings.programs,
    affiliates: result,
    totals: {
      affiliates: result.length,
      payingSubscriptions: byProgram.reduce((total, entry) => total + entry.payingSubscriptions, 0),
      trialSubscriptions: byProgram.reduce((total, entry) => total + entry.trialSubscriptions, 0),
      expectedMonthlyShareCents: result.reduce((total, affiliate) => total + affiliate.expectedMonthlyShareCents, 0),
      byProgram,
    },
  };
}

export { MAX_SHARE_RATE_BPS };
