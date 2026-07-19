import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  createRateLimiter,
  hashRateLimitIdentity,
  normalizeRateLimitEmail,
  rateLimitByIpAndBodyEmail,
  rateLimitByIp,
} from "../src/middleware/rateLimit.js";

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("IP limiter uses Express-resolved req.ip, not spoofable forwarded headers", () => {
  const limiter = createRateLimiter({
    name: `test-ip-${crypto.randomUUID()}`,
    windowMs: 60_000,
    max: 1,
    keyGenerator: rateLimitByIp,
    message: "test_limited",
  });
  const firstResponse = responseRecorder();
  let firstNextCalls = 0;
  limiter(
    {
      ip: "203.0.113.10",
      headers: { "x-forwarded-for": "198.51.100.1" },
    },
    firstResponse,
    () => {
      firstNextCalls += 1;
    }
  );

  const secondResponse = responseRecorder();
  let secondNextCalls = 0;
  limiter(
    {
      ip: "203.0.113.10",
      headers: { "x-forwarded-for": "198.51.100.222" },
    },
    secondResponse,
    () => {
      secondNextCalls += 1;
    }
  );

  assert.equal(firstNextCalls, 1);
  assert.equal(secondNextCalls, 0);
  assert.equal(secondResponse.statusCode, 429);
  assert.equal(secondResponse.body.error, "test_limited");
  assert.ok(Number(secondResponse.headers["Retry-After"]) >= 1);
});

test("rate-limit identities never retain unbounded request values", () => {
  const hugeEmail = `${"A".repeat(2_000_000)}@example.com`;
  const normalized = normalizeRateLimitEmail(hugeEmail);
  const composite = rateLimitByIpAndBodyEmail({
    ip: "203.0.113.10",
    body: { email: hugeEmail },
  });
  const digest = hashRateLimitIdentity(composite);

  assert.equal(normalized.length, 320);
  assert.ok(composite.length <= 336);
  assert.match(digest, /^[A-Za-z0-9_-]{43}$/);
});

test("limiter hashes custom identities before storing bucket keys", () => {
  const sharedPrefix = "x".repeat(512);
  const limiter = createRateLimiter({
    name: `test-bounded-${crypto.randomUUID()}`,
    windowMs: 60_000,
    max: 1,
    keyGenerator: (req) => req.body.identity,
    message: "test_limited",
  });

  let firstNextCalls = 0;
  limiter(
    { body: { identity: `${sharedPrefix}first-large-tail` } },
    responseRecorder(),
    () => {
      firstNextCalls += 1;
    }
  );

  const secondResponse = responseRecorder();
  let secondNextCalls = 0;
  limiter(
    { body: { identity: `${sharedPrefix}second-large-tail` } },
    secondResponse,
    () => {
      secondNextCalls += 1;
    }
  );

  assert.equal(firstNextCalls, 1);
  assert.equal(secondNextCalls, 0);
  assert.equal(secondResponse.statusCode, 429);
});

test("a limiter skip predicate bypasses counting and rejection", () => {
  const limiter = createRateLimiter({
    name: `test-skip-${crypto.randomUUID()}`,
    windowMs: 60_000,
    max: 1,
    keyGenerator: (req) => req.user.sub,
    skip: (req) => req.user?.email === "owner@example.com",
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = responseRecorder();
    let nextCalls = 0;
    limiter(
      {
        user: {
          sub: "owner-id",
          email: "owner@example.com",
        },
      },
      response,
      () => {
        nextCalls += 1;
      }
    );
    assert.equal(nextCalls, 1);
    assert.equal(response.statusCode, 200);
  }
});
