# My Home Builder client portal

The client portal at `https://myhomebuilderllc.com/clients` runs here, in
`src/modules/myhomebuilder-portal/`. The website itself stays a static Cloudflare Pages
site; its only portal code is a Pages Function that forwards `/clients/*` to this module,
the same way jayje.com forwards its account pages. Everything else lives here:
- logins
- the admin panel and its emailed codes
- quotes, invoices and templates
- Stripe payments
- receipts
- documents and e-signing

## How requests arrive

- **From the website:** the Pages Function (in the `myhomebuilder` repository) forwards
  `/clients/<path>` to `/v1/myhomebuilder/portal/clients/<path>`. It adds three headers:
  `X-MHB-Proxy-Key` (the shared secret), `X-MHB-Origin` and `X-MHB-Client-Ip`. Requests
  without a valid key, an allowed origin and a real IP address are refused.
- **The portal code works on Web Requests.** `handler.js` sees the public URL
  (`https://myhomebuilderllc.com/clients/...`) and returns HTML, redirects and cookies.
  The Function returns them to the browser unchanged. Session cookies stay first-party on
  myhomebuilderllc.com with `Path=/clients`.
- **Muskegon project files:** these (the selection app and live material designer) are
  static files on the website. For them the portal checks the session and answers with an
  empty grant carrying `X-MHB-Asset: <path>` and the protective headers. The Function then
  serves that file from Pages. It honors the grant only for paths under
  `/clients/muskegon-addition/`.
- **Stripe** calls `https://comms-app-1wo0.onrender.com/v1/myhomebuilder/portal/stripe/webhook`
  directly, signed with its own secret. Subscribe it to these events, with API version
  `2024-06-20`:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `checkout.session.async_payment_failed`

  The endpoint ignores Checkout sessions that are not portal invoices. SendForge's and
  JayJe's webhooks are separate and unchanged.

## Configuration (Render)

- `MHB_PORTAL_ENABLED=true` turns the module on (otherwise every route answers 503).
- `MHB_PROXY_SECRET`: shared with the website's Pages Function (at least 32 characters).
- `MHB_SESSION_SECRET`: signs client and admin session cookies.
- `MHB_CLIENT_PORTAL_PASSWORD`: the Muskegon Addition client's project login. Portals created
  in the admin panel store PBKDF2-hashed logins in `mhb_clients` instead.
- `MHB_STRIPE_SECRET_KEY` and `MHB_STRIPE_WEBHOOK_SECRET`: My Home Builder LLC's own Stripe
  account, not SendForge's `STRIPE_SECRET_KEY`.
- `SENDGRID_API_KEY`: the backend's existing key. `myhomebuilderllc.com` is domain-authenticated
  in the same SendGrid account, and mail goes from `billing@myhomebuilderllc.com` with replies
  to `mb@myhomebuilderllc.com`. Messages carry the category `myhomebuilder-portal` and no
  `sf_` custom arguments, so SendForge's event webhook skips them. Click, open and
  subscription tracking are off per message so pay links are never rewritten.
- Optional overrides:
  - `MHB_SITE_URL` (default `https://myhomebuilderllc.com`), used for links in emails the webhook sends
  - `MHB_ALLOWED_ORIGINS` (default the apex and `www` origins)
  - `MHB_ADMIN_EMAIL` (default `mb@myhomebuilderllc.com`)
  - `MHB_EMAIL_FROM`, `MHB_EMAIL_CLIENT_FROM` and `MHB_EMAIL_REPLY_TO`

`ADMIN_WRITES_ENABLED=false` pauses admin changes here too; sign-in and viewing keep working.

## Data

`20260925_create_myhomebuilder_portal.js` adds `mhb_*` tables only, with no foreign keys
to the account tables. Each record keeps its full JSON in `data`; the columns beside it are
for lookups and uniqueness (invoice numbers, share-link tokens).

- Uploaded documents, signature images and signed PDFs are stored in `mhb_files` (up to
  20 MB each).
- Invoice numbers come from `mhb_counters` and are unique across all client portals.
- Automatic emails (receipts and builder notices) are claimed in `mhb_sent_emails` before
  sending, so a payment produces one receipt however many times Stripe delivers the event.
  If SendGrid fails, the claim is released and the webhook answers 500, so Stripe retries.
  With a webhook configured, only the webhook sends payment emails; the client's return
  from Checkout records the payment for the page it lands on.
- Rate limits are kept in `mhb_rate_limits`:
  - 20 sign-in or admin-code attempts and 120 form posts per visitor address per minute
  - 3 admin code requests per address and 12 overall per 10 minutes

## Tests

`test/myhomebuilder-portal.test.js` runs the handler and the Express router with the real
migration on PGlite, with SendGrid and Stripe faked at `fetch`.
