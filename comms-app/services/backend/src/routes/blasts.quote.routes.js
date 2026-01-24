import { Router } from "express";
import { db } from "../config/db.js";
import { PLAN, INTL_CAPS_CENTS, isDomesticUSCA } from "../config/pricingPolicy.js";
import { getTwilioSmsUnitPriceUSD } from "../services/twilioPricing.service.js";
import { getIntlTier, isTierBlocked, getMultiplierForTier } from "../services/intlTier.service.js";
import { parseE164CountryCode } from "../services/phoneCountry.service.js"; // create next file

export const blastsQuoteRouter = Router();

/**
 * POST /v1/blasts/quote
 * Body: { userId, recipients: [ "+1555...", ... ], body: "..." }
 * (You can swap userId for auth user in your middleware later.)
 */
blastsQuoteRouter.post("/", async (req, res) => {
  const { userId, recipients } = req.body || {};
  if (!userId || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: "userId and recipients[] required" });
  }

  const user = await db("users").where({ id: userId }).first();
  if (!user) return res.status(404).json({ error: "user not found" });

  const plan = user.plan_tier;
  if (plan === PLAN.FREE) {
    // Free tier: intl blocked, you can still compute domestic-only sends elsewhere
    return res.json({
      intlCount: 0,
      domesticCount: recipients.length,
      blocked: true,
      blockedReason: "free_plan_intl_blocked",
    });
  }

  if (user.intl_blocked_reason) {
    return res.json({ blocked: true, blockedReason: user.intl_blocked_reason });
  }

  if (!user.stripe_payment_method_attached) {
    return res.json({ blocked: true, blockedReason: "no_payment_method_for_intl" });
  }

  let intlCount = 0;
  let domesticCount = 0;

  // estimate cents for THIS blast
  let estimatedIntlCents = 0;

  // Country bucketing reduces pricing calls
  const countryCounts = new Map();

  for (const e164 of recipients) {
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

  // price each destination country using Twilio live pricing
  for (const [cc, count] of countryCounts.entries()) {
    const tier = getIntlTier(cc);
    const mult = getMultiplierForTier(tier);
    if (!mult) return res.json({ blocked: true, blockedReason: `intl_missing_multiplier_${cc}` });

    const unitUsd = await getTwilioSmsUnitPriceUSD(cc);
    const unitCents = Math.round(unitUsd * 100);
    const billedUnitCents = Math.ceil(unitCents * mult);

    estimatedIntlCents += billedUnitCents * count;
  }

  const caps = plan === PLAN.PRO ? INTL_CAPS_CENTS.pro : INTL_CAPS_CENTS.business;
  const since = user.intl_spend_since_charge_cents || 0;

  const breachesSoftPerBlast = estimatedIntlCents > caps.soft_per_blast;
  const breachesHardAccum = since + estimatedIntlCents > caps.hard_accum;

  // You asked: immediate invoice+charge anytime softcap breached (per blast)
  // Also: if accumulated passes hardcap -> immediate invoice+charge
  const requiresImmediateCharge = intlCount > 0 && (breachesSoftPerBlast || breachesHardAccum);

  return res.json({
    domesticCount,
    intlCount,
    estimatedIntlCents,
    estimatedIntlUsd: (estimatedIntlCents / 100).toFixed(2),
    requiresConfirm: intlCount > 0,
    requiresImmediateCharge,
    reason: breachesSoftPerBlast ? "softcap_per_blast" : breachesHardAccum ? "hardcap_accum" : null,
    caps,
    intlSpendSinceChargeCents: since,
  });
});
