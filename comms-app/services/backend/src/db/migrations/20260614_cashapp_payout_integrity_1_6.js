import crypto from "crypto";

const TABFORGE_TIERS = [
  { requiredPurchases: 5, rewardAmountCents: 1000 },
  { requiredPurchases: 15, rewardAmountCents: 2000 },
  { requiredPurchases: 50, rewardAmountCents: 7500 },
];

function normalizeCashAppTag(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const cleaned = raw.replace(/^\$+/, "").replace(/[^a-zA-Z0-9_.$-]/g, "").slice(0, 80);
  if (!cleaned) return null;
  return cleaned.startsWith("$") ? cleaned : `$${cleaned}`;
}

function cashAppTagKey(value) {
  const normalized = normalizeCashAppTag(value);
  return normalized ? normalized.replace(/^\$+/, "").toLowerCase() : null;
}

async function addColumnIfMissing(knex, table, column, addColumn) {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, addColumn);
}

async function writeSystemAudit(knex, payload) {
  if (!(await knex.schema.hasTable("admin_audit_log"))) return;
  await knex("admin_audit_log").insert({
    id: crypto.randomUUID(),
    admin_user_id: null,
    admin_email: "system@sendforge.app",
    action: payload.action,
    resource_type: payload.resourceType || null,
    resource_id: payload.resourceId ? String(payload.resourceId) : null,
    before_value: payload.beforeValue || null,
    after_value: payload.afterValue || null,
    ip_hash: null,
    user_agent: "migration:20260614_cashapp_payout_integrity_1_6",
    metadata: payload.metadata || {},
    created_at: knex.fn.now(),
  });
}

export async function up(knex) {
  const hasUsers = await knex.schema.hasTable("users");
  const hasRewardQueue = await knex.schema.hasTable("reward_queue");
  const hasReferralCodes = await knex.schema.hasTable("referral_codes");

  if (hasUsers && !(await knex.schema.hasTable("cash_app_tag_claims"))) {
    await knex.schema.createTable("cash_app_tag_claims", (t) => {
      t.uuid("id").primary();
      t.uuid("user_id").notNullable().index();
      t.text("normalized_tag").notNullable().unique();
      t.text("display_tag").notNullable();
      t.text("status").notNullable().defaultTo("active").index();
      t.timestamp("claimed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("retired_at", { useTz: true }).nullable();
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  if (await knex.schema.hasTable("cash_app_tag_claims")) {
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS cash_app_tag_claims_one_active_per_user
      ON cash_app_tag_claims (user_id)
      WHERE status = 'active'
    `);
  }

  if (hasUsers && (await knex.schema.hasColumn("users", "cash_app_tag"))) {
    const users = await knex("users")
      .select("id", "email", "cash_app_tag", "created_at")
      .whereNotNull("cash_app_tag")
      .whereRaw("btrim(cash_app_tag) <> ''")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc");

    for (const user of users) {
      const displayTag = normalizeCashAppTag(user.cash_app_tag);
      const normalizedTag = cashAppTagKey(displayTag);

      if (!displayTag || !normalizedTag) {
        await knex("users").where({ id: user.id }).update({ cash_app_tag: null });
        if (hasReferralCodes) {
          await knex("referral_codes")
            .where({ user_id: user.id })
            .update({ cashapp_handle: null, updated_at: knex.fn.now() });
        }
        if (hasRewardQueue) {
          await knex("reward_queue")
            .where({ user_id: user.id })
            .whereIn("status", ["pending", "approved"])
            .update({ cashapp_handle: null, updated_at: knex.fn.now() });
        }
        continue;
      }

      const existingClaim = await knex("cash_app_tag_claims")
        .where({ normalized_tag: normalizedTag })
        .first();

      if (!existingClaim) {
        await knex("cash_app_tag_claims")
          .where({ user_id: user.id, status: "active" })
          .update({ status: "retired", retired_at: knex.fn.now(), updated_at: knex.fn.now() });

        await knex("cash_app_tag_claims").insert({
          id: crypto.randomUUID(),
          user_id: user.id,
          normalized_tag: normalizedTag,
          display_tag: displayTag,
          status: "active",
          claimed_at: knex.fn.now(),
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        });

        if (displayTag !== user.cash_app_tag) {
          await knex("users").where({ id: user.id }).update({ cash_app_tag: displayTag });
        }
        continue;
      }

      if (existingClaim.user_id === user.id) {
        await knex("cash_app_tag_claims")
          .where({ id: existingClaim.id })
          .update({ display_tag: displayTag, status: "active", retired_at: null, updated_at: knex.fn.now() });
        if (displayTag !== user.cash_app_tag) {
          await knex("users").where({ id: user.id }).update({ cash_app_tag: displayTag });
        }
        continue;
      }

      // Deterministically preserve the first/oldest owner and clear later duplicates.
      await knex("users").where({ id: user.id }).update({ cash_app_tag: null });
      if (hasReferralCodes) {
        await knex("referral_codes")
          .where({ user_id: user.id })
          .update({ cashapp_handle: null, updated_at: knex.fn.now() });
      }
      if (hasRewardQueue) {
        await knex("reward_queue")
          .where({ user_id: user.id })
          .whereIn("status", ["pending", "approved"])
          .update({
            cashapp_handle: null,
            status: "pending",
            approved_by: null,
            approved_at: null,
            admin_note: "Cash App tag conflict detected. User must enter a unique Cash App tag before payout approval.",
            updated_at: knex.fn.now(),
          });
      }

      await writeSystemAudit(knex, {
        action: "cashapp_tag.duplicate_cleared",
        resourceType: "user",
        resourceId: user.id,
        beforeValue: { cashAppTag: user.cash_app_tag },
        afterValue: { cashAppTag: null },
        metadata: {
          conflictingOwnerUserId: existingClaim.user_id,
          normalizedTag,
        },
      });
    }
  }

  if (hasRewardQueue) {
    await addColumnIfMissing(knex, "reward_queue", "reward_key", (t) => t.text("reward_key").nullable());
    await addColumnIfMissing(knex, "reward_queue", "payout_reference", (t) => t.text("payout_reference").nullable());

    const rows = await knex("reward_queue")
      .select("id", "user_id", "product_slug", "metadata", "created_at")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc");

    const seen = new Set();
    for (const row of rows) {
      const tierKey = String(row.metadata?.tier_key || "").trim();
      if (!row.user_id || !row.product_slug || !tierKey) continue;
      const composite = `${row.user_id}|${row.product_slug}|${tierKey}`;
      if (seen.has(composite)) continue;
      seen.add(composite);
      await knex("reward_queue").where({ id: row.id }).update({ reward_key: tierKey });
    }

    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS reward_queue_unique_milestone
      ON reward_queue (user_id, product_slug, reward_key)
    `);

    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS reward_queue_unique_payout_reference
      ON reward_queue (payout_reference)
      WHERE payout_reference IS NOT NULL AND btrim(payout_reference) <> ''
    `);
  }

  if (await knex.schema.hasTable("referral_programs")) {
    const existing = await knex("referral_programs").where({ product_slug: "tabforge" }).first();
    if (existing) {
      await knex("referral_programs")
        .where({ product_slug: "tabforge" })
        .update({
          required_purchases: 5,
          reward_amount_cents: 1000,
          metadata: {
            ...(existing.metadata || {}),
            qualification: "verified_purchase",
            tiers: TABFORGE_TIERS,
            referrer_purchase_required: false,
            referred_purchase_required: true,
            payout_flow: "pending -> approved -> paid",
            description: "Referrer purchase is not required. Referred users must complete verified TabForge Pro purchases. Payouts: $10 at 5, $20 at 15, and $75 at 50.",
          },
          updated_at: knex.fn.now(),
        });
    }
  }
}

export async function down(knex) {
  if (await knex.schema.hasTable("reward_queue")) {
    await knex.raw("DROP INDEX IF EXISTS reward_queue_unique_payout_reference");
    await knex.raw("DROP INDEX IF EXISTS reward_queue_unique_milestone");
    if (await knex.schema.hasColumn("reward_queue", "payout_reference")) {
      await knex.schema.alterTable("reward_queue", (t) => t.dropColumn("payout_reference"));
    }
    if (await knex.schema.hasColumn("reward_queue", "reward_key")) {
      await knex.schema.alterTable("reward_queue", (t) => t.dropColumn("reward_key"));
    }
  }

  if (await knex.schema.hasTable("cash_app_tag_claims")) {
    await knex.raw("DROP INDEX IF EXISTS cash_app_tag_claims_one_active_per_user");
    await knex.schema.dropTable("cash_app_tag_claims");
  }
}
