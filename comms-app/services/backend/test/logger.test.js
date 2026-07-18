import test from "node:test";
import assert from "node:assert/strict";
import { getRequestId } from "../src/utils/logger.js";

test("request IDs stay opaque before they enter provider custom args", () => {
  assert.equal(
    getRequestId({
      headers: { "x-request-id": "request_123:edge-4" },
    }),
    "request_123:edge-4"
  );

  const generated = getRequestId({
    headers: { "x-request-id": "person@example.com / private value" },
  });
  assert.match(
    generated,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
});
