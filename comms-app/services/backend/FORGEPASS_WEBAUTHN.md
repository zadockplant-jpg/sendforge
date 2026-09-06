# ForgePass WebAuthn relying party

SendForge is the first-party relying party for ForgePass. The browser obtains a
one-time challenge from this backend, the ForgePass authenticator signs it with
a credential protected by the local TPM, and this backend verifies the signed
response before issuing the normal SendForge customer JWT.

No private credential key is sent to SendForge. PostgreSQL stores the credential
ID, COSE public key, signature counter, account relation, and non-secret device
metadata needed to verify future assertions.

## Local live test

From `comms-app`:

```sh
docker compose up -d postgres redis
```

From `comms-app/services/backend`:

```sh
npm install
npm run migrate
npm test
npm start
```

Open <http://localhost:3000/forgepass/> in a native browser while ForgePass is
running. Use an existing verified SendForge account for the one-time enrollment
bootstrap, then confirm its current password when adding the credential. After
enrollment, sign out and use **Sign in with ForgePass** without entering an
email or password.

During enrollment, allow the browser's request to share authenticator
information. The server asks for direct attestation conveyance so Chrome keeps
the AAGUID returned by a cross-platform ForgePass authenticator instead of
replacing it with the all-zero AAGUID.

The live page is served by this backend and has no CDN or third-party relying
party dependency. Its bearer token is kept in `sessionStorage`, so closing the
tab ends that browser session.

## API

| Method | Endpoint | Authorization | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/auth/passkeys/register/options` | Customer JWT + current password | Begin enrollment for the authenticated account |
| `POST` | `/v1/auth/passkeys/register/verify` | Customer JWT | Verify and persist a new ForgePass public credential |
| `POST` | `/v1/auth/passkeys/login/options` | Public, rate-limited | Begin discoverable authentication |
| `POST` | `/v1/auth/passkeys/login/verify` | Public, rate-limited | Verify the assertion and issue a customer JWT |
| `GET` | `/v1/auth/passkeys` | Customer JWT | List the account's credentials |
| `DELETE` | `/v1/auth/passkeys/:id` | Customer JWT | Remove one account-owned credential |

Registration never accepts a user ID or email from the request body. It derives
the account from the already-validated customer JWT and verifies the current
password before creating a ceremony. Login is discoverable: the credential ID
and signed user handle resolve the account, which avoids an email lookup and
account-enumeration response. Enrollment and authentication both require the
authenticator's user-verification flag.

Ceremonies are stored in `webauthn_challenges`, expire after a short TTL, and are
atomically deleted before verification. Authentication locks the credential row
while checking and updating its signature counter. Each account is capped at ten
credentials, with the cap enforced again under a database lock during insert.

## Configuration

Development defaults target `http://localhost:3000`. Production must explicitly
set the relying-party boundary:

```dotenv
WEBAUTHN_RP_NAME=ForgePass
WEBAUTHN_RP_ID=sendforge.app
WEBAUTHN_ORIGINS=https://sendforge.app
WEBAUTHN_TIMEOUT_MS=60000
WEBAUTHN_CHALLENGE_TTL_SECONDS=300
WEBAUTHN_ALLOWED_AAGUIDS=ccac9302f70b5904a2823658e8bca0a6
```

Choose the production RP ID before enrolling production credentials. WebAuthn
credentials registered for `localhost` cannot authenticate for `sendforge.app`.
Every non-localhost origin must use HTTPS and must belong to the configured RP
ID.

The ForgePass AAGUID allowlist narrows which authenticator implementation the
service accepts, but an AAGUID alone is not proof of genuine TPM hardware.
ForgePass currently returns a `none` attestation statement even when the relying
party requests direct conveyance, so the AAGUID is not signed by a trusted
attestation chain. Cryptographic hardware provenance would require a future
ForgePass attestation certificate chain and a server-side trust root. The
current system does prove possession of the exact enrolled private key and keeps
that key inside the ForgePass client.

## Verification

Run the complete backend suite:

```sh
npm test
```

For a clean database, apply all migrations and inspect the two WebAuthn tables:

```sh
npm run migrate
```

The browser remains the end-to-end test because it supplies the origin-bound
`clientDataJSON` and mediates the operating system's authenticator transport.
