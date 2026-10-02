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
- `MHB_CLIENT_PORTAL_PASSWORD`: the Muskegon Addition client's first project login. Portals
  created in the admin panel store PBKDF2-hashed logins in `mhb_clients`. The first time the
  admin panel opens, Muskegon's login is stored the same way (hash, sealed copy; activity
  `client.login-normalized`), and after that this variable is not read.
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
  debit card, Money order, or Other with a typed method, plus the date received and optional
  notes (`note`, shown to the admin only). Payments recorded before notes may carry a reference
  in their label ("Check #1042"); changing such a payment keeps it.
  - A paid invoice's recorded payment can be corrected (method, date, notes) or marked
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
- A quote or invoice can go to another project from its admin page (Another project, shown when
  there is another project).
  - **Copy** opens that project's new quote or invoice editor, filled in
    from it. It is reviewed and posted there with its own number and link. A due date that has
    already passed is left blank.
  - **Send** moves one entered in the wrong project. It keeps its number
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
  - and failed sign-ins in a row block an address (see Sign-in protection)

## Sign-in protection

`guard.js`, migration `20261012_myhomebuilder_portal_login_guard.js` (`mhb_login_guard`).

- **What counts:** a failed sign-in from a visitor's address: a wrong client login, a wrong crew
  password, or a rejected admin code (wrong, expired, or after too many tries). The address is
  the one Cloudflare passes through the site's Function (`X-MHB-Client-Ip`); an IPv6 address
  counts by its /64 network, which one household or phone holds.
- **Blocks:** the 5th failure in a row blocks the address for 20 minutes, the 10th for 60 minutes
  and the 15th for good. A successful sign-in from it starts the count again.
- **While blocked:** the client login, the crew login, the admin code and admin code requests from
  it answer "Sign-in is paused" (429, with Retry-After) or, for good, "Sign-in is blocked" (403)
  without checking anything, so its tries cannot use up the admin's live codes either. Sessions
  already open keep working, and nothing else in the portal is closed to it.
- **Blocked sign-ins** (`/clients/admin/blocked`, in the admin panel's footer, with how many are
  blocked) lists each address with its count, its block and its last failure (time and which
  sign-in), marks the admin's own address, and has **Unblock** (or **Clear count**).
- Each block and unblock is in the activity log.
- Cloudflare does not do this for the portal: its rate limiting counts requests, not failed
  sign-ins, and does not block for good. The 20-a-minute limit above still applies first.

## Export Client to PDF

`export.js`. **Export Client to PDF** sits at the very bottom of a client portal's page, and in the
right-click menu of a client portal or project. It opens a popup that asks what goes in, then
downloads `<client portal> - Project Breakdown <date>.pdf` (`GET
/clients/admin/clients/<slug>/export`). Without scripts the link downloads the full breakdown.
From a project it exports the whole client portal; a portal in the archive exports with all its
projects. Each export is in the activity log.

- **The breakdown:** the business's letterhead (the MB mark, address and license), the client
  portal's name and site, key figures, a table of its projects, and then a page for each project:
  its work (each invoice's and quote's lines), its photos, and the figures below. Every page has
  the business and page numbers at the foot. Quotes made into invoices are left out (their
  invoice carries the work), as are void ones and projects in the archive.
- **Costs, profit and payments** (on unless unticked): for investors. It adds invoiced, paid and
  outstanding, gross expenses (job costs, from each job book), gross profit and margin, gross
  expenses by category as bars, each project's payments and itemized expenses. Unticked, for a
  potential client, the PDF shows each project's work and its price (its invoices' total), and
  nothing about payments, balances, costs or profit.
- **Photos** (on unless unticked): up to six per project, those its client portal shows, JPEG and
  PNG, with their notes and dates. They go in as stored, at most 15 MB of them per PDF so it can
  be emailed.
- Client emails, logins, documents and the admin's notes are never in it. Text in pdfkit's own
  fonts (no fetches); characters those fonts lack come out without accents or as "?".

## Projects on the admin panel

- **Add a client portal** is a bar at the top of the admin panel. Click it to open the fields and
  click outside it, or its −, to fold it again. A project is named, not given an id: its id (for
  addresses and records) is made from the name, with -2, -3 and so on when the name is taken.
- **The project login is optional.** A project created without one is **admin only** (shown as
  "Admin only" in the list). It is not client facing until the selected project's **Client
  login** field is saved. Saving a new login there replaces the old one. A client portal can hold
  several projects under its one login (see Client portals and their projects).
- **The client login shows in plain text** in that field, so a client's access is never lost.
  Besides its hash, each login is kept sealed in `mhb_secure` (`client-login:<slug>`, secure.js,
  AES-256-GCM). A login saved before this is not on file: the field asks for it again. The
  Muskegon project's login, first set in Render, is stored like the others (see
  `MHB_CLIENT_PORTAL_PASSWORD`), so it shows and changes here too.
- **Add a client portal** also takes the job site address, and at its very bottom **Display all
  data to client portal (read only)**.
- **Display all data to client portal (read only)**, also at the very bottom of each project,
  makes the client portal a read-only view of the whole job:
  - The client sees its quotes and invoices (with invoiced, paid and outstanding) and its
    **Financials**: gross income, gross expenses, gross profit and each expense, from the job book.
  - Nothing can be done: paying, accepting a quote, uploading and documents are refused.
  - Documents read "Document view disabled for completed projects".
  - Public quote and invoice links are not affected.
- The selected project's **Client email**, **Job site address** and **Client login** fold under
  the project's name (a click on it opens them), and each saves with the disk button on its left.
- **The project's panel**, under its name: **Quote**, **Invoice**, **Purchase** (Add expense) and
  **Payment** (Add payment), then one-line headings that open on a click:
  - **Ledger:** the project's full book (`books.js` `jobBook`), oldest first: each invoice's
    income and each cost, with the gross profit after each, then the totals, and its Job book link
    (periods and the download).
  - **Invoices** (open to start): its quotes and invoices. Clicking anywhere on a row opens it.
  - **Payments:** every payment received on its invoices, newest first, by hand or through Stripe
    (less Stripe refunds), with its notes and the total received.
  - **Purchases:** its expenses (see Job expenses).
  - **Documents**, with **Upload Document** folded at their foot.
  - Each one stays open or folded as it was left, in that browser (`localStorage`).
- **No dropdown arrows** anywhere in the portal: a box that opens a list when clicked is the menu.
- **The quote and invoice editor** has no Cancel (the project's name above the heading goes back).
  - **Templates**, beside a new quote or invoice's heading, opens the chosen template as soon as it
    is picked.
  - **Notes and terms** has **Use template** to its right: a saved one fills the box, and **Create
    new** names what is typed, saved as a notes and terms template when the form is posted (a name
    already in use takes the new text). They share `mhb_templates`, marked `type: "notes"`, and
    the Templates page lists them apart, to delete.
  - **Save as template**, under Add another payment, opens the template's name; posting with a
    name saves the quote or invoice as a template too.
- **A quote's or invoice's page** has its actions beside the heading (a quote's **Create
  invoice** or its invoice, **Edit**, **Save as template**, **Mark void** while allowed, and the
  trash button, whose page confirms what goes with it). Beside the document (above it on a phone)
  are one-line folds, each with a short status at its end:
  - **Payment** (open to start on an open invoice): payments toward the balance, with Remove,
    and Add payment ("$568.00 due"); on a paid one, its payment to change and Mark as unpaid
    ("Check · Sep 25, 2026"), or what Stripe recorded.
  - **Email** ("Sent Sep 25, 2026"), **Receipt** on a paid invoice, **Share** (its links),
    **Another project** and **History** (what happened to it, and when).
  - On a phone, action buttons keep their own widths, and the project's Quote, Invoice, Purchase
    and Payment share one row.
- The panel shows nothing about setup while everything is ready. If portal storage, file storage,
  Stripe, its webhook or email is not set up, a warning names what is missing.

## Schedule and Important notes

`team.js` (routes), `team-pages.js` (pages), `schedule.js` and `notes.js` (records). Migration
`20261008_myhomebuilder_portal_notes_schedule.js` creates `mhb_schedule` and `mhb_notes`.

- **Schedule** (`/clients/admin/schedule`) is a month calendar.
  - Each entry has: a job (a client portal, or none for a note on those days), a start and an
    optional end date, an optional time, the crew (employees and subcontractors from Labor), and
    notes.
  - A day's + opens the Add to the schedule popup for that day. Without scripts it opens a page
    for it instead. Clicking an entry opens it to change or remove.
  - Someone scheduled on two entries the same day is shown in pink on both.
  - On phones the month is a list of the days that have something on them.
- **Crew** see **Your schedule** at the top of the crew portal. It shows their own entries from
  today through the next 45 days, with the job's site address, the time and the notes.
- **Important notes** (`/clients/admin/notes`) are notes between the admin and the **team
  leaders**: crew members whose Labor profile has **Team leader** checked.
  - Team leaders see the same board in their crew portal (`/clients/crew/notes` posts). They can
    add notes and mark them.
  - Each note is marked **In progress**, **Completed** or **Contingent**; choosing its current mark
    again sets it back to open. Each change keeps who made it and when.
  - Completed notes fold under **Completed**.
  - Only the admin deletes notes.
- Adding, changing and removing schedule entries and notes is recorded in the activity log.

## Paying a bill down

An invoice can be paid over time. **Add a payment** (on the invoice's admin page, or **Payment**
beside Quote, Invoice and Purchase, which asks which open invoice) records money received outside
Stripe:

- **Toward the balance or settling it:** less than the balance due, it is a payment toward it
  (`item.installments`) and the invoice stays open, shown as Partly paid. The balance, or no
  amount given (the list's status popup), settles it (`item.payment`). More than the balance is
  refused.
- **Receipts:** each payment can email the client a receipt with what is still due.
- **What the client sees:** the invoice lists every payment and the balance due, and paying online
  charges only the balance (Stripe needs at least $0.50; less is recorded by hand). The emailed
  invoice and the lists show the balance too.
- **Correcting:** a payment toward the balance added by mistake is removed from the invoice's
  admin page while the invoice is open. Marking a paid invoice unpaid removes only the settling
  payment.
- **Limits:** an invoice with payments toward it cannot be voided, and its total cannot be edited
  below what has been paid. Deleting it deletes its payments, and they come out of the books.

- **Payments on a new invoice:** the invoice editor's **Payments** lists a deposit or earlier
  payments: amount, paid by (Other method shows when Other is chosen), received on and notes (kept
  with the payment as `note`, shown to the admin only). Add another payment adds a row; a row
  without an amount is skipped. Less than the total leaves the rest due; the total marks the
  invoice paid (the last payment settles it). More than the total is refused, keeping what was
  typed. Choosing Quote hides Payments. An existing invoice's payments are added and removed on
  its page.

## Job expenses

**Purchase** beside Quote, Invoice and Payment (`expenses.js`, migrations
`20261007_myhomebuilder_portal_expenses.js` and `20261009_myhomebuilder_portal_job_books.js`)
records a cost of that client portal's job. The form is compact: each box says what goes in it.
- **Expense** (what it was), **Paid to** and **Category**.
  - Paid to suggests everyone in Labor (and their companies), then whoever earlier expenses went to.
  - Category suggests Materials, Labor, Subcontractors, Equipment rental, Permits and fees, Land,
    House, Commercial property and Other job costs. Both take anything typed.
  - A known category posts to its account (Land 5500, House 5510, Commercial property 5520, Labor
    5000 Job labor). Any other is kept as typed and posted to Other job costs.
- The amount, the date, what paid it (a bank account from Banking, the owner's own money, or not
  paid yet), and an optional receipt (PDF or photo).

The panel's **Purchases** lists the job's expenses with their total, each with its receipt and a trash button that
asks first. **Add expense on the Books page** does the same with a job choice. With no job it is
overhead (`client_slug` empty), a typed category going to Other overhead. Clients see expenses only
on a project shown read only.

- **Books:** Dr the job cost account, tagged with the job (the Books page's Jobs table), Cr the
  bank account's books account, Owner contributions or Accounts payable. Deleting reverses it.
- **Banking:** a withdrawal of the same amount from that bank account is suggested as the expense
  (Recorded expenses). Filing it there posts nothing more, so the cost counts once; deleting the
  expense unfiles the withdrawal.

## Upload document

The client portal and the crew portal each have **Upload document** near the top and at their
documents. Clients' uploads go under Uploaded by you. Crew choose what it is: a certificate of
insurance (Insurance), a license or certification (Onboarding), or other.

## Photo gallery

Clients, crew and the admin add photos with a note to a project's gallery. Migration
`20261010_myhomebuilder_portal_photos.js` creates `mhb_photos`; each photo's file is in `mhb_files`
under `photos/<slug>/<id>/<name>`.

- **Adding:** several photos at once share one note (up to 500 characters). Only JPEG, PNG, WebP and
  GIF, up to 20 MB each, are kept: the file's first bytes decide, not the type the browser sends. If
  any file in a batch is not an image, none is added. Up to 20 photos per upload. The whole request
  is also capped by the router's body limit (`MAX_BODY_BYTES` in `index.js`, 21 MB today).
  - Client: **Gallery** beside **Upload document** (`POST /clients/photos`). Not on a read-only
    project.
  - Crew: **Add photos** in the crew portal (`POST /clients/crew/photos`), to one of the active
    jobs. Crew see the photos they added, with their notes, and open only those
    (`/clients/crew/photos/<id>`).
  - Admin: **Gallery** on the project's panel, a one-line fold under Documents with its photo
    count (`POST /clients/admin/clients/<slug>/photos`, Add photos folded at its foot), with
    every photo, its note, who added it and when. Returning to `#gallery` opens it.
- **What the client sees:** the photos shown appear at the very top of the client portal home,
  above Project resources, each opening the full image (`/clients/photos/<id>`, served inline).
  Nothing renders when none are shown. A read-only project still shows them.
- **Shown or hidden:** each photo starts shown. On the panel, each has a **Shown** checkbox, and one
  checkbox, **Show photos in the client portal** (`photosVisible` on the project, on by default),
  shows or hides them all. Both save as soon as they are clicked. A hidden photo is dimmed on the
  panel, and its address answers 404 to the client.
- **Deleting:** the trash button asks first, then removes the photo and its file.
- **The date:** each photo on the panel shows who added it and its date, the day it was added until
  the admin changes it. A click on the date opens **Photo date** (a popup; without scripts the
  page `/clients/admin/clients/<slug>/photos/<id>/date`) to change it, or **Delete date** (or save
  it empty) so the photo shows no date. The deleted date's spot still opens the popup, and names
  itself (Add date) only under the pointer. The date is `date` on the photo: missing means the
  day it was added, `""` means none. Crew see the same date on their photos; clients see none.
- Adding, showing, hiding, dating and deleting photos are recorded in the activity log.

## Client portals and their projects

The admin panel's list (the client portal screen) shows client portals. A client portal can hold
projects: each project names its client portal in `parentSlug`, one level deep. A project keeps
everything of its own (quotes, invoices, expenses, documents, gallery, site address, read only),
and its `label` (worked out on reading, never saved) puts the client portal's name first, as in
"Smith Residence · Deck", wherever jobs are listed: Books, Labor, Banking, the schedule, Documents,
the crew portal and Another project.

- **A client portal's page** starts with **Add project**, then its projects (the client portal
  itself first, then the projects in it by name; with more than one they fold under the client
  portal's name, opening on a click), then **Show finances for all projects under this client**,
  then the panel of the project open, with its **Ledger**. The list on the left keeps its client
  portal chosen and says how many projects it has.
- **Add project** takes a name and a job site address (the client portal's to start). The project
  starts with the client portal's emails.
- **Show finances for all projects under this client** (folded until opened) lists each project's
  date (its earliest invoice), invoiced, paid and outstanding (as its list totals them) and its gross income, gross expenses and
  gross profit (as its job book totals them, `books.js` `jobTotals`), then all projects together.
- **The right-click menu.** A right-click on a client portal in the list, or on a project at the
  top of its page (a long press on a phone), opens a menu (`site/clients/portal/billing.js`):
  - **Send to archive** (see The archive)
  - **Inside another portal:** a popup asks which client portal. The client portal (with every
    project in it) or project becomes a project of that client portal (`/inside`).
  - **Make it its own client portal**, for a project (`/own`)

  The same actions sit folded under **Archive or move** at the bottom of each project's panel,
  for a page without scripts. On a phone the menu opens beside the finger, and the tap that ends
  the long press neither follows the link nor picks a choice.
- **Logins:** a project has no login of its own; it uses its client portal's. One login opens the
  client portal (first) and every project in it, and the client switches between them at the top
  of their portal (`/clients/switch`). A login saved on a project's panel is its client portal's.
  The Muskegon project moves like any other once its login is stored in the portal (the first
  admin panel visit); its project files open for whichever login opens it.
  - Put inside another portal, a portal or project drops its own login (hash and sealed copy) and
    uses its new client portal's. Made its own client portal, a project has no login (admin only)
    until it is given one.
  - Either way the move is dated (`loginChangedAt`), and a client session that began before it no
    longer opens that project, so a move never carries an old sign-in into another client's
    projects.
- **Portals that shared a login before projects existed** (the old Projects under this login
  checkboxes: a `loginGroup` with one hash) keep sharing it: the login opens the first of them by
  name, the client switches between them, the list shows "Shared login", and a new login saved on
  any of them changes it for all. Put inside another portal, one leaves that login; a group left
  with one client portal ends.
- Projects added, moved, made their own client portal, archived and restored are recorded in the
  activity log.

## The archive

**Send to archive** (the right-click menu, or Archive or move) takes a client portal, with the
projects in it, or one project, out of use: `active: false` and `archivedAt`, with `archivedWith`
on the projects that went with their client portal.

- **Off the client portal screen**, and out of every job list: Books, Documents, Labor, Banking,
  the schedule, the crew portal and Another project. Nothing more is done to it until it is
  restored.
- **Out of the books entirely:** the Books page's figures, jobs, ledger and its download, account
  balances and the balance check skip every journal entry tagged with it. The entries stay, so
  restoring it brings it all back. The activity log is not filtered; it is the permanent record.
  Money that moved through shared accounts for it (its Stripe payments, bank filings, crew costs)
  leaves those accounts' balances on the Books page with it.
- **Its client cannot open it:** its login opens nothing (a project's client portal opens without
  it), and it leaves the client's switcher. Public quote and invoice links keep working.
- **Archive** (`/clients/admin/archive`, in the footer of the admin panel, with how many are
  there) lists archived client portals (with the projects that went with them) and projects
  archived on their own. Each opens on the admin panel, marked as in the archive, with **Restore**.
- **Restore** brings back the client portal with the projects that went with it; a project
  archived on its own before stays archived. A project inside a client portal that is in the
  archive too waits for the client portal.

## The Back button

Every form answers with a redirect when it succeeds. A page that answers a form directly (a problem
to fix, or a step such as "code sent") loads `/clients/portal/history.js` (its policy allows
`script-src 'self'`), which turns its place in the browser's history into a plain visit, so Back
never asks to resubmit. Opened with GET, a form's address redirects to the page it belongs to
(`pageFor` in handler.js) instead of answering 405.

## Books

The admin panel's **Books** page (`/clients/admin/books`, `books.js`) holds the portal's
bookkeeping. Migration `20260930_myhomebuilder_portal_books.js` creates its tables. Client portals
and projects in the archive are left out of it entirely (see The archive).

- **Jobs** is the jobs ledger, one job per row: gross income (income accounts tagged with the
  job), gross expenses (expense accounts tagged with it, except Stripe fees and dispute losses)
  and gross profit, with the total for all jobs. Each job opens its **job book**
  (`/clients/admin/books/jobs/<slug>`, `jobBook`).
  - The job book shows its income and expenses, each invoice, expense, labor entry or bank
    transaction once as it stands now (edits and reversals netted).
  - It also shows the expenses by category, and the gross figures for any period.
- **Overhead** breaks down what no job carries, by category (an expense's typed category, or the
  account's name), then gross profit, other income, overhead and **net profit**.

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
- **The activity log cannot be changed.** Invoices and the books can be edited; the log is how
  anything done is traced, so it only grows. Migration
  `20261006_myhomebuilder_portal_activity_seal.js` makes Postgres refuse any UPDATE, DELETE or
  TRUNCATE of `mhb_activity`, and seals each entry as it is added: `chain_seq` numbers entries in
  order and `chain_hash` is the SHA-256 of the previous seal and the entry's fields
  (`mhb_activity_row_hash`). The Books page re-checks every seal (`verifyActivityLog`) and says
  whether all entries check out, which entry first stopped matching if one was changed or removed
  while the protection was off, and whether the protection is on. The activity download includes
  each entry's number and seal, so a saved copy can later be compared with the log.
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
  - **installment:<id>:** a payment toward the balance recorded by hand (Add payment), received
    outside Stripe to receivable, on its own date. One part per payment; removing one reverses it.
  - **payment:** Stripe balance, or received outside Stripe, to receivable, on the payment date.
    After payments toward the balance, it is the rest: what settled the invoice.
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

## Live material designer

Every project has the live material designer at `/clients/designer/` (`designer.js`, migration
`20261011_myhomebuilder_portal_renders.js`).

- **The app:** a static build from the separate `build-material-render-from-image` repository
  (`site/clients/designer/`). For a signed-in client (their project) or the admin
  (`?project=slug`), the backend answers with an `X-MHB-Asset` grant and the Function serves the
  file. Its policy adds `'wasm-unsafe-eval'`: the surface model runs on WebAssembly.
- **Renders** (`mhb_renders`): the admin uses **Load render** in the designer (Designer link on
  the project panel).
  - The admin's browser finds the surfaces, the camera and each surface's plane; the admin
    confirms the labels (floor, walls, cabinets…); and the designer saves three things: the
    render PNG, its surface map PNG and the package.
  - The renders API is under `/clients/designer/api/`:
    - `scenes`: the project's renders, plus Muskegon's two calibrated rooms;
    - `renders/<id>/image` and `renders/<id>/labels`;
    - for the admin only: `renders` POST (add), `renders/<id>` POST (save again) and
      `renders/<id>/delete`.
  - The package is checked against the PNG sizes and the known categories.
  - The admin write switch pauses these changes too, and each change is in the activity log.
- **For clients:** a project with renders shows **Live material designer** under Project
  resources, and the client tries finishes on them. The old Muskegon address
  (`/clients/muskegon-addition/material-render/`) redirects to the designer.

## PDF signing library

`vendor/pdf-lib.js` is pdf-lib 1.17.1 bundled into one ES module, so the module adds no npm
dependency. It was built with
`esbuild node_modules/pdf-lib/es/index.js --bundle --format=esm --platform=neutral --main-fields=module,main --minify --legal-comments=eof`.
To upgrade, rebuild it the same way from the new pdf-lib version and run the tests.

## Tests

`test/myhomebuilder-portal.test.js` runs the handler and the Express router with the real
migration on PGlite, with SendGrid and Stripe faked at `fetch`.
