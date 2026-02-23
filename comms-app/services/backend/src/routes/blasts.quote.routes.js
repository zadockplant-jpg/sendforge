import { Router } from "express";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { PLAN, INTL_CAPS_CENTS, INTL_MULTIPLIERS, isDomesticUSCA } from "../config/pricingPolicy.js";
import { getTwilioSmsUnitPriceUSD } from "../services/twilioPricing.service.js";
import { getIntlTier, isTierBlocked, getMultiplierForTier } from "../services/intlTier.service.js";
import { parseE164CountryCode } from "../services/phoneCountry.service.js";
import { resolveRecipients } from "../services/recipientsResolve.service.js";

export const blastsQuoteRouter = Router();

/**
 * POST /v1/blasts/quote
 * Auth: Bearer JWT required
 *
 * Body supports:
 * - { groupIds: [], contactIds: [], channels: ["sms","email"], body: "..." }
 * OR (legacy)
 * - { recipients: ["+1...", "+44..."], body: "...", channels? }
 */
blastsQuoteRouter.post("/", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: "missing_token" });

  const { recipients, groupIds, contactIds, channels } = req.body || {};

  const ch = Array.isArray(channels) ? channels.map(String) : ["sms"];

  // If SMS isn't selected, intl SMS quote flow isn't needed.
  const wantsSms = ch.includes("sms");
  if (!wantsSms) {
    return res.json({
      blocked: false,
      domesticCount: 0,
      intlCount: 0,
      estimatedIntlCents: 0,
      requiresConfirm: false,
      requiresImmediateCharge: false,
      note: "sms_not_selected",
    });
  }

  let smsRecipients = [];

  if (Array.isArray(recipients) && recipients.length) {
    smsRecipients = recipients.map(String);
  } else {
    const resolved = await resolveRecipients({
      userId,
      groupIds,
      contactIds,
    });
    smsRecipients = resolved.sms;
  }

  if (!Array.isArray(smsRecipients) || smsRecipients.length === 0) {
    return res.status(400).json({ error: "No SMS recipients (missing phone_e164)" });
  }

  const user = await db("users").where({ id: userId }).first();
  if (!user) return res.status(404).json({ error: "user not found" });

  const plan = user.plan_tier || PLAN.FREE;

  // Hard blocks
  if (plan === PLAN.FREE) {
    return res.json({ blocked: true, blockedReason: "free_plan_intl_blocked" });
  }
  if (user.intl_blocked_reason) {
    return res.json({ blocked: true, blockedReason: user.intl_blocked_reason });
  }
  if (!user.stripe_payment_method_attached) {
    return res.json({ blocked: true, blockedReason: "no_payment_method_for_intl" });
  }

  let intlCount = 0;
  let domesticCount = 0;
  const countryCounts = new Map();

  for (const e164 of smsRecipients) {
    const cc = parseE164CountryCode(e164);
    if (!cc) return res.status(400).json({ error: `invalid phone: ${e164}` });

    if (isDomesticUSCA(cc)) {
      domesticCount++;
      continue;
    }

    const tier = getIntlTier(cc);
    if (isTierBlocked(tier)) {
      return res.json({ blocked: true, blockedReason: `intl_blocked_country_${cc}` });
    }

    intlCount++;
    countryCounts.set(cc, (countryCounts.get(cc) || 0) + 1);
  }

  if (intlCount === 0) {
    return res.json({
      blocked: false,
      domesticCount,
      intlCount: 0,
      estimatedIntlCents: 0,
      requiresConfirm: false,
      requiresImmediateCharge: false,
    });
  }

  let estimatedIntlCents = 0;

  for (const [cc, count] of countryCounts.entries()) {
    const tier = getIntlTier(cc);
    const mult = getMultiplierForTier(tier) ?? (tier === "tier1" ? INTL_MULTIPLIERS.tier1 : INTL_MULTIPLIERS.tier2);

    const unitUsd = await getTwilioSmsUnitPriceUSD(cc);
    const unitCents = Math.round(unitUsd * 100);
    const billedUnitCents = Math.ceil(unitCents * mult);

    estimatedIntlCents += billedUnitCents * count;
  }

  const caps = plan === PLAN.PRO ? INTL_CAPS_CENTS.pro : INTL_CAPS_CENTS.business;
  const since = user.intl_spend_since_charge_cents || 0;

  const breachesSoftPerBlast = estimatedIntlCents > caps.soft_per_blast;
  const breachesHardAccum = since + estimatedIntlCents > caps.hard_accum;

  const requiresImmediateCharge = breachesSoftPerBlast || breachesHardAccum;

  return res.json({
    blocked: false,
    domesticCount,
    intlCount,
    estimatedIntlCents,
    estimatedIntlUsd: (estimatedIntlCents / 100).toFixed(2),
    caps,
    intlSpendSinceChargeCents: since,
    requiresConfirm: true,
    requiresImmediateCharge,
    reason: breachesSoftPerBlast ? "softcap_per_blast" : breachesHardAccum ? "hardcap_accum" : null,
  });
});