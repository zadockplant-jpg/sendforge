// An activation code works only in the app for its product. TuneForge sends
// productSlug with a code; before this the route ignored it, so a DropForge
// code typed into TuneForge took a DropForge place for a licence TuneForge
// then refused. DropForge's own app sends no productSlug and is unchanged.
// A file of its own: /activate allows ten calls a minute per address.

import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after, before } from "node:test";
import express from "express";

import { attachPglite } from "./helpers/pglite-db.js";

process.env.LICENSE_SIGNING_KEY = crypto.randomBytes(32).toString("base64");
process.env.LICENSE_SIGNING_KID = "code-product-test";
process.env.JWT_SECRET ||= "activation-code-product-test-secret-32-bytes";

// env.js reads the environment when it is first imported.
const { db } = await import("../src/config/db.js");
const { grantProductEntitlement } = await import("../src/services/entitlement.service.js");
const { getOrCreateActivationCode } = await import("../src/services/deviceActivation.service.js");
const { licensingRouter } = await import("../src/routes/licensing.routes.js");

let detach;
let server;
let origin;

before(async () => {
  detach = await attachPglite(db);
  const app = express();
  app.use(express.json());
  app.use("/v1/licensing", licensingRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await detach?.();
});

async function activate(body) {
  const response = await fetch(`${origin}/v1/licensing/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function owner(productSlug) {
  const id = randomUUID();
  await db("users").insert({ id, email: `${id}@example.com` });
  await grantProductEntitlement({ userId: id, productSlug, source: "test" });
  return { id, code: (await getOrCreateActivationCode(id, productSlug)).code };
}

async function places(userId, productSlug) {
  const row = await db("device_activations").where({ user_id: userId, product_slug: productSlug }).count("* as n").first();
  return Number(row.n);
}

test("a DropForge code typed into TuneForge is not a code TuneForge knows", async () => {
  const person = await owner("forgedrop");
  const wrong = await activate({ activationCode: person.code, productSlug: "tuneforge", deviceName: "Music PC" });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.json.error, "unknown_activation_code");
  const unknown = await activate({ activationCode: person.code, productSlug: "not-a-product", deviceName: "Music PC" });
  assert.equal(unknown.status, 404);
  assert.equal(await places(person.id, "forgedrop"), 0, "no DropForge place was taken");
});

test("a code still activates its own product, named or not", async () => {
  const person = await owner("forgedrop");
  const named = await activate({ activationCode: person.code, productSlug: "ForgeDrop", deviceName: "Studio PC" });
  assert.equal(named.status, 200);
  const unnamed = await activate({ activationCode: person.code, deviceName: "Laptop" });
  assert.equal(unnamed.status, 200);
  assert.equal(await places(person.id, "forgedrop"), 2);

  const listener = await owner("tuneforge");
  const tune = await activate({ activationCode: listener.code, productSlug: "tuneforge", deviceName: "Music PC" });
  assert.equal(tune.status, 200);
  assert.match(listener.code, /^TF-/);
  assert.equal(await places(listener.id, "tuneforge"), 1);
});
