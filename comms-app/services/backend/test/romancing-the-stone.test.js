// Romancing the Stone: circles, quests, stones, one-way reward paths, the
// licence that powers a circle, and its ten-device limit.
//
// The HTTP tests run the real router, service, auth middleware and migration
// against an in-process Postgres (PGlite). The billing tests drive the shared
// Stripe webhook handler with a fake Stripe client.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after, before } from "node:test";
import express from "express";
import { PGlite } from "@electric-sql/pglite";

process.env.JWT_SECRET ||= "romancing-the-stone-test-secret-at-least-32-bytes";
process.env.RTS_ENABLED = "true";
process.env.RTS_COMP_EMAILS = "";

const { db } = await import("../src/config/db.js");
const { issueCustomerAccessToken } = await import("../src/services/auth.service.js");
const { requireAuth } = await import("../src/middleware/auth.js");
const engine = await import("../src/modules/romancing-the-stone/engine.js");
const { up, down } = await import("../src/db/migrations/20260924_create_romancing_the_stone.js");
const { createRtsRouter } = await import("../src/modules/romancing-the-stone/router.js");
const { createRtsService, periodKey, makeInviteCode } = await import("../src/modules/romancing-the-stone/service.js");
const { createHub } = await import("../src/modules/romancing-the-stone/events.js");
const { getRtsConfig } = await import("../src/modules/romancing-the-stone/config.js");
const { sharedLicenseCache, resolveLicense } = await import("../src/modules/romancing-the-stone/license.js");
const rtsBilling = await import("../src/modules/romancing-the-stone/billing.js");
const { perksFor } = await import("../src/modules/romancing-the-stone/perks.js");
const { handleCheckoutSessionCompleted } = await import("../src/routes/stripe.webhooks.routes.js");

// ------------------------------------------------------------------ fixtures

/** The decoy path from the product brief: a knife, a stopwatch and candy. */
function decoyGraph() {
  return {
    v: 1,
    start: "doors",
    nodes: {
      doors: {
        type: "choice",
        prompt: "Three doors. One choice. No going back.",
        options: [
          { id: "knife", icon: "knife", color: "violet", label: "", reveal: "Personal protection", to: "protect" },
          { id: "watch", icon: "stopwatch", color: "cyan", label: "", reveal: "Mystery category: time away", to: "time" },
          { id: "candy", icon: "candy", color: "pink", label: "", reveal: "Sweet… but not candy.", to: "night" },
        ],
      },
      protect: {
        type: "question",
        prompt: "When trouble comes, you…",
        options: [
          { id: "stand", text: "Stand your ground", to: "class" },
          { id: "ready", text: "Stay ready", to: "edc" },
        ],
      },
      time: {
        type: "chance",
        prompt: "Spin for how far you're going.",
        options: [
          { id: "near", weight: 3, reveal: "Close to home", to: "daytrip" },
          { id: "far", weight: 1, reveal: "Pack a bag", to: "getaway" },
        ],
      },
      night: {
        type: "question",
        prompt: "Pick a soundtrack for the night:",
        options: [
          { id: "live", text: "Live music", to: "concert" },
          { id: "quiet", text: "Candlelight and courses", to: "catered" },
        ],
      },
      class: { type: "reward", title: "Self-defense class for two", icon: "shield", color: "violet" },
      edc: { type: "reward", title: "Everyday-carry kit", icon: "flashlight", color: "violet" },
      daytrip: { type: "reward", title: "Surprise day trip", icon: "car", color: "cyan" },
      getaway: { type: "reward", title: "Weekend getaway", icon: "plane", color: "cyan" },
      concert: { type: "reward", title: "Concert tickets for two", icon: "music", color: "pink", reveal: "Front row energy." },
      catered: { type: "reward", title: "Date to a catered event", icon: "cocktail", color: "pink" },
    },
  };
}
const REWARD_TITLES = Object.values(decoyGraph().nodes)
  .filter((node) => node.type === "reward")
  .map((node) => node.title);

// -------------------------------------------------------------- engine only

test("the decoy path validates and counts its routes", () => {
  const result = engine.validateGraph(decoyGraph());
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.stats, { steps: 10, depth: 3, rewards: 6, routes: 6 });
});

test("paths only go forward, reach every step and end in rewards", () => {
  const loop = decoyGraph();
  loop.nodes.protect.options[0].to = "doors";
  assert.match(engine.validateGraph(loop).errors.join(), /loops back/);

  const orphan = decoyGraph();
  orphan.nodes.lost = { type: "reward", title: "Lost", icon: "gem" };
  assert.match(engine.validateGraph(orphan).errors.join(), /never be reached/);

  const dangling = decoyGraph();
  dangling.nodes.night.options[0].to = "nowhere";
  assert.match(engine.validateGraph(dangling).errors.join(), /leads nowhere/);

  const oneDoor = decoyGraph();
  oneDoor.nodes.doors.options = oneDoor.nodes.doors.options.slice(0, 1);
  assert.match(engine.validateGraph(oneDoor).errors.join(), /between 2 and 6 doors/);

  const noTitle = decoyGraph();
  noTitle.nodes.concert.title = "   ";
  assert.match(engine.validateGraph(noTitle).errors.join(), /reward title is required/);

  assert.equal(engine.validateGraph(null).ok, false);
  assert.equal(engine.validateGraph({ start: "a", nodes: {} }).ok, false);
});

test("a seeker's view of a step carries no destinations, reveals or rewards", () => {
  const graph = decoyGraph();
  const view = engine.publicNode(graph, "doors");
  assert.deepEqual(Object.keys(view.options[0]).sort(), ["color", "icon", "id", "label"]);
  const text = JSON.stringify([view, engine.publicNode(graph, "night"), engine.publicNode(graph, "time")]);
  for (const secret of [...REWARD_TITLES, "Personal protection", "Sweet", "Pack a bag", "concert", "protect"]) {
    assert.equal(text.includes(secret), false, `leaked ${secret}`);
  }
  assert.deepEqual(engine.publicNode(graph, "time"), { id: "time", type: "chance", prompt: "Spin for how far you're going.", count: 2 });
});

test("chance follows its weights and steps report the reveal line", () => {
  const graph = decoyGraph();
  const picks = [0, 1, 2, 3].map((roll) => engine.takeStep(graph, "time", "spin", () => roll).nextId);
  assert.deepEqual(picks, ["daytrip", "daytrip", "daytrip", "getaway"]);
  const step = engine.takeStep(graph, "doors", "candy", () => 0);
  assert.equal(step.record.reveal, "Sweet… but not candy.");
  assert.equal(step.finished, false);
  assert.equal(engine.takeStep(graph, "night", "live", () => 0).finished, true);
  assert.throws(() => engine.takeStep(graph, "doors", "nope", () => 0), /unknown_option/);
  assert.throws(() => engine.takeStep(graph, "concert", "x", () => 0), /path_finished/);
});

test("claim periods follow the circle's own calendar", () => {
  // 03:30 UTC Monday is still Sunday evening in Michigan.
  const date = new Date("2026-09-28T03:30:00Z");
  assert.equal(periodKey("daily", "UTC", date), "d:2026-09-28");
  assert.equal(periodKey("daily", "America/Detroit", date), "d:2026-09-27");
  assert.equal(periodKey("weekly", "UTC", date), "w:2026-09-28");
  assert.equal(periodKey("weekly", "America/Detroit", date), "w:2026-09-21");
  assert.equal(periodKey("once", "UTC", date), "once");
  assert.equal(periodKey("always", "UTC", date), "");
  assert.match(makeInviteCode(), /^[A-HJKMNP-Z2-9]{8}$/);
});

test("perks are built in and all say coming soon", () => {
  const subscriber = perksFor({ plan: "subscription" });
  const permanent = perksFor({ plan: "permanent" });
  assert.ok(subscriber.every((perk) => perk.status === "coming_soon"));
  assert.deepEqual(subscriber.filter((perk) => perk.eligible).map((perk) => perk.id), ["subscriber-drops"]);
  assert.deepEqual(permanent.filter((perk) => perk.eligible).map((perk) => perk.id), [
    "permanent-merch",
    "permanent-partner-deals",
  ]);
  assert.equal(perksFor({ plan: null }).some((perk) => perk.eligible), false);
});

test("the subscription checkout is $30 today with six months included, then $5/month", () => {
  const [start, renewal] = rtsBilling.buildRtsSubscriptionLineItems();
  assert.equal(start.price_data.unit_amount, 3000);
  assert.equal(start.price_data.recurring, undefined);
  assert.equal(renewal.price_data.unit_amount, 500);
  assert.deepEqual(renewal.price_data.recurring, { interval: "month" });
  const options = rtsBilling.buildRtsSubscriptionCheckoutOptions({ userId: "u1" });
  assert.equal(options.subscription_data.trial_period_days, 183);
  assert.equal(options.subscription_data.metadata.plan, "rts_subscription");
  assert.equal(options.subscription_data.metadata.user_id, "u1");
  assert.match(options.custom_text.submit.message, /\$30 today.*first 6 months.*\$5\/month/);
  assert.equal(rtsBilling.RTS_CATALOG["romancing-the-stone-permanent"].unitAmountCents, 12000);
  assert.equal(rtsBilling.rtsCheckoutReturnUrls({}), null);
  const urls = rtsBilling.rtsCheckoutReturnUrls({ RTS_APP_URL: "https://rts.example.com/app/" });
  assert.match(urls.success_url, /^https:\/\/rts\.example\.com\/app\/\?checkout=success&session_id=\{CHECKOUT_SESSION_ID\}#plans$/);
});

// ------------------------------------------------------------ with Postgres

let pg;
let server;
let base;
const hub = createHub();
const people = {};

before(async () => {
  pg = new PGlite();
  await pg.waitReady;
  if (db.client.pool) await db.client.destroy();
  db.client.initializeDriver();
  db.client.initializePool({ ...db.client.config, pool: { min: 0, max: 1 } });
  db.client.acquireRawConnection = async () => ({
    query(config, callback) {
      pg.query(config.text, config.values).then(
        (result) =>
          callback(null, {
            rows: result.rows,
            rowCount: result.affectedRows,
            command: config.text.trim().split(/\s/)[0].toUpperCase(),
          }),
        (error) => callback(error)
      );
    },
  });
  db.client.destroyRawConnection = async () => {};

  await db.schema.createTable("users", (t) => {
    t.uuid("id").primary();
    t.text("email").unique();
    t.boolean("email_verified").defaultTo(true);
    t.integer("auth_version").defaultTo(0);
    t.text("stripe_customer_id").nullable();
    t.uuid("referred_by_user_id").nullable();
  });
  await db.schema.createTable("product_entitlements", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable();
    t.text("product_slug").notNullable();
    t.text("source");
    t.text("source_ref");
    t.text("status");
    t.timestamp("granted_at", { useTz: true });
    t.timestamp("expires_at", { useTz: true });
    t.jsonb("metadata").defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true });
    t.unique(["user_id", "product_slug"]);
  });
  await db.schema.createTable("subscriptions", (t) => {
    t.uuid("id").primary();
    t.uuid("user_id").notNullable();
    t.text("provider").notNullable();
    t.text("provider_customer_id").notNullable().defaultTo("");
    t.text("provider_subscription_id").notNullable().defaultTo("");
    t.text("plan").notNullable();
    t.text("status").notNullable();
    t.timestamp("current_period_start", { useTz: true });
    t.timestamp("current_period_end", { useTz: true });
    t.jsonb("raw").notNullable().defaultTo("{}");
    t.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
  });
  await db.raw(
    "CREATE UNIQUE INDEX subscriptions_provider_sub ON subscriptions (provider, provider_subscription_id) WHERE provider_subscription_id <> ''"
  );
  await db.schema.createTable("billing_checkout_attempts", (t) => {
    t.uuid("id").primary();
    t.text("stripe_checkout_session_id");
    t.text("status");
    t.timestamp("updated_at", { useTz: true });
  });
  await up(db);

  for (const name of ["alex", "blair", "casey", "drew"]) {
    const id = randomUUID();
    await db("users").insert({ id, email: `${name}@example.com` });
    people[name] = { id, email: `${name}@example.com`, token: issueCustomerAccessToken({ id, email: `${name}@example.com` }) };
  }
  // Alex bought the permanent licence.
  await db("product_entitlements").insert({
    id: randomUUID(),
    user_id: people.alex.id,
    product_slug: "romancing-the-stone-permanent",
    source: "stripe",
    source_ref: "pi_alex",
    status: "active",
  });

  let roll = 0;
  const service = createRtsService({ db, hub, randomInt: (max) => roll++ % max });
  const app = express();
  app.use(
    "/v1/rts",
    createRtsRouter({
      getConfig: getRtsConfig,
      requireAuth,
      db,
      hub,
      licenseCache: sharedLicenseCache,
      service,
      logger: { error() {} },
    })
  );
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/v1/rts`;
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server?.close(resolve));
  await db.destroy();
  await pg?.close();
});

const deviceOf = (name, n = 1) => `${name}-device-${n}`.padEnd(20, "x");

async function call(name, method, path, { body, device = deviceOf(name), as, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(name ? { Authorization: `Bearer ${people[name].token}` } : {}),
      ...(device ? { "X-RTS-Device": device, "X-RTS-Device-Label": `${name} phone` } : {}),
      ...(as ? { "X-RTS-Member": as } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, body: json, text };
}

const state = {};

test("a licence is needed to start a circle, not to join one", async () => {
  assert.equal((await call(null, "GET", "/me")).status, 401);
  const refused = await call("blair", "POST", "/circles", { body: { name: "Us", kind: "couple", displayName: "Blair" } });
  assert.equal(refused.status, 402);
  assert.equal(refused.body.error, "license_required");

  const me = await call("alex", "GET", "/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.license.plan, "permanent");
  assert.equal(me.body.license.deviceLimit, 10);
  assert.equal(me.body.pricing.subscription.startCents, 3000);

  const created = await call("alex", "POST", "/circles", {
    body: { name: "Alex & Blair", kind: "couple", displayName: "Alex", timezone: "America/Detroit" },
  });
  assert.equal(created.status, 201);
  state.circle = created.body.circleId;
  state.alex = created.body.memberId;

  const joined = await call("blair", "POST", "/circles/join", {
    body: { inviteCode: created.body.inviteCode.toLowerCase(), displayName: "Blair" },
  });
  assert.equal(joined.status, 201);
  state.blair = joined.body.memberId;
  const again = await call("blair", "POST", "/circles/join", { body: { inviteCode: created.body.inviteCode, displayName: "Blair" } });
  assert.equal(again.status, 200);
  assert.equal(again.body.memberId, state.blair);

  const view = await call("blair", "GET", `/circles/${state.circle}`);
  assert.equal(view.status, 200);
  assert.deepEqual(
    view.body.members.map((member) => [member.displayName, member.role]),
    [["Alex", "both"], ["Blair", "both"]]
  );
  assert.equal(view.body.circle.licenseActive, true);

  assert.equal((await call("casey", "GET", `/circles/${state.circle}`)).status, 404, "outsiders see nothing");
  assert.equal((await call("blair", "GET", `/circles/${state.circle}`, { device: null })).body.error, "device_required");
});

test("the path maker sees behind the doors; the seeker does not", async () => {
  const created = await call("alex", "POST", `/circles/${state.circle}/paths`, {
    body: {
      title: "The Three Doors",
      teaser: "Pick a picture. Live with it.",
      icon: "gem",
      color: "violet",
      cost: null,
      repeatable: false,
      assigneeIds: [],
      graph: decoyGraph(),
    },
  });
  assert.equal(created.status, 201, created.text);
  state.path = created.body.pathId;

  const bad = decoyGraph();
  bad.nodes.night.options[1].to = "doors";
  const refused = await call("alex", "POST", `/circles/${state.circle}/paths`, {
    body: { title: "Loop", cost: 0, graph: bad },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "invalid_path");

  const selfAssigned = await call("alex", "POST", `/circles/${state.circle}/paths`, {
    body: { title: "Mine", cost: 0, assigneeIds: [state.alex], graph: decoyGraph() },
  });
  assert.equal(selfAssigned.body.error, "cannot_assign_yourself");

  const makerView = await call("alex", "GET", `/circles/${state.circle}/paths/${state.path}`);
  assert.equal(makerView.body.canEdit, true);
  assert.equal(makerView.body.graph.start, "doors");

  const seekerView = await call("blair", "GET", `/circles/${state.circle}/paths/${state.path}`);
  assert.equal(seekerView.body.canEdit, false);
  assert.equal(seekerView.body.eligible, true);
  assert.equal(seekerView.body.graph, undefined);
  for (const title of REWARD_TITLES) assert.equal(seekerView.text.includes(title), false);

  const circleView = await call("blair", "GET", `/circles/${state.circle}`);
  const card = circleView.body.paths.find((path) => path.id === state.path);
  assert.equal(card.stats, null);
  for (const title of REWARD_TITLES) assert.equal(circleView.text.includes(title), false);

  const edit = await call("blair", "PATCH", `/circles/${state.circle}/paths/${state.path}`, { body: { title: "Peek" } });
  assert.equal(edit.status, 403, "a seeker who is also a keeper still cannot open the path in the editor");
});

test("quests pay stones and keys once approved by someone else", async () => {
  const quest = await call("alex", "POST", `/circles/${state.circle}/quests`, {
    body: { title: "Dishes all week", points: 50, keyPathId: state.path, recurrence: "weekly" },
  });
  assert.equal(quest.status, 201, quest.text);
  state.quest = quest.body.questId;

  const claim = await call("blair", "POST", `/circles/${state.circle}/quests/${state.quest}/claim`, { body: { note: "Spotless" } });
  assert.equal(claim.status, 201);
  assert.equal(claim.body.status, "pending");
  const twice = await call("blair", "POST", `/circles/${state.circle}/quests/${state.quest}/claim`, { body: {} });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, "already_claimed");

  assert.equal(
    (await call("blair", "POST", `/circles/${state.circle}/claims/${claim.body.claimId}/decide`, { body: { approve: true } })).body.error,
    "cannot_decide_own_claim"
  );
  assert.equal((await call("alex", "POST", `/circles/${state.circle}/quests/${state.quest}/claim`, { body: {} })).body.error, "not_your_quest");

  const approved = await call("alex", "POST", `/circles/${state.circle}/claims/${claim.body.claimId}/decide`, { body: { approve: true } });
  assert.equal(approved.body.status, "approved");
  const again = await call("alex", "POST", `/circles/${state.circle}/claims/${claim.body.claimId}/decide`, { body: { approve: false } });
  assert.equal(again.body.error, "already_decided");

  const view = await call("blair", "GET", `/circles/${state.circle}`);
  assert.equal(view.body.members.find((member) => member.id === state.blair).balance, 50);
  const card = view.body.paths.find((path) => path.id === state.path);
  assert.equal(card.keys, 1);
  assert.equal(view.body.quests.find((q) => q.id === state.quest).state, "approved");
  assert.ok(view.body.events.some((event) => event.type === "claim_approved" && event.data.keyPathTitle === "The Three Doors"));

  const ledger = await call("blair", "GET", `/circles/${state.circle}/ledger`);
  assert.deepEqual(ledger.body.entries.map((entry) => [entry.kind, entry.delta, entry.balanceAfter]), [["quest", 50, 50]]);
});

test("a walk is one way, retry-safe and never shows what was behind the other doors", async () => {
  const opened = await call("blair", "POST", `/circles/${state.circle}/paths/${state.path}/open`, { body: { payWith: "key" } });
  assert.equal(opened.status, 201, opened.text);
  const run = opened.body.run;
  state.run = run.id;
  assert.equal(run.current.type, "choice");
  assert.deepEqual(run.current.options.map((option) => option.icon), ["knife", "stopwatch", "candy"]);
  for (const secret of [...REWARD_TITLES, "Personal protection", "Sweet", "night", "protect"]) {
    assert.equal(opened.text.includes(secret), false, `leaked ${secret}`);
  }

  const first = await call("blair", "POST", `/circles/${state.circle}/runs/${run.id}/step`, {
    body: { nodeId: "doors", optionId: "candy" },
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.record.reveal, "Sweet… but not candy.");
  assert.equal(first.body.run.current.prompt, "Pick a soundtrack for the night:");
  assert.equal(first.text.includes("Personal protection"), false);
  assert.equal(first.text.includes("Concert tickets"), false);

  const replay = await call("blair", "POST", `/circles/${state.circle}/runs/${run.id}/step`, {
    body: { nodeId: "doors", optionId: "candy" },
  });
  assert.equal(replay.body.replayed, true);
  const goBack = await call("blair", "POST", `/circles/${state.circle}/runs/${run.id}/step`, {
    body: { nodeId: "doors", optionId: "knife" },
  });
  assert.equal(goBack.status, 409);
  assert.equal(goBack.body.error, "stale_step");

  assert.equal(
    (await call("alex", "POST", `/circles/${state.circle}/runs/${run.id}/step`, { body: { nodeId: "night", optionId: "live" } })).body.error,
    "not_your_journey"
  );

  const last = await call("blair", "POST", `/circles/${state.circle}/runs/${run.id}/step`, {
    body: { nodeId: "night", optionId: "live" },
  });
  assert.equal(last.body.run.status, "complete");
  assert.equal(last.body.run.reward.title, "Concert tickets for two");
  assert.equal(last.body.run.reward.reveal, "Front row energy.");
  assert.equal(last.body.run.current, null);
  assert.equal(last.body.run.steps.length, 2);

  const done = await call("blair", "POST", `/circles/${state.circle}/runs/${run.id}/step`, {
    body: { nodeId: "concert", optionId: "x" },
  });
  assert.equal(done.body.error, "journey_finished");
});

test("the path maker delivers the treasure; a one-time path cannot be walked twice", async () => {
  assert.equal(
    (await call("blair", "POST", `/circles/${state.circle}/runs/${state.run}/fulfill`, { body: { status: "delivered" } })).body.error,
    "cannot_fulfill_own_reward"
  );
  const alexView = await call("alex", "GET", `/circles/${state.circle}`);
  const treasure = alexView.body.runs.find((run) => run.id === state.run);
  assert.equal(treasure.reward.title, "Concert tickets for two");
  assert.equal(treasure.canFulfill, true);
  const delivered = await call("alex", "POST", `/circles/${state.circle}/runs/${state.run}/fulfill`, {
    body: { status: "delivered", note: "Saturday!" },
  });
  assert.equal(delivered.status, 200);

  const gift = await call("alex", "POST", `/circles/${state.circle}/gifts`, {
    body: { memberId: state.blair, stones: 100, pathId: state.path, note: "Birthday" },
  });
  assert.equal(gift.body.balance, 150);
  const reopen = await call("blair", "POST", `/circles/${state.circle}/paths/${state.path}/open`, { body: { payWith: "key" } });
  assert.equal(reopen.status, 409);
  assert.equal(reopen.body.error, "already_opened");
  assert.equal(
    (await call("alex", "POST", `/circles/${state.circle}/gifts`, { body: { memberId: state.alex, stones: 5 } })).body.error,
    "cannot_gift_yourself"
  );
});

test("stones buy walks; a keeper can cancel one and refund it", async () => {
  const shop = await call("alex", "POST", `/circles/${state.circle}/paths`, {
    body: { title: "Treat Shop", icon: "candy", color: "pink", cost: 60, repeatable: true, graph: decoyGraph() },
  });
  state.shop = shop.body.pathId;

  const bought = await call("blair", "POST", `/circles/${state.circle}/paths/${state.shop}/open`, { body: { payWith: "stones" } });
  assert.equal(bought.status, 201);
  const resumed = await call("blair", "POST", `/circles/${state.circle}/paths/${state.shop}/open`, { body: { payWith: "stones" } });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.resumed, true);
  assert.equal(resumed.body.run.id, bought.body.run.id);

  let view = await call("blair", "GET", `/circles/${state.circle}`);
  assert.equal(view.body.members.find((member) => member.id === state.blair).balance, 90, "charged once");

  const canceled = await call("alex", "POST", `/circles/${state.circle}/runs/${bought.body.run.id}/cancel`);
  assert.equal(canceled.status, 200);
  view = await call("blair", "GET", `/circles/${state.circle}`);
  assert.equal(view.body.members.find((member) => member.id === state.blair).balance, 150);

  const poor = await call("alex", "POST", `/circles/${state.circle}/gifts`, { body: { memberId: state.blair, stones: -1000 } });
  assert.equal(poor.body.error, "not_enough_stones");
  const walkAgain = await call("blair", "POST", `/circles/${state.circle}/paths/${state.shop}/open`, { body: { payWith: "stones" } });
  const spin = await call("blair", "POST", `/circles/${state.circle}/runs/${walkAgain.body.run.id}/step`, {
    body: { nodeId: "doors", optionId: "watch" },
  });
  assert.equal(spin.body.run.current.type, "chance");
  assert.equal(spin.body.run.current.count, 2);
  const outcome = await call("blair", "POST", `/circles/${state.circle}/runs/${walkAgain.body.run.id}/step`, {
    body: { nodeId: "time" },
  });
  assert.equal(outcome.body.run.status, "complete");
  assert.ok(["Surprise day trip", "Weekend getaway"].includes(outcome.body.run.reward.title));
});

test("a keeper plays for a child profile without an account", async () => {
  const kid = await call("alex", "POST", `/circles/${state.circle}/members`, { body: { displayName: "Robin", avatar: "rocket" } });
  assert.equal(kid.status, 201);
  state.robin = kid.body.memberId;
  const chore = await call("alex", "POST", `/circles/${state.circle}/quests`, {
    body: { title: "Make your bed", points: 5, recurrence: "daily", assigneeIds: [state.robin], requiresApproval: false },
  });
  const claimed = await call("alex", "POST", `/circles/${state.circle}/quests/${chore.body.questId}/claim`, {
    as: state.robin,
    body: {},
  });
  assert.equal(claimed.body.status, "approved", "no approval needed for this chore");
  const asRobin = await call("alex", "GET", `/circles/${state.circle}`, { as: state.robin });
  assert.equal(asRobin.body.actorId, state.robin);
  assert.equal(asRobin.body.members.find((member) => member.id === state.robin).balance, 5);
  assert.equal((await call("alex", "GET", `/circles/${state.circle}`, { as: state.blair })).body.error, "not_a_managed_profile");
  const promote = await call("alex", "PATCH", `/circles/${state.circle}/members/${state.robin}`, { body: { role: "keeper" } });
  assert.equal(promote.body.error, "managed_profiles_are_seekers");
});

test("one licence covers ten devices across the whole circle", async () => {
  // Alex's and Blair's phones already hold two of Alex's slots.
  const me = await call("alex", "GET", "/me");
  assert.equal(me.body.license.devicesUsed, 2);
  for (let n = 2; n <= 9; n += 1) {
    assert.equal((await call("blair", "GET", `/circles/${state.circle}`, { device: deviceOf("blair", n) })).status, 200);
  }
  const full = await call("blair", "GET", `/circles/${state.circle}`, { device: deviceOf("blair", 10) });
  assert.equal(full.status, 403);
  assert.deepEqual(
    { error: full.body.error, limit: full.body.limit, used: full.body.used, sponsoredByYou: full.body.sponsoredByYou },
    { error: "device_limit_reached", limit: 10, used: 10, sponsoredByYou: false }
  );
  // A known device keeps working at the limit.
  assert.equal((await call("blair", "GET", `/circles/${state.circle}`, { device: deviceOf("blair", 3) })).status, 200);

  const devices = await call("alex", "GET", "/devices");
  assert.equal(devices.body.devices.length, 10);
  assert.equal((await call("blair", "DELETE", `/devices/${devices.body.devices[0].id}`)).status, 404, "only the licence holder manages its devices");
  assert.equal((await call("alex", "DELETE", `/devices/${devices.body.devices.at(-1).id}`)).status, 200);
  assert.equal((await call("blair", "GET", `/circles/${state.circle}`, { device: deviceOf("blair", 10) })).status, 200);
});

test("a lapsed licence pauses the circle until a keeper with a licence takes it over", async () => {
  await db("product_entitlements").where({ user_id: people.alex.id }).update({ status: "revoked" });
  sharedLicenseCache.clear();
  const read = await call("blair", "GET", `/circles/${state.circle}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.circle.licenseActive, false);
  const write = await call("blair", "POST", `/circles/${state.circle}/quests/${state.quest}/claim`, { body: {} });
  assert.equal(write.status, 402);
  assert.equal(write.body.error, "circle_paused");
  assert.equal((await call("blair", "POST", `/circles/${state.circle}/sponsor`)).body.error, "license_required");

  // Blair subscribes, and takes the circle over.
  await db("product_entitlements").insert({
    id: randomUUID(),
    user_id: people.blair.id,
    product_slug: "romancing-the-stone-subscription",
    source: "manual",
    status: "active",
  });
  sharedLicenseCache.clear();
  const takeover = await call("blair", "POST", `/circles/${state.circle}/sponsor`);
  assert.equal(takeover.status, 200, takeover.text);
  const after = await call("blair", "GET", `/circles/${state.circle}`);
  assert.equal(after.body.circle.licenseActive, true);
  assert.equal(after.body.circle.sponsoredByViewer, true);
  await db("product_entitlements").where({ user_id: people.alex.id }).update({ status: "active" });
  sharedLicenseCache.clear();
});

test("the app hears about changes without polling", async () => {
  const controller = new AbortController();
  const current = (await call("alex", "GET", `/circles/${state.circle}`)).body.circle.seq;
  const response = await fetch(`${base}/circles/${state.circle}/stream?after=${current}`, {
    headers: { Authorization: `Bearer ${people.alex.token}`, "X-RTS-Device": deviceOf("alex") },
    signal: controller.signal,
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const waitFor = async (pattern) => {
    while (!pattern.test(buffer)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
    }
    return buffer;
  };
  await waitFor(/retry: 5000/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(/event: change/.test(buffer), false, "nothing new yet");
  await call("alex", "PATCH", `/circles/${state.circle}`, { body: { name: "Alex + Blair" } });
  const text = await waitFor(/event: change/);
  assert.match(text, /event: change\ndata: \{"seq":\d+\}/);
  assert.ok(Number(text.match(/"seq":(\d+)/)[1]) > current);
  controller.abort();
});

test("leaving keeps a keeper in charge", async () => {
  await call("alex", "PATCH", `/circles/${state.circle}/members/${state.blair}`, { body: { role: "seeker" } });
  const leave = await call("alex", "POST", `/circles/${state.circle}/leave`);
  assert.equal(leave.body.error, "promote_a_keeper_first");
  const demoteSelf = await call("alex", "PATCH", `/circles/${state.circle}/members/${state.alex}`, { body: { role: "seeker" } });
  assert.equal(demoteSelf.body.error, "ask_another_keeper", "nobody sets their own role");
  const removeLastOtherKeeper = await call("blair", "DELETE", `/circles/${state.circle}/members/${state.alex}`);
  assert.equal(removeLastOtherKeeper.body.error, "keepers_only", "Blair is only a seeker right now");
  await call("alex", "PATCH", `/circles/${state.circle}/members/${state.blair}`, { body: { role: "both" } });
});

// -------------------------------------------------------- hardening checks

const fresh = {};

test("validation cost grows with the size of a path, not its number of routes", () => {
  const layered = (layers) => {
    const nodes = {};
    for (let i = 0; i < layers; i += 1) {
      nodes[`n${i}`] = {
        type: "chance",
        options: Array.from({ length: 8 }, (_, k) => ({ id: `o${k}`, to: i === layers - 1 ? "end" : `n${i + 1}` })),
      };
    }
    nodes.end = { type: "reward", title: "End", icon: "gem" };
    return { start: "n0", nodes };
  };
  const started = Date.now();
  const deepest = engine.validateGraph(layered(11));
  assert.equal(deepest.ok, true);
  assert.equal(deepest.stats.routes, engine.ROUTE_CAP);
  assert.match(engine.validateGraph(layered(40)).errors.join(), /at most 12 steps deep/);
  assert.ok(Date.now() - started < 200, "no route enumeration");
  assert.match(engine.validateGraph({ start: "constructor", nodes: {} }).errors.join(), /starting step/);
  const startsAtReward = engine.validateGraph({ start: "r", nodes: { r: { type: "reward", title: "Now", icon: "gem" } } });
  assert.match(startsAtReward.errors.join(), /starts with doors/);
});

test("a fresh circle for the hardening checks", async () => {
  await db("rts_devices").del();
  const created = await call("alex", "POST", "/circles", { body: { name: "Hardening", kind: "friends", displayName: "Alex", role: "both" } });
  assert.equal(created.status, 201, created.text);
  fresh.circle = created.body.circleId;
  fresh.alex = created.body.memberId;
  fresh.blair = (await call("blair", "POST", "/circles/join", { body: { inviteCode: created.body.inviteCode, displayName: "Blair" } })).body.memberId;
  fresh.casey = (await call("casey", "POST", "/circles/join", { body: { inviteCode: created.body.inviteCode, displayName: "Casey" } })).body.memberId;
  fresh.drew = (await call("drew", "POST", "/circles/join", { body: { inviteCode: created.body.inviteCode, displayName: "Drew" } })).body.memberId;
  const path = await call("alex", "POST", `/circles/${fresh.circle}/paths`, {
    body: { title: "Secret Doors", cost: 0, repeatable: true, graph: decoyGraph() },
  });
  fresh.path = path.body.pathId;
  assert.equal((await call("alex", "POST", "/circles", { body: { name: "X", kind: "team", displayName: "A", role: "seeker" } })).status, 400, "whoever starts a circle keeps it");
});

test("roles are set by someone else, and anyone who has seen behind the doors can never walk them", async () => {
  const selfPromote = await call("blair", "PATCH", `/circles/${fresh.circle}/members/${fresh.blair}`, { body: { role: "keeper" } });
  assert.equal(selfPromote.body.error, "ask_another_keeper");
  // Alex makes Blair a keeper; Blair looks behind the doors; Alex turns her back into a seeker.
  assert.equal((await call("alex", "PATCH", `/circles/${fresh.circle}/members/${fresh.blair}`, { body: { role: "keeper" } })).status, 200);
  const peek = await call("blair", "GET", `/circles/${fresh.circle}/paths/${fresh.path}`);
  assert.equal(peek.body.graph.start, "doors");
  assert.equal((await call("alex", "PATCH", `/circles/${fresh.circle}/members/${fresh.blair}`, { body: { role: "both" } })).status, 200);
  const after = await call("blair", "GET", `/circles/${fresh.circle}/paths/${fresh.path}`);
  assert.equal(after.body.eligible, false, "she has seen it");
  assert.equal((await call("blair", "POST", `/circles/${fresh.circle}/paths/${fresh.path}/open`, { body: { payWith: "free" } })).body.error, "not_your_path");
  // Casey never looked, so Casey still can.
  assert.equal((await call("casey", "GET", `/circles/${fresh.circle}/paths/${fresh.path}`)).body.eligible, true);
});

test("a keeper cannot pay themselves with a quest", async () => {
  const selfAssigned = await call("blair", "POST", `/circles/${fresh.circle}/quests`, {
    body: { title: "Pay me", points: 100000, recurrence: "always", assigneeIds: [fresh.blair], requiresApproval: false },
  });
  assert.equal(selfAssigned.body.error, "cannot_assign_yourself");
  // A no-approval quest made by someone else still waits for approval when a keeper claims it.
  const quest = await call("alex", "POST", `/circles/${fresh.circle}/quests`, {
    body: { title: "Water the plants", points: 10, recurrence: "always", requiresApproval: false },
  });
  const claim = await call("blair", "POST", `/circles/${fresh.circle}/quests/${quest.body.questId}/claim`, { body: {} });
  assert.equal(claim.body.status, "pending");
  // Raising the points after the claim does not change what it pays.
  await call("blair", "PATCH", `/circles/${fresh.circle}/quests/${quest.body.questId}`, { body: { points: 5000 } });
  await call("alex", "POST", `/circles/${fresh.circle}/claims/${claim.body.claimId}/decide`, { body: { approve: true } });
  const view = await call("blair", "GET", `/circles/${fresh.circle}`);
  assert.equal(view.body.members.find((member) => member.id === fresh.blair).balance, 10);
  fresh.quest = quest.body.questId;
});

test("archiving a path keeps its rewards secret from other seekers", async () => {
  const walk = await call("casey", "POST", `/circles/${fresh.circle}/paths/${fresh.path}/open`, { body: { payWith: "free" } });
  await call("casey", "POST", `/circles/${fresh.circle}/runs/${walk.body.run.id}/step`, { body: { nodeId: "doors", optionId: "candy" } });
  await call("casey", "POST", `/circles/${fresh.circle}/runs/${walk.body.run.id}/step`, { body: { nodeId: "night", optionId: "live" } });
  await call("alex", "DELETE", `/circles/${fresh.circle}/paths/${fresh.path}`);
  // Drew could still have won it and never looked behind the doors.
  const drewView = await call("drew", "GET", `/circles/${fresh.circle}`);
  for (const title of REWARD_TITLES) assert.equal(drewView.text.includes(title), false, `${title} leaked after archiving`);
  const caseyView = await call("casey", "GET", `/circles/${fresh.circle}`);
  assert.ok(caseyView.text.includes("Concert tickets for two"), "the winner still sees it");
});

test("a departing sponsor takes the licence with them; a keeper with a licence takes over", async () => {
  // Casey claims and then gets removed: the claim is closed, not stuck.
  await call("alex", "PATCH", `/circles/${fresh.circle}/members/${fresh.casey}`, { body: { role: "seeker" } });
  const approvalQuest = await call("alex", "POST", `/circles/${fresh.circle}/quests`, {
    body: { title: "Fold the laundry", points: 5, recurrence: "always", requiresApproval: true },
  });
  const pending = await call("casey", "POST", `/circles/${fresh.circle}/quests/${approvalQuest.body.questId}/claim`, { body: {} });
  assert.equal(pending.body.status, "pending");
  await call("alex", "DELETE", `/circles/${fresh.circle}/members/${fresh.casey}`);
  const closed = await db("rts_claims").where({ id: pending.body.claimId }).first();
  assert.equal(closed.status, "rejected");

  // Blair removes Alex, whose licence powers the circle.
  const removed = await call("blair", "DELETE", `/circles/${fresh.circle}/members/${fresh.alex}`);
  assert.equal(removed.status, 200, removed.text);
  const circleRow = await db("rts_circles").where({ id: fresh.circle }).first();
  assert.equal(circleRow.sponsor_user_id, null);
  const paused = await call("blair", "POST", `/circles/${fresh.circle}/quests/${fresh.quest}/claim`, { body: {} });
  assert.equal(paused.body.error, "circle_paused");
  const view = await call("blair", "GET", `/circles/${fresh.circle}`);
  assert.equal(view.body.circle.licenseActive, false);
  assert.ok(view.body.events.some((event) => event.type === "sponsor_left"));
  // Blair has her own licence (from the lapsed-licence test) and takes over.
  sharedLicenseCache.clear();
  assert.equal((await call("blair", "POST", `/circles/${fresh.circle}/sponsor`)).status, 200);
  assert.equal((await call("blair", "GET", `/circles/${fresh.circle}`)).body.circle.licenseActive, true);
});

test("a child profile sees its own reward when a keeper plays for it", async () => {
  const kid = await call("blair", "POST", `/circles/${fresh.circle}/members`, { body: { displayName: "Kit" } });
  const path = await call("blair", "POST", `/circles/${fresh.circle}/paths`, {
    body: { title: "Kid doors", cost: 0, assigneeIds: [kid.body.memberId], graph: decoyGraph() },
  });
  const walk = await call("blair", "POST", `/circles/${fresh.circle}/paths/${path.body.pathId}/open`, {
    as: kid.body.memberId,
    body: { payWith: "free" },
  });
  await call("blair", "POST", `/circles/${fresh.circle}/runs/${walk.body.run.id}/step`, { as: kid.body.memberId, body: { nodeId: "doors", optionId: "knife" } });
  const done = await call("blair", "POST", `/circles/${fresh.circle}/runs/${walk.body.run.id}/step`, {
    as: kid.body.memberId,
    body: { nodeId: "protect", optionId: "stand" },
  });
  assert.equal(done.body.run.reward.title, "Self-defense class for two");
});

// ------------------------------------------------------------------ billing

function fakeStripe(subscriptions = {}) {
  const updates = [];
  const cancels = [];
  return {
    updates,
    cancels,
    subscriptions: {
      async retrieve(id) {
        return subscriptions[id];
      },
      async list({ customer }) {
        return { data: Object.values(subscriptions).filter((sub) => sub.customer === customer) };
      },
      async update(id, params) {
        updates.push([id, params]);
        return { id, ...params };
      },
      async cancel(id) {
        cancels.push(id);
        return { id, status: "canceled" };
      },
    },
  };
}

async function license(name) {
  sharedLicenseCache.clear();
  return resolveLicense(db, { userId: people[name].id, email: people[name].email }, getRtsConfig());
}

test("the subscription is granted by its status and ends with it", async () => {
  const userId = people.casey.id;
  const trialEnd = Math.floor(Date.now() / 1000) + 183 * 86400;
  const sub = {
    id: "sub_casey",
    customer: "cus_casey",
    status: "trialing",
    trial_end: trialEnd,
    current_period_end: trialEnd,
    metadata: {
      user_id: userId,
      plan: "rts_subscription",
      product_slug: "romancing-the-stone",
      entitlement_slug: "romancing-the-stone-subscription",
    },
  };
  const stripe = fakeStripe({ sub_casey: sub });
  const checkout = {
    id: "cs_casey",
    customer: "cus_casey",
    subscription: "sub_casey",
    payment_status: "paid",
    amount_total: 3000,
    metadata: {
      user_id: userId,
      product_slug: "romancing-the-stone",
      fulfillment_type: "multi_entitlement_cart",
      checkout_items: JSON.stringify([
        {
          kind: "subscription",
          slug: "romancing-the-stone",
          entitlementSlug: "romancing-the-stone-subscription",
          unitAmountCents: 3000,
          quantity: 1,
        },
      ]),
    },
  };
  await handleCheckoutSessionCompleted(checkout, stripe);
  const row = await db("product_entitlements").where({ user_id: userId, product_slug: "romancing-the-stone-subscription" }).first();
  assert.equal(row.status, "active");
  assert.equal(row.source, "stripe_subscription", "granted from the subscription, not the checkout");
  assert.equal(row.source_ref, "subscription:sub_casey:romancing-the-stone");
  let current = await license("casey");
  assert.equal(current.plan, "subscription");
  assert.ok(current.subscription.includedUntil);

  // Casey can now start a circle.
  const created = await call("casey", "POST", "/circles", { body: { name: "Team", kind: "team", displayName: "Casey" } });
  assert.equal(created.status, 201);

  // Stripe cancels; access ends.
  sub.status = "canceled";
  await rtsBilling.syncRtsSubscriptionEntitlement({ userId, subscription: sub });
  await db("subscriptions").where({ provider_subscription_id: "sub_casey" }).update({ status: "canceled" });
  current = await license("casey");
  assert.equal(current.active, false);
});

test("a stale subscription entitlement does not outlive the subscription row", async () => {
  const userId = people.drew.id;
  await db("subscriptions").insert({
    id: randomUUID(),
    user_id: userId,
    provider: "stripe",
    provider_subscription_id: "sub_drew",
    plan: "rts_subscription",
    status: "past_due",
    raw: JSON.stringify({ past_due_since: new Date(Date.now() - 9 * 86400_000).toISOString() }),
  });
  await db("product_entitlements").insert({
    id: randomUUID(),
    user_id: userId,
    product_slug: "romancing-the-stone-subscription",
    source: "stripe_subscription",
    source_ref: "subscription:sub_drew:romancing-the-stone",
    status: "active",
  });
  assert.equal((await license("drew")).active, false, "seven-day past-due grace is over");
});

test("buying the permanent licence stops the $5/month renewal", async () => {
  const userId = people.drew.id;
  await db("subscriptions").where({ provider_subscription_id: "sub_drew" }).update({ status: "trialing" });
  const stripe = fakeStripe();
  await handleCheckoutSessionCompleted(
    {
      id: "cs_drew_perm",
      customer: "cus_drew",
      payment_intent: "pi_drew_perm",
      payment_status: "paid",
      amount_total: 12000,
      metadata: {
        user_id: userId,
        product_slug: "romancing-the-stone-permanent",
        fulfillment_type: "multi_entitlement_cart",
        checkout_items: JSON.stringify([
          {
            kind: "product",
            slug: "romancing-the-stone-permanent",
            entitlementSlug: "romancing-the-stone-permanent",
            unitAmountCents: 12000,
            quantity: 1,
          },
        ]),
      },
    },
    stripe
  );
  assert.deepEqual(stripe.updates, [["sub_drew", { cancel_at_period_end: true, metadata: { superseded_by: "romancing-the-stone-permanent" } }]]);
  assert.deepEqual(stripe.cancels, []);
  const current = await license("drew");
  assert.equal(current.plan, "permanent");
  assert.equal(await rtsBilling.rtsExistingLicense(userId), "permanent");
  assert.equal(await rtsBilling.rtsExistingLicense(people.casey.id), null);
});

test("the shared checkout knows both licences and refuses duplicates", async () => {
  const { billingRouter } = await import("../src/routes/billing.routes.js");
  const app = express();
  app.use(express.json());
  app.use("/v1/billing", billingRouter);
  const billingServer = app.listen(0, "127.0.0.1");
  await once(billingServer, "listening");
  const checkout = (name, productSlug) =>
    fetch(`http://127.0.0.1:${billingServer.address().port}/v1/billing/catalog/checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${people[name].token}` },
      body: JSON.stringify({ productSlug }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
  try {
    // Alex already owns it permanently.
    assert.deepEqual((await checkout("alex", "romancing-the-stone-permanent")).body.error, "already_owned");
    assert.deepEqual((await checkout("alex", "romancing-the-stone")).body.error, "already_owned");
    // Blair's subscription is active, so a second one is refused, but an upgrade is not.
    assert.equal((await checkout("blair", "romancing-the-stone")).body.error, "subscription_already_active");
    const upgrade = await checkout("blair", "romancing-the-stone-permanent");
    assert.equal(upgrade.body.error, "stripe_not_configured", "passes every licence check and reaches Stripe");
    // Switched off, nothing can be bought.
    process.env.RTS_ENABLED = "false";
    assert.equal((await checkout("casey", "romancing-the-stone")).status, 503);
    process.env.RTS_ENABLED = "true";
  } finally {
    billingServer.closeAllConnections?.();
    await new Promise((resolve) => billingServer.close(resolve));
  }
});

test("an upgrade finds subscriptions Stripe knows about, and cancels unpaid ones outright", async () => {
  const stripe = fakeStripe({
    sub_new: { id: "sub_new", customer: "cus_new", status: "trialing", metadata: { plan: "rts_subscription" } },
    sub_owed: { id: "sub_owed", customer: "cus_new", status: "past_due", metadata: { plan: "rts_subscription" } },
    sub_other: { id: "sub_other", customer: "cus_new", status: "active", metadata: { plan: "tabforge_private_sync" } },
  });
  const stopped = await rtsBilling.afterRtsPermanentPurchase({ userId: people.casey.id, stripe, customerId: "cus_new" });
  assert.equal(stopped, 2);
  assert.deepEqual(stripe.updates.map(([id]) => id), ["sub_new"]);
  assert.deepEqual(stripe.cancels, ["sub_owed"]);
  // A Stripe failure is not swallowed, so the webhook is retried.
  const broken = fakeStripe({ sub_x: { id: "sub_x", customer: "cus_x", status: "active", metadata: { plan: "rts_subscription" } } });
  broken.subscriptions.update = async () => {
    throw new Error("stripe down");
  };
  await assert.rejects(rtsBilling.afterRtsPermanentPurchase({ userId: people.casey.id, stripe: broken, customerId: "cus_x" }), /stripe down/);
});

test("the module can be switched off and its tables removed", async () => {
  process.env.RTS_ENABLED = "false";
  const response = await call("alex", "GET", "/me");
  assert.equal(response.status, 503);
  assert.equal(response.body.error, "service_unavailable");
  process.env.RTS_ENABLED = "true";

  await down(db);
  for (const table of ["rts_circles", "rts_members", "rts_runs", "rts_devices", "rts_events"]) {
    assert.equal(await db.schema.hasTable(table), false, table);
  }
  assert.equal(await db.schema.hasTable("product_entitlements"), true, "shared tables are untouched");
  await up(db);
  assert.equal(await db.schema.hasTable("rts_circles"), true, "and it applies cleanly again");
});
