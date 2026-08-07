import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";

import { createPasskeyRouter } from "../src/routes/passkey.routes.js";
import { PasskeyError } from "../src/services/passkey.service.js";

const USER = {
  sub: "9c883873-e9f1-43de-a90a-6b633775e40c",
  email: "forgepass@example.com",
};
const CEREMONY_ID = "98b1cc67-76e0-4d79-b3a8-762a6d2476d1";
const CREDENTIAL_RECORD_ID = "ae253b70-bf72-4e41-9784-2b9203fa9831";

function testAuth(req, res, next) {
  if (req.headers.authorization !== "Bearer test-token") {
    return res.status(401).json({ error: "missing_token" });
  }
  req.user = USER;
  return next();
}

async function withServer(service, callback) {
  const app = express();
  app.use(express.json());
  app.use(
    "/v1/auth/passkeys",
    createPasskeyRouter({ service, authMiddleware: testAuth })
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}/v1/auth/passkeys`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function request(base, path, { method = "POST", token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

function registrationResponse() {
  return {
    id: "credential_id",
    rawId: "credential_id",
    type: "public-key",
    response: {
      clientDataJSON: "client_data",
      attestationObject: "attestation_object",
      transports: ["usb"],
    },
    clientExtensionResults: {},
    authenticatorAttachment: "cross-platform",
  };
}

function authenticationResponse() {
  return {
    id: "credential_id",
    rawId: "credential_id",
    type: "public-key",
    response: {
      clientDataJSON: "client_data",
      authenticatorData: "authenticator_data",
      signature: "signature",
      userHandle: "dXNlcl9oYW5kbGU",
    },
    clientExtensionResults: {},
    authenticatorAttachment: "cross-platform",
  };
}

test("passkey registration trusts the authenticated account, not request identity", async () => {
  const calls = [];
  const service = {
    async registrationOptions(input) {
      calls.push(["options", input]);
      return { ceremonyId: CEREMONY_ID, options: { challenge: "challenge" } };
    },
    async verifyRegistration(input) {
      calls.push(["verify", input]);
      return { ok: true, credential: { id: CREDENTIAL_RECORD_ID } };
    },
  };

  await withServer(service, async (base) => {
    const unauthenticated = await request(base, "/register/options", {
      body: {},
    });
    assert.equal(unauthenticated.status, 401);

    const spoofed = await request(base, "/register/options", {
      token: "test-token",
      body: { userId: "another-user", email: "other@example.com" },
    });
    assert.equal(spoofed.status, 400);
    assert.deepEqual(spoofed.payload, { error: "invalid_input" });

    const options = await request(base, "/register/options", {
      token: "test-token",
      body: { password: "current-password" },
    });
    assert.equal(options.status, 200);
    assert.equal(options.payload.ceremonyId, CEREMONY_ID);

    const verification = await request(base, "/register/verify", {
      token: "test-token",
      body: {
        ceremonyId: CEREMONY_ID,
        response: registrationResponse(),
      },
    });
    assert.equal(verification.status, 201);
  });

  assert.deepEqual(calls[0], ["options", {
    userId: USER.sub,
    password: "current-password",
  }]);
  assert.equal(calls[1][0], "verify");
  assert.equal(calls[1][1].userId, USER.sub);
  assert.equal(calls[1][1].ceremonyId, CEREMONY_ID);
});

test("passkey login is discoverable, bounded, and returns the existing session shape", async () => {
  const calls = [];
  const service = {
    async authenticationOptions() {
      calls.push("options");
      return {
        ceremonyId: CEREMONY_ID,
        options: { challenge: "challenge", rpId: "localhost" },
      };
    },
    async verifyAuthentication(input) {
      calls.push(["verify", input]);
      return {
        token: "customer-jwt",
        user: USER,
        credential: { id: CREDENTIAL_RECORD_ID, name: "ForgePass" },
      };
    },
  };

  await withServer(service, async (base) => {
    const identifyingBody = await request(base, "/login/options", {
      body: { email: USER.email },
    });
    assert.equal(identifyingBody.status, 400);

    const options = await request(base, "/login/options", { body: {} });
    assert.equal(options.status, 200);
    assert.equal(options.payload.ceremonyId, CEREMONY_ID);

    const malformed = await request(base, "/login/verify", {
      body: { ceremonyId: CEREMONY_ID, response: { id: "credential_id" } },
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.payload, { error: "invalid_input" });

    const verified = await request(base, "/login/verify", {
      body: {
        ceremonyId: CEREMONY_ID,
        response: authenticationResponse(),
      },
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.payload.token, "customer-jwt");
    assert.deepEqual(verified.payload.user, USER);
  });

  assert.equal(calls[0], "options");
  assert.equal(calls[1][0], "verify");
  assert.equal(calls[1][1].ceremonyId, CEREMONY_ID);
  assert.equal(calls[1][1].response.id, "credential_id");
});

test("registration identifies a non-ForgePass authenticator without exposing verifier errors", async () => {
  const service = {
    async verifyRegistration() {
      throw new PasskeyError("authenticator_not_allowed");
    },
  };

  await withServer(service, async (base) => {
    const response = await request(base, "/register/verify", {
      token: "test-token",
      body: {
        ceremonyId: CEREMONY_ID,
        response: registrationResponse(),
      },
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.payload, { error: "authenticator_not_allowed" });
  });
});

test("passkey management always scopes list and delete to the authenticated user", async () => {
  const calls = [];
  const service = {
    async listCredentials(userId) {
      calls.push(["list", userId]);
      return [{ id: CREDENTIAL_RECORD_ID, name: "ForgePass" }];
    },
    async deleteCredential(userId, id) {
      calls.push(["delete", userId, id]);
      return { ok: true };
    },
  };

  await withServer(service, async (base) => {
    const list = await request(base, "/", {
      method: "GET",
      token: "test-token",
    });
    assert.equal(list.status, 200);
    assert.equal(list.payload.credentials[0].name, "ForgePass");

    const deletion = await request(base, `/${CREDENTIAL_RECORD_ID}`, {
      method: "DELETE",
      token: "test-token",
    });
    assert.equal(deletion.status, 200);
    assert.equal(deletion.payload.ok, true);
  });

  assert.deepEqual(calls, [
    ["list", USER.sub],
    ["delete", USER.sub, CREDENTIAL_RECORD_ID],
  ]);
});
