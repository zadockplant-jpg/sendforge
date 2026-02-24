import { Router } from "express";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  PLAN,
  INTL_CAPS_CENTS,
  INTL_MULTIPLIER,
  isDomesticUSCA,
} from "..comms-app\services\backend\src\config\pricingpolicy.js";
import { parseE164CountryCode } from "../services/phone_country.service.js";
import { getIntlTier } from "../services/intl_tier.service.js";
import { getTwilioSmsUnitPriceUSD } from "../services/twilio_pricing.service.js";

export const blastsQuoteRouter = Router();

/**
 * POST /v1/blasts/quote
 * Body: { recipients: ["+1...", "+44..."], body: "..." }
 */
blastsQuoteRouter.post("/", requireAuth, async (req, res) => {
  const userId = req.user?.sub;
  const { recipients } = req.body || {};

  if (!userId) {
    return res.status(401).json({ error: "missing_token" });
  }

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: "recipients[] required" });
  }

  const user = await db("users").where({ id: userId }).first();
  if (!user) return res.status(404).json({ error: "user not found" });

  const plan = user.plan_tier || PLAN.FREE;

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

  for (const e164 of recipients) {
    const cc = parseE164CountryCode(e164);
    if (!cc) return res.status(400).json({ error: `invalid phone: ${e164}` });

    if (isDomesticUSCA(cc)) {
      domesticCount++;
      continue;
    }

    const tier = getIntlTier(cc);
    if (tier === "tier3") {
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
    const mult =
      tier === "tier1" ? INTL_MULTIPLIER.tier1 : INTL_MULTIPLIER.tier2;

    const unitUsd = await getTwilioSmsUnitPriceUSD(cc);
    const unitCents = Math.round(unitUsd * 100);
    const billedUnitCents = Math.ceil(unitCents * mult);

    estimatedIntlCents += billedUnitCents * count;
  }

  const caps =
    plan === PLAN.PRO ? INTL_CAPS_CENTS.pro : INTL_CAPS_CENTS.business;
  const since = user.intl_spend_since_charge_cents || 0;

  const breachesSoftPerBlast =
    estimatedIntlCents > caps.soft_per_blast;
  const breachesHardAccum =
    since + estimatedIntlCents > caps.hard_accum;

  const requiresImmediateCharge =
    breachesSoftPerBlast || breachesHardAccum;

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
    reason: breachesSoftPerBlast
      ? "softcap_per_blast"
      : breachesHardAccum
      ? "hardcap_accum"
      : null,
  });
});