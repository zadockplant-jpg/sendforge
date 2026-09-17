import { getJayjeConfig } from '../jayje/config.js';
import { JayjeMailError } from '../jayje/notification.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clean = value => String(value ?? '').replace(/[\r\n]/g, ' ').trim();

export function inviteBody({ referral, name = '', referrer, link, percent }, config) {
  const from = clean(referrer?.name || '').slice(0, 120) || 'Someone you know';
  const greeting = clean(name).slice(0, 120);
  const offer = `${percent}% referral bonus on handyman services`;
  const text = `${greeting ? `Hi ${greeting},\n\n` : ''}${from} uses JayJe for work around their home and thought you might too.\n\nUse their referral link and your first JayJe invoice gets a ${offer}:\n${link}\n\nReferral code: ${referral.code}\n\nJayJe — handyman, trade services and new construction.\nMuskegon, Michigan | jayje.com\n\nYou received this because ${from} entered your email address. There is no account and nothing to cancel if you ignore it.\n`;
  const html = `<div style="font-family:Arial,sans-serif;color:#111111;line-height:1.7">
<h1 style="font-size:24px">Your home projects, handled.</h1>
${greeting ? `<p>Hi ${escape(greeting)},</p>` : ''}
<p>${escape(from)} uses JayJe for work around their home and thought you might too.</p>
<p>Use their referral link and your first JayJe invoice gets a <strong>${escape(offer)}</strong>.</p>
<p><a href="${escape(link)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#0b6bcb;color:#ffffff;text-decoration:none;font-weight:600">Claim your ${escape(String(percent))}%</a></p>
<p>Or enter referral code <strong>${escape(referral.code)}</strong> when you get in touch.</p>
<p style="color:#555555;font-size:13px">You received this because ${escape(from)} entered your email address. There is no account and nothing to cancel if you ignore it.</p>
<p style="color:#555555;font-size:13px">JayJe — Muskegon, Michigan</p></div>`;
  return {
    personalizations: [{ to: [{ email: referral.invited_email }], custom_args: { jayje_referral: referral.id } }],
    from: { email: config.fromEmail, name: 'JayJe' },
    ...(referrer?.email ? { reply_to: { email: referrer.email, name: from } } : {}),
    subject: `${from} invited you to JayJe — ${percent}% off handyman services`,
    content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }],
    categories: ['jayje-referral-invite'],
    tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false }, subscription_tracking: { enable: false } },
  };
}

/** Same provider contract as the service-request notification: a 202 is the
 * only success, and an ambiguous failure is reported as delivery-unknown. */
export function createInviteMailer(getConfig = getJayjeConfig, fetcher = fetch) {
  return async function sendInvite(context) {
    const config = getConfig();
    if (!config.sendgridKey || !config.fromEmail) throw new JayjeMailError('mail_not_configured');
    let response;
    try {
      response = await fetcher('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.sendgridKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(inviteBody(context, config)),
        signal: AbortSignal.timeout(7500), redirect: 'error',
      });
    } catch { throw new JayjeMailError('mail_delivery_unknown', true); }
    if (response.status !== 202) throw new JayjeMailError(`mail_http_${response.status}`, response.status >= 500 || response.status === 408);
    return { messageId: response.headers.get('x-message-id') || null };
  };
}
