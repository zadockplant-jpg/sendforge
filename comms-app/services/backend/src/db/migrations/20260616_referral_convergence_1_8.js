import crypto from "crypto";

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

export async function up(knex) {
  if (!(await knex.schema.hasTable("users"))) return;

  if (!(await knex.schema.hasTable("cash_app_tag_claims"))) {
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
  } else {
    await addColumnIfMissing(knex, "cash_app_tag_claims", "normalized_tag", (t) => t.text("normalized_tag").nullable());
    await addColumnIfMissing(knex, "cash_app_tag_claims", "display_tag", (t) => t.text("display_tag").nullable());
    await addColumnIfMissing(knex, "cash_app_tag_claims", "status", (t) => t.text("status").notNullable().defaultTo("active"));
    await addColumnIfMissing(knex, "cash_app_tag_claims", "claimed_at", (t) => t.timestamp("claimed_at", { useTz: true }).nullable());
    await addColumnIfMissing(knex, "cash_app_tag_claims", "retired_at", (t) => t.timestamp("retired_at", { useTz: true }).nullable());
    await addColumnIfMissing(knex, "cash_app_tag_claims", "created_at", (t) => t.timestamp("created_at", { useTz: true }).nullable());
    await addColumnIfMissing(knex, "cash_app_tag_claims", "updated_at", (t) => t.timestamp("updated_at", { useTz: true }).nullable());
  }

  const users = (await knex.schema.hasColumn("users", "cash_app_tag"))
    ? await knex("users")
        .select("id", "cash_app_tag", "created_at")
        .whereNotNull("cash_app_tag")
        .whereRaw("btrim(cash_app_tag) <> ''")
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
    : [];

  for (const user of users) {
    const displayTag = normalizeCashAppTag(user.cash_app_tag);
    const normalizedTag = cashAppTagKey(displayTag);

    if (!displayTag || !normalizedTag) {
      await knex("users").where({ id: user.id }).update({ cash_app_tag: null });
      continue;
    }

    const existingClaim = await knex("cash_app_tag_claims")
      .where({ normalized_tag: normalizedTag })
      .first();

    if (existingClaim && existingClaim.user_id !== user.id) {
      // The earliest owner keeps the tag. Later duplicates are cleared and must
      // enter a unique Cash App tag before a payout can be approved.
      await knex("users").where({ id: user.id }).update({ cash_app_tag: null });

      if (await knex.schema.hasTable("referral_codes")) {
        await knex("referral_codes")
          .where({ user_id: user.id })
          .update({ cashapp_handle: null, updated_at: knex.fn.now() });
      }

      if (await knex.schema.hasTable("reward_queue")) {
        await knex("reward_queue")
          .where({ user_id: user.id })
          .whereIn("status", ["pending", "approved"])
          .update({
            cashapp_handle: null,
            status: "pending",
            approved_by: null,
            approved_at: null,
            admin_note: "Cash App tag conflict detected. Enter a unique Cash App tag before payout approval.",
            updated_at: knex.fn.now(),
          });
      }
      continue;
    }

    await knex("cash_app_tag_claims")
      .where({ user_id: user.id, status: "active" })
      .whereNot({ normalized_tag: normalizedTag })
      .update({ status: "retired", retired_at: knex.fn.now(), updated_at: knex.fn.now() });

    if (existingClaim) {
      await knex("cash_app_tag_claims")
        .where({ id: existingClaim.id })
        .update({
          display_tag: displayTag,
          status: "active",
          retired_at: null,
          claimed_at: existingClaim.claimed_at || knex.fn.now(),
          updated_at: knex.fn.now(),
        });
    } else {
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
    }

    if (displayTag !== user.cash_app_tag) {
      await knex("users").where({ id: user.id }).update({ cash_app_tag: displayTag });
    }
  }

  // Repair partial/duplicate active-claim states before enforcing the index.
  const activeClaims = await knex("cash_app_tag_claims")
    .select("id", "user_id", "normalized_tag", "claimed_at", "created_at")
    .where({ status: "active" })
    .orderBy("claimed_at", "asc")
    .orderBy("created_at", "asc")
    .orderBy("id", "asc");

  const activeByUser = new Map();
  for (const claim of activeClaims) {
    if (!activeByUser.has(claim.user_id)) {
      activeByUser.set(claim.user_id, claim.id);
      continue;
    }
    await knex("cash_app_tag_claims")
      .where({ id: claim.id })
      .update({ status: "retired", retired_at: knex.fn.now(), updated_at: knex.fn.now() });
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS cash_app_tag_claims_normalized_unique
    ON cash_app_tag_claims (normalized_tag)
    WHERE normalized_tag IS NOT NULL AND btrim(normalized_tag) <> ''
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS cash_app_tag_claims_one_active_per_user
    ON cash_app_tag_claims (user_id)
    WHERE status = 'active'
  `);
}

export async function down() {
  // Intentionally non-destructive. Cash App claim history protects payout integrity
  // and must not be removed by a routine rollback.
}
