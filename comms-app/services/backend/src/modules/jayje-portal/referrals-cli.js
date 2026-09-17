#!/usr/bin/env node
// Inspect and retry referral invitations from the Render shell:
//   node src/modules/jayje-portal/referrals-cli.js list
//   node src/modules/jayje-portal/referrals-cli.js retry <referral uuid>
import { db } from '../../config/db.js';
import { createReferrals } from './referrals.js';
import { createInviteMailer } from './referral-mail.js';

const [command, argument] = process.argv.slice(2);
const referrals = createReferrals({ db, siteUrl: process.env.JAYJE_SITE_URL || 'https://jayje.com', mail: createInviteMailer() });

try {
  if (command === 'list') {
    const rows = await db('jayje_referrals')
      .leftJoin('jayje_clients', 'jayje_clients.id', 'jayje_referrals.referrer_client_id')
      .orderBy('jayje_referrals.created_at', 'desc').limit(Number(argument) || 30)
      .select('jayje_referrals.id', 'jayje_referrals.code', 'jayje_referrals.invited_email', 'jayje_referrals.status',
        'jayje_referrals.notification_status', 'jayje_referrals.notification_error_code', 'jayje_referrals.credit_cents',
        'jayje_referrals.created_at', 'jayje_clients.email as referrer');
    console.table(rows);
  } else if (command === 'retry' && argument) {
    const row = await db('jayje_referrals').where({ id: argument }).first();
    if (!row) throw new Error('referral_not_found');
    const referrer = await db('jayje_clients').where({ id: row.referrer_client_id }).first();
    // Reopen a failed or stuck send so the mailer will claim it again.
    await db('jayje_referrals').where({ id: row.id }).update({ notification_status: 'failed', updated_at: db.fn.now() });
    await referrals.send(row, { referrer });
    console.log(await db('jayje_referrals').where({ id: row.id }).first(['id', 'notification_status', 'notification_error_code']));
  } else {
    console.log('usage: referrals-cli.js list [limit] | retry <referral uuid>');
  }
} finally {
  await db.destroy();
}
