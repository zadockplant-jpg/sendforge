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
  `2024-06-20` (`stripe.js` `WEBHOOK_EVENTS`):
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `checkout.session.async_payment_failed`
  - `charge.refunded` and `charge.refund.updated`
  - `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`,
    `charge.dispute.funds_withdrawn` and `charge.dispute.funds_reinstated`

  In the myhomebuilder repository, `npm run setup:portal` adds any of these that an existing
  webhook does not send yet, keeping its signing secret. The endpoint ignores Checkout sessions
  and charges that are not portal invoices. SendForge's and JayJe's webhooks are separate and
  unchanged.
- **What the webhook trusts.** The signature proves an event came from Stripe; the webhook then
  reads Stripe's own copy of the Checkout session (or the charge, its refunds and the dispute)
  and acts on that, so a late, repeated or out-of-order event changes nothing. If Stripe cannot
  be reached it answers 500 and Stripe retries. A Checkout pays an invoice only for the total it
  was opened with: a payment of any other amount or currency leaves the invoice open, is kept as
  unapplied, and emails the builder once ("Stripe payment for Invoice N does not match its
  total"). Each event handled is kept by id in `mhb_stripe_events`.

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
  - `MHB_ADMIN_EMAIL` (default `mb@myhomebuilderllc.com`): builder notices, and where clients'
    replies go
  - `MHB_ADMIN_CODE_EMAIL`: where admin sign-in codes go instead of `MHB_ADMIN_EMAIL`, so only
    the owner's inbox opens the admin panel. The sign-in page shows it masked.
  - `MHB_EMAIL_FROM`, `MHB_EMAIL_CLIENT_FROM` and `MHB_EMAIL_REPLY_TO`
  - `MHB_DATA_KEY` (32 random bytes, base64): the key for crew paperwork (see Labor). Without
    it, a key derived from `MHB_SESSION_SECRET` is used.

`ADMIN_WRITES_ENABLED=false` pauses admin changes here too; sign-in and viewing keep working.

## Admin sign-in

"Administrator access" (on the login page) and "Admin" (inside a portal) email a 6-digit
code to `MHB_ADMIN_CODE_EMAIL`, or to the admin address when that is not set; the page shows
the inbox masked. A code expires in 10 minutes, works once, and works on any
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

## Books

The admin panel's **Books** page (`/clients/admin/books`, `books.js`) holds the portal's
bookkeeping. Migration `20260930_myhomebuilder_portal_books.js` creates its tables.

- **Activity log** (`mhb_activity`) records everything done in the portal, newest first:
  - the admin's actions, with the address they came from: sign-ins and admin codes (requested
    and rejected), client portals and their emails, quotes and invoices (created, edited,
    emailed, voided, moved, deleted), payments recorded, corrected or removed, receipts,
    templates and documents
  - clients' actions: sign-ins, quotes accepted, uploads and signatures, Stripe Checkout opened
  - Stripe's events: payments (with Stripe's fee), bank payments started or failed, second
    payments for a paid invoice, payments for a deleted invoice or for an amount the invoice
    does not total, refunds (and refunds that failed), and disputes opened, updated, won or lost
  - the portal's own: invoice numbers re-sorted by date
- **Journal** (`mhb_journal_entries` and `mhb_journal_lines`) is double-entry: each entry's
  debits equal its credits, and each line is one or the other. The chart of accounts
  (`mhb_accounts`):
  - 1100 Accounts receivable
  - 1200 Stripe balance
  - 1250 Funds held in disputes
  - 1300 Payments received outside Stripe
  - 2100 Unapplied payments
  - 4000 Sales
  - 4200 Refunds
  - 6100 Stripe fees
  - 6200 Dispute losses and fees
  - 1000 Business checking, 2000 Accounts payable, 2300 Wages payable, 5000 Job labor,
    5100 Subcontractors and 6450 Shop and overhead labor (added for Labor)

  Migration `20261003_myhomebuilder_portal_stripe_events.js` added 1250, 4200 and 6200, the
  `mhb_stripe_events` table, and room for one journal part per refund.
- **How an invoice's entries follow it.** They are derived from its state (`syncInvoiceBooks`).
  After any change, the journal gets only the difference: a reversal of each part that no longer
  matches, on that part's own date, and the part as it is now. The parts:
  - **issue:** receivable to sales, on the invoice date.
  - **payment:** Stripe balance, or received outside Stripe, to receivable, on the payment date.
  - **fee:** Stripe fees to Stripe balance.
  - **refund:<id>:** refunds to Stripe balance, on the refund's day, one part per Stripe refund.
    A refund that fails or is canceled comes back off. The invoice's payment keeps each refund
    (`payment.refunds`), and the admin page and the client's invoice show them.
  - **dispute:** funds held in disputes (what Stripe withdrew) and dispute fees to Stripe balance,
    on the day it opened; **dispute-close**, when it closes: won, back to the Stripe balance
    with any returned fee; lost, to dispute losses. The payment keeps it as `payment.dispute`.

  A voided or deleted invoice's issue is reversed. A deleted invoice's hand-recorded payment goes
  with it, but its Stripe payment stays, moved to unapplied payments, since Stripe holds the
  money. Money Stripe took with no invoice to apply it to (a second payment, or a payment for a
  deleted invoice, or one for an amount the invoice does not total) is posted to unapplied
  payments, once per Checkout: (kind, external id) is unique. A refund of such money comes out
  of unapplied payments, once per refund.
- **Recording** happens in one transaction per event, activity and journal together.
  - It never fails the action it follows: an error is logged instead.
  - The page's **balance check** (`checkBooks`) compares every invoice with its entries. It
    lists any mismatch, including deleted invoices still holding sales or receivable.
  - **Post corrections** (`correctBooks`) posts what is missing, with an activity row. Nothing
    is ever deleted from the journal.
- **The page** has these parts:
  - Filters: one client portal or all, and a date range, with quick periods.
  - Totals: invoiced, received, Stripe fees, refunds, outstanding and unapplied, and money
    held in disputes and approved labor not paid yet (owed to crew) when there is any.
  - Jobs: each client portal's invoiced amount, labor, subcontractors, other job costs and
    profit in the period.
  - The ledger, newest first, with a running amount owed.
  - Account balances (a trial balance).
  - The activity log.

  Two CSV downloads (`ledger.csv`, one row per debit or credit, and `activity.csv`) follow the
  same filters. A cell that a spreadsheet would run as a formula (starting `=`, `+`, `-`, `@`)
  is prefixed with an apostrophe.
- **Opening:** the first time the books are used, invoices saved before them get opening entries
  (source `opening`), and every quote and invoice gets its history in the log from its saved
  fields (`data.fromRecords`). The `books-opened` row in `mhb_counters` marks that this is done.
- **The business bank account, later:** entries carry `source`, `external_id` and `labels`, and
  the chart takes new accounts. Bank transactions can join the journal (source `bank`, their
  transaction id as the external id, posted once), then be labeled and categorized against
  expense accounts and matched to Stripe payouts.

## Labor

The admin panel's **Labor** page (`/clients/admin/labor`) and the **crew portal**
(`/clients/crew`), in `crew.js` (routes), `labor-pages.js` (pages), `labor.js` (records and
crew sessions), `forms.js` (paperwork), `waivers.js` (lien waivers) and `secure.js`
(encryption). Migration `20261004_myhomebuilder_portal_labor.js` creates `mhb_workers`,
`mhb_labor`, `mhb_secure` and `mhb_settings`.

- **Employees and subcontractors.** The admin adds each one as an employee (W-2) or a
  subcontractor (1099), with an email, and an hourly rate and start date for employees. They get
  an emailed link to choose a password (it works once, for 7 days); **Send the invite again** or
  **Forgot your password?** sends a new one (2 hours once a password is set). They sign in at
  `/clients/crew` with their email and password: their own session cookie
  (`__Secure-mhb_crew_session`, 12 hours), which opens nothing else. **Deactivate** signs them
  out everywhere and stops sign-ins; a password change also ends older sessions.
- **Hours and invoices.** Employees send hours (a date, a job or shop, and hours like 8, 7.5 or
  7:30). Subcontractors send invoices (number, date, amount, the work's last day, what they
  provided, and the invoice file if they have one). An invoice on a job then asks for Michigan's
  **conditional lien waiver** (Construction Lien Act, MCL 570.1115(9), word for word): partial,
  or full when they mark it their final invoice for the job. It takes effect only when the
  amount is paid. The signed waiver is a PDF kept with the invoice, and the builder is emailed.
  The waiver prints the job site address saved on the client's panel (**Job site address**).
- **Approving.** The Labor page lists what is waiting. The admin picks the job (or shop) and, for
  hours, the cost (filled in at the employee's rate), then **Approve**, or **Return** with a note
  the crew member sees. Approved work is owed until **Mark paid** (a popup: how it was paid,
  reference and date); **Undo approval** and **Mark unpaid** step back.
- **Books.** Each approved entry posts **cost** on its work or invoice date: Job labor (hours) or
  Subcontractors (invoices), or Shop and overhead labor without a job, owed to Wages payable or
  Accounts payable, tagged with the job. **paid** clears it from Business checking. Both follow
  the entry's state like an invoice's parts, and the balance check covers them.
- **Paperwork**, filled out and signed in the crew portal on the official forms:
  - employees: Form W-4 (2026), Form MI-W4, Form I-9 Section 1 and an optional direct deposit
    authorization
  - subcontractors: Form W-9, plus an uploaded certificate of insurance
  The admin completes **Section 2 of the I-9** after examining the documents, and marks the
  Michigan new hire report done (within 20 days of the start date, www.mi-newhire.com).
  Answers, signatures and signed PDFs are encrypted (AES-256-GCM) in `mhb_secure`; each blob
  names the key that sealed it (`data` for `MHB_DATA_KEY`, `session` for the key derived from
  `MHB_SESSION_SECRET`). Do not change or remove either once paperwork is stored. Filling a
  form out again starts without Social Security, tax id or bank numbers. The admin's downloads
  are logged. The employer details printed on the forms are saved on the Labor page.
- **Documents for crew** (agreements, onboarding, insurance, other) are shared from the crew
  member's page, can be signed like client documents, and live under the portal id
  `crew:<worker id>`, apart from the client portals.

## Banking

The admin panel's **Banking** page (`/clients/admin/bank`, `bank.js` and `bank-pages.js`).
Migration `20261005_myhomebuilder_portal_banking.js` creates `mhb_bank_accounts` and
`mhb_bank_transactions`, and adds the job cost, overhead, equity, other income and transfer
accounts.

- **Linking through Stripe.** **Link with Stripe** opens Stripe's hosted Checkout page in setup
  mode, asking for transactions access (Financial Connections, instant verification only), so
  the portal needs no Stripe.js or publishable key. The customer standing for My Home Builder is
  kept in `mhb_settings` (`bank`). On return the account is subscribed to transactions; Stripe
  refreshes them about once a day, up to 180 days back. The page fetches them when it opens (at
  most every 6 hours), and **Refresh** asks Stripe for a new refresh. A negative amount is money
  out. Live mode needs Stripe's Financial Connections approval
  (https://dashboard.stripe.com/settings/financial-connections); until then Stripe's error is
  shown with that link. The setup Checkout session carries no invoice, so the payment webhook
  ignores it.
- **Statements.** A CSV (a date column and an amount, or debit and credit, column), OFX or QFX
  file. Rows keep the same id when uploaded again (the bank's FITID, or a hash of the row and its
  repeat count), so overlapping statements add only what is new. Some credit card CSVs show
  money out as positive; the upload form asks.
- **Books accounts.** The first bank account posts to 1000 Business checking; later ones get
  1010, 1020... (credit cards 2010, 2020...), added to the chart with the account's name.
- **Filing.** Each transaction is filed to one of:
  - a job: Materials, Equipment rental, Permits and fees or Other job costs (5200 to 5900),
    tagged with the job, for the Books page's Jobs table
  - overhead: 6300 to 6490 (advertising, vehicles and fuel, insurance, office and software,
    phone and internet, rent and utilities, legal and accounting, licenses and dues, tools,
    bank fees, meals, travel, payroll taxes, training, repairs, other)
  - Stripe payout (1200), client payment deposited (1300, a check or cash payment recorded on
    an invoice), other income (4300), owner contribution (3000) or draw (3100), payroll run
    (2300), transfer between accounts (1900), or already in the books (posts nothing)
  - crew work of the same amount (Pay crew): approved work is marked paid from the bank; work
    already marked paid by hand is matched to the withdrawal instead. Unfiling, or Mark unpaid
    on the Labor page, puts it back.

  Money out debits what it is filed to and credits the bank's books account; money in the
  reverse. Pending transactions can be filed and post once the bank posts them; a voided one
  comes back out. Hours marked paid through payroll post no cash entry: the payroll run's
  withdrawal, filed as Payroll run, clears Wages payable.
- **Suggestions** (one click): crew work of the same amount, how the same merchant was filed
  last time, or common merchants (fuel, phone, insurance, software, advertising, bank fees,
  payroll taxes, meals, travel, Stripe payouts, check deposits). **File checked** files several
  at once (crew work is paid one at a time).
- The balance check and **Post corrections** cover filed transactions like invoices and labor.

## PDF signing library

`vendor/pdf-lib.js` is pdf-lib 1.17.1 bundled into one ES module, so the module adds no npm
dependency. It was built with
`esbuild node_modules/pdf-lib/es/index.js --bundle --format=esm --platform=neutral --main-fields=module,main --minify --legal-comments=eof`.
To upgrade, rebuild it the same way from the new pdf-lib version and run the tests.

## Tests

`test/myhomebuilder-portal.test.js` runs the handler and the Express router with the real
migration on PGlite, with SendGrid and Stripe faked at `fetch`.
