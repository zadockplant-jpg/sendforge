/**
 * Who holds a Romancing the Stone licence, and which devices it covers.
 *
 * A licence belongs to one SendForge account (the sponsor). It powers every
 * circle that account sponsors: partners, kids and teammates join for free,
 * and every device that opens those circles counts toward the sponsor's ten.
 */

import { randomUUID } from "node:crypto";
import {
  isActiveTabForgeSubscriptionStatus,
  tabForgePastDueSince,
} from "../../services/tabforgeBilling.service.js";
import {
  RTS_DEVICE_LIMIT,
  RTS_PERMANENT_ENTITLEMENT,
  RTS_SUBSCRIPTION_ENTITLEMENT,
  RTS_SUBSCRIPTION_PLAN,
  RTS_INCLUDED_MONTHS,
  RTS_START_PRICE_CENTS,
  RTS_RENEWAL_PRICE_CENTS,
  RTS_PERMANENT_PRICE_CENTS,
} from "./config.js";

export class DeviceLimitReached extends Error {
  constructor(limit, used) {
    super("device_limit_reached");
    this.code = "device_limit_reached";
    this.limit = limit;
    this.used = used;
  }
}

const iso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export const PRICING = Object.freeze({
  subscription: {
    startCents: RTS_START_PRICE_CENTS,
    includedMonths: RTS_INCLUDED_MONTHS,
    renewalCents: RTS_RENEWAL_PRICE_CENTS,
    renewalInterval: "month",
  },
  permanent: { priceCents: RTS_PERMANENT_PRICE_CENTS },
  deviceLimit: RTS_DEVICE_LIMIT,
});

/**
 * The licence state of one account. Subscription access is re-checked
 * against the subscription row, so a past-due grace window that ends without
 * a Stripe event still ends access.
 */
export async function resolveLicense(database, { userId, email }, config) {
  const empty = {
    active: false,
    plan: null,
    subscription: null,
    deviceLimit: RTS_DEVICE_LIMIT,
  };
  if (!userId) return empty;

  const rows = await database("product_entitlements")
    .where({ user_id: userId, status: "active" })
    .whereIn("product_slug", [RTS_PERMANENT_ENTITLEMENT, RTS_SUBSCRIPTION_ENTITLEMENT])
    .andWhere((query) => query.whereNull("expires_at").orWhere("expires_at", ">", database.fn.now()));
  const permanent = rows.find((row) => row.product_slug === RTS_PERMANENT_ENTITLEMENT);
  const subscriptionEntitlement = rows.find((row) => row.product_slug === RTS_SUBSCRIPTION_ENTITLEMENT);

  const subscriptionRow = await database("subscriptions")
    .where({ user_id: userId, provider: "stripe", plan: RTS_SUBSCRIPTION_PLAN })
    .orderByRaw("case when status in ('active','trialing','past_due') then 0 else 1 end")
    .orderBy("updated_at", "desc")
    .first();

  let subscriptionActive = false;
  if (subscriptionEntitlement) {
    const stripeBacked =
      subscriptionEntitlement.source === "stripe_subscription" ||
      String(subscriptionEntitlement.source_ref || "").startsWith("subscription:");
    subscriptionActive = stripeBacked
      ? Boolean(
          subscriptionRow &&
            isActiveTabForgeSubscriptionStatus(subscriptionRow.status, {
              pastDueSince: tabForgePastDueSince(subscriptionRow),
            })
        )
      : true;
  }

  const raw = subscriptionRow?.raw && typeof subscriptionRow.raw === "object" ? subscriptionRow.raw : {};
  const subscription = subscriptionRow
    ? {
        status: subscriptionRow.status,
        includedUntil: iso(raw.trial_end),
        renewsAt: iso(subscriptionRow.current_period_end),
        cancelAtPeriodEnd: Boolean(raw.cancel_at_period_end),
        active: subscriptionActive,
      }
    : null;

  const comp = Boolean(email && config?.compEmails?.includes(String(email).trim().toLowerCase()));
  const plan = permanent ? "permanent" : subscriptionActive ? "subscription" : comp ? "comp" : null;
  return {
    active: Boolean(plan),
    plan,
    subscription,
    deviceLimit: RTS_DEVICE_LIMIT,
  };
}

/** A short cache so a burst of requests from one app does not re-query billing. */
export function createLicenseCache({ ttlMs = 30_000, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    async get(key, load) {
      const hit = entries.get(key);
      const time = now();
      if (hit && hit.expiresAt > time) return hit.value;
      const value = await load();
      if (entries.size > 5000) entries.clear();
      entries.set(key, { value, expiresAt: time + ttlMs });
      return value;
    },
    clear(key) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
  };
}

/** The process-wide cache the router reads and the billing hooks clear. */
export const sharedLicenseCache = createLicenseCache();

export const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;

export function cleanDeviceLabel(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Make sure `deviceId` holds one of the sponsor's device slots, taking a free
 * one if it has none. Serialised per sponsor so two new devices cannot both
 * take the last slot.
 */
export async function ensureDevice(database, { sponsorUserId, deviceId, userId, label, limit = RTS_DEVICE_LIMIT }) {
  return database.transaction(async (trx) => {
    await trx.raw("select pg_advisory_xact_lock(hashtext('rts-devices'), hashtext(?))", [String(sponsorUserId)]);
    const existing = await trx("rts_devices")
      .where({ sponsor_user_id: sponsorUserId, device_id: deviceId })
      .whereNull("revoked_at")
      .first();
    if (existing) {
      const stale = !existing.last_seen_at || Date.now() - new Date(existing.last_seen_at).getTime() > 60 * 60 * 1000;
      if (stale || (label && label !== existing.label)) {
        await trx("rts_devices")
          .where({ id: existing.id })
          .update({ last_seen_at: trx.fn.now(), last_user_id: userId, label: label || existing.label });
      }
      return { id: existing.id, created: false };
    }
    const [{ count }] = await trx("rts_devices")
      .where({ sponsor_user_id: sponsorUserId })
      .whereNull("revoked_at")
      .count({ count: "*" });
    const used = Number(count);
    if (used >= limit) throw new DeviceLimitReached(limit, used);
    const id = randomUUID();
    await trx("rts_devices").insert({
      id,
      sponsor_user_id: sponsorUserId,
      device_id: deviceId,
      label: label || "Device",
      last_user_id: userId,
      last_seen_at: trx.fn.now(),
    });
    return { id, created: true };
  });
}

export async function listDevices(database, sponsorUserId) {
  const rows = await database("rts_devices")
    .select("id", "device_id", "label", "created_at", "last_seen_at", "last_user_id")
    .where({ sponsor_user_id: sponsorUserId })
    .whereNull("revoked_at")
    .orderBy("last_seen_at", "desc");
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    addedAt: iso(row.created_at),
    lastSeenAt: iso(row.last_seen_at),
    // Only the tail of the device id leaves the server: enough for the app to
    // mark "this device", not enough to impersonate it.
    fingerprint: row.device_id.slice(-6),
  }));
}

export async function revokeDevice(database, { sponsorUserId, id }) {
  return database("rts_devices")
    .where({ sponsor_user_id: sponsorUserId, id })
    .whereNull("revoked_at")
    .update({ revoked_at: database.fn.now() });
}
