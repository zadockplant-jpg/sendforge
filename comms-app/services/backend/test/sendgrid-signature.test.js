import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { after, test } from "node:test";

import {
  verifySendgridSignature,
} from "../src/middleware/sendgridSignature.js";

const PUBLIC_KEY_ENV = "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY";
const LEGACY_PUBLIC_KEY_ENV =
  "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY_BASE64";
const originalPublicKey = process.env[PUBLIC_KEY_ENV];
const originalLegacyPublicKey =
  process.env[LEGACY_PUBLIC_KEY_ENV];

after(() => {
  restoreEnv(PUBLIC_KEY_ENV, originalPublicKey);
  restoreEnv(LEGACY_PUBLIC_KEY_ENV, originalLegacyPublicKey);
});

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});

const rawBody = Buffer.from(
  '[{"email":"recipient@example.com", "event":"delivered"}]',
  "utf8"
);
const timestamp = "1784217600";

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function useDerPublicKey() {
  delete process.env[PUBLIC_KEY_ENV];
  process.env[LEGACY_PUBLIC_KEY_ENV] = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
}

function usePemPublicKey() {
  delete process.env[LEGACY_PUBLIC_KEY_ENV];
  process.env[PUBLIC_KEY_ENV] = publicKey
    .export({ format: "pem", type: "spki" })
    .toString()
    .replaceAll("\n", "\\n");
}

function signatureFor(body = rawBody, signedTimestamp = timestamp) {
  return sign(
    "sha256",
    Buffer.concat([
      Buffer.from(signedTimestamp, "utf8"),
      Buffer.from(body),
    ]),
    privateKey
  ).toString("base64");
}

function invoke({
  body = rawBody,
  signature = signatureFor(),
  requestTimestamp = timestamp,
  includeRawBody = true,
  includeSignature = true,
  includeTimestamp = true,
} = {}) {
  const headers = new Map();
  if (includeSignature) {
    headers.set(
      "x-twilio-email-event-webhook-signature",
      signature
    );
  }
  if (includeTimestamp) {
    headers.set(
      "x-twilio-email-event-webhook-timestamp",
      requestTimestamp
    );
  }

  const req = {
    header(name) {
      return headers.get(name.toLowerCase());
    },
  };
  if (includeRawBody) req.rawBody = body;

  const response = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  let nextCalls = 0;

  assert.doesNotThrow(() => {
    verifySendgridSignature(req, response, () => {
      nextCalls += 1;
    });
  });

  return { nextCalls, response };
}

test("accepts a valid signature with a base64 DER public key", () => {
  useDerPublicKey();

  const result = invoke();

  assert.equal(result.nextCalls, 1);
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body, undefined);
});

test("accepts a valid signature with escaped-newline PEM config", () => {
  usePemPublicKey();

  const result = invoke();

  assert.equal(result.nextCalls, 1);
  assert.equal(result.response.statusCode, 200);
});

test("verifies the exact raw body bytes", () => {
  useDerPublicKey();
  const reserializedBody = Buffer.from(
    JSON.stringify(JSON.parse(rawBody.toString("utf8"))),
    "utf8"
  );

  const valid = invoke();
  const tampered = invoke({ body: reserializedBody });

  assert.equal(valid.nextCalls, 1);
  assert.equal(tampered.nextCalls, 0);
  assert.equal(tampered.response.statusCode, 401);
  assert.deepEqual(tampered.response.body, {
    error: "invalid_sendgrid_signature",
  });
});

test("rejects a tampered timestamp", () => {
  useDerPublicKey();

  const result = invoke({ requestTimestamp: `${timestamp}1` });

  assert.equal(result.nextCalls, 0);
  assert.equal(result.response.statusCode, 401);
  assert.deepEqual(result.response.body, {
    error: "invalid_sendgrid_signature",
  });
});

test("rejects a malformed signature without throwing", () => {
  useDerPublicKey();

  const result = invoke({ signature: "not-base64!" });

  assert.equal(result.nextCalls, 0);
  assert.equal(result.response.statusCode, 401);
  assert.deepEqual(result.response.body, {
    error: "invalid_sendgrid_signature",
  });
});

test("returns 500 when the public key is missing", () => {
  delete process.env[PUBLIC_KEY_ENV];
  delete process.env[LEGACY_PUBLIC_KEY_ENV];

  const result = invoke();

  assert.equal(result.nextCalls, 0);
  assert.equal(result.response.statusCode, 500);
  assert.deepEqual(result.response.body, {
    error: "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY missing",
  });
});

test("returns 500 when the exact raw body was not captured", () => {
  useDerPublicKey();

  const result = invoke({ includeRawBody: false });

  assert.equal(result.nextCalls, 0);
  assert.equal(result.response.statusCode, 500);
  assert.deepEqual(result.response.body, {
    error: "rawBody missing (check app.js json verify)",
  });
});

test("rejects missing signature headers", () => {
  useDerPublicKey();

  for (const headers of [
    { includeSignature: false },
    { includeTimestamp: false },
  ]) {
    const result = invoke(headers);
    assert.equal(result.nextCalls, 0);
    assert.equal(result.response.statusCode, 401);
    assert.deepEqual(result.response.body, {
      error: "missing_sendgrid_signature_headers",
    });
  }
});
