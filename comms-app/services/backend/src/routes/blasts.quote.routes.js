// comms-app/services/backend/src/routes/blasts.quote.routes.js
import { Router } from "express";
import { db } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  PLAN,
  INTL_CAPS_CENTS,
  INTL_MULTIPLIER,
  isDomesticUSCA,
} from "../config/pricingpolicytmp.js";
import { parseE164CountryCode } from "../services/phone_country.service.js";
import { getIntlTier } from "../services/intl_tier.service.js";
import { getTwilioSmsUnitPriceUSD } from "../services/twilio_pricing.service.js";

export const blastsQuoteRouter = Router();

/**
 * POST /v1/blasts/quote
 * Auth: Bearer JWT required
 * Body: {
 *   groupIds: ["..."],
 *   channels: ["sms","email"],
 *   body: "..."
 * }
 *
 * Quote is only relevant for SMS international pricing.
 * If SMS not selected -> intlCount 0 / no confirm flow.
 */
blastsQuoteRouter.post("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub;
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds.map(String) : [];
    const channels = Array.isArray(req.body?.channels) ? req.body.channels.map(String) : [];
    const wantsSms = channels.includes("sms");

    if (!userId) return res.status(401).json({ error: "missing_token" });
    if (!groupIds.length) return res.status(400).json({ error: "groupIds[] required" });

    // If not sending SMS, no intl pricing flow needed.
    if (!wantsSms) {
      return res.json({
        blocked: false,
        domesticCount: 0,
        intlCount: 0,
        estimatedIntlCents: 0,
        requiresConfirm: false,
        requiresImmediateCharge: false,
      });
    }

    const user = await db("users").where({ id: userId }).first();
    if (!user) return res.status(404).json({ error: "user_not_found" });

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

    // Resolve recipients (phones) from selected groups (snapshot + meta)
    // Meta groups: resolve descendant snapshot groups via recursive CTE.
    const rows = await db.raw(
      `
      WITH RECURSIVE descendants AS (
        SELECT g.id, g.type
        FROM groups g
        WHERE g.user_id = ? AND g.id = ANY(?)

        UNION ALL

        SELECT child.id, child.type
        FROM meta_group_links l
        JOIN groups parent ON parent.id = l.parent_group_id
        JOIN groups child ON child.id = l.child_group_id
        JOIN descendants d ON d.id = parent.id
        WHERE parent.user_id = ?
      ),
      snapshot_groups AS (
        SELECT DISTINCT id
        FROM descendants
        WHERE type = 'snapshot'
      ),
      member_contacts AS (
        SELECT DISTINCT c.phone_e164 AS phone
        FROM group_members gm
        JOIN snapshot_groups sg ON sg.id = gm.group_id
        JOIN contacts c ON c.id = gm.contact_id
        WHERE c.user_id = ? AND c.phone_e164 IS NOT NULL AND c.phone_e164 <> ''
      )
      SELECT phone FROM member_contacts
      `,
      [userId, groupIds, userId, userId],
    );

    const recipients = (rows?.rows || []).map((r) => r.phone).filter(Boolean);

    if (!recipients.length) {
      return res.status(400).json({ error: "no_sms_recipients" });
    }

    let intlCount = 0;
    let domesticCount = 0;

    // Count by country to minimize Twilio calls
    const countryCounts = new Map();

    for (const e164 of recipients) {
      const cc = parseE164CountryCode(e164);
      if (!cc) return res.status(400).json({ error: `invalid_phone:${e164}` });

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

    // If no intl recipients, no intl charge flow
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
      const mult = tier === "tier1" ? INTL_MULTIPLIER.tier1 : INTL_MULTIPLIER.tier2;

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
  } catch (e) {
    return res.status(500).json({ error: "quote_failed" });
  }
});