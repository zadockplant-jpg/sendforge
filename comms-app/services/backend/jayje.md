# Isolated JayJe module — 1.0.0

This is an additive module inside the existing SendForge service. Existing backend package version becomes 1.2.2; no dependencies change.

## Boundaries

The single mount is `/v1/jayje`, before the shared body parsers. JayJe owns its own 24 KiB JSON limit, proxy authentication and error responses. Existing SendForge parsers, raw-body verification, CORS, auth, accounts, messaging, billing, TabForge, ForgePass and webhook route mounts are not modified.

The module is disabled unless `JAYJE_ENABLED=true` and all required settings are present. It lazily reuses the existing Knex and Redis instances. It uses the existing SendGrid API credential but a separate business inbox, sender name, email template and category. It never adds requesters to SendForge users, contacts, referral lists or marketing groups.

| Component | Responsibility |
|---|---|
| `config.js` | Scoped environment settings, service contract and explicit enablement |
| `validation.js` | Strict normalized request schema; contact consent and honeypot |
| `rate-limit.js` | Atomic Redis counters with JayJe-prefixed HMAC identifiers |
| `repository.js` | Queries only `jayje_service_requests`; request and notification claims |
| `notification.js` | Escaped business-inbox email and provider-state handling |
| `service.js` | Durable intake, payload fingerprint and duplicate protection |
| `router.js` | Proxy boundary, HTTP contract and isolated errors |
| `index.js` | Mountable router composed with existing infrastructure |
| `inbox.js` | Secured Render-Shell inspection, status changes and manual retry |

Only a new table and its indexes are added. The migration does not alter, rename or reference existing account or billing tables. Run migrations through the existing Render deploy-time process, never locally. Confirm that deploy command; it is not inferred from an unavailable Render dashboard.

## Required configuration

See `jayje.env.example`. An explicit business inbox is required. When `JAYJE_FROM_EMAIL` is blank, sender address fallback is `CONTACT_FROM_EMAIL`, then `ACCOUNT_FROM_EMAIL`, then `SENDGRID_FROM_EMAIL`; that address must be usable with the existing SendGrid key. No `.env` file or production credential is supplied or changed.

The Cloudflare Pages Function is the trusted caller. Its shared `JAYJE_PROXY_SECRET` is compared using timing-safe digests. `X-Jayje-Origin` must be an exact allowed HTTPS origin; wildcard origin matching is not supported. `X-Jayje-Client-Ip` must be a valid IP forwarded by the authenticated proxy. This route is not meant to be called directly from an unauthenticated browser.

## HTTP contract

`POST /v1/jayje/requests` accepts JSON:

```json
{
  "requestKey": "00f68f60-6fc6-42b6-9249-b410f823ea0b",
  "services": ["hvac", "lighting"],
  "name": "Test Customer",
  "email": "customer@example.com",
  "phone": "",
  "contactMethod": "email",
  "location": "Muskegon",
  "timeframe": "month",
  "message": "Please inspect the furnace and replace the kitchen light.",
  "consent": true,
  "website": ""
}
```

The eight service IDs are `handyman`, `hvac`, `electrical`, `lighting`, `plumbing`, `flood-damage`, `security`, `construction`. Contact methods are `email` and `phone`; phone requires a number. Timeframes are `soon`, `month`, `planning`.

A newly stored request returns **202** and `{ "ok": true, "reference": "JJ-XXXXXXXXXXXX" }`, with 12 hexadecimal characters after `JJ-`. An unchanged retry with the same request key returns **200** and the same reference. A conflicting payload with that key returns **409**. Reopening the page generates a new key; duplicate protection is scoped to the original page attempt, not fuzzy matching across unrelated submissions.

Other responses: 400 invalid input, 403 forbidden proxy, 405 wrong method, 413 oversized body, 415 wrong content type, 429 intake limit, 503 disabled/missing settings or unavailable storage/limiter. Error responses contain no project contents or credentials.

The limit is 10 attempts per IP and 4 per normalized email over one-hour counter windows. Retries also count toward that limit. Counter keys use HMAC with the server secret and expire after one hour. Raw IP/email values are not used as Redis keys. Disconnected Redis fails closed; there is no unsafe unbounded in-memory fallback.

`GET /v1/jayje/health` is authenticated with the same secret and origin, and checks table availability plus Redis. It is not a public readiness endpoint and does not test email delivery.

## Storage and email semantics

Request insertion occurs before email. The unique request key and atomic notification claim prevent unchanged retries from inserting or emailing twice. Mail HTML is escaped; the customer email is Reply-To, not a user-selected notification destination.

Email states are `pending`, `sending`, `accepted`, `failed`, `unknown`. `accepted` means SendGrid returned HTTP 202, not that an inbox received it. Network ambiguity and server errors are recorded as `unknown`; they are not blindly resent on browser retries. A process interruption may leave `sending`, which also requires reconciliation. Inspect requests in the Render Shell and check SendGrid activity before forcing another notification. There is no background retry scheduler in this release.

SendGrid event webhooks and their existing SendForge handling are untouched. JayJe does not currently consume provider delivery events into its table.

Status values used by the inbox utility are `new`, `contacted`, `scheduled`, `closed`. Marking a request scheduled is an internal status action; the public form does not book an appointment.

## Test and operate

From the existing backend directory, with existing dependencies installed:

```sh
node --test test/jayje.test.js
npm test
node src/modules/jayje/inbox.js list
node src/modules/jayje/inbox.js show REQUEST_UUID
node src/modules/jayje/inbox.js status REQUEST_UUID contacted
node src/modules/jayje/inbox.js retry REQUEST_UUID
```

The tests inject fake storage/mail/Redis and compile migration SQL without executing it. The inbox commands are for the existing secured Render Shell with its deployed environment. Do not point local tests at production database URLs.

The operator can explicitly use `retry REQUEST_UUID --force` after checking provider activity. That bypasses the ordinary notification-state guard and can send an additional email. A normal retry is limited to pending/failed records and fewer than five attempts.

To disable intake, set `JAYJE_ENABLED=false`; preserve collected records. The migration's down function drops the JayJe table and is not an operational disable switch.

Official implementation references:
- https://expressjs.com/en/4x/api/
- https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
- https://support.sendgrid.com/hc/en-us/articles/37945843123995-SendGrid-API-Returns-202-Accepted-Response-but-doesn-t-Send-Email
