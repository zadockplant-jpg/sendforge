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

## Admin sign-in

"Administrator access" (on the login page) and "Admin" (inside a portal) email a 6-digit
code to the admin address. A code expires in 10 minutes, works once, and works on any
device. It is not tied to the page that asked for it.

- **Entering a code:** another device opens `/clients/admin/code` ("Enter a code" on the
  login page) and types it there. The code email names that page too.
- **How a code is checked:** the entered code is checked against every live code
  (`mhb_admin_challenges`).
- **Limits:** each attempt counts against all live codes (`claimAdminAttempt`), so no code is
  tried more than 5 times, the same as when a code was bound to one page. A code past its
  tries is removed.
- A sign-in lasts 24 hours. Client project logins are separate and unchanged.

## Data

`20260925_create_myhomebuilder_portal.js` adds `mhb_*` tables only, with no foreign keys
to the account tables. Each record keeps its full JSON in `data`; the columns beside it are
for lookups and uniqueness (invoice numbers, share-link tokens).

- Every quote and invoice prints the business address (6749 Fulton St E, Ste A #2333,
  Ada, MI 49301) and "License # 242601116" in its header. Its footer reads
  "$1,000,000 liability insurance provided by Next First Insurance Agency Inc". These are
  constants at the top of `pages.js`, worded exactly as the owner gave them.
- The Ada address is a digital mailbox, so an open invoice's payment panel (on the public
  invoice link and in the client portal) also has an "I'm paying by check" button. It reveals
  the check mailing address, 5899 1/2 White Rd, Muskegon, MI 49442, with payable-to and memo
  guidance. It is a native `<details>` disclosure and needs no script.
- Payments received outside Stripe are recorded with a "Paid by" choice. The choices are
  Check, Cash, Zelle, Venmo, Cash App, PayPal, Bank transfer (ACH), Wire transfer, Credit or
  debit card, Money order, or Other with a typed method, plus an optional reference.
  - A paid invoice's recorded payment can be corrected (method, reference, date) or marked
    unpaid. Marking it unpaid reopens it and forgets its receipt and payment notice, so a
    later payment sends fresh ones.
  - Stripe payments keep what Stripe recorded.
  - Paid invoices stay editable (title, lines, notes). A payment recorded by hand is the
    invoice paid in full, so its amount follows the edited total. A Stripe payment keeps the
    amount Stripe charged.
- Each project (client portal) keeps a list of up to 10 email addresses (`emails` in its
  JSON).
  - Every quote, invoice and receipt for the project is addressed to the whole list as one
    email, with every address in To.
  - The Send to fields are filled in from the list. Any new address the admin emails from the
    project (quote, invoice or receipt) is added to it. Addresses are removed on the client
    panel, where the list can also be typed directly.
  - Stripe Checkout is given the first address.
  - The admin email fields take several addresses, separated by commas, semicolons, spaces or
    lines, or pasted as "Name <address>". The site's `billing.js` shows each address as a
    removable chip and flags an incomplete one before sending. A problem found on the server
    is named on the page, which keeps what was typed.
  - Migration `20260927_myhomebuilder_portal_project_emails.js` made each saved single
    `email` a list. A project with none started with the addresses its most recent quote or
    invoice was emailed to. The migration also set hand-recorded payment amounts to their
    invoice totals.
- A quote or invoice can go to another project from its admin page ("Another project" card).
  - **Copy to another project** opens that project's new quote or invoice editor, filled in
    from it. It is reviewed and posted there with its own number and link. A due date that has
    already passed is left blank.
  - **Send to another project** moves one entered in the wrong project. It keeps its number
    and link. A quote and the invoice made from it move together.
  - The moved item's sent-email records (keyed by project) move with it, so a receipt is not
    sent twice.
  - An unpaid invoice's open Checkout is closed, and paying starts a new one. A bank payment
    still processing blocks the move.
  - Stripe events and Checkout returns find an invoice by id alone. A payment through a
    Checkout started before a move is still recorded, on the new project.
- Every address a quote, invoice or receipt is emailed to is kept in `mhb_recipients` with
  its last send; builder notices and admin codes are not. The admin panel's email fields
  offer them as a pick list, newest first, eight rows tall with the rest scrolling. The list
  leaves out addresses already in the field. It is drawn by the site's `billing.js`; without
  scripts it is a plain `<datalist>`. Migration `20260925_myhomebuilder_portal_recipients.js`
  loaded the addresses emailed before it.
- Uploaded documents, signature images and signed PDFs are stored in `mhb_files` (up to
  20 MB each).
- Invoices are numbered 1, 2, 3 … with no prefix, dash or leading zeros, and quotes have
  their own 1, 2, 3 … sequence. Wherever a number appears on its own, it is labeled
  "Invoice 12" or "Quote 3". Migration `20260925_myhomebuilder_portal_plain_numbers.js`
  rewrote earlier numbers (INV-0012 became 12).
  - Each quote and invoice has a date (`issuedOn`, the editor's Date field, shown as
    "Issued"). It defaults to the day it is entered; ones saved before dates existed use the
    day they were created.
  - Invoice numbers follow those dates across every client portal. Invoices with the same
    date are numbered in the order they were entered.
  - `renumberInvoices` re-sorts them after an invoice is added, re-dated or deleted, so
    numbers can move, and a quote made into an invoice keeps naming it. Emails already sent
    keep the number they were sent with.
  - An open Checkout is reused only while it shows the current number. Saves of a whole
    item keep the number the row has, so a save made while numbers move cannot restore an old
    one.
  - Quotes keep their `mhb_counters` sequence, in the order entered.
- Only an open invoice's email has a Pay button and pay link.
  - An invoice emailed after it is paid says so: "(paid)" in the subject, then the paid date,
    method and balance due, with a "View the paid invoice" button.
  - One emailed while a bank payment is processing says that instead.
- A quote or invoice can be deleted from its page (Delete invoice / Delete quote).
  - A confirmation page first says what goes with it: a recorded payment, a link already
    emailed, the quote or invoice linked to it.
  - Deleting removes it and its sent-email records. An unpaid invoice's open Checkout is
    closed, and a bank payment still processing blocks the delete. The linked quote can be
    invoiced again.
  - If Stripe is later paid through a deleted invoice's Checkout, the builder is emailed once
    ("Stripe payment for deleted Invoice N"), since the portal has nothing to record it on.
- Each project's list of quotes and invoices in the admin panel ends with its totals.
  - **Invoiced:** every invoice not voided.
  - **Paid:** what was recorded as paid.
  - **Outstanding:** the sum of each invoice's balance due.
  - Quotes are left out. Clients' portals do not show these totals.
- Automatic emails (receipts and builder notices) are claimed in `mhb_sent_emails` before
  sending, so a payment produces one receipt however many times Stripe delivers the event.
  If SendGrid fails, the claim is released and the webhook answers 500, so Stripe retries.
  With a webhook configured, only the webhook sends payment emails; the client's return
  from Checkout records the payment for the page it lands on.
- Rate limits are kept in `mhb_rate_limits`:
  - 20 sign-in or admin-code attempts and 120 form posts per visitor address per minute
  - 3 admin code requests per address and 12 overall per 10 minutes

## PDF signing library

`vendor/pdf-lib.js` is pdf-lib 1.17.1 bundled into one ES module, so the module adds no npm
dependency. It was built with
`esbuild node_modules/pdf-lib/es/index.js --bundle --format=esm --platform=neutral --main-fields=module,main --minify --legal-comments=eof`.
To upgrade, rebuild it the same way from the new pdf-lib version and run the tests.

## Tests

`test/myhomebuilder-portal.test.js` runs the handler and the Express router with the real
migration on PGlite, with SendGrid and Stripe faked at `fetch`.
