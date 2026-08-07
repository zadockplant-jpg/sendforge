import assert from "node:assert/strict";
import test from "node:test";

import {
  FORGEPASS_AAGUID,
  MAX_PASSKEYS_PER_USER,
  PASSKEY_ALGORITHMS,
  PasskeyError,
  createPasskeyService,
  normalizeAaguid,
  normalizeTransports,
  safeCounter,
  userHandleForUserId,
} from "../src/services/passkey.service.js";

const USER_ID = "9c883873-e9f1-43de-a90a-6b633775e40c";
const USER_EMAIL = "forgepass@example.com";
const USER_PASSWORD = "current-password";
const CONFIGURATION = Object.freeze({
  webAuthnRpName: "ForgePass",
  webAuthnRpId: "localhost",
  webAuthnOrigins: ["http://localhost:3000"],
  webAuthnTimeoutMs: 60_000,
  webAuthnChallengeTtlMs: 300_000,
  webAuthnAllowedAaguids: [FORGEPASS_AAGUID],
});

function fakeRepository({ credentialRow = null } = {}) {
  const ceremonies = new Map();
  const insertedCredentials = [];
  const existingCredentials = [];
  const publicCredentials = [];
  const deletedCredentials = [];

  return {
    ceremonies,
    insertedCredentials,
    existingCredentials,
    publicCredentials,
    deletedCredentials,
    credentialRow,

    async listCredentialsForOptions(userId) {
      return existingCredentials.filter((entry) => entry.user_id === userId);
    },
    async createCeremony(ceremony) {
      ceremonies.set(ceremony.id, ceremony);
    },
    async consumeCeremony({ id, userId, purpose, now }) {
      const ceremony = ceremonies.get(id);
      if (!ceremony) return null;
      if (
        ceremony.purpose !== purpose ||
        (userId && ceremony.userId !== userId)
      ) {
        return null;
      }
      ceremonies.delete(id);
      if (ceremony.expiresAt.getTime() <= now.getTime()) return null;
      return {
        challenge: ceremony.challenge,
        user_id: ceremony.userId,
        expires_at: ceremony.expiresAt,
      };
    },
    async getVerifiedUser(userId) {
      if (userId !== USER_ID) return null;
      return {
        id: USER_ID,
        email: USER_EMAIL,
        password_hash: "stored-password-hash",
        email_verified: true,
        auth_version: 7,
      };
    },
    async insertCredential(credential) {
      insertedCredentials.push(credential);
    },
    async withLockedCredential(credentialId, operation) {
      if (!this.credentialRow || this.credentialRow.credential_id !== credentialId) {
        return null;
      }
      return operation({
        row: this.credentialRow,
        update: async (values) => Object.assign(this.credentialRow, values),
      });
    },
    async listCredentials(userId) {
      return publicCredentials.filter((entry) => entry.user_id === userId);
    },
    async deleteCredential(userId, id) {
      deletedCredentials.push({ userId, id });
      return publicCredentials.some(
        (entry) => entry.user_id === userId && entry.id === id
      )
        ? 1
        : 0;
    },
  };
}

function fixedClock() {
  return new Date("2026-08-07T12:00:00.000Z");
}

async function verifyTestPassword(password, passwordHash) {
  return (
    password === USER_PASSWORD && passwordHash === "stored-password-hash"
  );
}

test("passkey normalization keeps only bounded WebAuthn metadata", () => {
  assert.equal(
    normalizeAaguid("CCAC9302-F70B-5904-A282-3658E8BCA0A6"),
    FORGEPASS_AAGUID
  );
  assert.equal(normalizeAaguid("not-an-aaguid"), "");
  assert.deepEqual(
    normalizeTransports(["usb", "USB", "hybrid", "unknown", "internal"]),
    ["usb", "hybrid", "internal"]
  );
  assert.equal(
    userHandleForUserId(USER_ID),
    Buffer.from(USER_ID).toString("base64url")
  );
  assert.equal(safeCounter("4294967295"), 4_294_967_295);
  assert.throws(() => safeCounter("not-a-counter"), PasskeyError);
});

test("registration options are bound to the authenticated account and ForgePass", async () => {
  const repository = fakeRepository();
  repository.existingCredentials.push({
    user_id: USER_ID,
    credential_id: "existing_credential",
    transports: ["usb"],
  });
  let receivedOptions;
  const service = createPasskeyService({
    repository,
    configuration: CONFIGURATION,
    registrationOptions: async (options) => {
      receivedOptions = options;
      return { challenge: "registration_challenge", rp: { id: options.rpID } };
    },
    passwordVerifier: verifyTestPassword,
    randomUUID: () => "98b1cc67-76e0-4d79-b3a8-762a6d2476d1",
    clock: fixedClock,
  });

  const result = await service.registrationOptions({
    userId: USER_ID,
    password: USER_PASSWORD,
  });

  assert.equal(result.ceremonyId, "98b1cc67-76e0-4d79-b3a8-762a6d2476d1");
  assert.equal(receivedOptions.rpID, "localhost");
  assert.equal(receivedOptions.userName, USER_EMAIL);
  assert.equal(Buffer.from(receivedOptions.userID).toString(), USER_ID);
  assert.equal(receivedOptions.attestationType, "direct");
  assert.deepEqual(receivedOptions.supportedAlgorithmIDs, PASSKEY_ALGORITHMS);
  assert.deepEqual(receivedOptions.authenticatorSelection, {
    authenticatorAttachment: "cross-platform",
    residentKey: "required",
    userVerification: "required",
  });
  assert.deepEqual(receivedOptions.excludeCredentials, [
    { id: "existing_credential", transports: ["usb"] },
  ]);

  const stored = repository.ceremonies.get(result.ceremonyId);
  assert.equal(stored.userId, USER_ID);
  assert.equal(stored.challenge, "registration_challenge");
  assert.equal(
    stored.expiresAt.toISOString(),
    "2026-08-07T12:05:00.000Z"
  );
});

test("registration requires the current password before creating a ceremony", async () => {
  const repository = fakeRepository();
  let optionsGenerated = false;
  const service = createPasskeyService({
    repository,
    configuration: CONFIGURATION,
    registrationOptions: async () => {
      optionsGenerated = true;
      return { challenge: "must_not_be_created" };
    },
    passwordVerifier: async () => false,
    randomUUID: () => "98b1cc67-76e0-4d79-b3a8-762a6d2476d1",
    clock: fixedClock,
  });

  await assert.rejects(
    service.registrationOptions({
      userId: USER_ID,
      password: "incorrect-password",
    }),
    { code: "reauthentication_failed" }
  );
  assert.equal(optionsGenerated, false);
  assert.equal(repository.ceremonies.size, 0);
});

test("registration refuses to grow an account beyond its credential cap", async () => {
  const repository = fakeRepository();
  for (let index = 0; index < MAX_PASSKEYS_PER_USER; index += 1) {
    repository.existingCredentials.push({
      user_id: USER_ID,
      credential_id: `credential_${index}`,
      transports: ["usb"],
    });
  }
  const service = createPasskeyService({
    repository,
    configuration: CONFIGURATION,
    registrationOptions: async () => {
      throw new Error("options must not be generated above the cap");
    },
    passwordVerifier: verifyTestPassword,
    randomUUID: () => "98b1cc67-76e0-4d79-b3a8-762a6d2476d1",
    clock: fixedClock,
  });

  await assert.rejects(
    service.registrationOptions({
      userId: USER_ID,
      password: USER_PASSWORD,
    }),
    { code: "credential_limit_reached" }
  );
  assert.equal(repository.ceremonies.size, 0);
});

test("verified registration stores only public credential material", async () => {
  const repository = fakeRepository();
  let verifyArguments;
  let uuidCall = 0;
  const service = createPasskeyService({
    repository,
    configuration: CONFIGURATION,
    registrationOptions: async () => ({ challenge: "registration_challenge" }),
    registrationVerifier: async (arguments_) => {
      verifyArguments = arguments_;
      return {
        verified: true,
        registrationInfo: {
          aaguid: "ccac9302-f70b-5904-a282-3658e8bca0a6",
          credential: {
            id: "new_credential",
            publicKey: new Uint8Array([1, 2, 3, 4]),
            counter: 0,
          },
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
        },
      };
    },
    passwordVerifier: verifyTestPassword,
    randomUUID: () =>
      [
        "98b1cc67-76e0-4d79-b3a8-762a6d2476d1",
        "ae253b70-bf72-4e41-9784-2b9203fa9831",
      ][uuidCall++],
    clock: fixedClock,
  });

  const begin = await service.registrationOptions({
    userId: USER_ID,
    password: USER_PASSWORD,
  });
  const response = {
    id: "new_credential",
    rawId: "new_credential",
    type: "public-key",
    response: {
      clientDataJSON: "client_data",
      attestationObject: "attestation_object",
      transports: ["usb"],
    },
    clientExtensionResults: {},
  };
  const result = await service.verifyRegistration({
    userId: USER_ID,
    ceremonyId: begin.ceremonyId,
    response,
  });

  assert.equal(result.ok, true);
  assert.equal(result.credential.aaguid, FORGEPASS_AAGUID);
  assert.equal(verifyArguments.expectedChallenge, "registration_challenge");
  assert.deepEqual(verifyArguments.expectedOrigin, ["http://localhost:3000"]);
  assert.equal(verifyArguments.expectedRPID, "localhost");
  assert.equal(verifyArguments.requireUserVerification, true);

  assert.equal(repository.insertedCredentials.length, 1);
  const stored = repository.insertedCredentials[0];
  assert.equal(stored.user_id, USER_ID);
  assert.equal(stored.credential_id, "new_credential");
  assert.deepEqual([...stored.public_key], [1, 2, 3, 4]);
  assert.equal(stored.user_handle, userHandleForUserId(USER_ID));
  assert.equal(stored.counter, "0");
  assert.equal(stored.transports, '["usb"]');
  assert.equal("private_key" in stored, false);
});

test("registration ceremonies cannot cross accounts and are consumed on use", async () => {
  const repository = fakeRepository();
  const service = createPasskeyService({
    repository,
    configuration: CONFIGURATION,
    registrationOptions: async () => ({ challenge: "one_time_challenge" }),
    registrationVerifier: async () => ({ verified: false }),
    passwordVerifier: verifyTestPassword,
    randomUUID: () => "98b1cc67-76e0-4d79-b3a8-762a6d2476d1",
    clock: fixedClock,
  });
  const begin = await service.registrationOptions({
    userId: USER_ID,
    password: USER_PASSWORD,
  });

  await assert.rejects(
    service.verifyRegistration({
      userId: "d6e788ad-96a2-421d-9093-257fd9606f60",
      ceremonyId: begin.ceremonyId,
      response: {},
    }),
    { code: "invalid_or_expired_ceremony" }
  );
  assert.equal(repository.ceremonies.has(begin.ceremonyId), true);
  await assert.rejects(
    service.verifyRegistration({
      userId: USER_ID,
      ceremonyId: begin.ceremonyId,
      response: {},
    }),
    { code: "registration_failed" }
  );
  await assert.rejects(
    service.verifyRegistration({
      userId: USER_ID,
      ceremonyId: begin.ceremonyId,
      response: {},
    }),
    { code: "invalid_or_expired_ceremony" }
  );
});

test("discoverable authentication identifies the user and rotates the counter", async () => {
  const userHandle = userHandleForUserId(USER_ID);
  const row = {
    record_id: "10f28d75-5392-40f2-bd0d-7d85300787ea",
    user_id: USER_ID,
    credential_id: "registered_credential",
    public_key: Buffer.from([8, 6, 7, 5, 3, 0, 9]),
    counter: "4",
    transports: ["usb"],
    user_handle: userHandle,
    aaguid: FORGEPASS_AAGUID,
    device_type: "singleDevice",
    backed_up: false,
    email: USER_EMAIL,
    email_verified: true,
    auth_version: 7,
  };
  const repository = fakeRepository({ credentialRow: row });
  let generatedOptions;
  let verifyArguments;
  const service = createPasskeyService({
    repository,
    configuration: CONFIGURATION,
    authenticationOptions: async (options) => {
      generatedOptions = options;
      return { challenge: "authentication_challenge", rpId: options.rpID };
    },
    authenticationVerifier: async (arguments_) => {
      verifyArguments = arguments_;
      return {
        verified: true,
        authenticationInfo: {
          newCounter: 5,
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
        },
      };
    },
    tokenIssuer: (user) => `token-for:${user.id}:${user.authVersion}`,
    randomUUID: () => "9c3b6b95-e975-42f1-b29d-82524c243a7d",
    clock: fixedClock,
  });

  const begin = await service.authenticationOptions();
  assert.equal("allowCredentials" in generatedOptions, false);
  assert.equal(generatedOptions.userVerification, "required");
  assert.equal(verifyArguments, undefined);

  const response = {
    id: "registered_credential",
    rawId: "registered_credential",
    type: "public-key",
    response: {
      clientDataJSON: "client_data",
      authenticatorData: "authenticator_data",
      signature: "signature",
      userHandle,
    },
    clientExtensionResults: {},
  };
  const result = await service.verifyAuthentication({
    ceremonyId: begin.ceremonyId,
    response,
  });

  assert.equal(result.token, `token-for:${USER_ID}:7`);
  assert.deepEqual(result.user, { id: USER_ID, email: USER_EMAIL });
  assert.equal(verifyArguments.expectedChallenge, "authentication_challenge");
  assert.equal(verifyArguments.requireUserVerification, true);
  assert.equal(verifyArguments.credential.id, "registered_credential");
  assert.deepEqual([...verifyArguments.credential.publicKey], [8, 6, 7, 5, 3, 0, 9]);
  assert.equal(verifyArguments.credential.counter, 4);
  assert.equal(row.counter, "5");
  assert.equal(row.last_used_at.toISOString(), "2026-08-07T12:00:00.000Z");

  await assert.rejects(
    service.verifyAuthentication({ ceremonyId: begin.ceremonyId, response }),
    { code: "invalid_or_expired_ceremony" }
  );
});

test("authentication rejects an assertion whose discoverable user handle changed", async () => {
  const repository = fakeRepository({
    credentialRow: {
      record_id: "10f28d75-5392-40f2-bd0d-7d85300787ea",
      user_id: USER_ID,
      credential_id: "registered_credential",
      public_key: Buffer.from([1]),
      counter: 0,
      transports: [],
      user_handle: userHandleForUserId(USER_ID),
      email: USER_EMAIL,
      email_verified: true,
      auth_version: 0,
    },
  });
  const service = createPasskeyService({
    repository,
    configuration: CONFIGURATION,
    authenticationOptions: async () => ({ challenge: "challenge" }),
    authenticationVerifier: async () => {
      throw new Error("verifier must not run");
    },
    randomUUID: () => "9c3b6b95-e975-42f1-b29d-82524c243a7d",
    clock: fixedClock,
  });
  const begin = await service.authenticationOptions();

  await assert.rejects(
    service.verifyAuthentication({
      ceremonyId: begin.ceremonyId,
      response: {
        id: "registered_credential",
        response: { userHandle: Buffer.from("another-user").toString("base64url") },
      },
    }),
    { code: "authentication_failed" }
  );
  assert.equal(repository.ceremonies.size, 0);
});
