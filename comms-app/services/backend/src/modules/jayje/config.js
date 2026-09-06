export const JAYJE_VERSION = '1.0.0';
export const CONSENT_VERSION = '2026-09-06';
export const SERVICE_NAMES = Object.freeze({
  handyman: 'Handyman', hvac: 'Heating & cooling', electrical: 'Electrical',
  lighting: 'Lighting', plumbing: 'Plumbing & drains',
  'flood-damage': 'Flood damage', security: 'Security systems', construction: 'New construction',
});
export const TIMEFRAMES = Object.freeze({soon:'As soon as possible',month:'Within a month',planning:'Planning ahead'});
const validEmail = value => typeof value === 'string' && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) && value.length <= 254;
export function getJayjeConfig(environment = process.env) {
  const originStrings = (environment.JAYJE_ALLOWED_ORIGINS || 'https://jayje.com,https://www.jayje.com').split(',').map(x=>x.trim()).filter(Boolean);
  const origins = originStrings.filter(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.hostname.includes('*') && url.origin === value; } catch { return false; }
  });
  return Object.freeze({
    enabled: environment.JAYJE_ENABLED === 'true',
    proxySecret: environment.JAYJE_PROXY_SECRET || '',
    origins,
    toEmail: environment.JAYJE_CONTACT_TO_EMAIL || '',
    fromEmail: environment.JAYJE_FROM_EMAIL || environment.CONTACT_FROM_EMAIL || environment.ACCOUNT_FROM_EMAIL || environment.SENDGRID_FROM_EMAIL || '',
    fromName: (environment.JAYJE_FROM_NAME || 'JayJe service requests').replace(/[\r\n]/g,' ').slice(0,100),
    sendgridKey: environment.SENDGRID_API_KEY || '',
    bodyLimit: '24kb',
  });
}
export function configReady(config) {
  return Boolean(config.enabled && config.proxySecret.length >= 32 && config.origins.length &&
    validEmail(config.toEmail) && validEmail(config.fromEmail) && config.sendgridKey);
}
