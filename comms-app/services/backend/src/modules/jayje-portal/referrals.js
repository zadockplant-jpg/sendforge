import { randomUUID, randomInt } from 'node:crypto';
import { z } from 'zod';
import { fail } from './service.js';

// A referred friend takes this share off the handyman line items of their
// first JayJe invoice. The referrer receives the same amount as an account
// credit once that invoice is paid.
export const REFERRAL_BPS = Number.parseInt(process.env.JAYJE_REFERRAL_BPS || '500', 10) || 500;
export const DISCOUNTED_CATEGORIES = Object.freeze(['handyman']);
export const WELCOME_LABEL = 'Referral welcome discount (handyman)';
export const CREDIT_LABEL = 'Referral credit';
export const MAX_INVITES_PER_DAY = 25;

// Ambiguous characters are left out so a code can be read aloud or retyped.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const inviteSchema = z.object({
  email: z.string().trim().email().max(254).transform(s => s.toLowerCase()),
  name: z.string().trim().max(160).default(''),
}).strict();
export const claimSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}$/),
}).strict();

export const newCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
export const share = cents => Number((BigInt(Math.max(0, cents)) * BigInt(REFERRAL_BPS) + 5000n) / 10000n);
export const referralLink = (code, siteUrl) => `${siteUrl.replace(/\/$/, '')}/?ref=${code}`;

/** Cents of a document's line items that a referral discount applies to. */
export function discountableCents(items) {
  return items.filter(item => DISCOUNTED_CATEGORIES.includes(item.category))
    .reduce((n, item) => n + Number(item.total_cents ?? (BigInt(item.quantity_milli) * BigInt(item.unit_cents) + 500n) / 1000n), 0);
}

export function createReferrals({ db, siteUrl = 'https://jayje.com', mail = null, logger = console }) {
  async function codeFor(clientId, database = db) {
    const existing = await database('jayje_referral_codes').where({ client_id: clientId }).first();
    if (existing) return existing.code;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      const [row] = await database('jayje_referral_codes').insert({ code, client_id: clientId }).onConflict('code').ignore().returning('*');
      if (row) return row.code;
      const mine = await database('jayje_referral_codes').where({ client_id: clientId }).first();
      if (mine) return mine.code;
    }
    throw fail(503, 'referral_code_unavailable');
  }

  // The open-invitation and one-referral-per-client rules are partial unique
  // indexes, so a race surfaces here as a constraint violation, not a read.
  async function insertReferral(row) {
    try {
      const [saved] = await db('jayje_referrals').insert(row).returning('*');
      return saved;
    } catch (error) {
      if (error?.code === '23505') throw fail(409, 'referral_already_invited');
      throw error;
    }
  }

  async function summary(clientId) {
    const code = await codeFor(clientId);
    const referrals = await db('jayje_referrals').where({ referrer_client_id: clientId }).orderBy('created_at', 'desc').limit(200);
    const credits = await db('jayje_referral_credits').where({ client_id: clientId }).orderBy('created_at', 'desc').limit(200);
    return {
      code,
      link: referralLink(code, siteUrl),
      percent: REFERRAL_BPS / 100,
      referrals: referrals.map(row => ({
        id: row.id, invited_email: row.invited_email, status: row.status,
        discount_cents: row.discount_cents, credit_cents: row.credit_cents,
        invite_delivered: row.notification_status === 'accepted',
        created_at: row.created_at, joined_at: row.joined_at, redeemed_at: row.redeemed_at,
      })),
      credits,
      credit_available_cents: credits.filter(c => c.status === 'available').reduce((n, c) => n + c.amount_cents, 0),
    };
  }

  /** Records the invitation before any mail is attempted, so a provider
   * failure leaves a retryable row rather than a lost referral. */
  async function invite(client, input) {
    const data = inviteSchema.parse(input);
    if (data.email === String(client.email).toLowerCase()) throw fail(409, 'referral_self_invite');
    const since = new Date(Date.now() - 86400000);
    const [{ count }] = await db('jayje_referrals').where({ referrer_client_id: client.id }).where('created_at', '>', since).count({ count: '*' });
    if (Number(count) >= MAX_INVITES_PER_DAY) throw fail(429, 'referral_invite_limit');
    const referred = await db('jayje_clients').where({ email: data.email }).first();
    if (referred) {
      const documents = await db('jayje_documents').where({ client_id: referred.id }).whereNot({ status: 'draft' }).first();
      if (documents) throw fail(409, 'referral_existing_customer');
    }
    const code = await codeFor(client.id);
    const row = {
      id: randomUUID(), code, referrer_client_id: client.id, invited_email: data.email,
      referred_client_id: referred && referred.id !== client.id ? referred.id : null,
      status: referred && referred.id !== client.id ? 'joined' : 'invited',
      joined_at: referred && referred.id !== client.id ? new Date() : null,
    };
    const saved = await insertReferral(row);
    await send(saved, { name: data.name, referrer: client });
    return db('jayje_referrals').where({ id: saved.id }).first();
  }

  async function send(referral, { name = '', referrer } = {}) {
    if (!mail) return;
    const [claimed] = await db('jayje_referrals').where({ id: referral.id }).whereIn('notification_status', ['pending', 'failed'])
      .update({
        notification_status: 'sending', notification_attempts: db.raw('notification_attempts + 1'),
        notification_attempted_at: db.fn.now(), updated_at: db.fn.now(),
      }).returning('*');
    if (!claimed) return;
    try {
      const result = await mail({ referral: claimed, name, referrer, link: referralLink(claimed.code, siteUrl), percent: REFERRAL_BPS / 100 });
      await db('jayje_referrals').where({ id: referral.id }).update({
        notification_status: 'accepted', notification_error_code: null,
        notification_provider_id: result?.messageId ? String(result.messageId).slice(0, 250) : null,
        notified_at: db.fn.now(), updated_at: db.fn.now(),
      });
    } catch (error) {
      const code = /^mail_[a-z0-9_]+$/.test(error?.code || '') ? error.code : 'mail_send_failed';
      await db('jayje_referrals').where({ id: referral.id }).update({
        notification_status: error?.deliveryUnknown ? 'unknown' : 'failed',
        notification_error_code: code.slice(0, 80), updated_at: db.fn.now(),
      }).catch(() => { /* row stays sending for manual reconciliation */ });
      logger.error('[jayje-referrals]', code, referral.id);
    }
  }

  /** A friend who arrived on a referral link connects it to their account. */
  async function claim(client, input) {
    const { code } = claimSchema.parse(input);
    const owner = await db('jayje_referral_codes').where({ code }).first();
    if (!owner) throw fail(404, 'referral_code_not_found');
    if (owner.client_id === client.id) throw fail(409, 'referral_self_invite');
    const mine = await db('jayje_referrals').where({ referred_client_id: client.id }).first();
    if (mine) return mine;
    const history = await db('jayje_documents').where({ client_id: client.id }).whereNot({ status: 'draft' }).first();
    if (history) throw fail(409, 'referral_existing_customer');
    const email = String(client.email).toLowerCase();
    const open = await db('jayje_referrals').where({ invited_email: email }).whereNot({ status: 'cancelled' }).first();
    if (open) {
      if (open.referrer_client_id !== owner.client_id) throw fail(409, 'referral_already_invited');
      const [joined] = await db('jayje_referrals').where({ id: open.id }).where({ status: 'invited' })
        .update({ referred_client_id: client.id, status: 'joined', joined_at: db.fn.now(), updated_at: db.fn.now() }).returning('*');
      return joined || open;
    }
    return insertReferral({
      id: randomUUID(), code, referrer_client_id: owner.client_id, invited_email: email,
      referred_client_id: client.id, status: 'joined', joined_at: new Date(),
      notification_status: 'skipped',
    });
  }

  /** The discount and credits a new document may carry, resolved under the
   * caller's transaction so two drafts cannot claim the same referral. */
  async function pending(trx, clientId, items, creditIds = []) {
    const detail = [];
    let referralId = null;
    const referral = await trx('jayje_referrals').where({ referred_client_id: clientId, status: 'joined' }).forUpdate().first();
    if (referral) {
      const amount = share(discountableCents(items));
      if (amount > 0) { referralId = referral.id; detail.push({ label: WELCOME_LABEL, amount_cents: amount }); }
    }
    for (const id of [...new Set(creditIds)]) {
      const credit = await trx('jayje_referral_credits').where({ id, client_id: clientId, status: 'available' }).forUpdate().first();
      if (!credit) throw fail(409, 'referral_credit_unavailable');
      detail.push({ label: CREDIT_LABEL, amount_cents: credit.amount_cents, credit_id: credit.id });
    }
    return { referral_id: referralId, discount_detail: detail, discount_cents: detail.reduce((n, d) => n + d.amount_cents, 0) };
  }

  async function applyCredits(trx, document) {
    const ids = (document.discount_detail || []).filter(d => d.credit_id).map(d => d.credit_id);
    if (ids.length) await trx('jayje_referral_credits').whereIn('id', ids).update({ status: 'applied', applied_document_id: document.id, updated_at: trx.fn.now() });
  }

  /** A voided document returns its credits, and frees its referral discount. */
  async function release(trx, document) {
    await trx('jayje_referral_credits').where({ applied_document_id: document.id })
      .update({ status: 'available', applied_document_id: null, updated_at: trx.fn.now() });
  }

  /** On payment: the friend's discount is spent and the referrer is credited. */
  async function settle(trx, invoice) {
    if (!invoice.referral_id) return null;
    const referral = await trx('jayje_referrals').where({ id: invoice.referral_id }).forUpdate().first();
    if (!referral || referral.status === 'redeemed') return null;
    const welcome = (invoice.discount_detail || []).find(d => d.label === WELCOME_LABEL)?.amount_cents || 0;
    await trx('jayje_referrals').where({ id: referral.id }).update({
      status: 'redeemed', discount_cents: welcome, credit_cents: welcome,
      redeemed_at: trx.fn.now(), updated_at: trx.fn.now(),
    });
    if (welcome > 0) {
      await trx('jayje_referral_credits').insert({
        id: randomUUID(), referral_id: referral.id, client_id: referral.referrer_client_id,
        amount_cents: welcome, status: 'available',
      }).onConflict('referral_id').ignore();
    }
    return referral;
  }

  return { codeFor, summary, invite, send, claim, pending, applyCredits, release, settle };
}
