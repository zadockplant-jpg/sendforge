// The owner renamed ForgeDrop to DropForge (2026-09-27). The owner dashboard
// shows two programme names as stored: the DropForge referral programme's
// description (20260926_referral_programs_rcg_forgedrop.js) and the Cloud
// pickup affiliate share's label (20260929_recurring_affiliate_payouts.js).
// Only the wording those migrations wrote is replaced; text the owner edited
// in the dashboard is left as it is. Running it again changes nothing.

export const OLD_REFERRAL_DESCRIPTION =
  "ForgeDrop: $25 at 5, $50 at 15, $60 at 25, $175 at 50, then $175 for each additional 25 referred customers who bought it.";
export const NEW_REFERRAL_DESCRIPTION =
  "DropForge: $25 at 5, $50 at 15, $60 at 25, $175 at 50, then $175 for each additional 25 referred customers who bought it.";
export const OLD_SHARE_LABEL = "ForgeDrop Cloud pickup";
export const NEW_SHARE_LABEL = "DropForge Cloud pickup";

export async function up(knex) {
  if (await knex.schema.hasTable("referral_programs")) {
    const row = await knex("referral_programs").where({ product_slug: "forgedrop" }).first();
    const metadata = typeof row?.metadata === "string" ? JSON.parse(row.metadata) : row?.metadata;
    if (metadata?.description === OLD_REFERRAL_DESCRIPTION) {
      await knex("referral_programs")
        .where({ id: row.id })
        .update({ metadata: { ...metadata, description: NEW_REFERRAL_DESCRIPTION }, updated_at: knex.fn.now() });
    }
  }
  if (await knex.schema.hasTable("subscription_share_programs")) {
    await knex("subscription_share_programs")
      .where({ program_slug: "forgedrop-cloud-pickup", label: OLD_SHARE_LABEL })
      .update({ label: NEW_SHARE_LABEL, updated_at: knex.fn.now() });
  }
}

// Names only; nothing to undo.
export async function down() {}
