# JayJe account portal

JayJe uses the existing SendForge users, password verification, signed customer
sessions, admin allowlist, and admin email-code verification. The account UI lives
at `https://jayje.com/account/`. TabForge and SendForge product billing is unchanged.

## Configuration

Render applies the additive `20260907_create_jayje_portal.js` migration through the
existing start command. Do not run production migrations from a local checkout.

Required backend settings:

- `JAYJE_PORTAL_ENABLED=true`
- `JAYJE_SITE_URL=https://jayje.com`
- `JAYJE_PROXY_SECRET`: existing shared secret, also stored in Cloudflare Pages.
- `JAYJE_ALLOWED_ORIGINS=https://jayje.com,https://www.jayje.com`
- `STRIPE_SECRET_KEY`: existing Stripe account key; keep unchanged.
- `JAYJE_STRIPE_WEBHOOK_SECRET`: signing secret for the separate JayJe endpoint.

Public service-request intake remains independently controlled by `JAYJE_ENABLED`
and its configured notification inbox. Enabling the portal does not enable intake.

## Payments

The dedicated Stripe endpoint is
`https://comms-app-1wo0.onrender.com/v1/jayje/portal/stripe/webhook`.
Subscribe to `checkout.session.completed`, `checkout.session.expired`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`, and
`charge.dispute.closed`. Its API version is `2024-06-20`.
Keep the existing SendForge webhook and its signing secret unchanged.

Admin creates a client using the client's account email, saves a quote or invoice
draft, then makes it available. Verified shared accounts claim their own client
record. Clients can accept or decline quotes. Admin can turn an accepted quote
into one invoice draft. Issued documents are immutable; void and replace a
document to correct its scope. Voided records stay in the account history.

Invoices use USD, full payment, and hosted Stripe card checkout. Amounts and tax
are calculated on the server using integer arithmetic. Admin supplies the
applicable tax rate. No automatic tax calculation or recurring subscriptions are
introduced. Quotes use their date as the last valid date; invoices use a due date.

Each invoice locks and reserves a checkout attempt before calling Stripe. Repeated
requests reuse that attempt's idempotency key. Payment metadata uses only JayJe
identifiers; no SendForge product entitlement or shared Stripe customer field is
changed. Webhook delivery retrieves the canonical Stripe session, verifies the
invoice, amount and currency, and atomically records payment. Client-return URLs
never assert payment. The authenticated Check payment status action can also
reconcile directly with Stripe. Duplicate callbacks create one receipt.

A checkout expires after one hour. An open or pending checkout blocks voiding.
After expiry, Check payment status reconciles it, then admin can void the invoice.
If session creation has an ambiguous outcome and the session ID was never saved,
the portal blocks a replacement rather than risk double payment. Investigate the
attempt ID in `jayje_checkout_attempts` against Stripe's request logs using
`jayje-invoice-<attempt UUID>`. Confirm the provider outcome before any manual
repair; never set an invoice paid from a browser query or an unverified event.
Refunds are performed in Stripe Dashboard; the portal keeps the original paid
record and shows the refund/dispute status. No refund button is exposed here.

## Google sign-in activation

Create a **Web application** OAuth client in the intended Google Cloud project.
Configure the consent screen with the JayJe app name, verified `jayje.com` domain,
homepage `https://jayje.com`, and privacy URL `https://jayje.com/privacy/`.
Use only `openid`, `email`, and `profile` scopes. For public access, publish the
consent screen; otherwise only explicitly configured test users can sign in.

Authorized redirect URIs (exact strings):

```text
https://jayje.com/api/account/google/callback
https://www.jayje.com/api/account/google/callback
```

Save the client ID and secret as `JAYJE_GOOGLE_CLIENT_ID` and
`JAYJE_GOOGLE_CLIENT_SECRET` on the existing SendForge Render service, then deploy.
No Google secret belongs in Cloudflare's public variables or in Git. Do not
replace the unrelated `GOOGLE_CLIENT_*` credentials used for contact integrations.
The UI displays Google sign-in only when both JayJe settings are present.

The server uses state, nonce, PKCE, Google-issued ID-token validation and a
ten-minute single-use Redis transaction. An existing shared account must first
sign in and select **Link Google** with the same email. Matching an email alone
never silently links an existing account. Admin Google sign-in still requires the
shared email-code challenge. Essential session cookies are Secure, HttpOnly and
SameSite=Lax. Pages requires a same-origin Origin header for mutations and never
accepts a browser-provided Authorization header.

## Verification and rollback

Run `npm test` in this backend directory with isolated test database/Redis URLs.
The JayJe tests execute the production migration and queries in an in-memory
PostgreSQL instance (PGlite), plus HTTP boundary, JWT role, raw webhook-signature,
concurrent checkout, duplicate-event, amount, client-isolation, and PDF tests.
They never connect to production Stripe or send a live charge.

The website's `npm run check` covers build and Pages proxy checks.
`python tests/browser-portal.py` runs its full UI workflow against a fixture API
with Playwright after starting the frontend dev server on port 4178.

Disable `JAYJE_PORTAL_ENABLED` to stop portal access without changing other apps.
Keep the additive tables when reverting application code. Do not drop paid
records or disable the shared SendForge webhook as part of a JayJe rollback.
