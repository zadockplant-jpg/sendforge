# SendGrid referral-email launch

The SendForge backend sends account and referral email through the SendGrid
Mail Send API. Referral invites also use SendForge's signed unsubscribe link,
a dedicated SendGrid unsubscribe group, exact event correlation, signed Event
Webhook verification, delivery-state tracking, bounce/spam suppression, sender
and destination rate limits, and an explicit recipient-consent attestation.

## 1. Authenticate `sendforge.app`

In SendGrid, open **Settings → Sender Authentication → Domain
Authentication** and authenticate `sendforge.app`.

- Choose Cloudflare as the DNS provider.
- Keep automated security enabled.
- Add every CNAME record exactly as SendGrid provides it.
- In Cloudflare DNS, make SendGrid authentication records **DNS only**, not
  proxied.
- Return to SendGrid and wait until the domain shows **Verified**.

Domain authentication is the production requirement. Single Sender
Verification is useful only as a temporary test.

The From address used by this service is `referrals@sendforge.app`, so the
authenticated domain must match `sendforge.app`.

## 2. Create the referral unsubscribe group

In SendGrid, open **Marketing → Unsubscribe Groups**, create:

- Name: `SendForge referral invitations`
- Description: `Optional promotional referral invitations from SendForge users`

Copy the numeric group ID. Do not reuse this group for password resets, email
verification, account recovery, or admin security mail.

## 3. Create the API key

In SendGrid, open **Settings → API Keys** and create a restricted key named
`SendForge production mail`. Grant only the Mail Send permission required by
the backend. Copy the key once and store it only in Render.

## 4. Configure the signed Event Webhook

In SendGrid, open **Settings → Mail Settings → Event Webhooks** and create an
enabled webhook with:

- Post URL:
  `https://comms-app-1wo0.onrender.com/v1/webhooks/sendgrid/events`
- Events: Processed, Delivered, Deferred, Bounce, Dropped, Spam Report,
  Unsubscribe, and Group Unsubscribe
- Security: **Enable Signed Event Webhook**

Save the webhook before using **Test Integration**. Saving generates the
signature-verification key. Copy the one-line Base64 key into
`SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY_BASE64`, or a PEM public key into
`SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`. Configure only one form.

The backend verifies the signature against the timestamp plus the exact raw
request bytes. Unsigned or altered webhook requests fail closed.

## 5. Set Render environment variables

In the production Render web service, add or update:

```dotenv
PUBLIC_BASE_URL=https://comms-app-1wo0.onrender.com
PUBLIC_SITE_URL=https://sendforge.app

SENDGRID_API_KEY=<restricted Mail Send key>
SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY_BASE64=<signed webhook public key>
SENDGRID_REFERRAL_UNSUBSCRIBE_GROUP_ID=<numeric group ID>

ACCOUNT_FROM_EMAIL=referrals@sendforge.app
ACCOUNT_FROM_NAME=SendForge
REFERRAL_FROM_EMAIL=referrals@sendforge.app
REFERRAL_FROM_NAME=SendForge Rewards
REFERRAL_BUSINESS_ADDRESS=<complete legal postal address>
PRIVACY_POLICY_URL=https://sendforge.app/privacy.html
SUPPORT_EMAIL=support@sendforge.app

VERIFY_FROM_EMAIL=referrals@sendforge.app
SENDGRID_FROM_EMAIL=referrals@sendforge.app
SENDGRID_FROM_NAME=SendForge
CONTACT_FROM_EMAIL=referrals@sendforge.app
CONTACT_FROM_NAME=SendForge
CONTACT_TO_EMAIL=support@sendforge.app
```

`REFERRAL_BUSINESS_ADDRESS` must be a real business street address, registered
USPS PO box, or registered commercial mailbox. Never commit API keys or webhook
keys to Git.

Save the Render variables and deploy the latest production commit.

## 6. Apply migrations and verify

From the Render shell for the backend:

```bash
npm run migrate
```

Then verify:

1. `GET https://comms-app-1wo0.onrender.com/health` returns success.
2. In SendGrid, use **Test Integration** after signature verification is saved.
3. Send one referral invitation only to an address whose owner has agreed to
   receive it.
4. The Account page should first report that SendGrid accepted the invite.
5. In SendGrid **Activity**, confirm the same message advances from Processed
   to Delivered.
6. Confirm the referral event in SendForge advances to `delivered`.
7. Test the unsubscribe link; a second invite from that referrer to the same
   address must be blocked.

A SendGrid `202` means accepted for processing, not guaranteed inbox delivery.
The signed Event Webhook is the source of truth for Delivered, Bounced,
Dropped, Spam Report, and Unsubscribe states.
