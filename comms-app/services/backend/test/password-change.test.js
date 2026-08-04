import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcrypt";

import {
  MAX_PASSWORD_BYTES,
  PASSWORD_HASH_COST,
  preparePasswordChange,
} from "../src/services/passwordChange.service.js";

process.env.JWT_SECRET =
  process.env.JWT_SECRET || "sendforge-password-route-test-secret-at-least-32-bytes";

const [
  { accountRouter },
  { db },
  {
    clearCustomerAuthStateCache,
    issueCustomerAccessToken,
    verifyCustomerAccessToken,
  },
] = await Promise.all([
  import("../src/routes/account.routes.js"),
  import("../src/config/db.js"),
  import("../src/services/auth.service.js"),
]);

function passwordRouteHandlers() {
  const route = accountRouter.stack.find(
    (layer) => layer.route?.path === "/password" && layer.route.methods.patch
  )?.route;
  assert.ok(route, "PATCH /password must remain registered");
  return route.stack.map((layer) => layer.handle);
}

function responseRecorder(resolve) {
  return {
    statusCode: 200,
    body: null,
    headers: {},
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
      resolve(this);
      return this;
    },
  };
}

async function dispatch(handlers, request) {
  return new Promise((resolve, reject) => {
    let index = 0;
    const response = responseRecorder(resolve);
    const next = (error) => {
      if (error) {
        reject(error);
        return;
      }
      if (index >= handlers.length) {
        resolve(response);
        return;
      }
      const handler = handlers[index];
      index += 1;
      try {
        Promise.resolve(handler(request, response, next)).catch(reject);
      } catch (handlerError) {
        reject(handlerError);
      }
    };
    next();
  });
}

function authenticatedRequest(token, body = {}) {
  return {
    body,
    headers: {
      authorization: `Bearer ${token}`,
      "x-request-id": "password-route-test",
    },
    ip: "203.0.113.10",
  };
}

function installUsersDatabase(state, { forceUpdateConflict = false } = {}) {
  const original = {
    acquireConnection: db.client.acquireConnection,
    releaseConnection: db.client.releaseConnection,
    query: db.client._query,
  };
  const queries = [];

  db.client.acquireConnection = async () => ({ __knexUid: "password-route-test" });
  db.client.releaseConnection = async () => {};
  db.client._query = async (_connection, query) => {
    queries.push({
      method: query.method,
      sql: query.sql,
      bindings: [...(query.bindings || [])],
    });

    if (query.sql.startsWith("select") && query.sql.includes('"email_verified"')) {
      query.response = {
        command: "SELECT",
        rowCount: 1,
        rows: [
          {
            id: state.id,
            email: state.email,
            email_verified: true,
            auth_version: state.authVersion,
          },
        ],
      };
      return query;
    }

    if (query.sql.startsWith("select") && query.sql.includes('"password_hash"')) {
      query.response = {
        command: "SELECT",
        rowCount: 1,
        rows: [
          {
            id: state.id,
            email: state.email,
            password_hash: state.passwordHash,
            auth_version: state.authVersion,
          },
        ],
      };
      return query;
    }

    if (query.sql.startsWith("update")) {
      const [
        nextPasswordHash,
        nextVerificationTokenHash,
        nextVerificationSentAt,
        nextAuthVersion,
        userId,
        expectedPasswordHash,
        expectedAuthVersion,
      ] = query.bindings;
      const matchesCurrentState =
        userId === state.id &&
        expectedPasswordHash === state.passwordHash &&
        expectedAuthVersion === state.authVersion;
      const updated = !forceUpdateConflict && matchesCurrentState;
      if (updated) {
        state.passwordHash = nextPasswordHash;
        state.verificationTokenHash = nextVerificationTokenHash;
        state.verificationSentAt = nextVerificationSentAt;
        state.authVersion = nextAuthVersion;
      }
      query.response = {
        command: "UPDATE",
        rowCount: updated ? 1 : 0,
        rows: [],
      };
      return query;
    }

    throw new Error(`Unexpected password-route query: ${query.sql}`);
  };

  return {
    queries,
    restore() {
      db.client.acquireConnection = original.acquireConnection;
      db.client.releaseConnection = original.releaseConnection;
      db.client._query = original.query;
      clearCustomerAuthStateCache(state.id);
    },
  };
}

async function routeUser({
  id,
  email = "owner@example.com",
  authVersion = 4,
  currentPassword = "current-password",
}) {
  return {
    id,
    email,
    authVersion,
    currentPassword,
    passwordHash: await bcrypt.hash(currentPassword, 4),
    verificationTokenHash: "pending-reset-token-hash",
    verificationSentAt: new Date(),
  };
}

function tokenFor(state) {
  return issueCustomerAccessToken({
    id: state.id,
    email: state.email,
    authVersion: state.authVersion,
  });
}

test("password change rejects invalid and overlong input before bcrypt work", async () => {
  let comparisons = 0;
  const compare = async () => {
    comparisons += 1;
    return true;
  };

  assert.deepEqual(
    await preparePasswordChange({
      currentPassword: "short",
      newPassword: "new-password",
      passwordHash: "stored-hash",
      compare,
    }),
    { error: "invalid_input" }
  );
  assert.deepEqual(
    await preparePasswordChange({
      currentPassword: "current-password",
      newPassword: "x".repeat(MAX_PASSWORD_BYTES + 1),
      passwordHash: "stored-hash",
      compare,
    }),
    { error: "invalid_input" }
  );
  assert.equal(comparisons, 0);
});

test("password change requires the current password", async () => {
  const result = await preparePasswordChange({
    currentPassword: "wrong-password",
    newPassword: "replacement-password",
    passwordHash: "stored-hash",
    compare: async () => false,
  });

  assert.deepEqual(result, { error: "current_password_incorrect" });
});

test("password change rejects reuse of the current password", async () => {
  const comparisons = [];
  const result = await preparePasswordChange({
    currentPassword: "current-password",
    newPassword: "current-password",
    passwordHash: "stored-hash",
    compare: async (candidate) => {
      comparisons.push(candidate);
      return true;
    },
  });

  assert.deepEqual(comparisons, ["current-password", "current-password"]);
  assert.deepEqual(result, { error: "new_password_matches_current" });
});

test("password change hashes an accepted replacement at the configured cost", async () => {
  const comparisons = [];
  const hashes = [];
  const result = await preparePasswordChange({
    currentPassword: "current-password",
    newPassword: "replacement-password",
    passwordHash: "stored-hash",
    compare: async (candidate) => {
      comparisons.push(candidate);
      return candidate === "current-password";
    },
    hash: async (candidate, cost) => {
      hashes.push([candidate, cost]);
      return "replacement-hash";
    },
  });

  assert.deepEqual(comparisons, ["current-password", "replacement-password"]);
  assert.deepEqual(hashes, [["replacement-password", PASSWORD_HASH_COST]]);
  assert.deepEqual(result, { passwordHash: "replacement-hash" });
});

test("password route authenticates first and atomically rotates credentials", async () => {
  const handlers = passwordRouteHandlers();
  assert.deepEqual(
    handlers.map((handler) => handler.name),
    ["requireAuth", "rateLimit", ""]
  );

  const state = await routeUser({
    id: "5ba878a9-1fc9-4e5f-99d1-cf2c83f70d63",
    authVersion: 4,
  });
  const database = installUsersDatabase(state);
  try {
    const unauthenticated = await dispatch(handlers, {
      body: {},
      headers: {},
      ip: "203.0.113.10",
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.deepEqual(unauthenticated.body, { error: "missing_token" });
    assert.equal(database.queries.length, 0);

    const oldPasswordHash = state.passwordHash;
    const oldToken = tokenFor(state);
    const oldClaims = verifyCustomerAccessToken(oldToken);
    const response = await dispatch(
      handlers,
      authenticatedRequest(oldToken, {
        currentPassword: state.currentPassword,
        newPassword: "replacement-password",
      })
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.email, state.email);
    assert.equal(typeof response.body.token, "string");

    const replacementClaims = verifyCustomerAccessToken(response.body.token);
    assert.equal(replacementClaims.sub, state.id);
    assert.equal(replacementClaims.email, state.email);
    assert.equal(replacementClaims.auth_version, 5);
    assert.equal(
      replacementClaims.session_started_at,
      oldClaims.session_started_at
    );

    assert.equal(state.authVersion, 5);
    assert.equal(state.verificationTokenHash, null);
    assert.equal(state.verificationSentAt, null);
    assert.notEqual(state.passwordHash, oldPasswordHash);
    assert.equal(
      await bcrypt.compare("replacement-password", state.passwordHash),
      true
    );

    const update = database.queries.find((query) =>
      query.sql.startsWith("update")
    );
    assert.ok(update, "the password change must issue an UPDATE");
    assert.match(update.sql, /where \"id\" = \$5/);
    assert.match(update.sql, /\"password_hash\" = \$6/);
    assert.match(update.sql, /\"auth_version\" = \$7/);
    assert.deepEqual(update.bindings.slice(1, 4), [null, null, 5]);
    assert.deepEqual(update.bindings.slice(4), [
      state.id,
      oldPasswordHash,
      4,
    ]);

    // requireAuth cached version 4 before the update. Rejecting the old token
    // here proves the successful route cleared that stale cache entry.
    const staleTokenResponse = await dispatch(
      [handlers[0]],
      authenticatedRequest(oldToken)
    );
    assert.equal(staleTokenResponse.statusCode, 401);
    assert.deepEqual(staleTokenResponse.body, { error: "invalid_token" });

    const replacementRequest = authenticatedRequest(response.body.token);
    const replacementTokenResponse = await dispatch(
      [handlers[0]],
      replacementRequest
    );
    assert.equal(replacementTokenResponse.statusCode, 200);
    assert.equal(replacementRequest.user.auth_version, 5);
  } finally {
    database.restore();
  }
});

test("password route preserves its validation and current-password statuses", async () => {
  const handlers = passwordRouteHandlers();
  const state = await routeUser({
    id: "b5ad76af-50f0-431d-9863-a13f601a8b4b",
  });
  const database = installUsersDatabase(state);
  try {
    const token = tokenFor(state);
    const invalid = await dispatch(
      handlers,
      authenticatedRequest(token, {
        currentPassword: "short",
        newPassword: "replacement-password",
      })
    );
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.body, { error: "invalid_input" });

    const incorrect = await dispatch(
      handlers,
      authenticatedRequest(token, {
        currentPassword: "incorrect-password",
        newPassword: "replacement-password",
      })
    );
    assert.equal(incorrect.statusCode, 403);
    assert.deepEqual(incorrect.body, {
      error: "current_password_incorrect",
    });
    assert.equal(
      database.queries.some((query) => query.sql.startsWith("update")),
      false
    );
  } finally {
    database.restore();
  }
});

test("password route reports a guarded-update conflict without changing state", async () => {
  const handlers = passwordRouteHandlers();
  const state = await routeUser({
    id: "64d2601d-b8e4-4f73-9909-af031f7900d0",
  });
  const oldPasswordHash = state.passwordHash;
  const database = installUsersDatabase(state, { forceUpdateConflict: true });
  try {
    const response = await dispatch(
      handlers,
      authenticatedRequest(tokenFor(state), {
        currentPassword: state.currentPassword,
        newPassword: "replacement-password",
      })
    );

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, { error: "password_changed_elsewhere" });
    assert.equal(state.passwordHash, oldPasswordHash);
    assert.equal(state.authVersion, 4);
    assert.equal(state.verificationTokenHash, "pending-reset-token-hash");
    assert.ok(
      database.queries.some((query) => query.sql.startsWith("update")),
      "the conflict must come from the guarded UPDATE"
    );
  } finally {
    database.restore();
  }
});
