// The share an affiliate earns on every paid invoice of a subscription they
// referred (TabForge Private Sync, ForgeDrop Cloud pickup), as the owner sets
// it from the admin dashboard.
//
// Rates are basis points: 500 is 5%. Each programme has a rate and an on/off
// switch (subscription_share_programs), and one affiliate can have a rate of
// their own on a programme (subscription_share_overrides), where 0 means they
// earn nothing on it. The switch is for everyone: a programme that is off
// pays no one, overrides included.
//
// This module reads only those two tables, so referral.service.js can use it
// without an import cycle. Until the migration has run, or where the tables
// do not exist (the other test files' databases), every programme is on at
// 5%, which is exactly what the share recorders paid before the rate could be
// set.

import { db } from "../../config/db.js";

export const DEFAULT_SHARE_RATE_BPS = 500;
export const MAX_SHARE_RATE_BPS = 10000;
export const SHARE_PROGRAMS_TABLE = "subscription_share_programs";
export const SHARE_OVERRIDES_TABLE = "subscription_share_overrides";

// A table, once seen, is not going to disappear, so it is asked about once.
const seenTables = new Set();

export async function shareTableReady(trx, table) {
  if (seenTables.has(table)) return true;
  try {
    if (await trx.schema.hasTable(table)) {
      seenTables.add(table);
      return true;
    }
  } catch {
    // Unknown is treated as absent, which falls back to the defaults.
  }
  return false;
}

/** A rate in basis points, or null when it is not one. */
export function validShareRateBps(value) {
  if (value === null || value === undefined || value === "") return null;
  const bps = Number(value);
  return Number.isInteger(bps) && bps >= 0 && bps <= MAX_SHARE_RATE_BPS ? bps : null;
}

/**
 * One invoice's share: rounded to the nearest cent, and never nothing for a
 * paid invoice while the rate is above zero. Integer arithmetic, so 500 bps
 * gives exactly what the old `Math.round(paid * 0.05)` gave.
 */
export function shareCentsAt(netPaidCents, rateBps = DEFAULT_SHARE_RATE_BPS) {
  const paid = Number(netPaidCents);
  const bps = validShareRateBps(rateBps);
  if (!Number.isFinite(paid) || paid <= 0 || !bps) return 0;
  return Math.max(1, Math.round((paid * bps) / 10000));
}

/**
 * The rate a programme row and an override row add up to. `source` says where
 * it came from: "override", "program", "default" (no row yet), or
 * "program_off" when the programme is switched off.
 */
export function effectiveShareRate({ programRow = null, overrideRow = null } = {}) {
  const programRateBps = validShareRateBps(programRow?.rate_bps) ?? DEFAULT_SHARE_RATE_BPS;
  const enabled = programRow ? programRow.enabled !== false : true;
  const overrideBps = validShareRateBps(overrideRow?.rate_bps);
  if (!enabled) {
    return { rateBps: 0, programRateBps, enabled: false, overrideBps, source: "program_off" };
  }
  if (overrideBps !== null) {
    return { rateBps: overrideBps, programRateBps, enabled: true, overrideBps, source: "override" };
  }
  return { rateBps: programRateBps, programRateBps, enabled: true, overrideBps: null, source: programRow ? "program" : "default" };
}

/** The rate one affiliate earns on one programme now. */
export async function resolveShareRate(programSlug, affiliateUserId, trx = db) {
  const slug = String(programSlug || "").trim().toLowerCase();
  const programRow = (await shareTableReady(trx, SHARE_PROGRAMS_TABLE))
    ? await trx(SHARE_PROGRAMS_TABLE).where({ program_slug: slug }).first()
    : null;
  const overrideRow = affiliateUserId && (await shareTableReady(trx, SHARE_OVERRIDES_TABLE))
    ? await trx(SHARE_OVERRIDES_TABLE).where({ user_id: affiliateUserId, program_slug: slug }).first()
    : null;
  return effectiveShareRate({ programRow: programRow || null, overrideRow: overrideRow || null });
}

/**
 * When the invoice was paid, as an ISO string: the caller's value when it
 * gives one (a Date, an ISO string, or Stripe's Unix seconds), else now, which
 * is when Stripe's invoice.paid event is being handled.
 */
export function invoicePaidAtIso(value, now = new Date()) {
  let ms = null;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value ?? ""))) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) ms = numeric < 1e12 ? numeric * 1000 : numeric;
  } else if (value) {
    ms = Date.parse(String(value));
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(now).toISOString();
}
