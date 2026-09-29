// My Home Builder client portal: logins, the Muskegon project files, quotes, invoices,
// templates, Stripe pay links and receipts, documents and e-signing, the admin panel, and labor
// (the crew portal, paperwork, lien waivers and job costs).
//
// The handler tests call the portal code with Web Requests, as the router does. The HTTP
// tests run the real Express router. Both use the real migration on an in-process Postgres
// (PGlite). SendGrid and Stripe are faked at fetch; requests to the local server pass through.

import assert from "node:assert/strict";
import { once } from "node:events";
import test, { after, before, beforeEach } from "node:test";
import express from "express";

process.env.MHB_PORTAL_ENABLED = "true";
process.env.MHB_PROXY_SECRET = "mhb-test-proxy-secret-that-is-long-enough-0001";
process.env.MHB_SESSION_SECRET = "mhb-test-session-secret-that-is-long-and-unique";
process.env.MHB_CLIENT_PORTAL_PASSWORD = "test-project-login";
process.env.MHB_STRIPE_SECRET_KEY = "sk_test_123";
process.env.MHB_STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.MHB_SITE_URL = "https://myhomebuilderllc.com";
process.env.SENDGRID_API_KEY = "SG.test.key";

const { db } = await import("../src/config/db.js");
const { attachPglite } = await import("./helpers/pglite-db.js");
const { up } = await import("../src/db/migrations/20260925_create_myhomebuilder_portal.js");
const { up: plainNumbers } = await import("../src/db/migrations/20260925_myhomebuilder_portal_plain_numbers.js");
const { up: recipientsTable } = await import("../src/db/migrations/20260925_myhomebuilder_portal_recipients.js");
const { up: projectEmails } = await import("../src/db/migrations/20260927_myhomebuilder_portal_project_emails.js");
const { up: booksTables } = await import("../src/db/migrations/20260930_myhomebuilder_portal_books.js");
const { up: stripeEvents } = await import("../src/db/migrations/20261003_myhomebuilder_portal_stripe_events.js");
const { up: laborTables } = await import("../src/db/migrations/20261004_myhomebuilder_portal_labor.js");
const { myhomebuilderPortalRouter, portalEnv } = await import("../src/modules/myhomebuilder-portal/index.js");
const { handlePortalRequest } = await import("../src/modules/myhomebuilder-portal/handler.js");
const { ADMIN_SESSION_TTL_SECONDS, createAdminSession, hmacHex, isValidSlug, slugify } = await import(
  "../src/modules/myhomebuilder-portal/security.js"
);
const { addressesText, parseEmailList } = await import("../src/modules/myhomebuilder-portal/email.js");
const { parseLineItems, parseMoney, addDays, todayInMichigan } = await import("../src/modules/myhomebuilder-portal/billing.js");
const { STRIPE_API_VERSION } = await import("../src/modules/myhomebuilder-portal/stripe.js");
const { createStore, putBilling } = await import("../src/modules/myhomebuilder-portal/store.js");
const { PDFDocument } = await import("../src/modules/myhomebuilder-portal/vendor/pdf-lib.js");

// ---------- Fakes for SendGrid and Stripe ----------

// email.failures holds statuses SendGrid returns for the next requests (outages and rate limits).
const email = { delivered: [], failures: [] };
// charges, refunds (by charge), disputes and intents (their metadata) serve refund and dispute
// events; unavailable makes every Stripe request fail.
const stripe = { created: [], expired: [], versions: new Set(), sessions: new Map(), charges: new Map(), refunds: new Map(), disputes: new Map(), intents: new Map(), unavailable: false };
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const headers = new Headers(init.headers || {});

  if (url === "https://api.sendgrid.com/v3/mail/send") {
    const body = JSON.parse(init.body);
    const failure = email.failures.shift();
    if (failure) return Response.json({ errors: [{ message: "unavailable" }] }, { status: failure });
    const id = `msg_${email.delivered.length + 1}`;
    email.delivered.push({
      id,
      to: body.personalizations[0].to.map((recipient) => recipient.email),
      from: body.from,
      reply_to: body.reply_to,
      subject: body.subject,
      text: body.content.find((part) => part.type === "text/plain")?.value,
      html: body.content.find((part) => part.type === "text/html")?.value,
      categories: body.categories,
      tracking: body.tracking_settings
    });
    return new Response(null, { status: 202, headers: { "X-Message-Id": id } });
  }

  if (url.startsWith("https://api.stripe.com/v1/")) {
    stripe.versions.add(headers.get("Stripe-Version"));
    if (stripe.unavailable) return Response.json({ error: { message: "Stripe is unavailable" } }, { status: 500 });
    const path = url.slice("https://api.stripe.com/v1".length);
    const charge = path.match(/^\/charges\/([^/?]+)$/u);
    if (charge) return stripe.charges.has(charge[1]) ? Response.json(stripe.charges.get(charge[1])) : Response.json({ error: { message: "No such charge" } }, { status: 404 });
    if (path.startsWith("/refunds?")) return Response.json({ object: "list", data: stripe.refunds.get(new URLSearchParams(path.split("?")[1]).get("charge")) || [] });
    const dispute = path.match(/^\/disputes\/([^/?]+)$/u);
    if (dispute) return stripe.disputes.has(dispute[1]) ? Response.json(stripe.disputes.get(dispute[1])) : Response.json({ error: { message: "No such dispute" } }, { status: 404 });
    if (path === "/checkout/sessions" && init.method === "POST") {
      const params = Object.fromEntries(new URLSearchParams(init.body));
      const id = `cs_test_${stripe.created.length + 1}`;
      stripe.created.push(params);
      const session = {
        id,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        status: "open",
        payment_status: "unpaid",
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        amount_total: Number(params["line_items[0][price_data][unit_amount]"]),
        metadata: { clientSlug: params["metadata[clientSlug]"], invoiceId: params["metadata[invoiceId]"], invoiceNumber: params["metadata[invoiceNumber]"] }
      };
      stripe.sessions.set(id, session);
      return Response.json(session);
    }
    const expire = path.match(/^\/checkout\/sessions\/([^/]+)\/expire$/u);
    if (expire) {
      stripe.expired.push(expire[1]);
      const session = stripe.sessions.get(expire[1]);
      if (session) session.status = "expired";
      return Response.json(session || {});
    }
    const retrieve = path.match(/^\/checkout\/sessions\/([^/?]+)$/u);
    if (retrieve) {
      const session = stripe.sessions.get(retrieve[1]);
      return session ? Response.json(session) : Response.json({ error: { message: "No such session" } }, { status: 404 });
    }
    if (path.startsWith("/payment_intents/")) {
      const id = path.split("/")[2].split("?")[0];
      return Response.json({
        id,
        metadata: stripe.intents.get(id)?.metadata || {},
        latest_charge: {
          receipt_url: "https://pay.stripe.com/receipts/test_receipt",
          payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
          balance_transaction: { fee: 262 }
        }
      });
    }
  }
  return realFetch(input, init);
};

function payStripeSession(id, overrides = {}) {
  const session = stripe.sessions.get(id);
  Object.assign(session, {
    status: "complete",
    payment_status: "paid",
    payment_intent: "pi_test_123",
    customer_details: { email: "payer@example.com" },
    url: null,
    ...overrides
  });
  return session;
}

function deliveredTo(address) {
  return email.delivered.filter((message) => message.to.includes(address));
}

// ---------- Database and server ----------

const MHB_TABLES = ["mhb_clients", "mhb_billing", "mhb_counters", "mhb_templates", "mhb_documents", "mhb_files", "mhb_sent_emails", "mhb_admin_challenges", "mhb_rate_limits", "mhb_recipients", "mhb_journal_lines", "mhb_journal_entries", "mhb_activity", "mhb_stripe_events", "mhb_labor", "mhb_workers", "mhb_secure", "mhb_settings"];
let server;
let base;
let renumbered = [];
let backfilled = [];
let migratedClients = [];
let migratedBilling = [];

// Projects and payments as they were before project email lists, for the fourth migration.
async function insertLegacyProjects() {
  const client = (slug, data) => ({ slug, data: JSON.stringify({ slug, name: slug, active: true, ...data }) });
  await db("mhb_clients").insert([
    client("single-email", { email: "Single@Example.com" }),
    client("never-emailed", { email: "" }),
    client("emailed-before", {})
  ]);
  const billing = (id, slug, number, extra) => {
    const data = { id, clientSlug: slug, kind: "invoice", number, createdAt: "2026-09-20T12:00:00.000Z", amountCents: 500000, ...extra };
    return { id, client_slug: slug, kind: "invoice", number, data: JSON.stringify(data), created_at: data.createdAt };
  };
  await db("mhb_billing").insert([
    billing("older-send", "emailed-before", "900", { sentTo: "old@example.com", sentAt: "2026-09-20T12:00:00.000Z" }),
    billing("newer-send", "emailed-before", "901", { sentTo: "pcm@example.com", sentAt: "2026-09-27T12:00:00.000Z" }),
    billing("single-send", "single-email", "902", { sentTo: "other@example.com", sentAt: "2026-09-27T12:00:00.000Z" }),
    billing("zelle-edited", "emailed-before", "903", { status: "paid", payment: { source: "manual", method: "zelle", label: "Zelle", amountCents: 1500000 } }),
    billing("stripe-edited", "emailed-before", "904", { status: "paid", payment: { source: "stripe", label: "Visa •••• 4242", amountCents: 1500000 } })
  ]);
}

// Records made before numbers became plain, to check the second migration rewrites them.
async function insertLegacyNumbers() {
  const legacy = [
    { id: "legacy-inv", kind: "invoice", number: "INV-0012", extra: { fromQuoteNumber: "QUO-0003", sentTo: "Owner@Example.com", sentAt: "2026-09-24T12:30:00.000Z" } },
    { id: "legacy-quo", kind: "quote", number: "QUO-0003", extra: { invoiceNumber: "INV-0012" } }
  ];
  for (const record of legacy) {
    const data = { id: record.id, clientSlug: "muskegon-addition", kind: record.kind, number: record.number, createdAt: "2026-09-24T12:00:00.000Z", ...record.extra };
    await db("mhb_billing").insert({ id: record.id, client_slug: "muskegon-addition", kind: record.kind, number: record.number, data: JSON.stringify(data), created_at: data.createdAt });
  }
}

before(async () => {
  await attachPglite(db);
  await up(db);
  await insertLegacyNumbers();
  await plainNumbers(db);
  renumbered = await db("mhb_billing").orderBy("id").select("kind", "number", "data");
  // A receipt and a builder notice sent before the recipients list existed.
  await db("mhb_sent_emails").insert([
    { key: "muskegon-addition:legacy-inv:receipt", recipient: "payer@example.com", status: "sent", sent_at: "2026-09-24T13:00:00.000Z" },
    { key: "muskegon-addition:legacy-inv:paid-notice", recipient: "mb@myhomebuilderllc.com", status: "sent", sent_at: "2026-09-24T13:00:01.000Z" }
  ]);
  await recipientsTable(db);
  backfilled = await db("mhb_recipients").orderBy("last_sent_at", "desc").select("email", "display");
  await insertLegacyProjects();
  await projectEmails(db);
  await booksTables(db);
  await stripeEvents(db);
  await laborTables(db);
  migratedClients = (await db("mhb_clients").orderBy("slug").select("data")).map((row) => json(row.data));
  migratedBilling = (await db("mhb_billing").whereIn("id", ["zelle-edited", "stripe-edited"]).orderBy("id").select("data")).map((row) => json(row.data));
  const app = express();
  app.use("/v1/myhomebuilder/portal", myhomebuilderPortalRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/v1/myhomebuilder/portal`;
});

beforeEach(async () => {
  await db.raw(`TRUNCATE ${MHB_TABLES.join(", ")}`);
  email.delivered.length = 0;
  email.failures.length = 0;
  stripe.created.length = 0;
  stripe.expired.length = 0;
  stripe.sessions.clear();
  for (const map of [stripe.charges, stripe.refunds, stripe.disputes, stripe.intents]) map.clear();
  stripe.unavailable = false;
  process.env.MHB_PORTAL_ENABLED = "true";
  delete process.env.ADMIN_WRITES_ENABLED;
});

after(async () => {
  server?.close();
});

function json(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function billingRecords() {
  return (await db("mhb_billing").select("data")).map((row) => json(row.data));
}

async function stored(item) {
  return json((await db("mhb_billing").where({ id: item.id }).first()).data);
}

async function sentEmail(key) {
  return db("mhb_sent_emails").where({ key }).first();
}

// ---------- Handler requests ----------

function portal(overrides = {}) {
  return { ...portalEnv(), ...overrides };
}

function request(path, init = undefined, env = portal()) {
  return handlePortalRequest({ request: new Request(`https://myhomebuilderllc.com${path}`, init), env });
}

function cookieValue(response) {
  return response.headers.get("Set-Cookie").split(";")[0];
}

function form(fields, cookies = "", headers = {}) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) body.append(name, entry);
  }
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookies ? { Cookie: cookies } : {}), ...headers },
    body
  };
}

function lines(...rows) {
  return {
    itemDescription: rows.map((row) => row[0]),
    itemQuantity: rows.map((row) => row[1]),
    itemUnitPrice: rows.map((row) => row[2])
  };
}

async function loginAsClient(password = process.env.MHB_CLIENT_PORTAL_PASSWORD, env = portal()) {
  const response = await request("/clients/login", form({ password }), env);
  assert.equal(response.status, 303);
  return cookieValue(response);
}

let adminIp = 0;
async function loginAsAdmin(env = portal(), cookies = "") {
  adminIp += 1;
  const headers = { "CF-Connecting-IP": `203.0.113.${adminIp % 250}`, ...(cookies ? { Cookie: cookies } : {}) };
  const requested = await request("/clients/admin/request", { method: "POST", headers }, env);
  assert.equal(requested.status, 200);
  assert.match(await requested.text(), /action="\/clients\/admin\/verify"/u);
  const code = email.delivered.at(-1).text.match(/Verification code: (\d{6})/u)[1];
  const verify = await request("/clients/admin/verify", form({ code }, cookies), env);
  assert.equal(verify.status, 303);
  assert.equal(verify.headers.get("Location"), "/clients/admin");
  const adminCookie = cookieValue(verify);
  return cookies ? `${cookies}; ${adminCookie}` : adminCookie;
}

async function setClientEmail(adminCookie, addresses = "client@example.com") {
  const response = await request("/clients/admin/clients/muskegon-addition/profile", form({ emails: addresses }, adminCookie));
  assert.equal(response.status, 303);
}

async function projectRecord(slug = "muskegon-addition") {
  const row = await db("mhb_clients").where({ slug }).first();
  return row ? json(row.data) : null;
}

async function postInvoice(adminCookie, fields) {
  const before = new Set((await billingRecords()).map((item) => item.id));
  const response = await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "invoice", ...fields }, adminCookie));
  assert.equal(response.status, 303, await response.clone().text());
  const item = (await billingRecords()).find((entry) => !before.has(entry.id));
  return { response, item };
}

async function signedWebhook(type, session, { http = false, id = `evt_${Math.random()}` } = {}) {
  const payload = JSON.stringify({ id, type, created: Math.floor(Date.now() / 1000), data: { object: session } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacHex(process.env.MHB_STRIPE_WEBHOOK_SECRET, `${timestamp}.${payload}`);
  const init = { method: "POST", headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}`, "Content-Type": "application/json" }, body: payload };
  return http ? realFetch(`${base}/stripe/webhook`, init) : request("/clients/stripe/webhook", init);
}

async function samplePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  return pdf.save();
}

function multipart(fields, file, cookies) {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  body.append("file", new File([file.bytes], file.name, { type: file.type }));
  return { method: "POST", headers: { Cookie: cookies }, body };
}

// Requests as the site's forwarding Function sends them.
function proxied(path, init = {}, { ip = "198.51.100.20", origin = "https://myhomebuilderllc.com", key = process.env.MHB_PROXY_SECRET } = {}) {
  const headers = new Headers(init.headers || {});
  if (key) headers.set("X-MHB-Proxy-Key", key);
  if (origin) headers.set("X-MHB-Origin", origin);
  if (ip) headers.set("X-MHB-Client-Ip", ip);
  return realFetch(`${base}${path}`, { ...init, headers, redirect: "manual" });
}

// ---------- Login and the Muskegon project ----------

test("shows a no-store login page without revealing projects", async () => {
  const response = await request("/clients");
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control"), /no-store/u);
  assert.equal(response.headers.get("Vary"), "Cookie");
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow, noarchive");
  assert.match(body, /Private project access/u);
  assert.match(body, /Administrator access/u);
  assert.doesNotMatch(body, /muskegon-addition-selections/u);

  const head = await request("/clients", { method: "HEAD" });
  assert.equal(head.status, 200);
});

test("rejects an incorrect login, and a correct one opens the Muskegon project", async () => {
  const wrong = await request("/clients/login", form({ password: "incorrect" }));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("Set-Cookie"), null);
  assert.match(await wrong.text(), /not recognized/u);

  const login = await request("/clients/login", form({ password: process.env.MHB_CLIENT_PORTAL_PASSWORD }));
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("Location"), "/clients");
  assert.match(login.headers.get("Set-Cookie"), /HttpOnly/u);
  assert.match(login.headers.get("Set-Cookie"), /Secure/u);
  assert.match(login.headers.get("Set-Cookie"), /Path=\/clients/u);
  const cookie = cookieValue(login);

  const home = await (await request("/clients", { headers: { Cookie: cookie } })).text();
  assert.match(home, /Muskegon Addition Selections/u);
  assert.match(home, /href="\/clients\/muskegon-addition\/material-render\/\?scene=kitchen"/u);

  const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("a") ? "b" : "a"}`;
  assert.match(await (await request("/clients", { headers: { Cookie: tampered } })).text(), /Private project access/u);
});

test("grants the Muskegon project files only to a signed-in client, with protective headers", async () => {
  for (const path of ["/clients/muskegon-addition/", "/clients/muskegon-addition/material-render/assets/index-test.js"]) {
    const anonymous = await request(path);
    assert.equal(anonymous.status, 303, path);
    assert.equal(anonymous.headers.get("Location"), `/clients?next=${encodeURIComponent(path)}`, path);
    assert.equal(anonymous.headers.get("X-MHB-Asset"), null, path);
  }

  const cookie = await loginAsClient();
  const grant = await request("/clients/muskegon-addition/material-render/assets/scenes/kitchen-base-corrected.png", { headers: { Cookie: cookie } });
  assert.equal(grant.status, 200);
  assert.equal(grant.headers.get("X-MHB-Asset"), "/clients/muskegon-addition/material-render/assets/scenes/kitchen-base-corrected.png");
  assert.match(grant.headers.get("Content-Security-Policy"), /script-src 'self'/u);
  assert.match(grant.headers.get("Content-Security-Policy"), /worker-src 'self' blob:/u);
  assert.match(grant.headers.get("Cache-Control"), /no-store/u);
  assert.equal(grant.headers.get("X-Robots-Tag"), "noindex, nofollow, noarchive");

  const root = await request("/clients/muskegon-addition", { headers: { Cookie: cookie } });
  assert.equal(root.headers.get("X-MHB-Asset"), "/clients/muskegon-addition/");
  const post = await request("/clients/muskegon-addition/material-render/", { method: "POST", headers: { Cookie: cookie } });
  assert.equal(post.status, 405);
});

test("returns a client to the exact protected deep link and never to another destination", async () => {
  const destination = "/clients/muskegon-addition/material-render/?scene=kitchen&design=shared-test";
  const loginPage = await (await request(`/clients?next=${encodeURIComponent(destination)}`)).text();
  assert.match(loginPage, /scene=kitchen&amp;design=shared-test/u);
  const login = await request("/clients/login", form({ password: process.env.MHB_CLIENT_PORTAL_PASSWORD, next: destination }));
  assert.equal(login.headers.get("Location"), destination);

  for (const other of ["https://example.com/steal", "//example.com/steal", "/clients/another-project/", "javascript:alert(1)"]) {
    const response = await request("/clients/login", form({ password: process.env.MHB_CLIENT_PORTAL_PASSWORD, next: other }));
    assert.equal(response.headers.get("Location"), "/clients", other);
  }
});

test("logout expires the session, method rules hold, and the portal fails closed without its settings", async () => {
  const logout = await request("/clients/logout", { method: "POST" });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get("Set-Cookie"), /Max-Age=0/u);
  assert.equal((await request("/clients/login", { method: "PUT" })).headers.get("Allow"), "GET, HEAD, POST");
  assert.equal((await request("/clients/logout")).headers.get("Allow"), "POST");
  assert.equal((await request("/clients", undefined, portal({ CLIENT_PORTAL_PASSWORD: "" }))).status, 503);
});

// ---------- Admin access ----------

test("admin code goes to mb@myhomebuilderllc.com from billing@ and unlocks the admin panel", async () => {
  const clientCookie = await loginAsClient();
  const adminCookie = await loginAsAdmin(portal(), clientCookie);
  const codeEmail = email.delivered.at(-1);
  assert.deepEqual(codeEmail.to, ["mb@myhomebuilderllc.com"]);
  assert.equal(codeEmail.from.email, "billing@myhomebuilderllc.com");
  assert.match(codeEmail.subject, /^\d{6} is your My Home Builder admin code$/u);

  const dashboard = await request("/clients/admin", { headers: { Cookie: adminCookie } });
  assert.equal(dashboard.status, 200);
  const body = await dashboard.text();
  assert.match(body, /Manage client portals/u);
  assert.match(body, /Portal storage: ready/u);
  assert.equal((await request("/clients/admin", { headers: { Cookie: clientCookie } })).status, 303);
});

test("with MHB_ADMIN_CODE_EMAIL set, admin codes go only to that inbox, shown masked, and notices stay with the admin email", async () => {
  const env = portal({ ADMIN_CODE_EMAIL: "owner.private@example.com" });
  const requested = await request("/clients/admin/request", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.251" } }, env);
  const page = await requested.text();
  assert.equal(requested.status, 200);
  assert.match(page, /sent to <strong>o\u2022{8}e@example\.com<\/strong>/u);
  assert.doesNotMatch(page, /owner\.private@example\.com|mb@myhomebuilderllc\.com/u);
  const codeEmail = email.delivered.at(-1);
  assert.deepEqual(codeEmail.to, ["owner.private@example.com"]);
  const code = codeEmail.text.match(/Verification code: (\d{6})/u)[1];
  const verify = await request("/clients/admin/verify", form({ code }), env);
  assert.equal(verify.headers.get("Location"), "/clients/admin");
  assert.match(await (await request("/clients/admin/code", {}, env)).text(), /emailed to <strong>o\u2022{8}e@example\.com<\/strong>/u);

  // Quotes and invoices still take replies at the builder's address.
  const adminCookie = cookieValue(verify);
  await setClientEmail(adminCookie);
  const sent = await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "invoice", title: "Deposit", amount: "500", sendNow: "yes" }, adminCookie), env);
  assert.match(sent.headers.get("Location"), /notice=billing-sent/u);
  const invoiceEmail = deliveredTo("client@example.com").at(-1);
  assert.deepEqual(invoiceEmail.reply_to, { email: "mb@myhomebuilderllc.com" });
});

test("an admin sign-in lasts 24 hours: the cookie and its signed expiry agree", async () => {
  assert.equal(ADMIN_SESSION_TTL_SECONDS, 24 * 60 * 60, "one admin sign-in a day, as the owner asked");
  assert.match(await createAdminSession("mhb-test-session-secret-that-is-long-and-unique"), /Max-Age=86400;/u);
  const before = Math.floor(Date.now() / 1000);
  const adminCookie = await loginAsAdmin();
  const expiry = Number(adminCookie.split("=")[1].split(".")[0]);
  assert.ok(expiry - before >= 86400 - 5 && expiry - before <= 86400 + 60, `signed expiry ${expiry - before}s ahead`);
});

test("throttles admin code requests per address and burns a challenge after too many wrong codes", async () => {
  const headers = { "CF-Connecting-IP": "198.51.100.7" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await request("/clients/admin/request", { method: "POST", headers })).status, 200);
  }
  const blocked = await request("/clients/admin/request", { method: "POST", headers });
  assert.equal(blocked.status, 429);
  assert.match(await blocked.text(), /Too many code requests/u);
  assert.equal((await request("/clients/admin/request", { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.8" } })).status, 200);

  assert.equal((await request("/clients/admin/request", { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.9" } })).status, 200);
  const live = (await db("mhb_admin_challenges").select("id")).map((row) => row.id);
  assert.equal(live.length, 5);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await request("/clients/admin/verify", form({ code: "000000" }))).status, 401);
  }
  const burned = await request("/clients/admin/verify", form({ code: "000000" }));
  assert.equal(burned.status, 429);
  assert.match(await burned.text(), /Too many attempts\. Request a new code\./u);
  assert.equal((await db("mhb_admin_challenges").whereIn("id", live)).length, 0);
});

test("an admin code works on any device, once, and every try counts against every live code", async () => {
  // Asked for on one device (a client's browser), entered on another with no cookies.
  const clientCookie = await loginAsClient();
  const asked = await request("/clients/admin/request", { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.31", Cookie: clientCookie } });
  const askedBody = await asked.text();
  assert.doesNotMatch(askedBody, /name="challenge"/u, "the code is not tied to the page that asked for it");
  assert.match(askedBody, /href="\/clients\/admin\/code">myhomebuilderllc\.com\/clients\/admin\/code<\/a>/u);
  const codeEmail = email.delivered.at(-1);
  assert.match(codeEmail.text, /can be used once, on any device/u);
  assert.match(codeEmail.text, /To use it on another device, enter it at https:\/\/myhomebuilderllc\.com\/clients\/admin\/code/u);
  const code = codeEmail.text.match(/Verification code: (\d{6})/u)[1];

  const login = await (await request("/clients")).text();
  assert.match(login, /Administrator access<\/button>\s*<a class="portal-logout-button" href="\/clients\/admin\/code">Enter a code<\/a>/u);
  const page = await request("/clients/admin/code", { headers: { "CF-Connecting-IP": "203.0.113.200" } });
  assert.equal(page.status, 200);
  const pageBody = await page.text();
  assert.match(pageBody, /Enter the verification code/u);
  assert.match(pageBody, /form="admin-email-code">Email a code<\/button>/u);
  assert.match(pageBody, /id="admin-email-code" action="\/clients\/admin\/request" method="post"/u);

  const other = await request("/clients/admin/verify", form({ code }, "", { "CF-Connecting-IP": "203.0.113.200" }));
  assert.equal(other.status, 303);
  assert.equal(other.headers.get("Location"), "/clients/admin");
  const adminCookie = cookieValue(other);
  assert.equal((await request("/clients/admin", { headers: { Cookie: adminCookie } })).status, 200);
  assert.equal((await request("/clients/admin/code", { headers: { Cookie: adminCookie } })).headers.get("Location"), "/clients/admin");

  const again = await request("/clients/admin/verify", form({ code }));
  assert.equal(again.status, 401, "a code works once");
  assert.match(await again.text(), /That code has expired\. Request a new one from the Admin button\./u);

  // Two codes asked for: either works. A wrong code counts against both, so tries entered from
  // any device still reach no code more than five times.
  const newCode = async (ip) => {
    await request("/clients/admin/request", { method: "POST", headers: { "CF-Connecting-IP": ip } });
    return email.delivered.at(-1).text.match(/Verification code: (\d{6})/u)[1];
  };
  const first = await newCode("198.51.100.32");
  const second = await newCode("198.51.100.33");
  assert.equal((await request("/clients/admin/verify", form({ code: first }))).status, 303, "an earlier code still works");
  assert.equal((await request("/clients/admin/verify", form({ code: second }))).status, 303);
  const third = await newCode("198.51.100.34");
  await newCode("198.51.100.35");
  const wrong = third === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await request("/clients/admin/verify", form({ code: wrong }, "", { "CF-Connecting-IP": `203.0.113.${210 + attempt}` }));
    assert.equal(response.status, 401);
    assert.match(await response.text(), /That code did not match\. Check the email and try again\./u);
  }
  assert.deepEqual((await db("mhb_admin_challenges").select("attempts")).map((row) => Number(row.attempts)), [4, 4]);
  assert.equal((await request("/clients/admin/verify", form({ code: third }))).status, 303, "the fifth try, if right, still opens the panel");
  assert.equal((await request("/clients/admin/verify", form({ code: wrong }))).status, 429, "the other code has had its five tries");
  assert.equal((await db("mhb_admin_challenges").select("id")).length, 0);
});

test("admin creates a client portal whose hashed login opens its own portal", async () => {
  const adminCookie = await loginAsAdmin();
  const created = await request("/clients/admin/clients", form({ name: "Wolf Lake Views", slug: "wolf-lake-views", password: "wolflakeviews-login-2026", email: "wolf@example.com" }, adminCookie));
  assert.match(created.headers.get("Location"), /client=wolf-lake-views&notice=client-added/u);
  const record = json((await db("mhb_clients").where({ slug: "wolf-lake-views" }).first()).data);
  assert.match(record.passwordHash, /^pbkdf2\$/u);
  assert.equal(JSON.stringify(record).includes("wolflakeviews-login-2026"), false);

  const cookie = await loginAsClient("wolflakeviews-login-2026");
  const home = await (await request("/clients", { headers: { Cookie: cookie } })).text();
  assert.match(home, /Wolf Lake Views/u);
  assert.doesNotMatch(home, /Muskegon Addition Selections/u);
  assert.equal((await request("/clients/muskegon-addition/", { headers: { Cookie: cookie } })).status, 303);
  const duplicate = await request("/clients/admin/clients", form({ name: "Again", slug: "wolf-lake-views", password: "another-login-2026" }, adminCookie));
  assert.equal(duplicate.status, 400);
  assert.match(await duplicate.text(), /A client portal with the id wolf-lake-views already exists/u);
});

test("adding a client portal fixes up the portal id and explains any problem, keeping what was typed", async () => {
  const adminCookie = await loginAsAdmin();
  const spaced = await request("/clients/admin/clients", form({ name: "Smith Residence", slug: "Smith Residence ", password: "smith-residence-2026" }, adminCookie));
  assert.equal(spaced.headers.get("Location"), "/clients/admin?client=smith-residence&notice=client-added");

  const blank = await request("/clients/admin/clients", form({ name: "Lakeshore Cottage & Dock", slug: "", password: "lakeshore-cottage-2026" }, adminCookie));
  assert.equal(blank.headers.get("Location"), "/clients/admin?client=lakeshore-cottage-and-dock&notice=client-added");

  const short = await request("/clients/admin/clients", form({ name: "Pine Street", slug: "", password: "short", emails: "pine@example.com, pat@example.com" }, adminCookie));
  assert.equal(short.status, 400);
  const shortBody = await short.text();
  assert.match(shortBody, /The project login needs 10 to 120 characters/u);
  assert.match(shortBody, /id="client-name" name="name" type="text" maxlength="120" required value="Pine Street"/u);
  assert.match(shortBody, /id="new-client-emails" name="emails"[^>]* value="pine@example\.com, pat@example\.com"/u);

  const reused = await request("/clients/admin/clients", form({ name: "Pine Street", slug: "", password: process.env.MHB_CLIENT_PORTAL_PASSWORD }, adminCookie));
  assert.equal(reused.status, 400);
  assert.match(await reused.text(), /That project login already opens another client portal/u);
  const reusedAgain = await request("/clients/admin/clients", form({ name: "Pine Street", slug: "", password: "smith-residence-2026" }, adminCookie));
  assert.match(await reusedAgain.text(), /That project login already opens another client portal/u);

  const dashboard = await (await request("/clients/admin", { headers: { Cookie: adminCookie } })).text();
  assert.doesNotMatch(dashboard, /pattern="\[a-z0-9\]/u, "the portal id field has no pattern the browser would ignore");
  assert.match(dashboard, /data-slug-source/u);
  assert.match(dashboard, /Portal id: smith-residence/u);
});

test("portal ids drop accents and symbols and stay within 64 characters", () => {
  assert.equal(slugify("Café Múskegon & Dock"), "cafe-muskegon-and-dock");
  assert.equal(slugify("O'Brien Remodel #2"), "o-brien-remodel-2");
  assert.equal(slugify(`${"a".repeat(63)} b`), "a".repeat(63));
  assert.equal(isValidSlug(slugify("###")), false);
});

// ---------- Quotes, invoices and payments ----------

test("numbers issued as INV-0012 and QUO-0003 become 12 and 3, cross-references included", () => {
  const [invoice, quote] = renumbered.map((row) => ({ ...row, data: json(row.data) }));
  assert.equal(invoice.number, "12");
  assert.equal(invoice.data.number, "12");
  assert.equal(invoice.data.fromQuoteNumber, "3");
  assert.equal(quote.number, "3");
  assert.equal(quote.data.invoiceNumber, "12");
});

test("quotes and invoices show the Ada address, the license number and the insurance line", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  const view = await (await request(`/clients/invoice/${item.shareToken}`)).text();
  assert.match(view, /<span>6749 Fulton St E, Ste A #2333<\/span><span>Ada, MI 49301<\/span>/u);
  assert.ok(view.includes("License # 242601116"));
  assert.doesNotMatch(view, /Builders license number/u);
  assert.ok(view.includes("$1,000,000 liability insurance provided by Next First Insurance Agency Inc"));
  assert.doesNotMatch(view, /billing-doc-from[^\n]*Muskegon, Michigan/u);
});

test("open invoices offer I'm paying by check, which gives the Muskegon mailing address", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  const view = await (await request(`/clients/invoice/${item.shareToken}`)).text();
  assert.match(view, /<summary class="button button-outline">I&#39;m paying by check<\/summary>/u);
  assert.match(view, /<address><strong>My Home Builder LLC<\/strong><br>5899 1\/2 White Rd<br>Muskegon, MI 49442<\/address>/u);
  assert.match(view, /write Invoice 1 in the memo/u);

  const clientCookie = await loginAsClient();
  assert.match(await (await request(`/clients/billing/${item.id}`, { headers: { Cookie: clientCookie } })).text(), /I&#39;m paying by check/u);

  await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}/record-payment`, form({ method: "check", paidOn: "2026-09-25" }, adminCookie));
  assert.doesNotMatch(await (await request(`/clients/invoice/${item.shareToken}`)).text(), /paying by check/u);
});

test("addresses already emailed are loaded into the pick list, newest first, without builder notices", () => {
  assert.deepEqual(backfilled.map((row) => row.email), ["payer@example.com", "owner@example.com"]);
  assert.equal(backfilled[1].display, "Owner@Example.com");
});

test("every address the admin emails joins the pick list on the admin pages, newest first", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "first@example.com");
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500", sendNow: "yes" });
  await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}/send`, form({ to: "Second@Example.com" }, adminCookie));
  await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}/send`, form({ to: "first@example.com" }, adminCookie));
  assert.ok(!deliveredTo("mb@myhomebuilderllc.com").some((message) => message.subject.startsWith("Invoice")), "builder notices are not part of this test");

  const recipients = await db("mhb_recipients").orderBy("last_sent_at", "desc").select("email", "send_count");
  assert.deepEqual(recipients.map((row) => row.email), ["first@example.com", "second@example.com"]);
  assert.equal(recipients[0].send_count, 2);

  const page = await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}`, { headers: { Cookie: adminCookie } });
  const body = await page.text();
  const listed = [...body.matchAll(/<option value="([^"]+)" label="[^"]+"><\/option>/gu)].map((match) => match[1]);
  assert.deepEqual(listed, ["first@example.com", "Second@Example.com"]);
  assert.match(body, /id="send-to" name="to" type="text" inputmode="email"[^>]* required list="mhb-recipients" autocomplete="off" data-recipient-input/u);

  const dashboard = await request("/clients/admin?client=muskegon-addition", { headers: { Cookie: adminCookie } });
  assert.match(dashboard.headers.get("Content-Security-Policy"), /script-src 'self'/u);
  const dashboardBody = await dashboard.text();
  assert.match(dashboardBody, /<datalist id="mhb-recipients">/u);
  assert.match(dashboardBody, /id="client-emails" name="emails" type="text" inputmode="email"[^>]* list="mhb-recipients"/u);
});

test("email fields read several addresses, however they are separated or pasted", () => {
  assert.deepEqual(parseEmailList(" pcm@example.com, Spouse@Example.com;third@example.com\nfourth@example.com fifth@example.com "), {
    addresses: ["pcm@example.com", "Spouse@Example.com", "third@example.com", "fourth@example.com", "fifth@example.com"],
    invalid: []
  });
  assert.deepEqual(parseEmailList('"Pat Hayes" <pcm@example.com>; Sam <sam@example.com>, mailto:office@example.com').addresses, ["pcm@example.com", "sam@example.com", "office@example.com"]);
  assert.deepEqual(parseEmailList("pcm@example.com, PCM@example.com, pcm@example"), { addresses: ["pcm@example.com"], invalid: ["pcm@example"] });
  assert.deepEqual(parseEmailList(" , ; "), { addresses: [], invalid: [] });
  assert.equal(addressesText(["a@example.com"]), "a@example.com");
  assert.equal(addressesText(["a@example.com", "b@example.com"]), "a@example.com and b@example.com");
  assert.equal(addressesText(["a@example.com", "b@example.com", "c@example.com"]), "a@example.com, b@example.com and c@example.com");
});

test("a quote or invoice goes to several addresses at once, and they fill in the project's other quotes, invoices and receipts", async () => {
  const adminCookie = await loginAsAdmin();
  const newInvoice = async () => (await request("/clients/admin/clients/muskegon-addition/billing/new?kind=invoice", { headers: { Cookie: adminCookie } })).text();
  assert.match(await newInvoice(), /Add client emails on the client panel/u);

  const { item: first } = await postInvoice(adminCookie, { title: "Pre Construction Services", amount: "5,000" });
  const firstPath = `/clients/admin/clients/muskegon-addition/billing/${first.id}`;
  const sent = await request(`${firstPath}/send`, form({ to: "pcm@example.com, Spouse@Example.com; pcm@example.com" }, adminCookie));
  assert.match(sent.headers.get("Location"), /notice=sent/u);
  assert.deepEqual(email.delivered.at(-1).to, ["pcm@example.com", "Spouse@Example.com"], "one email with both addresses in To");
  assert.equal((await stored(first)).sentTo, "pcm@example.com, Spouse@Example.com");
  assert.deepEqual((await projectRecord()).emails, ["pcm@example.com", "Spouse@Example.com"]);

  // Every other quote and invoice for the project is addressed to them.
  assert.match(await newInvoice(), /Email it to pcm@example\.com and Spouse@Example\.com after posting/u);
  const { item: second } = await postInvoice(adminCookie, { title: "Framing draw", amount: "8,000", sendNow: "yes" });
  assert.deepEqual(email.delivered.at(-1).to, ["pcm@example.com", "Spouse@Example.com"]);
  await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "quote", title: "Deck", ...lines(["Deck", "1", "4,000"]) }, adminCookie));
  const quote = (await billingRecords()).find((entry) => entry.kind === "quote");
  const quotePage = await (await request(`/clients/admin/clients/muskegon-addition/billing/${quote.id}`, { headers: { Cookie: adminCookie } })).text();
  assert.match(quotePage, /id="send-to" name="to"[^>]* value="pcm@example\.com, Spouse@Example\.com"/u);

  // A new address joins the project; one already on it (in any case) is not repeated.
  await request(`/clients/admin/clients/muskegon-addition/billing/${second.id}/send`, form({ to: "SPOUSE@example.com, office@example.com" }, adminCookie));
  assert.deepEqual((await projectRecord()).emails, ["pcm@example.com", "Spouse@Example.com", "office@example.com"]);
  const dashboard = await (await request("/clients/admin?client=muskegon-addition", { headers: { Cookie: adminCookie } })).text();
  assert.match(dashboard, /id="client-emails" name="emails"[^>]* value="pcm@example\.com, Spouse@Example\.com, office@example\.com"/u);

  // Receipts go to the whole list, as one email.
  await request(`${firstPath}/record-payment`, form({ method: "zelle", paidOn: "2026-07-30", sendReceipt: "yes" }, adminCookie));
  const receipt = email.delivered.at(-1);
  assert.equal(receipt.subject, `Receipt for invoice ${first.number} from My Home Builder LLC`);
  assert.deepEqual(receipt.to, ["pcm@example.com", "Spouse@Example.com", "office@example.com"]);
  assert.match(await (await request(firstPath, { headers: { Cookie: adminCookie } })).text(), /Emailed to pcm@example\.com, Spouse@Example\.com, office@example\.com on/u);

  // Stripe Checkout takes one address: the project's first.
  await request(`/clients/pay/${second.shareToken}`);
  assert.equal(stripe.created.at(-1).customer_email, "pcm@example.com");
});

test("a problem with typed addresses is named and what was typed is kept", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "pcm@example.com");
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  const path = `/clients/admin/clients/muskegon-addition/billing/${item.id}`;
  const deliveredBefore = email.delivered.length;

  const typo = await request(`${path}/send`, form({ to: "pcm@example.com, spouse@@example.com" }, adminCookie));
  assert.equal(typo.status, 400);
  const typoBody = await typo.text();
  assert.match(typoBody, /spouse@@example\.com is not a complete email address/u);
  assert.match(typoBody, /id="send-to" name="to"[^>]* value="pcm@example\.com, spouse@@example\.com"/u);

  const eleven = Array.from({ length: 11 }, (_, index) => `person${index}@example.com`).join(", ");
  assert.match(await (await request(`${path}/send`, form({ to: eleven }, adminCookie))).text(), /Enter up to 10 email addresses/u);
  assert.match(await (await request(`${path}/send`, form({ to: " , " }, adminCookie))).text(), /Enter at least one email address/u);
  assert.equal(email.delivered.length, deliveredBefore, "nothing is sent");

  const profile = await request("/clients/admin/clients/muskegon-addition/profile", form({ emails: "pcm@example.com, sam@example" }, adminCookie));
  assert.equal(profile.status, 400);
  const profileBody = await profile.text();
  assert.match(profileBody, /sam@example is not a complete email address/u);
  assert.match(profileBody, /id="client-emails" name="emails"[^>]* value="pcm@example\.com, sam@example"/u);
  assert.deepEqual((await projectRecord()).emails, ["pcm@example.com"]);

  // Clearing the list on the client panel leaves the project with no addresses.
  await setClientEmail(adminCookie, "");
  assert.deepEqual((await projectRecord()).emails, []);
  assert.match(await (await request(path, { headers: { Cookie: adminCookie } })).text(), /id="send-to" name="to"[^>]* value=""/u);
});

test("a new client portal can start with several emails", async () => {
  const adminCookie = await loginAsAdmin();
  const created = await request("/clients/admin/clients", form({ name: "Smith Residence", password: "smith-residence-2026", emails: "pat@example.com; sam@example.com" }, adminCookie));
  assert.equal(created.headers.get("Location"), "/clients/admin?client=smith-residence&notice=client-added");
  assert.deepEqual((await projectRecord("smith-residence")).emails, ["pat@example.com", "sam@example.com"]);
  assert.match(await (await request("/clients/admin?client=smith-residence", { headers: { Cookie: adminCookie } })).text(), /Portal id: smith-residence · pat@example\.com, sam@example\.com/u);

  const bad = await request("/clients/admin/clients", form({ name: "Pine Street", password: "pine-street-2026", emails: "pine@example" }, adminCookie));
  assert.equal(bad.status, 400);
  const badBody = await bad.text();
  assert.match(badBody, /pine@example is not a complete email address/u);
  assert.match(badBody, /id="new-client-emails" name="emails"[^>]* value="pine@example"/u);
  assert.equal(await projectRecord("pine-street"), null);
});

test("projects keep their saved email as a list, or start with the addresses their last quote or invoice went to", () => {
  const bySlug = Object.fromEntries(migratedClients.map((client) => [client.slug, client]));
  assert.deepEqual(bySlug["single-email"].emails, ["Single@Example.com"], "a saved email wins over past sends");
  assert.equal("email" in bySlug["single-email"], false);
  assert.deepEqual(bySlug["emailed-before"].emails, ["pcm@example.com"], "the most recent send, not every past one");
  assert.equal(bySlug["never-emailed"].emails, undefined);
  assert.deepEqual(bySlug["muskegon-addition"], { slug: "muskegon-addition", emails: ["Owner@Example.com"] }, "Muskegon's other details stay in code");
});

test("a payment recorded by hand is set to its invoice's total, while a Stripe payment keeps what Stripe charged", () => {
  const [stripePaid, byHand] = migratedBilling;
  assert.equal(byHand.payment.amountCents, 500000);
  assert.equal(stripePaid.payment.amountCents, 1500000);
});

test("editing a paid invoice's lines keeps a payment recorded by hand equal to the new total", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Pre Construction Services", amount: "15,000" });
  const path = `/clients/admin/clients/muskegon-addition/billing/${item.id}`;
  await request(`${path}/record-payment`, form({ method: "zelle", paidOn: "2026-07-30" }, adminCookie));
  assert.match(await (await request(`${path}/edit`, { headers: { Cookie: adminCookie } })).text(), /the recorded payment changes to match/u);

  const edited = await request(`${path}/edit`, form({ title: "Pre Construction Services", ...lines(["Pre Construction Services", "1", "5,000"]) }, adminCookie));
  assert.match(edited.headers.get("Location"), /notice=billing-updated/u);
  const paid = await stored(item);
  assert.equal(paid.amountCents, 500000);
  assert.equal(paid.payment.amountCents, 500000);
  const view = await (await request(`/clients/invoice/${item.shareToken}`)).text();
  assert.match(view, /-\$5,000\.00/u);
  assert.doesNotMatch(view, /15,000/u);

  // Saving the payment also sets its amount to the total.
  await db("mhb_billing").where({ id: item.id }).update({ data: JSON.stringify({ ...paid, payment: { ...paid.payment, amountCents: 1500000 } }) });
  await request(`${path}/payment`, form({ method: "zelle", paidOn: "2026-07-30" }, adminCookie));
  assert.equal((await stored(item)).payment.amountCents, 500000);
});

// ---------- Copying and sending to another project ----------

async function addPortal(adminCookie, name, emails = "") {
  const response = await request("/clients/admin/clients", form({ name, password: `${slugify(name)}-login-2026`, emails }, adminCookie));
  assert.equal(response.status, 303, await response.clone().text());
  return slugify(name);
}

test("an invoice copied to another project opens that project's editor, and posts there with its own number", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Cabinet package", dueDate: "2026-01-15", description: "Net 15.", ...lines(["Base cabinets", "12", "450"], ["Hardware", "1", "380.50"]) });
  const path = `/clients/admin/clients/muskegon-addition/billing/${item.id}`;
  assert.match(await (await request(path, { headers: { Cookie: adminCookie } })).text(), /Add another client portal to copy this invoice to it or send it there/u);

  const smith = await addPortal(adminCookie, "Smith Residence", "pat@example.com, sam@example.com");
  const page = await (await request(path, { headers: { Cookie: adminCookie } })).text();
  assert.match(page, /<option value="smith-residence">Smith Residence<\/option>/u);
  assert.doesNotMatch(page, /<option value="muskegon-addition">/u, "the project it is in is not offered");
  assert.match(page, />Copy to another project<\/button>/u);
  assert.match(page, /formaction="[^"]+\/move" formmethod="post">Send to another project<\/button>/u);

  const editor = await request(`${path}/copy?to=${smith}`, { headers: { Cookie: adminCookie } });
  assert.equal(editor.status, 200);
  const editorBody = await editor.text();
  assert.match(editorBody, /Copied from Invoice 1 in Muskegon Addition\. Review it, then post it to Smith Residence\./u);
  assert.match(editorBody, /action="\/clients\/admin\/clients\/smith-residence\/billing" method="post"/u);
  for (const value of ["Cabinet package", "Base cabinets", "12", "450.00", "Hardware", "380.50"]) assert.ok(editorBody.includes(`value="${value}"`), value);
  assert.match(editorBody, /Net 15\./u);
  assert.match(editorBody, /id="billing-due" name="dueDate" type="date" value=""/u, "a due date already past is left to set");
  assert.match(editorBody, /Email it to pat@example\.com and sam@example\.com after posting/u);
  assert.ok(editorBody.includes(`href="${path}">Cancel`), "Cancel goes back to the original");

  // Posting it there makes a new invoice in that project; the original stays as it was.
  const posted = await request(`/clients/admin/clients/${smith}/billing`, form({ kind: "invoice", title: "Cabinet package", description: "Net 15.", sendNow: "yes", ...lines(["Base cabinets", "12", "450"], ["Hardware", "1", "380.50"]) }, adminCookie));
  assert.equal(posted.status, 303);
  const copy = (await billingRecords()).find((entry) => entry.clientSlug === smith);
  assert.equal(copy.number, "2");
  assert.equal(copy.amountCents, 578050);
  assert.notEqual(copy.shareToken, item.shareToken);
  assert.deepEqual(email.delivered.at(-1).to, ["pat@example.com", "sam@example.com"]);
  assert.equal((await stored(item)).clientSlug, "muskegon-addition");

  for (const to of ["muskegon-addition", "nowhere"]) {
    assert.match((await request(`${path}/copy?to=${to}`, { headers: { Cookie: adminCookie } })).headers.get("Location"), /notice=project-invalid/u);
  }
});

test("an invoice sent to another project keeps its number, link, payments and sent emails", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "wrong@example.com");
  const smith = await addPortal(adminCookie, "Smith Residence", "pat@example.com");
  const { item } = await postInvoice(adminCookie, { title: "Framing draw", amount: "8,000" });
  const oldPath = `/clients/admin/clients/muskegon-addition/billing/${item.id}`;
  await request(`/clients/pay/${item.shareToken}`);
  const earlySession = [...stripe.sessions.keys()].at(-1);

  const moved = await request(`${oldPath}/move`, form({ to: smith }, adminCookie));
  assert.equal(moved.headers.get("Location"), `/clients/admin/clients/smith-residence/billing/${item.id}?notice=moved`);
  const record = await stored(item);
  assert.equal(record.clientSlug, smith);
  assert.equal(record.number, "1");
  assert.equal(record.shareToken, item.shareToken);
  assert.equal(record.checkoutSessionId, undefined);
  assert.ok(stripe.expired.includes(earlySession), "the Checkout naming the old project is closed");
  assert.equal((await db("mhb_billing").where({ id: item.id }).first()).client_slug, smith);

  const newPath = `/clients/admin/clients/${smith}/billing/${item.id}`;
  const newPage = await (await request(moved.headers.get("Location"), { headers: { Cookie: adminCookie } })).text();
  assert.match(newPage, /Sent to this project\. It keeps its number and link/u);
  assert.match(newPage, /Moved from Muskegon Addition/u);
  assert.match(newPage, /id="send-to" name="to"[^>]* value="pat@example\.com"/u);
  assert.equal((await request(oldPath, { headers: { Cookie: adminCookie } })).status, 404);
  assert.doesNotMatch(await (await request("/clients/admin?client=muskegon-addition", { headers: { Cookie: adminCookie } })).text(), /Framing draw/u);
  assert.match(await (await request(`/clients/invoice/${item.shareToken}`)).text(), /Smith Residence/u);

  // A payment through a Checkout started before the move is recorded on the new project.
  await signedWebhook("checkout.session.completed", payStripeSession(earlySession, { amount_total: 800000 }));
  assert.equal((await stored(item)).status, "paid");
  assert.ok(deliveredTo("pat@example.com").some((message) => message.subject.startsWith("Receipt")), "the receipt goes to the new project's emails");
  assert.equal(deliveredTo("wrong@example.com").length, 0);

  // Its sent emails move with it: sent back, it still shows its receipt and sends nothing twice.
  await request(`${newPath}/move`, form({ to: "muskegon-addition" }, adminCookie));
  const back = await (await request(oldPath, { headers: { Cookie: adminCookie } })).text();
  assert.match(back, /Moved from Smith Residence/u);
  assert.match(back, /Receipt emailed to pat@example\.com/u);
  const deliveredBefore = email.delivered.length;
  assert.equal((await signedWebhook("checkout.session.completed", stripe.sessions.get(earlySession))).status, 200);
  assert.equal(email.delivered.length, deliveredBefore, "no second receipt or payment notice");
});

test("a quote sent to another project takes the invoice made from it, and a processing bank payment stays put", async () => {
  const adminCookie = await loginAsAdmin();
  const smith = await addPortal(adminCookie, "Smith Residence");
  await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "quote", title: "Deck", ...lines(["Deck", "1", "4,000"]) }, adminCookie));
  const quote = (await billingRecords()).find((entry) => entry.kind === "quote");
  const quotePath = `/clients/admin/clients/muskegon-addition/billing/${quote.id}`;
  await request(`${quotePath}/invoice`, form({}, adminCookie));
  const invoice = (await billingRecords()).find((entry) => entry.kind === "invoice");
  assert.match(await (await request(quotePath, { headers: { Cookie: adminCookie } })).text(), /Send to another project moves this quote there with Invoice 1, which was made from it/u);

  const moved = await request(`${quotePath}/move`, form({ to: smith }, adminCookie));
  assert.match(moved.headers.get("Location"), /notice=moved-pair/u);
  assert.equal((await stored(quote)).clientSlug, smith);
  assert.equal((await stored(invoice)).clientSlug, smith);
  const quotePage = await (await request(`/clients/admin/clients/${smith}/billing/${quote.id}`, { headers: { Cookie: adminCookie } })).text();
  assert.ok(quotePage.includes(`href="/clients/admin/clients/smith-residence/billing/${invoice.id}">Invoice 1</a>`), "the link to its invoice still works");

  // A bank payment still processing keeps the invoice (and so its quote) where it is.
  const invoicePath = `/clients/admin/clients/${smith}/billing/${invoice.id}`;
  await request(`/clients/pay/${invoice.shareToken}`);
  await signedWebhook("checkout.session.completed", payStripeSession([...stripe.sessions.keys()].at(-1), { payment_status: "unpaid", amount_total: 400000 }));
  assert.equal((await stored(invoice)).status, "processing");
  const processingPage = await (await request(invoicePath, { headers: { Cookie: adminCookie } })).text();
  assert.doesNotMatch(processingPage, />Send to another project</u);
  assert.match(processingPage, /A bank payment is still processing/u);
  assert.match((await request(`${invoicePath}/move`, form({ to: "muskegon-addition" }, adminCookie))).headers.get("Location"), /notice=move-processing/u);
  assert.equal((await stored(invoice)).clientSlug, smith);
  assert.equal((await stored(quote)).clientSlug, smith);
  assert.match((await request(`${invoicePath}/move`, form({ to: smith }, adminCookie))).headers.get("Location"), /notice=project-invalid/u);
});

// ---------- Deleting, totals and invoice numbers in date order ----------

test("deleting an invoice asks first, says what goes with it, and removes it and its link", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "pat@example.com");
  await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "quote", title: "Deck", ...lines(["Deck", "1", "4,000"]) }, adminCookie));
  const quote = (await billingRecords()).find((entry) => entry.kind === "quote");
  const quotePath = `/clients/admin/clients/muskegon-addition/billing/${quote.id}`;
  await request(`${quotePath}/invoice`, form({}, adminCookie));
  const invoice = (await billingRecords()).find((entry) => entry.kind === "invoice");
  const path = `/clients/admin/clients/muskegon-addition/billing/${invoice.id}`;
  await request(`${path}/send`, form({ to: "pat@example.com" }, adminCookie));
  await request(`/clients/pay/${invoice.shareToken}`);
  const session = [...stripe.sessions.keys()].at(-1);

  assert.match(await (await request(path, { headers: { Cookie: adminCookie } })).text(), /<div class="admin-danger"><a class="portal-logout-button" href="[^"]+\/delete">Delete invoice<\/a><\/div>/u);
  const confirm = await (await request(`${path}/delete`, { headers: { Cookie: adminCookie } })).text();
  assert.match(confirm, /Delete Invoice 1\?/u);
  assert.match(confirm, /It was emailed to pat@example\.com\. The link in that email will stop working\./u);
  assert.match(confirm, /It was made from Quote 1\. The quote stays and can be invoiced again\./u);
  assert.match(confirm, /To keep a record of it instead, go back and use Mark void\./u);
  assert.match(confirm, /Deleting can't be undone\.<\/strong> Later invoices move up a number/u);
  assert.match(confirm, /class="button button-danger" type="submit">Delete invoice<\/button>/u);
  assert.ok(await db("mhb_billing").where({ id: invoice.id }).first(), "nothing is deleted until confirmed");

  const deleted = await request(`${path}/delete`, form({}, adminCookie));
  assert.equal(deleted.headers.get("Location"), "/clients/admin?client=muskegon-addition&notice=invoice-deleted");
  assert.equal(await db("mhb_billing").where({ id: invoice.id }).first(), undefined);
  assert.ok(stripe.expired.includes(session), "its open Checkout is closed");
  assert.equal((await request(path, { headers: { Cookie: adminCookie } })).status, 404);
  assert.equal((await request(`/clients/invoice/${invoice.shareToken}`)).status, 404);
  assert.match(await (await request(deleted.headers.get("Location"), { headers: { Cookie: adminCookie } })).text(), /Invoice deleted\. Its link no longer works\./u);
  assert.equal((await stored(quote)).invoiceId, undefined);
  assert.match(await (await request(quotePath, { headers: { Cookie: adminCookie } })).text(), /Create invoice from this quote/u, "the quote can be invoiced again");

  // A payment through its old Checkout is not lost: the builder is told, once.
  await signedWebhook("checkout.session.completed", payStripeSession(session, { amount_total: 400000 }));
  const alert = deliveredTo("mb@myhomebuilderllc.com").at(-1);
  assert.equal(alert.subject, "Stripe payment for deleted Invoice 1");
  assert.match(alert.text, /Stripe received \$4,000\.00 from payer@example\.com for Invoice 1 \(Muskegon Addition\), which was deleted/u);
  const deliveredBefore = email.delivered.length;
  assert.equal((await signedWebhook("checkout.session.completed", stripe.sessions.get(session))).status, 200);
  assert.equal(email.delivered.length, deliveredBefore, "told once");
});

test("a paid invoice deletes with its payment record, a processing one waits, and quotes delete too", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "pat@example.com");
  const { item: paid } = await postInvoice(adminCookie, { title: "Deposit", amount: "5,000" });
  const paidPath = `/clients/admin/clients/muskegon-addition/billing/${paid.id}`;
  await request(`${paidPath}/record-payment`, form({ method: "zelle", paidOn: "2026-07-30", sendReceipt: "yes" }, adminCookie));
  assert.ok(await sentEmail(`muskegon-addition:${paid.id}:receipt`));
  const confirm = await (await request(`${paidPath}/delete`, { headers: { Cookie: adminCookie } })).text();
  assert.match(confirm, /It is marked paid \(Jul 30, 2026 · Zelle · \$5,000\.00\)\. That payment record is deleted with it\./u);
  assert.doesNotMatch(confirm, /Mark void/u);
  await request(`${paidPath}/delete`, form({}, adminCookie));
  assert.equal(await sentEmail(`muskegon-addition:${paid.id}:receipt`), undefined, "its sent-email records go too");

  const { item: bank } = await postInvoice(adminCookie, { title: "Foundation", amount: "400" });
  const bankPath = `/clients/admin/clients/muskegon-addition/billing/${bank.id}`;
  await request(`/clients/pay/${bank.shareToken}`);
  await signedWebhook("checkout.session.completed", payStripeSession([...stripe.sessions.keys()].at(-1), { payment_status: "unpaid", amount_total: 40000 }));
  const waiting = await (await request(`${bankPath}/delete`, { headers: { Cookie: adminCookie } })).text();
  assert.match(waiting, /A bank payment for this invoice is still processing/u);
  assert.doesNotMatch(waiting, /button-danger/u);
  assert.match((await request(`${bankPath}/delete`, form({}, adminCookie))).headers.get("Location"), /notice=delete-processing/u);
  assert.ok(await db("mhb_billing").where({ id: bank.id }).first());

  await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "quote", title: "Deck", ...lines(["Deck", "1", "4,000"]) }, adminCookie));
  const quote = (await billingRecords()).find((entry) => entry.kind === "quote");
  const quotePath = `/clients/admin/clients/muskegon-addition/billing/${quote.id}`;
  const quoteConfirm = await (await request(`${quotePath}/delete`, { headers: { Cookie: adminCookie } })).text();
  assert.match(quoteConfirm, /Delete Quote 1\?/u);
  assert.match(quoteConfirm, /Its number is not used again\./u);
  assert.match((await request(`${quotePath}/delete`, form({}, adminCookie))).headers.get("Location"), /notice=quote-deleted/u);
  assert.equal(await db("mhb_billing").where({ id: quote.id }).first(), undefined);
});

test("an invoice emailed after it is paid says paid and has no pay link, and so does one with a bank payment processing", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "pat@example.com");
  const { item } = await postInvoice(adminCookie, { title: "Pre Construction Services", amount: "80" });
  const path = `/clients/admin/clients/muskegon-addition/billing/${item.id}`;
  await request(`${path}/send`, form({ to: "pat@example.com" }, adminCookie));
  const open = email.delivered.at(-1);
  assert.equal(open.subject, "Invoice 1 from My Home Builder LLC");
  assert.ok(open.html.includes(`/clients/pay/${item.shareToken}`));
  assert.match(open.html, /Pay \$80\.00/u);

  await request(`${path}/record-payment`, form({ method: "zelle", paidOn: "2026-09-28" }, adminCookie));
  await request(`${path}/send`, form({ to: "pat@example.com" }, adminCookie));
  const paid = email.delivered.at(-1);
  assert.equal(paid.subject, "Invoice 1 from My Home Builder LLC (paid)");
  for (const part of [paid.html, paid.text]) {
    assert.doesNotMatch(part, /\/clients\/pay\/|Pay \$|Pay online|Amount due/u);
    assert.ok(part.includes(`/clients/invoice/${item.shareToken}`), "the invoice itself is still linked");
  }
  assert.match(paid.html, /It is paid\. Thank you\./u);
  assert.match(paid.html, /Invoice 1 · Paid/u);
  assert.match(paid.html, />View the paid invoice</u);
  assert.match(paid.text, /Status: Paid\nPaid on: Sep 28, 2026\nPayment method: Zelle\nBalance due: \$0\.00/u);

  const { item: bank } = await postInvoice(adminCookie, { title: "Foundation", amount: "400" });
  await request(`/clients/pay/${bank.shareToken}`);
  await signedWebhook("checkout.session.completed", payStripeSession([...stripe.sessions.keys()].at(-1), { payment_status: "unpaid", amount_total: 40000 }));
  await request(`/clients/admin/clients/muskegon-addition/billing/${bank.id}/send`, form({ to: "pat@example.com" }, adminCookie));
  const processing = email.delivered.at(-1);
  assert.equal(processing.subject, "Invoice 2 from My Home Builder LLC (payment processing)");
  assert.match(processing.text, /Your bank payment for it is processing\./u);
  assert.doesNotMatch(processing.html, /\/clients\/pay\/|Pay \$/u);
});

test("the admin list says how each invoice was paid or when it is due, and changes status or deletes from popups", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "pat@example.com");
  const { item: due } = await postInvoice(adminCookie, { title: "Framing", amount: "1,000", dueDate: "2099-10-01" });
  const { item: open } = await postInvoice(adminCookie, { title: "Permits", amount: "250" });
  const { item: paid } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  await request(`/clients/admin/clients/muskegon-addition/billing/${paid.id}/record-payment`, form({ method: "zelle", paidOn: "2026-09-28" }, adminCookie));
  const list = async () => (await request("/clients/admin?client=muskegon-addition", { headers: { Cookie: adminCookie } })).text();
  const page = await list();
  const base = "/clients/admin/clients/muskegon-addition/billing";
  assert.match(page, /<small class="status-detail">Due Oct 1, 2099<\/small>/u);
  assert.match(page, /<small class="status-detail">No due date<\/small>/u);
  assert.match(page, /<small class="status-detail"><a class="payment-change" href="[^"]+" data-payment-menu data-label="Invoice 3 · Deposit" data-method="zelle" data-method-name="" data-reference="" data-paid-on="2026-09-28" title="Change how it was paid">Zelle · Sep 28, 2026<\/a><\/small>/u);
  assert.ok(page.includes(`<a class="status-change" href="${base}/${paid.id}" data-status-menu data-label="Invoice 3 · Deposit" data-state="paid" data-source="manual" data-method="Zelle"`), "the status opens its popup, or the invoice without scripts");
  assert.ok(page.includes(`<a class="billing-trash" href="${base}/${due.id}/delete" data-delete-menu data-label="Invoice 1 · Framing" data-kind="invoice"`));
  assert.match(page, /aria-label="Delete Invoice 1" title="Delete"><svg/u);
  assert.match(page, /<dialog class="admin-dialog" id="status-dialog"/u);
  assert.match(page, /<button class="button button-solid" type="submit">Mark as paid<\/button>/u);
  assert.match(page, /Email a receipt to pat@example\.com/u);
  assert.match(page, /<dialog class="admin-dialog" id="delete-dialog"/u);

  // Due to paid from the popup: how it was paid, then back to the list.
  const marked = await request(`${base}/${open.id}/record-payment`, form({ method: "check", reference: "#88", paidOn: "2026-09-29", return: "list" }, adminCookie));
  assert.equal(marked.headers.get("Location"), "/clients/admin?client=muskegon-addition&notice=payment-recorded");
  assert.equal((await stored(open)).payment.label, "Check #88");
  assert.match(await list(), /data-reference="#88" data-paid-on="2026-09-29" title="Change how it was paid">Check #88 · Sep 29, 2026<\/a><\/small>/u);

  // How it was paid, changed from the list's popup.
  assert.match(page, /<dialog class="admin-dialog" id="payment-dialog"/u);
  const changed = await request(`${base}/${open.id}/payment`, form({ method: "cashapp", reference: "", paidOn: "2026-09-30", return: "list" }, adminCookie));
  assert.equal(changed.headers.get("Location"), "/clients/admin?client=muskegon-addition&notice=payment-updated");
  assert.equal((await stored(open)).payment.label, "Cash App");
  assert.equal((await stored(open)).paidAt, "2026-09-30");
  assert.match(await list(), />Cash App · Sep 30, 2026<\/a><\/small>/u);
  const unnamed = await request(`${base}/${open.id}/payment`, form({ method: "other", methodName: "", paidOn: "2026-09-30", return: "list" }, adminCookie));
  assert.equal(unnamed.headers.get("Location"), "/clients/admin?client=muskegon-addition&notice=payment-other-required");
  const missing = await request(`${base}/${due.id}/record-payment`, form({ method: "other", methodName: "", paidOn: "2026-09-29", return: "list" }, adminCookie));
  assert.equal(missing.headers.get("Location"), "/clients/admin?client=muskegon-addition&notice=payment-other-required");

  // Paid to due: the payment recorded by hand is removed, then back to the list.
  const reopened = await request(`${base}/${paid.id}/reopen`, form({ return: "list" }, adminCookie));
  assert.equal(reopened.headers.get("Location"), "/clients/admin?client=muskegon-addition&notice=payment-removed");
  assert.equal((await stored(paid)).status, "open");
  // From the invoice page the same actions still return there.
  assert.match((await request(`${base}/${open.id}/reopen`, form({}, adminCookie))).headers.get("Location"), new RegExp(`${base}/${open.id}\\?notice=payment-removed`, "u"));

  // The trash button's form deletes and returns to the list.
  const deleted = await request(`${base}/${due.id}/delete`, form({}, adminCookie));
  assert.match(deleted.headers.get("Location"), /^\/clients\/admin\?client=muskegon-addition&notice=invoice-deleted/u);
  assert.equal(await db("mhb_billing").where({ id: due.id }).first(), undefined);
});

test("a project's quotes and invoices end with invoiced, paid and outstanding totals", async () => {
  const adminCookie = await loginAsAdmin();
  const dashboard = async () => (await request("/clients/admin?client=muskegon-addition", { headers: { Cookie: adminCookie } })).text();
  await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "quote", title: "Deck", ...lines(["Deck", "1", "4,000"]) }, adminCookie));
  assert.doesNotMatch(await dashboard(), /billing-totals/u, "quotes alone have no invoice totals");

  const { item: paid } = await postInvoice(adminCookie, { title: "Deposit", amount: "5,000" });
  await request(`/clients/admin/clients/muskegon-addition/billing/${paid.id}/record-payment`, form({ method: "zelle", paidOn: "2026-07-30" }, adminCookie));
  await postInvoice(adminCookie, { title: "Framing", amount: "8,000" });
  const { item: voided } = await postInvoice(adminCookie, { title: "Mistake", amount: "1,000" });
  await request(`/clients/admin/clients/muskegon-addition/billing/${voided.id}/void`, form({}, adminCookie));

  const body = await dashboard();
  assert.match(body, /<div><dt>Invoiced<\/dt><dd>\$13,000\.00<\/dd><\/div>/u, "the quote and the voided invoice are left out");
  assert.match(body, /<div><dt>Paid<\/dt><dd>\$5,000\.00<\/dd><\/div>/u);
  assert.match(body, /<div class="billing-totals-due"><dt>Outstanding<\/dt><dd>\$8,000\.00<\/dd><\/div>/u);
  assert.ok(body.indexOf("billing-totals") > body.indexOf("</table>"), "at the end of the list");
  assert.doesNotMatch(await (await request("/clients", { headers: { Cookie: await loginAsClient() } })).text(), /billing-totals/u, "the client's portal is unchanged");
});

// ---------- Books ----------

// Each account's balance (debits less credits), leaving out accounts at zero.
async function ledgerBalances() {
  const rows = await db("mhb_journal_lines").select("account").sum({ debit: "debit_cents", credit: "credit_cents" }).groupBy("account");
  return Object.fromEntries(rows.map((row) => [row.account, Number(row.debit) - Number(row.credit)]).filter(([, net]) => net !== 0));
}

test("the books follow an invoice's life in balanced entries, and log each step", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Framing", amount: "1,000", issuedOn: "2026-09-10" });
  const path = `/clients/admin/clients/muskegon-addition/billing/${item.id}`;
  assert.deepEqual(await ledgerBalances(), { 1100: 100000, 4000: -100000 });
  const issue = await db("mhb_journal_entries").where({ item_id: item.id, part: "issue" }).first(db.raw("memo, to_char(entry_date, 'YYYY-MM-DD') AS date"));
  assert.deepEqual({ ...issue }, { memo: "Invoice 1 · Framing", date: "2026-09-10" });

  await request(`${path}/record-payment`, form({ method: "zelle", paidOn: "2026-09-12" }, adminCookie));
  assert.deepEqual(await ledgerBalances(), { 1300: 100000, 4000: -100000 });
  await request(`${path}/edit`, form({ title: "Framing", issuedOn: "2026-09-10", ...lines(["Framing", "1", "1,200"]) }, adminCookie));
  assert.deepEqual(await ledgerBalances(), { 1300: 120000, 4000: -120000 }, "the payment recorded by hand follows the new total");
  await request(`${path}/reopen`, form({}, adminCookie));
  assert.deepEqual(await ledgerBalances(), { 1100: 120000, 4000: -120000 });
  await request(`${path}/void`, form({}, adminCookie));
  assert.deepEqual(await ledgerBalances(), {});

  const entries = await db("mhb_journal_entries").where({ item_id: item.id }).orderBy("id").select("kind", "part");
  assert.deepEqual(entries.map((entry) => `${entry.kind} ${entry.part}`), [
    "issue issue", "payment payment",
    "reversal issue", "issue issue", "reversal payment", "payment payment",
    "reversal payment",
    "reversal issue"
  ]);
  for (const entry of await db("mhb_journal_entries").select("id")) {
    const sums = await db("mhb_journal_lines").where({ entry_id: entry.id }).sum({ debit: "debit_cents", credit: "credit_cents" }).first();
    assert.equal(Number(sums.debit), Number(sums.credit), "every entry balances");
  }

  const logged = await db("mhb_activity").where({ item_id: item.id }).orderBy("id").select("action", "actor", "ip", "summary");
  assert.deepEqual(logged.map((row) => row.action), ["invoice.created", "payment.recorded", "invoice.edited", "payment.removed", "invoice.voided"]);
  assert.ok(logged.every((row) => row.actor === "admin"));
  assert.equal(logged[2].summary, "Edited Invoice 1: total $1,000.00 → $1,200.00");
  assert.equal(logged[1].summary, "Recorded a Zelle payment of $1,000.00 for Invoice 1, received Sep 12, 2026");
  assert.match(await (await request("/clients/admin/books", { headers: { Cookie: adminCookie } })).text(), /The books balance\./u);
});

test("Stripe payments post with their fee, repeated events post nothing, and money with no invoice is kept as unapplied", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  await request(`/clients/pay/${item.shareToken}`);
  const first = [...stripe.sessions.keys()].at(-1);
  await signedWebhook("checkout.session.completed", payStripeSession(first, { amount_total: 50000 }));
  assert.deepEqual(await ledgerBalances(), { 1200: 49738, 4000: -50000, 6100: 262 }, "Stripe's fee comes out of the Stripe balance");
  const count = async () => Number((await db("mhb_journal_entries").count({ n: "*" }).first()).n);
  const entriesBefore = await count();
  await signedWebhook("checkout.session.completed", stripe.sessions.get(first));
  assert.equal(await count(), entriesBefore, "a repeated event posts nothing");

  // A second payment for the paid invoice (an old Checkout, say) is kept as unapplied, once.
  const second = { id: "cs_test_second", status: "complete", payment_status: "paid", amount_total: 50000, currency: "usd", payment_intent: "pi_second", customer_details: { email: "payer@example.com" }, metadata: { clientSlug: "muskegon-addition", invoiceId: item.id, invoiceNumber: "1" } };
  stripe.sessions.set(second.id, second);
  await signedWebhook("checkout.session.completed", second);
  await signedWebhook("checkout.session.completed", second);
  assert.deepEqual(await ledgerBalances(), { 1200: 99738, 2100: -50000, 4000: -50000, 6100: 262 });

  // Deleted after it was paid: its sale and receivable go, and Stripe's money stays, unapplied.
  await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}/delete`, form({}, adminCookie));
  assert.deepEqual(await ledgerBalances(), { 1200: 99738, 2100: -100000, 6100: 262 });
  // Paid after it was deleted: unapplied too.
  const late = { ...second, id: "cs_test_late", payment_intent: "pi_late" };
  stripe.sessions.set(late.id, late);
  await signedWebhook("checkout.session.completed", late);
  assert.deepEqual(await ledgerBalances(), { 1200: 149738, 2100: -150000, 6100: 262 });

  const stripeLog = await db("mhb_activity").where({ actor: "stripe" }).orderBy("id").select("action", "summary");
  assert.deepEqual(stripeLog.map((row) => row.action), ["stripe.paid", "stripe.duplicate", "stripe.deleted-invoice"]);
  assert.equal(stripeLog[0].summary, "Stripe payment of $500.00 for Invoice 1 (Visa •••• 4242), Stripe fee $2.62");
  assert.ok(await db("mhb_activity").where({ actor: "client", action: "stripe.checkout" }).first(), "opening Checkout is logged");
  const check = await (await request("/clients/admin/books", { headers: { Cookie: adminCookie } })).text();
  assert.match(check, /The books balance\./u);
  assert.match(check, /<dt>Unapplied payments<\/dt><dd>\$1,500\.00<\/dd>/u);
});

test("the webhook reads Stripe's copy of the session, and a payment that no longer matches the invoice is kept as unapplied", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  await request(`/clients/pay/${item.shareToken}`);
  const sessionId = [...stripe.sessions.keys()].at(-1);

  // An event that says paid while Stripe says unpaid changes nothing.
  const claimed = { ...stripe.sessions.get(sessionId), status: "complete", payment_status: "paid", payment_intent: "pi_claimed" };
  assert.equal((await signedWebhook("checkout.session.completed", claimed)).status, 200);
  assert.equal((await stored(item)).status, "open");

  // A late event that still says unpaid records the payment Stripe now reports.
  const stale = { ...stripe.sessions.get(sessionId) };
  payStripeSession(sessionId);
  assert.equal((await signedWebhook("checkout.session.completed", stale)).status, 200);
  assert.equal((await stored(item)).status, "paid");

  // Stripe cannot be reached: the webhook answers 500, so Stripe tries again later.
  const { item: later } = await postInvoice(adminCookie, { title: "Framing", amount: "300" });
  await request(`/clients/pay/${later.shareToken}`);
  const laterSession = [...stripe.sessions.keys()].at(-1);
  stripe.unavailable = true;
  assert.equal((await signedWebhook("checkout.session.completed", payStripeSession(laterSession))).status, 500);
  stripe.unavailable = false;
  assert.equal((await stored(later)).status, "open");

  // Paid for a total the invoice does not have: kept as unapplied, the builder told once, the invoice left open.
  payStripeSession(laterSession, { amount_total: 25000 });
  for (let i = 0; i < 2; i++) assert.equal((await signedWebhook("checkout.session.completed", stripe.sessions.get(laterSession))).status, 200);
  assert.equal((await stored(later)).status, "open");
  const alerts = deliveredTo("mb@myhomebuilderllc.com").filter((message) => message.subject === "Stripe payment for Invoice 2 does not match its total");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Stripe received \$250\.00 from Muskegon Addition for Invoice 2 · Framing, which totals \$300\.00\. The payment was not applied, so the invoice is still open\./u);
  assert.equal((await ledgerBalances())[2100], -25000);
  assert.equal((await db("mhb_activity").where({ action: "stripe.mismatch" })).length, 1);
  // The client's return from Checkout says the payment is being confirmed, not that it is paid.
  assert.match((await request(`/clients/pay/${later.shareToken}/return?session_id=${laterSession}`)).headers.get("Location"), /notice=payment-pending/u);
  assert.match(await (await request("/clients/admin/books", { headers: { Cookie: adminCookie } })).text(), /The books balance\./u);
});

test("refunds and disputes reach the invoice and the books, and each Stripe event is kept by id", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "pat@example.com");
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  await request(`/clients/pay/${item.shareToken}`);
  await signedWebhook("checkout.session.completed", payStripeSession([...stripe.sessions.keys()].at(-1), { payment_intent: "pi_refund" }));
  const seconds = (iso) => Date.parse(iso) / 1000;
  stripe.intents.set("pi_refund", { metadata: { invoiceId: item.id, invoiceNumber: "1", clientSlug: "muskegon-addition" } });
  stripe.charges.set("ch_refund", { id: "ch_refund", payment_intent: "pi_refund", amount_refunded: 10000, refunded: false, currency: "usd", metadata: {} });
  stripe.refunds.set("ch_refund", [{ id: "re_part", amount: 10000, status: "succeeded", created: seconds("2026-09-26T15:00:00Z") }]);
  assert.equal((await signedWebhook("charge.refunded", { id: "ch_refund" }, { id: "evt_refund_1" })).status, 200);
  assert.equal((await signedWebhook("charge.refunded", { id: "ch_refund" }, { id: "evt_refund_2" })).status, 200);
  const refunded = await stored(item);
  assert.deepEqual(refunded.payment.refunds, [{ id: "re_part", amountCents: 10000, status: "succeeded", refundedAt: "2026-09-26T15:00:00.000Z" }]);
  assert.equal(refunded.payment.refundedCents, 10000);
  assert.deepEqual(await ledgerBalances(), { 1200: 50000 - 262 - 10000, 4000: -50000, 4200: 10000, 6100: 262 });
  assert.equal((await db("mhb_activity").where({ action: "stripe.refunded" })).length, 1, "a repeated event logs nothing new");
  const entry = await db("mhb_journal_entries").where({ kind: "refund" }).select(db.raw("to_char(entry_date, 'YYYY-MM-DD') AS day"), "memo").first();
  assert.deepEqual({ ...entry }, { day: "2026-09-26", memo: "Invoice 1 · refunded through Stripe" });
  const path = `/clients/admin/clients/muskegon-addition/billing/${item.id}`;
  assert.match(await (await request(path, { headers: { Cookie: adminCookie } })).text(), /Refunded \$100\.00 on Sep 26, 2026\./u);
  assert.match(await (await request(`/clients/invoice/${item.shareToken}`)).text(), /Refunded Sep 26, 2026<\/th><td>\$100\.00/u);

  // A refund Stripe could not make comes back off the books.
  stripe.refunds.set("ch_refund", [{ id: "re_part", amount: 10000, status: "failed", created: seconds("2026-09-26T15:00:00Z") }]);
  stripe.charges.get("ch_refund").amount_refunded = 0;
  await signedWebhook("charge.refund.updated", { id: "re_part", charge: "ch_refund" }, { id: "evt_refund_3" });
  assert.equal((await ledgerBalances())[4200], undefined);
  assert.equal((await db("mhb_activity").where({ action: "stripe.refund-failed" })).length, 1);

  // A dispute holds the money until it closes; a win returns it and the fee.
  stripe.disputes.set("dp_1", { id: "dp_1", charge: "ch_refund", status: "needs_response", created: seconds("2026-09-27T15:00:00Z"), balance_transactions: [{ amount: -50000, fee: 1500, created: seconds("2026-09-27T15:00:00Z") }] });
  await signedWebhook("charge.dispute.created", { id: "dp_1", charge: "ch_refund" }, { id: "evt_dispute_1" });
  assert.deepEqual(await ledgerBalances(), { 1200: 50000 - 262 - 50000 - 1500, 1250: 50000, 4000: -50000, 6100: 262, 6200: 1500 });
  const books = await (await request("/clients/admin/books", { headers: { Cookie: adminCookie } })).text();
  assert.match(books, /The books balance\./u);
  assert.match(books, /<dt>Held in disputes<\/dt><dd>\$500\.00<\/dd>/u);
  assert.match(await (await request(path, { headers: { Cookie: adminCookie } })).text(), /Disputed on Sep 27, 2026 \(needs response\)\. Respond in the Stripe dashboard\./u);
  stripe.disputes.get("dp_1").status = "won";
  stripe.disputes.get("dp_1").balance_transactions.push({ amount: 50000, fee: -1500, created: seconds("2026-09-29T15:00:00Z") });
  await signedWebhook("charge.dispute.closed", { id: "dp_1", charge: "ch_refund" }, { id: "evt_dispute_2" });
  assert.deepEqual(await ledgerBalances(), { 1200: 50000 - 262, 4000: -50000, 6100: 262 });
  assert.deepEqual((await db("mhb_activity").where({ action: "stripe.dispute" }).orderBy("id")).map((row) => row.summary), [
    "A dispute opened on Invoice 1; Stripe is holding $500.00 and charged a $15.00 fee",
    "Won the dispute on Invoice 1; Stripe returned $500.00"
  ]);
  assert.match(await (await request("/clients/admin/books", { headers: { Cookie: adminCookie } })).text(), /The books balance\./u);

  // Each portal event handled is kept by id; an event for a payment made elsewhere is not.
  stripe.charges.set("ch_other", { id: "ch_other", payment_intent: "pi_other", amount_refunded: 500, refunded: false, metadata: {} });
  assert.equal((await signedWebhook("charge.refunded", { id: "ch_other" }, { id: "evt_elsewhere" })).status, 200);
  const kept = (await db("mhb_stripe_events").select("id")).map((row) => row.id).filter((id) => /^evt_(refund|dispute|elsewhere)/u.test(id)).sort();
  assert.deepEqual(kept, ["evt_dispute_1", "evt_dispute_2", "evt_refund_1", "evt_refund_2", "evt_refund_3"]);
});

test("a refund of a payment not applied to an invoice comes out of Unapplied payments, once", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  await request(`/clients/pay/${item.shareToken}`);
  await signedWebhook("checkout.session.completed", payStripeSession([...stripe.sessions.keys()].at(-1)));
  const second = { id: "cs_test_second", status: "complete", payment_status: "paid", amount_total: 50000, currency: "usd", payment_intent: "pi_second", customer_details: { email: "payer@example.com" }, metadata: { clientSlug: "muskegon-addition", invoiceId: item.id, invoiceNumber: "1" } };
  stripe.sessions.set(second.id, second);
  await signedWebhook("checkout.session.completed", second);
  assert.equal((await ledgerBalances())[2100], -50000);

  stripe.intents.set("pi_second", { metadata: second.metadata });
  stripe.charges.set("ch_second", { id: "ch_second", payment_intent: "pi_second", amount_refunded: 50000, refunded: true, currency: "usd", metadata: {} });
  stripe.refunds.set("ch_second", [{ id: "re_second", amount: 50000, status: "succeeded", created: Math.floor(Date.now() / 1000) }]);
  for (let i = 0; i < 2; i++) assert.equal((await signedWebhook("charge.refunded", { id: "ch_second" })).status, 200);
  assert.deepEqual(await ledgerBalances(), { 1200: 50000 - 262, 4000: -50000, 6100: 262 });
  assert.equal((await stored(item)).payment.refunds, undefined, "the invoice's own payment is untouched");
  const logged = await db("mhb_activity").where({ action: "stripe.refunded" });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].summary, "Refunded $500.00 of a payment for Invoice 1 that was not applied to it");
  assert.match(await (await request("/clients/admin/books", { headers: { Cookie: adminCookie } })).text(), /The books balance\./u);
});

test("the books open with the invoices already in the portal, and their history from their records", async () => {
  const saved = (id, number, extra) => ({ id, clientSlug: "muskegon-addition", kind: "invoice", number, title: `Earlier ${number}`, amountCents: 100000, currency: "usd", status: "open", createdAt: "2026-08-01T15:00:00.000Z", shareToken: `tok_earlier_${id}_0123456789ab`, ...extra });
  for (const item of [
    saved("earlier-open", "1", {}),
    saved("earlier-paid", "2", { status: "paid", paidAt: "2026-08-05", payment: { source: "manual", method: "check", label: "Check #12", amountCents: 100000 }, sentAt: "2026-08-02T15:00:00.000Z", sentTo: "pat@example.com" })
  ]) {
    await db("mhb_billing").insert({ id: item.id, client_slug: item.clientSlug, kind: item.kind, number: item.number, share_token: item.shareToken, data: JSON.stringify(item), created_at: item.createdAt });
  }
  const adminCookie = await loginAsAdmin();
  const opening = await db("mhb_journal_entries").where({ source: "opening" }).orderBy("id").select("item_id", "part", db.raw("to_char(entry_date, 'YYYY-MM-DD') AS date"));
  assert.deepEqual(opening.map((row) => `${row.item_id} ${row.part} ${row.date}`), ["earlier-open issue 2026-08-01", "earlier-paid issue 2026-08-01", "earlier-paid payment 2026-08-05"]);
  assert.deepEqual(await ledgerBalances(), { 1100: 100000, 1300: 100000, 4000: -200000 });
  const history = await db("mhb_activity").whereRaw("data->>'fromRecords' = 'true'").orderBy("id").select("action", "summary");
  assert.deepEqual(history.map((row) => row.action), ["invoice.created", "invoice.created", "invoice.emailed", "payment.recorded"]);
  assert.equal(history[3].summary, "Recorded a Check #12 payment of $1,000.00 for Invoice 2");
  const page = await (await request("/clients/admin/books", { headers: { Cookie: adminCookie } })).text();
  assert.match(page, /The books balance\./u);
  assert.match(page, /opening entry/u);
});

test("the balance check finds an invoice whose entries do not match, and corrections fix it", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Framing", amount: "1,000" });
  await db("mhb_journal_entries").where({ item_id: item.id }).del();
  const off = await (await request("/clients/admin/books", { headers: { Cookie: adminCookie } })).text();
  assert.match(off, /The books do not balance\./u);
  assert.match(off, /Invoice 1 \(Muskegon Addition\): its invoiced amount does not match the journal\./u);

  const corrected = await request("/clients/admin/books/correct", form({}, adminCookie));
  assert.equal(corrected.headers.get("Location"), "/clients/admin/books?notice=books-corrected");
  const page = await (await request(corrected.headers.get("Location"), { headers: { Cookie: adminCookie } })).text();
  assert.match(page, /Corrections posted\. The books balance again\./u);
  assert.match(page, /The books balance\./u);
  assert.deepEqual(await ledgerBalances(), { 1100: 100000, 4000: -100000 });
  assert.match((await db("mhb_activity").where({ action: "books.corrected" }).first()).summary, /Posted corrections for Invoice 1 to balance the books/u);
  assert.equal((await request("/clients/admin/books/correct", form({}, adminCookie))).headers.get("Location"), "/clients/admin/books?notice=books-balanced");
});

test("the Books page totals, lists and downloads the books for every client portal or one, over any dates", async () => {
  const adminCookie = await loginAsAdmin();
  const smith = await addPortal(adminCookie, "=Smith Residence");
  const { item: framing } = await postInvoice(adminCookie, { title: "Framing", amount: "1,000", issuedOn: "2026-08-10" });
  await request(`/clients/admin/clients/muskegon-addition/billing/${framing.id}/record-payment`, form({ method: "zelle", paidOn: "2026-08-15" }, adminCookie));
  await request(`/clients/admin/clients/${smith}/billing`, form({ kind: "invoice", title: "Deck", issuedOn: "2026-09-05", ...lines(["Deck", "1", "3,000"]) }, adminCookie));

  const page = await (await request("/clients/admin/books", { headers: { Cookie: adminCookie } })).text();
  assert.match(page, /<a href="\/clients\/admin\/books">Books<\/a>/u, "the admin menu links to the books");
  assert.match(page, /<dt>Invoiced<\/dt><dd>\$4,000\.00<\/dd>/u);
  assert.match(page, /<dt>Received<\/dt><dd>\$1,000\.00<\/dd>/u);
  assert.match(page, /<dt>Outstanding<\/dt><dd>\$3,000\.00<\/dd>/u);
  assert.match(page, /1100 · Accounts receivable<\/td>\s*<td class="books-money" data-label="Debit">\$3,000\.00<\/td>/u);
  assert.match(page, /<th scope="row">Total<\/th><td class="books-money" data-label="Debit">\$4,000\.00<\/td><td class="books-money" data-label="Credit">\$4,000\.00<\/td>/u);
  assert.match(page, /Recorded a Zelle payment of \$1,000\.00 for Invoice 1/u);

  const smithOnly = await (await request(`/clients/admin/books?client=${smith}`, { headers: { Cookie: adminCookie } })).text();
  assert.match(smithOnly, /<dt>Invoiced<\/dt><dd>\$3,000\.00<\/dd>/u);
  assert.doesNotMatch(smithOnly, /Framing/u);
  const august = await (await request("/clients/admin/books?from=2026-08-01&to=2026-08-31", { headers: { Cookie: adminCookie } })).text();
  assert.match(august, /<dt>Invoiced<\/dt><dd>\$1,000\.00<\/dd>/u);
  assert.match(august, /<dt>Outstanding<\/dt><dd>\$0\.00<\/dd>/u, "owed at the end of August");

  const ledger = await request("/clients/admin/books/ledger.csv", { headers: { Cookie: adminCookie } });
  assert.equal(ledger.headers.get("Content-Type"), "text/csv; charset=utf-8");
  assert.equal(ledger.headers.get("Content-Disposition"), 'attachment; filename="my-home-builder-ledger.csv"');
  const ledgerText = await ledger.text();
  assert.ok(ledgerText.startsWith("Date,Entry,Kind,Client portal,Document,Account,Account name,Debit,Credit,Memo,Source,External id,Recorded at\r\n"));
  assert.match(ledgerText, /\r\n2026-08-10,\d+,issue,Muskegon Addition,Invoice 1,1100,Accounts receivable,1000\.00,,Invoice 1 · Framing,portal,,/u);
  assert.match(ledgerText, /,'=Smith Residence,Invoice 2,/u, "a cell that would run as a formula is quoted");
  const activity = await (await request(`/clients/admin/books/activity.csv?client=${smith}`, { headers: { Cookie: adminCookie } })).text();
  assert.ok(activity.startsWith("Time,Who,Action,Client portal,Document,Amount,What happened,IP address\r\n"));
  assert.match(activity, /,admin,invoice\.created,'=Smith Residence,Invoice 2,3000\.00,"Created Invoice 2 · Deck · \$3,000\.00",/u);
  assert.equal((await request("/clients/admin/books/ledger.csv")).status, 303, "only the admin can download the books");
});

test("the activity log records sign-ins, client portals, templates, documents and quotes accepted", async () => {
  await loginAsClient();
  const adminCookie = await loginAsAdmin();
  await request("/clients/admin/clients", form({ name: "Pine Street", password: "pine-street-2026", emails: "pine@example.com" }, adminCookie, { "CF-Connecting-IP": "198.51.100.77" }));
  await setClientEmail(adminCookie, "pat@example.com");
  await request("/clients/admin/templates", form({ templateName: "Deck package", kind: "quote", title: "Deck", ...lines(["Decking", "1", "400"]) }, adminCookie));
  await request("/clients/admin/clients/muskegon-addition/documents", multipart({}, { bytes: await samplePdf(), name: "contract.pdf", type: "application/pdf" }, adminCookie));
  await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "quote", title: "Deck", ...lines(["Deck", "1", "4,000"]) }, adminCookie));
  const quote = (await billingRecords()).find((entry) => entry.kind === "quote");
  await request(`/clients/quote/${quote.shareToken}/accept`, form({ name: "Pat Hayes" }));

  const rows = await db("mhb_activity").orderBy("id").select("actor", "action", "summary", "ip");
  const find = (action) => rows.find((row) => row.action === action);
  assert.deepEqual({ actor: find("client.signed-in").actor, summary: find("client.signed-in").summary }, { actor: "client", summary: "Muskegon Addition signed in to their portal" });
  assert.equal(find("admin.code-requested").actor, "visitor");
  assert.equal(find("admin.signed-in").summary, "Signed in to the admin panel");
  assert.equal(find("client.created").summary, "Created the client portal Pine Street for pine@example.com");
  assert.equal(find("client.created").ip, "198.51.100.77", "admin actions are logged with the address they came from");
  assert.equal(find("client.emails-saved").summary, "Saved the emails for Muskegon Addition: pat@example.com");
  assert.equal(find("template.saved").summary, "Created the template Deck package");
  assert.equal(find("document.uploaded").summary, "Shared contract.pdf with the client in Other documents");
  assert.deepEqual({ actor: find("quote.accepted").actor, summary: find("quote.accepted").summary }, { actor: "client", summary: "Quote 1 accepted by Pat Hayes" });

  await request("/clients/admin/verify", form({ code: "000000" }));
  assert.equal((await db("mhb_activity").where({ action: "admin.code-rejected" }).first()).summary, "Admin code not accepted: no code was live");
});

test("invoice numbers follow invoice dates across projects, and same-date invoices the order they were entered", async () => {
  const adminCookie = await loginAsAdmin();
  const smith = await addPortal(adminCookie, "Smith Residence");
  const post = async (slug, fields) => {
    const before = new Set((await billingRecords()).map((item) => item.id));
    const response = await request(`/clients/admin/clients/${slug}/billing`, form({ kind: "invoice", ...fields }, adminCookie));
    assert.equal(response.status, 303, await response.clone().text());
    return { response, item: (await billingRecords()).find((entry) => !before.has(entry.id)) };
  };
  const numbers = async () => Object.fromEntries((await billingRecords()).filter((item) => item.kind === "invoice").map((item) => [item.title, item.number]));

  const editor = await (await request("/clients/admin/clients/muskegon-addition/billing/new?kind=invoice", { headers: { Cookie: adminCookie } })).text();
  assert.match(editor, new RegExp(`id="billing-date" name="issuedOn" type="date" required value="${todayInMichigan()}"`, "u"));

  const september = await post("muskegon-addition", { title: "Muskegon September", amount: "1,000", issuedOn: "2026-09-10" });
  await post(smith, { title: "Smith September", amount: "2,000", issuedOn: "2026-09-10" });
  assert.deepEqual(await numbers(), { "Muskegon September": "1", "Smith September": "2" }, "the same date: in the order entered");

  const july = await post(smith, { title: "Smith July", amount: "3,000", issuedOn: "2026-07-30" });
  assert.match(july.response.headers.get("Location"), /notice=billing-added&also=renumbered/u);
  assert.deepEqual(await numbers(), { "Smith July": "1", "Muskegon September": "2", "Smith September": "3" });
  const page = await (await request(july.response.headers.get("Location"), { headers: { Cookie: adminCookie } })).text();
  assert.match(page, /Invoice numbers were updated to keep them in date order\./u);
  assert.match(page, />Invoice 1<\/h1>/u);
  assert.match(page, /<dt>Issued<\/dt><dd>Jul 30, 2026<\/dd>/u);
  for (const row of await db("mhb_billing").where({ kind: "invoice" }).select("number", "data")) assert.equal(json(row.data).number, row.number);

  // Re-dating an invoice moves it; deleting one moves later invoices up.
  const septemberPath = `/clients/admin/clients/muskegon-addition/billing/${september.item.id}`;
  const redated = await request(`${septemberPath}/edit`, form({ title: "Muskegon September", issuedOn: "2026-06-01", ...lines(["Work", "1", "1,000"]) }, adminCookie));
  assert.match(redated.headers.get("Location"), /notice=billing-updated&also=renumbered/u);
  assert.deepEqual(await numbers(), { "Muskegon September": "1", "Smith July": "2", "Smith September": "3" });
  const deleted = await request(`/clients/admin/clients/${smith}/billing/${july.item.id}/delete`, form({}, adminCookie));
  assert.match(deleted.headers.get("Location"), /notice=invoice-deleted&also=renumbered/u);
  assert.deepEqual(await numbers(), { "Muskegon September": "1", "Smith September": "2" });
});

test("a quote made into an invoice keeps naming it as numbers move, and Checkout is not reused under an old number", async () => {
  const adminCookie = await loginAsAdmin();
  await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "quote", title: "Deck", ...lines(["Deck", "1", "4,000"]) }, adminCookie));
  const quote = (await billingRecords()).find((entry) => entry.kind === "quote");
  const quotePath = `/clients/admin/clients/muskegon-addition/billing/${quote.id}`;
  await request(`${quotePath}/invoice`, form({}, adminCookie));
  const invoice = (await billingRecords()).find((entry) => entry.kind === "invoice");
  assert.equal(invoice.number, "1");
  await request(`/clients/pay/${invoice.shareToken}`);
  assert.equal(stripe.created.at(-1)["line_items[0][price_data][product_data][name]"], "Invoice 1 · Deck");

  await postInvoice(adminCookie, { title: "Earlier work", amount: "500", issuedOn: "2026-01-05" });
  assert.equal((await stored(invoice)).number, "2");
  assert.equal((await stored(quote)).invoiceNumber, "2");
  assert.match(await (await request(quotePath, { headers: { Cookie: adminCookie } })).text(), />Invoice 2<\/a>/u);

  await request(`/clients/pay/${invoice.shareToken}`);
  assert.equal(stripe.created.length, 2, "the open Checkout says Invoice 1, so a new one is made");
  assert.equal(stripe.created.at(-1)["line_items[0][price_data][product_data][name]"], "Invoice 2 · Deck");
});

test("a save of an invoice read before its number moved keeps the new number", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Later", amount: "500", issuedOn: "2026-09-20" });
  const stale = await stored(item);
  await postInvoice(adminCookie, { title: "Earlier", amount: "500", issuedOn: "2026-09-01" });
  assert.equal((await stored(item)).number, "2");
  await putBilling(createStore(db), { ...stale, title: "Later, renamed" });
  const saved = await stored(item);
  assert.equal(saved.number, "2");
  assert.equal(saved.title, "Later, renamed");
});

test("invoices and quotes number 1, 2, 3 in separate sequences, shown as Invoice 1 and Quote 1", async () => {
  const adminCookie = await loginAsAdmin();
  const first = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  const second = await postInvoice(adminCookie, { title: "Framing", amount: "800" });
  await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "quote", title: "Deck", ...lines(["Deck", "1", "4,000"]) }, adminCookie));
  const numbers = (await billingRecords()).map((item) => `${item.kind} ${item.number}`).sort();
  assert.deepEqual(numbers, ["invoice 1", "invoice 2", "quote 1"]);

  const adminPage = await (await request(`/clients/admin/clients/muskegon-addition/billing/${second.item.id}`, { headers: { Cookie: adminCookie } })).text();
  assert.match(adminPage, />Invoice 2<\/h1>/u);
  assert.match(adminPage, /<title>Invoice 2 · Framing \| My Home Builder LLC<\/title>/u);
  const view = await (await request(`/clients/invoice/${first.item.shareToken}`)).text();
  assert.match(view, /<span>Invoice<\/span><strong>1<\/strong>/u);
  assert.doesNotMatch(view, /INV-|0001/u);

  await request(`/clients/pay/${first.item.shareToken}`);
  assert.equal(stripe.created.at(-1)["line_items[0][price_data][product_data][name]"], "Invoice 1 · Deposit");
  assert.equal(stripe.created.at(-1)["payment_intent_data[description]"], "Invoice 1 · Deposit");
  assert.equal(stripe.created.at(-1)["metadata[invoiceNumber]"], "1");
});

test("line items total with exact cent rounding, credits and fractional quantities", () => {
  const parsed = parseLineItems(new URLSearchParams([
    ["itemDescription", "Carpentry hours"], ["itemQuantity", "2.5"], ["itemUnitPrice", "$80"],
    ["itemDescription", "Trim"], ["itemQuantity", "1.15"], ["itemUnitPrice", "19.99"],
    ["itemDescription", "Deposit credit"], ["itemQuantity", ""], ["itemUnitPrice", "-100.00"],
    ["itemDescription", ""], ["itemQuantity", "1"], ["itemUnitPrice", ""]
  ]));
  assert.deepEqual(parsed.lineItems.map((line) => line.amountCents), [20000, 2299, -10000]);
  assert.equal(parsed.totalCents, 12299);
  assert.match(parseLineItems(new URLSearchParams([["itemDescription", "Framing"], ["itemQuantity", "1"], ["itemUnitPrice", ""]])).error, /needs a unit price/u);
  assert.match(parseLineItems(new URLSearchParams([["itemDescription", ""], ["itemQuantity", "1"], ["itemUnitPrice", "50"]])).error, /needs a description/u);
  assert.match(parseLineItems(new URLSearchParams()).error, /at least one line/u);
  assert.equal(parseMoney("12,500.5"), 1250050);
  assert.equal(parseMoney("-5"), null);
});

test("admin builds an itemized invoice, emails it, and the client pays from the emailed link", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie);

  const editor = await request("/clients/admin/clients/muskegon-addition/billing/new?kind=invoice", { headers: { Cookie: adminCookie } });
  assert.match(editor.headers.get("Content-Security-Policy"), /script-src 'self'/u);
  assert.match(await editor.text(), /Email it to client@example\.com after posting/u);

  const { response, item } = await postInvoice(adminCookie, {
    title: "Framing draw",
    dueDate: "2026-10-01",
    description: "Second draw for framing.\nNet 15.",
    sendNow: "yes",
    ...lines(["Framing labor", "1", "8,000"], ["Lumber package", "2", "2,250.50"], ["", "1", ""])
  });
  assert.match(response.headers.get("Location"), /notice=billing-sent/u);
  assert.equal(item.number, "1");
  assert.equal(item.amountCents, 1250100);
  assert.equal(item.sentTo, "client@example.com");

  const invoiceEmail = deliveredTo("client@example.com").at(-1);
  assert.equal(invoiceEmail.subject, "Invoice 1 from My Home Builder LLC");
  assert.deepEqual(invoiceEmail.from, { email: "billing@myhomebuilderllc.com", name: "My Home Builder LLC" });
  assert.deepEqual(invoiceEmail.reply_to, { email: "mb@myhomebuilderllc.com" });
  assert.deepEqual(invoiceEmail.categories, ["myhomebuilder-portal", "invoice"]);
  assert.equal(invoiceEmail.tracking.click_tracking.enable, false);
  assert.ok(invoiceEmail.html.includes(`https://myhomebuilderllc.com/clients/pay/${item.shareToken}`));

  const view = await (await request(`/clients/invoice/${item.shareToken}`)).text();
  assert.match(view, /Bill to/u);
  assert.match(view, /Oct 1, 2026/u);
  assert.match(view, new RegExp(`href="/clients/pay/${item.shareToken}">Pay \\$12,501\\.00 securely`, "u"));

  const pay = await request(`/clients/pay/${item.shareToken}`);
  assert.equal(pay.headers.get("Location"), "https://checkout.stripe.com/c/pay/cs_test_1");
  const call = stripe.created.at(-1);
  assert.equal(call["line_items[0][price_data][unit_amount]"], "1250100");
  assert.equal(call.customer_email, "client@example.com");
  assert.equal(call.success_url, `https://myhomebuilderllc.com/clients/pay/${item.shareToken}/return?session_id={CHECKOUT_SESSION_ID}`);
  assert.deepEqual([...stripe.versions], [STRIPE_API_VERSION]);
  assert.equal((await request(`/clients/pay/${item.shareToken}`)).headers.get("Location"), "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(stripe.created.length, 1, "a second click reuses the open checkout");

  payStripeSession("cs_test_1", { amount_total: 1250100 });
  const beforeReturn = email.delivered.length;
  const returned = await request(`/clients/pay/${item.shareToken}/return?session_id=cs_test_1`);
  assert.equal(returned.headers.get("Location"), `/clients/invoice/${item.shareToken}?notice=paid`);
  assert.equal((await stored(item)).status, "paid");
  assert.equal(email.delivered.length, beforeReturn, "with a webhook configured, only the webhook sends payment emails");

  assert.equal((await signedWebhook("checkout.session.completed", stripe.sessions.get("cs_test_1"))).status, 200);
  const receipt = deliveredTo("client@example.com").at(-1);
  assert.equal(receipt.subject, "Receipt for invoice 1 from My Home Builder LLC");
  assert.match(receipt.html, /Visa •••• 4242/u);
  assert.equal(deliveredTo("mb@myhomebuilderllc.com").at(-1).subject, "Invoice 1 paid: $12,501.00 from Muskegon Addition");
  assert.equal((await sentEmail(`muskegon-addition:${item.id}:receipt`)).status, "sent");

  const deliveredBefore = email.delivered.length;
  assert.equal((await signedWebhook("checkout.session.completed", stripe.sessions.get("cs_test_1"))).status, 200);
  assert.equal(email.delivered.length, deliveredBefore, "a repeated webhook does not repeat the receipt");

  const adminPage = await (await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}`, { headers: { Cookie: adminCookie } })).text();
  assert.match(adminPage, /Emailed to client@example\.com on/u);
  assert.match(await (await request(`/clients/invoice/${item.shareToken}`)).text(), /Balance due/u);
});

test("two deliveries of the same payment at once send one receipt", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "twice@example.com");
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  await request(`/clients/pay/${item.shareToken}`);
  const session = payStripeSession([...stripe.sessions.keys()].at(-1), { amount_total: 50000 });
  const results = await Promise.all([signedWebhook("checkout.session.completed", session), signedWebhook("checkout.session.completed", session)]);
  assert.ok(results.some((response) => response.status === 200));
  // A delivery that found the other one mid-send answers 500; Stripe's retry then finds it sent.
  assert.equal((await signedWebhook("checkout.session.completed", session)).status, 200);
  assert.equal(deliveredTo("twice@example.com").filter((message) => message.subject.startsWith("Receipt")).length, 1);
});

test("a stale return after the webhook neither resends the receipt nor erases the record of it", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "race@example.com");
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  await request(`/clients/pay/${item.shareToken}`);
  const sessionId = [...stripe.sessions.keys()].at(-1);
  const beforePayment = await stored(item);

  payStripeSession(sessionId, { amount_total: 50000 });
  assert.equal((await signedWebhook("checkout.session.completed", stripe.sessions.get(sessionId))).status, 200);
  // The return request works from a copy of the invoice read before the webhook's write.
  await db("mhb_billing").where({ id: item.id }).update({ data: JSON.stringify(beforePayment) });
  assert.match((await request(`/clients/pay/${item.shareToken}/return?session_id=${sessionId}`)).headers.get("Location"), /notice=paid/u);
  assert.equal(deliveredTo("race@example.com").filter((message) => message.subject.startsWith("Receipt")).length, 1);
  const adminPage = await (await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}`, { headers: { Cookie: adminCookie } })).text();
  assert.match(adminPage, /Emailed to race@example\.com on/u);
});

test("without a webhook, the client's return from Checkout sends the receipt once", async () => {
  const env = portal({ STRIPE_WEBHOOK_SECRET: "" });
  const adminCookie = await loginAsAdmin(env);
  await setClientEmail(adminCookie, "nohook@example.com");
  const { item } = await postInvoice(adminCookie, { title: "Permit fees", amount: "750" });
  await request(`/clients/pay/${item.shareToken}`, undefined, env);
  const sessionId = [...stripe.sessions.keys()].at(-1);
  payStripeSession(sessionId, { amount_total: 75000 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.match((await request(`/clients/pay/${item.shareToken}/return?session_id=${sessionId}`, undefined, env)).headers.get("Location"), /notice=paid/u);
  }
  assert.equal(deliveredTo("nohook@example.com").filter((message) => message.subject.startsWith("Receipt")).length, 1);
});

test("when SendGrid fails the webhook answers 500, and Stripe's retry sends the receipt once", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "retry@example.com");
  const { item } = await postInvoice(adminCookie, { title: "Roofing", amount: "8,800" });
  await request(`/clients/pay/${item.shareToken}`);
  const session = payStripeSession([...stripe.sessions.keys()].at(-1), { amount_total: 880000 });

  email.failures.push(503, 503);
  assert.equal((await signedWebhook("checkout.session.completed", session)).status, 500);
  assert.equal((await stored(item)).status, "paid", "the payment is recorded even when email is down");
  assert.equal(await sentEmail(`muskegon-addition:${item.id}:receipt`), undefined);
  assert.equal((await signedWebhook("checkout.session.completed", session)).status, 200);
  assert.equal((await signedWebhook("checkout.session.completed", session)).status, 200);
  assert.equal(deliveredTo("retry@example.com").filter((message) => message.subject.startsWith("Receipt")).length, 1);
});

test("a SendGrid rate limit is retried once", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Porch", amount: "4,000" });
  email.failures.push(429);
  const sent = await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}/send`, form({ to: "limit@example.com" }, adminCookie));
  assert.match(sent.headers.get("Location"), /notice=sent/u);
  assert.equal(deliveredTo("limit@example.com").length, 1);
});

test("bank payments stay processing until Stripe confirms them, and a failure reopens the invoice", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "ach@example.com");
  const { item } = await postInvoice(adminCookie, { title: "Foundation draw", amount: "40,000" });

  await request(`/clients/pay/${item.shareToken}`);
  const first = [...stripe.sessions.keys()].at(-1);
  const pending = payStripeSession(first, { payment_status: "unpaid", amount_total: 4000000 });
  await signedWebhook("checkout.session.completed", pending);
  assert.equal((await stored(item)).status, "processing");
  assert.equal((await request(`/clients/pay/${item.shareToken}`)).headers.get("Location"), `/clients/invoice/${item.shareToken}?notice=not-payable`);

  await signedWebhook("checkout.session.async_payment_failed", pending);
  assert.equal((await stored(item)).status, "open");
  assert.equal(deliveredTo("mb@myhomebuilderllc.com").at(-1).subject, "Bank payment failed for Invoice 1");

  await request(`/clients/pay/${item.shareToken}`);
  const second = [...stripe.sessions.keys()].at(-1);
  assert.notEqual(second, first);
  await signedWebhook("checkout.session.completed", payStripeSession(second, { payment_status: "unpaid", amount_total: 4000000 }));
  await signedWebhook("checkout.session.async_payment_succeeded", payStripeSession(second, { amount_total: 4000000 }));
  assert.equal((await stored(item)).status, "paid");
  assert.equal(deliveredTo("ach@example.com").filter((message) => message.subject.startsWith("Receipt")).length, 1);
});

test("a check recorded by the admin emails a receipt, and a later Stripe payment is flagged as a duplicate", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "check@example.com");
  const { item } = await postInvoice(adminCookie, { title: "Cabinet deposit", amount: "3,200" });
  await request(`/clients/pay/${item.shareToken}`);
  const openSession = [...stripe.sessions.keys()].at(-1);

  const recorded = await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}/record-payment`, form({ method: "check", reference: "#1042", paidOn: "2026-09-20", sendReceipt: "yes" }, adminCookie));
  assert.match(recorded.headers.get("Location"), /notice=payment-recorded-receipt/u);
  assert.equal((await stored(item)).payment.label, "Check #1042");
  assert.ok(stripe.expired.includes(openSession), "the unfinished checkout is closed");
  assert.match(deliveredTo("check@example.com").at(-1).text, /Paid on: Sep 20, 2026/u);

  const resend = await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}/receipt`, form({ to: "office@example.com" }, adminCookie));
  assert.match(resend.headers.get("Location"), /notice=receipt-sent/u);
  assert.equal(deliveredTo("office@example.com").length, 1);

  await signedWebhook("checkout.session.completed", payStripeSession(openSession, { amount_total: 320000 }));
  assert.equal((await stored(item)).payment.source, "manual");
  assert.equal(deliveredTo("mb@myhomebuilderllc.com").at(-1).subject, "Check for a duplicate payment on Invoice 1");
});

test("a paid invoice's payment can be corrected, including Other with a typed method, or marked unpaid", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Pre Construction Services", amount: "15,000" });
  const path = `/clients/admin/clients/muskegon-addition/billing/${item.id}`;
  const page = await (await request(path, { headers: { Cookie: adminCookie } })).text();
  for (const option of ["Check", "Cash", "Zelle", "Venmo", "Cash App", "PayPal", "Bank transfer (ACH)", "Wire transfer", "Credit or debit card", "Money order", "Other"]) {
    assert.ok(page.includes(`>${option}</option>`), option);
  }
  assert.match(page, /data-payment-other/u);

  const missing = await request(`${path}/record-payment`, form({ method: "other", methodName: " ", paidOn: "2026-09-25" }, adminCookie));
  assert.match(missing.headers.get("Location"), /notice=payment-other-required/u);
  assert.equal((await stored(item)).status, "open");

  await request(`${path}/record-payment`, form({ method: "check", reference: "#77", paidOn: "2026-09-25" }, adminCookie));
  assert.equal((await stored(item)).payment.label, "Check #77");

  const corrected = await request(`${path}/payment`, form({ method: "zelle", reference: "", paidOn: "2026-09-24" }, adminCookie));
  assert.match(corrected.headers.get("Location"), /notice=payment-updated/u);
  let paid = await stored(item);
  assert.equal(paid.status, "paid");
  assert.equal(paid.payment.label, "Zelle");
  assert.equal(paid.paidAt, "2026-09-24");
  assert.match(await (await request(`/clients/invoice/${item.shareToken}`)).text(), /Paid Sep 24, 2026 · Zelle/u);

  await request(`${path}/payment`, form({ method: "other", methodName: "Trade credit", reference: "Lumber swap", paidOn: "2026-09-24" }, adminCookie));
  paid = await stored(item);
  assert.equal(paid.payment.label, "Trade credit Lumber swap");
  assert.equal(paid.payment.methodName, "Trade credit");
  const edited = await (await request(path, { headers: { Cookie: adminCookie } })).text();
  assert.match(edited, /<option value="other" selected>Other<\/option>/u);
  assert.match(edited, /value="Trade credit"/u);
  assert.match(edited, /Payment details changed/u);

  const editor = await request(`${path}/edit`, { headers: { Cookie: adminCookie } });
  assert.equal(editor.status, 200, "paid invoices can still be edited");
  assert.match(await editor.text(), /This invoice is marked paid/u);

  const reopened = await request(`${path}/reopen`, form({}, adminCookie));
  assert.match(reopened.headers.get("Location"), /notice=payment-removed/u);
  const open = await stored(item);
  assert.equal(open.status, "open");
  assert.equal(open.payment, undefined);
  assert.match(await (await request(`/clients/invoice/${item.shareToken}`)).text(), /I&#39;m paying by check/u);
});

test("a reopened invoice paid later through Stripe gets a fresh receipt, and Stripe payments cannot be edited by hand", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "again@example.com");
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  const path = `/clients/admin/clients/muskegon-addition/billing/${item.id}`;
  const receipts = () => deliveredTo("again@example.com").filter((message) => message.subject.startsWith("Receipt")).length;

  await request(`${path}/record-payment`, form({ method: "cash", paidOn: "2026-09-25", sendReceipt: "yes" }, adminCookie));
  assert.equal(receipts(), 1);
  await request(`${path}/reopen`, form({}, adminCookie));
  assert.equal(await sentEmail(`muskegon-addition:${item.id}:receipt`), undefined);

  await request(`/clients/pay/${item.shareToken}`);
  const session = payStripeSession([...stripe.sessions.keys()].at(-1), { amount_total: 50000 });
  assert.equal((await signedWebhook("checkout.session.completed", session)).status, 200);
  assert.equal((await stored(item)).payment.source, "stripe");
  assert.equal(receipts(), 2);

  assert.match((await request(`${path}/payment`, form({ method: "zelle", paidOn: "2026-09-25" }, adminCookie))).headers.get("Location"), /notice=payment-from-stripe/u);
  assert.match((await request(`${path}/reopen`, form({}, adminCookie))).headers.get("Location"), /notice=payment-from-stripe/u);
  assert.equal((await stored(item)).status, "paid");
  assert.match(await (await request(path, { headers: { Cookie: adminCookie } })).text(), /Paid online through Stripe/u);
  assert.match(await (await request(`${path}/edit`, { headers: { Cookie: adminCookie } })).text(), /the Stripe payment stays as Stripe recorded it/u);
});

test("templates are saved, listed, used for a new quote, edited and deleted", async () => {
  const adminCookie = await loginAsAdmin();
  const invalid = await request("/clients/admin/templates", form({ kind: "quote", title: "Deck", ...lines(["Decking", "1", "10"]) }, adminCookie));
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /Give the template a name/u);

  const created = await request("/clients/admin/templates", form({ templateName: "Deck package", kind: "quote", title: "Composite deck", dueInDays: "30", ...lines(["Composite decking", "320", "14.50"], ["Railing", "1", "2,400"]) }, adminCookie));
  assert.equal(created.status, 303);
  const [template] = (await db("mhb_templates").select("data")).map((row) => json(row.data));
  assert.equal(template.amountCents, 704000);
  assert.match(await (await request("/clients/admin/templates", { headers: { Cookie: adminCookie } })).text(), /Deck package/u);

  const fromTemplate = await (await request(`/clients/admin/clients/muskegon-addition/billing/new?template=${template.id}`, { headers: { Cookie: adminCookie } })).text();
  assert.match(fromTemplate, /value="Composite decking"/u);
  assert.match(fromTemplate, /name="kind" value="quote" checked/u);
  assert.match(fromTemplate, new RegExp(`value="${addDays(todayInMichigan(), 30)}"`, "u"));

  const saved = await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "invoice", title: "Rough plumbing", saveTemplate: "yes", templateName: "Rough plumbing", ...lines(["Rough-in", "1", "6,500"]) }, adminCookie));
  assert.match(saved.headers.get("Location"), /also=template-saved/u);
  assert.equal((await db("mhb_templates").count("* as n").first()).n, 2);

  await request(`/clients/admin/templates/${template.id}`, form({ templateName: "Deck package (large)", kind: "quote", title: "Composite deck", ...lines(["Composite decking", "400", "14.50"]) }, adminCookie));
  assert.equal(json((await db("mhb_templates").where({ id: template.id }).first()).data).name, "Deck package (large)");
  await request(`/clients/admin/templates/${template.id}/delete`, form({}, adminCookie));
  assert.equal(await db("mhb_templates").where({ id: template.id }).first(), undefined);
});

test("a quote link lets the client accept by name, the builder is told, and the quote becomes an invoice", async () => {
  const adminCookie = await loginAsAdmin();
  await setClientEmail(adminCookie, "quote@example.com");
  const posted = await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "quote", title: "Kitchen remodel", sendNow: "yes", ...lines(["Cabinets", "1", "18,000"], ["Counters", "1", "6,500"]) }, adminCookie));
  assert.match(posted.headers.get("Location"), /notice=billing-sent/u);
  const [quote] = await billingRecords();
  assert.equal(quote.number, "1");
  assert.ok(deliveredTo("quote@example.com").at(-1).html.includes(`/clients/quote/${quote.shareToken}`));

  const noName = await request(`/clients/quote/${quote.shareToken}/accept`, form({ name: " " }));
  assert.equal(noName.status, 400);
  const accepted = await request(`/clients/quote/${quote.shareToken}/accept`, form({ name: "Pat Client" }));
  assert.equal(accepted.headers.get("Location"), `/clients/quote/${quote.shareToken}?notice=accepted`);
  assert.equal((await stored(quote)).acceptedBy, "Pat Client");
  assert.equal(deliveredTo("mb@myhomebuilderllc.com").at(-1).subject, "Quote 1 accepted by Muskegon Addition");

  const converted = await request(`/clients/admin/clients/muskegon-addition/billing/${quote.id}/invoice`, form({}, adminCookie));
  assert.match(converted.headers.get("Location"), /notice=invoice-created/u);
  const invoice = (await billingRecords()).find((entry) => entry.kind === "invoice");
  assert.equal(invoice.number, "1", "invoices and quotes have separate sequences");
  assert.equal(invoice.amountCents, 2450000);
  assert.equal((await stored(quote)).invoiceNumber, "1");
  assert.equal((await request(`/clients/pay/${quote.shareToken}`)).headers.get("Location"), `/clients/quote/${quote.shareToken}`);
});

test("editing an open invoice closes its stale checkout; void invoices cannot be paid or edited", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Siding", ...lines(["Siding", "1", "9,000"]) });
  await request(`/clients/pay/${item.shareToken}`);
  const firstSession = [...stripe.sessions.keys()].at(-1);

  assert.match(await (await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}/edit`, { headers: { Cookie: adminCookie } })).text(), /value="9000\.00"/u);
  await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}/edit`, form({ title: "Siding and trim", ...lines(["Siding", "1", "9,000"], ["Trim", "1", "1,250"]) }, adminCookie));
  assert.equal((await stored(item)).amountCents, 1025000);
  assert.ok(stripe.expired.includes(firstSession));
  await request(`/clients/pay/${item.shareToken}`);
  assert.equal(stripe.created.at(-1)["line_items[0][price_data][unit_amount]"], "1025000");

  await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}/void`, form({}, adminCookie));
  assert.equal((await stored(item)).status, "void");
  assert.match((await request(`/clients/pay/${item.shareToken}`)).headers.get("Location"), /notice=not-payable/u);
  assert.match((await request(`/clients/admin/clients/muskegon-addition/billing/${item.id}/edit`, { headers: { Cookie: adminCookie } })).headers.get("Location"), /notice=not-editable/u);
});

test("the editor keeps the admin's input and explains what to fix", async () => {
  const adminCookie = await loginAsAdmin();
  const response = await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "invoice", title: "Windows", ...lines(["Window package", "1", ""]) }, adminCookie));
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.match(body, /Line 1 needs a unit price/u);
  assert.match(body, /value="Window package"/u);
  assert.equal((await billingRecords()).length, 0);
  const tiny = await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "invoice", title: "Tiny", ...lines(["Nail", "1", "0.10"]) }, adminCookie));
  assert.match(await tiny.text(), /at least \$0\.50/u);
});

test("invoice numbers are unique across client portals and each client sees only its own", async () => {
  const adminCookie = await loginAsAdmin();
  await request("/clients/admin/clients", form({ name: "Wolf Lake Views", slug: "wolf-lake-views", password: "wolflakeviews-login-2026" }, adminCookie));
  await postInvoice(adminCookie, { title: "Muskegon deposit", amount: "1,000" });
  await request("/clients/admin/clients/wolf-lake-views/billing", form({ kind: "invoice", title: "Wolf deposit", ...lines(["Deposit", "1", "2,000"]) }, adminCookie));
  assert.deepEqual((await billingRecords()).map((item) => `${item.clientSlug}:${item.number}`).sort(), ["muskegon-addition:1", "wolf-lake-views:2"]);

  const clientCookie = await loginAsClient();
  const home = await (await request("/clients", { headers: { Cookie: clientCookie } })).text();
  assert.match(home, /<span class="portal-number">1<\/span>/u);
  assert.doesNotMatch(home, /<span class="portal-number">2<\/span>/u);
  const id = home.match(/href="\/clients\/billing\/([^"]+)"/u)[1];
  assert.match(await (await request(`/clients/billing/${id}`, { headers: { Cookie: clientCookie } })).text(), /Pay \$1,000\.00 securely/u);
  const pay = await request(`/clients/billing/${id}/pay`, { method: "POST", headers: { Cookie: clientCookie } });
  assert.equal(pay.headers.get("Location"), "https://checkout.stripe.com/c/pay/cs_test_1");
});

test("share links reject unknown, short and malformed tokens", async () => {
  for (const path of ["/clients/invoice/short", "/clients/invoice/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "/clients/pay/%E0%A4%A"]) {
    assert.equal((await request(path)).status, 404, path);
  }
  assert.equal((await request("/clients/quote/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/accept", form({ name: "x" }))).status, 404);
});

test("the Stripe webhook accepts only a valid signature", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  const payload = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_live_1", payment_status: "paid", metadata: { clientSlug: "muskegon-addition", invoiceId: item.id } } } });
  const timestamp = Math.floor(Date.now() / 1000);
  const forged = await request("/clients/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": `t=${timestamp},v1=deadbeef` }, body: payload });
  assert.equal(forged.status, 400);
  assert.equal((await stored(item)).status, "open");
});

// ---------- Documents and e-signing ----------

test("documents go into the section the admin chooses, from the client's portal or the Documents page", async () => {
  const clientCookie = await loginAsClient();
  const adminCookie = await loginAsAdmin(portal(), clientCookie);
  const pdf = await samplePdf();
  const shared = await request("/clients/admin/clients/muskegon-addition/documents",
    multipart({ section: "change-orders", requiresClientSignature: "yes" }, { bytes: pdf, name: "Change Order 1.pdf", type: "application/pdf" }, adminCookie));
  assert.equal(shared.headers.get("Location"), "/clients/admin?client=muskegon-addition&notice=document-shared");
  const fromPage = await request("/clients/admin/documents",
    multipart({ client: "muskegon-addition", section: "permits" }, { bytes: pdf, name: "Building Permit.pdf", type: "application/pdf" }, adminCookie));
  assert.equal(fromPage.headers.get("Location"), "/clients/admin/documents?notice=document-shared");
  const odd = await request("/clients/admin/documents",
    multipart({ client: "muskegon-addition", section: "not-a-section" }, { bytes: pdf, name: "Notes.pdf", type: "application/pdf" }, adminCookie));
  assert.match(odd.headers.get("Location"), /notice=document-shared/u);
  assert.match((await request("/clients/admin/documents", multipart({ client: "no-such-portal", section: "plans" }, { bytes: pdf, name: "x.pdf", type: "application/pdf" }, adminCookie))).headers.get("Location"), /notice=invalid/u);
  await request("/clients/documents/upload", multipart({}, { bytes: pdf, name: "Survey.pdf", type: "application/pdf" }, clientCookie));

  const sections = Object.fromEntries((await db("mhb_documents").select("data")).map((row) => json(row.data)).map((document) => [document.name, document.section]));
  assert.deepEqual(sections, { "Change Order 1.pdf": "change-orders", "Building Permit.pdf": "permits", "Notes.pdf": "other", "Survey.pdf": "uploads" });

  const home = await (await request("/clients", { headers: { Cookie: clientCookie } })).text();
  const headings = [...home.matchAll(/<h3 class="document-section-heading">([^<]+)<\/h3>/gu)].map((match) => match[1]);
  assert.deepEqual(headings, ["Change orders", "Permits and inspections", "Other documents", "Uploaded by you"]);
  assert.match(home, /Change Order 1\.pdf[\s\S]*?Awaiting your signature/u);

  const admin = await (await request("/clients/admin?client=muskegon-addition", { headers: { Cookie: adminCookie } })).text();
  assert.match(admin, /<h3 class="document-section-heading">Uploaded by the client<\/h3>/u);
  assert.match(admin, /<select id="admin-upload-section" name="section"><option value="contracts" selected>Contracts and agreements<\/option>/u);

  const page = await (await request("/clients/admin/documents", { headers: { Cookie: adminCookie } })).text();
  assert.match(page, /<h1 class="portal-heading">Documents\.<\/h1>/u);
  assert.match(page, /<option value="muskegon-addition">Muskegon Addition<\/option>/u);
  assert.match(page, /Awaiting signatures[\s\S]*Change Order 1\.pdf<small>Muskegon Addition · Change orders ·/u);
  assert.match(page, /Shared recently[\s\S]*Building Permit\.pdf<small>Muskegon Addition · Permits and inspections ·/u);
  assert.match(page, /<a href="\/clients\/admin\/documents">Documents<\/a>/u);
  assert.equal((await request("/clients/admin/documents")).headers.get("Location"), "/clients", "admin only");
});

test("admin shares a contract, signs it, and the client countersigns into a signed PDF", async () => {
  const clientCookie = await loginAsClient();
  const adminCookie = await loginAsAdmin(portal(), clientCookie);
  const upload = await request("/clients/admin/clients/muskegon-addition/documents",
    multipart({ requiresClientSignature: "yes", requiresAdminSignature: "yes" }, { bytes: await samplePdf(), name: "Build Contract.pdf", type: "application/pdf" }, adminCookie));
  assert.match(upload.headers.get("Location"), /notice=document-shared/u);
  const document = json((await db("mhb_documents").first()).data);

  const adminSigned = await request(`/clients/admin/clients/muskegon-addition/documents/${document.id}/sign`, form({ name: "Builder Owner", consent: "yes", signature: "" }, adminCookie));
  assert.equal(adminSigned.status, 303);
  const home = await (await request("/clients", { headers: { Cookie: clientCookie } })).text();
  assert.match(home, /Awaiting your signature/u);

  const dot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  assert.equal((await request(`/clients/documents/${document.id}/sign`, form({ name: "Client Person", signature: dot }, clientCookie))).status, 400);
  const clientSigned = await request(`/clients/documents/${document.id}/sign`, form({ name: "Client Person", consent: "yes", signature: dot }, clientCookie));
  assert.match(clientSigned.headers.get("Location"), /notice=signed/u);

  const record = json((await db("mhb_documents").where({ id: document.id }).first()).data);
  assert.deepEqual(record.signatures.map((entry) => entry.party), ["admin", "client"]);
  const download = await request(`/clients/documents/${document.id}`, { headers: { Cookie: clientCookie } });
  assert.match(download.headers.get("Content-Disposition"), /Build Contract-signed\.pdf/u);
  const signedPdf = await PDFDocument.load(new Uint8Array(await download.arrayBuffer()));
  assert.equal(signedPdf.getPageCount(), 2);
});

test("client uploads are stored per client and rejected when the type is not allowed", async () => {
  const clientCookie = await loginAsClient();
  const photo = await request("/clients/documents/upload", multipart({}, { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), name: "site photo.jpg", type: "image/jpeg" }, clientCookie));
  assert.match(photo.headers.get("Location"), /notice=uploaded/u);
  assert.ok((await db("mhb_files").select("key")).some((row) => row.key.startsWith("clients/muskegon-addition/documents/")));
  const rejected = await request("/clients/documents/upload", multipart({}, { bytes: new Uint8Array([1, 2, 3]), name: "tool.exe", type: "application/x-msdownload" }, clientCookie));
  assert.match(rejected.headers.get("Location"), /notice=upload-failed/u);
});

// ---------- Through Express: the forwarding boundary ----------

test("only the site's Function can reach the portal, and it is off until enabled", async () => {
  assert.equal((await proxied("/clients", {}, { key: "" })).status, 403);
  assert.equal((await proxied("/clients", {}, { key: "wrong-secret-that-is-long-enough-00000000" })).status, 403);
  assert.equal((await proxied("/clients", {}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await proxied("/clients", {}, { ip: "not-an-ip" })).status, 403);
  assert.equal((await proxied("/admin")).status, 404);

  const page = await proxied("/clients");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Private project access/u);

  process.env.MHB_PORTAL_ENABLED = "false";
  assert.equal((await proxied("/clients")).status, 503);
});

test("forms, cookies, redirects and uploads pass through the router", async () => {
  const login = await proxied("/clients/login", form({ password: process.env.MHB_CLIENT_PORTAL_PASSWORD }));
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("Location"), "/clients");
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  assert.match(await (await proxied("/clients", { headers: { Cookie: cookie } })).text(), /Muskegon Addition Selections/u);

  const grant = await proxied("/clients/muskegon-addition/index.html", { headers: { Cookie: cookie } });
  assert.equal(grant.headers.get("X-MHB-Asset"), "/clients/muskegon-addition/index.html");

  const body = new FormData();
  body.append("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9])], "porch.jpg", { type: "image/jpeg" }));
  const upload = await proxied("/clients/documents/upload", { method: "POST", headers: { Cookie: cookie }, body });
  assert.match(upload.headers.get("Location"), /notice=uploaded/u);
  const [file] = await db("mhb_files").select("key", "size");
  assert.match(file.key, /porch\.jpg$/u);
  assert.equal(file.size, 5);
});

test("Stripe reaches the webhook directly, and forged signatures are refused", async () => {
  const adminCookie = await loginAsAdmin();
  const { item } = await postInvoice(adminCookie, { title: "Deposit", amount: "500" });
  await request(`/clients/pay/${item.shareToken}`);
  const session = payStripeSession([...stripe.sessions.keys()].at(-1), { amount_total: 50000 });
  const forged = await realFetch(`${base}/stripe/webhook`, { method: "POST", headers: { "Stripe-Signature": "t=1,v1=bad", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(forged.status, 400);
  const genuine = await signedWebhook("checkout.session.completed", session, { http: true });
  assert.equal(genuine.status, 200);
  assert.equal((await stored(item)).status, "paid");
});

test("sign-in attempts are limited per visitor, and the admin write switch pauses admin changes", async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal((await proxied("/clients/login", form({ password: "wrong" }), { ip: "192.0.2.44" })).status, 401);
  }
  assert.equal((await proxied("/clients/login", form({ password: "wrong" }), { ip: "192.0.2.44" })).status, 429);
  assert.equal((await proxied("/clients/login", form({ password: "wrong" }), { ip: "192.0.2.45" })).status, 401);

  process.env.ADMIN_WRITES_ENABLED = "false";
  const paused = await proxied("/clients/admin/clients", form({ name: "Paused", slug: "paused-client", password: "paused-login-2026" }));
  assert.equal(paused.status, 423);
  assert.match(await paused.text(), /Admin changes are paused/u);
});

// ---------- Labor: the crew portal and the admin Labor pages ----------

function crewForm(fields, file = null, cookies = "") {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  if (file) body.append("file", new File([file.bytes], file.name, { type: file.type }));
  return { method: "POST", headers: cookies ? { Cookie: cookies } : {}, body };
}

async function workerRecord(email) {
  const row = await db("mhb_workers").where({ email }).first();
  return row ? json(row.data) : null;
}

async function laborRecords() {
  return (await db("mhb_labor").select("data")).map((row) => json(row.data));
}

// Adds an employee or subcontractor, follows the emailed invite and chooses a password.
// Returns the worker and their crew session cookie.
async function addCrew(adminCookie, fields) {
  const added = await request("/clients/admin/labor/workers", form(fields, adminCookie));
  assert.equal(added.status, 303, await added.clone().text());
  assert.match(added.headers.get("Location"), /notice=worker-added$/u);
  const invite = deliveredTo(fields.email.toLowerCase()).at(-1);
  assert.equal(invite.subject, "Set up your My Home Builder crew portal");
  const link = invite.text.match(/https:\/\/myhomebuilderllc\.com(\/clients\/crew\/welcome\/[A-Za-z0-9_-]+)/u)[1];
  const page = await request(link);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Choose a password/u);
  const set = await request(link, form({ password: "crew-password-2026", confirm: "crew-password-2026" }));
  assert.equal(set.status, 303);
  assert.equal(set.headers.get("Location"), "/clients/crew?notice=password-set");
  assert.equal((await request(link)).status, 410, "an invite link works once");
  return { worker: await workerRecord(fields.email.toLowerCase()), cookie: cookieValue(set) };
}

async function withSite(adminCookie, slug = "muskegon-addition", siteAddress = "5899 1/2 White Rd, Muskegon, MI 49442") {
  const saved = await request(`/clients/admin/clients/${slug}/site`, form({ siteAddress }, adminCookie));
  assert.equal(saved.status, 303);
}

test("a subcontractor is invited, chooses a password, and signs in to the crew portal", async () => {
  const adminCookie = await loginAsAdmin();
  const { worker, cookie } = await addCrew(adminCookie, { kind: "subcontractor", name: "Dana Reyes", email: "Dana@Example.com", company: "Reyes Drywall LLC", trade: "Drywall" });
  assert.equal(worker.email, "dana@example.com");
  assert.equal(worker.kind, "subcontractor");
  assert.match(worker.passwordHash, /^pbkdf2\$/u);
  assert.equal(worker.invite, null);

  const home = await (await request("/clients/crew", { headers: { Cookie: cookie } })).text();
  assert.match(home, /Hi, Dana\./u);
  assert.match(home, /Form W-9/u);
  assert.match(home, /Certificate of insurance/u);
  assert.match(home, /Send an invoice/u);
  assert.doesNotMatch(home, /Send your hours/u);

  const wrong = await request("/clients/crew/login", form({ email: "dana@example.com", password: "not-the-password" }));
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /did not match/u);
  const right = await request("/clients/crew/login", form({ email: "DANA@example.com", password: "crew-password-2026" }));
  assert.equal(right.status, 303);
  assert.match(right.headers.get("Set-Cookie"), /__Secure-mhb_crew_session=.+; Max-Age=43200; Path=\/clients; HttpOnly; Secure; SameSite=Lax/u);

  // A crew session opens nothing else, and a client session is not a crew session.
  assert.equal((await request("/clients/admin/labor", { headers: { Cookie: cookie } })).headers.get("Location"), "/clients");
  assert.match(await (await request("/clients/crew", { headers: { Cookie: await loginAsClient() } })).text(), /Crew and subcontractors\./u);
  const activity = await db("mhb_activity").where({ actor: "crew" }).select("action");
  assert.ok(activity.some((row) => row.action === "crew.signed-in"));
});

test("forgot password answers the same for anyone, and emails a 2-hour link only to the crew", async () => {
  const adminCookie = await loginAsAdmin();
  await addCrew(adminCookie, { kind: "employee", name: "Sam Ortiz", email: "sam@example.com" });
  const before = email.delivered.length;
  const unknown = await (await request("/clients/crew/forgot", form({ email: "nobody@example.com" }))).text();
  const known = await (await request("/clients/crew/forgot", form({ email: "sam@example.com" }))).text();
  assert.equal(unknown, known);
  assert.equal(email.delivered.length, before + 1);
  const reset = email.delivered.at(-1);
  assert.equal(reset.subject, "Reset your My Home Builder crew portal password");
  assert.match(reset.text, /works for 2 hours/u);
  const link = reset.text.match(/(\/clients\/crew\/welcome\/[A-Za-z0-9_-]+)/u)[1];
  const set = await request(link, form({ password: "short", confirm: "short" }));
  assert.equal(set.status, 400);
  assert.match(await set.text(), /at least 10 characters/u);
  assert.equal((await request(link, form({ password: "a-new-password-1", confirm: "a-new-password-1" }))).status, 303);
  assert.equal((await request("/clients/crew/login", form({ email: "sam@example.com", password: "a-new-password-1" }))).status, 303);
});

test("a subcontractor's invoice on a job comes with a signed Michigan conditional lien waiver", async () => {
  const adminCookie = await loginAsAdmin();
  await withSite(adminCookie);
  const { worker, cookie } = await addCrew(adminCookie, { kind: "subcontractor", name: "Dana Reyes", email: "dana@example.com", company: "Reyes Drywall LLC", phone: "231-555-0101" });
  const today = todayInMichigan();
  const sent = await request("/clients/crew/bills", crewForm({ job: "muskegon-addition", invoiceNumber: "R-101", invoiceDate: today, amount: "4,250.00", through: today, description: "Drywall hang and finish" }, { bytes: await samplePdf(), name: "R-101.pdf", type: "application/pdf" }, cookie));
  assert.equal(sent.status, 303, await sent.clone().text());
  const [entry] = await laborRecords();
  assert.equal(entry.status, "waiver");
  assert.equal(entry.amountCents, 425000);
  assert.equal(sent.headers.get("Location"), `/clients/crew/bills/${entry.id}/waiver`);

  const page = await (await request(sent.headers.get("Location"), { headers: { Cookie: cookie } })).text();
  assert.match(page, /PARTIAL CONDITIONAL WAIVER/u);
  assert.match(page, /value="5899 1\/2 White Rd, Muskegon, MI 49442"/u);
  assert.match(page, /This waiver is conditioned on actual payment of the amount shown above\./u);
  assert.match(page, /\$4,250\.00/u);

  const fields = { property: "5899 1/2 White Rd, Muskegon, MI 49442", provided: "Drywall hang and finish", claimant: "Reyes Drywall LLC", address: "12 Pine St, Muskegon, MI 49441", phone: "231-555-0101", name: "Dana Reyes", consent: "yes" };
  const missing = await request(sent.headers.get("Location"), form(fields, cookie));
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /covers all amounts/u);
  const signed = await request(sent.headers.get("Location"), form({ ...fields, coversAll: "yes" }, cookie));
  assert.equal(signed.headers.get("Location"), "/clients/crew?notice=bill-sent");

  const [saved] = await laborRecords();
  assert.equal(saved.status, "submitted");
  assert.equal(saved.waiver.kind, "partial-conditional");
  assert.equal(saved.waiver.coversAll, true);
  const waiver = await request(`/clients/admin/labor/entries/${saved.id}/waiver`, { headers: { Cookie: adminCookie } });
  assert.equal(waiver.status, 200);
  const pdf = await PDFDocument.load(new Uint8Array(await waiver.arrayBuffer()));
  assert.equal(pdf.getTitle(), "Partial conditional waiver");
  assert.equal((await workerRecord("dana@example.com")).address, "12 Pine St, Muskegon, MI 49441", "the address is remembered for the next waiver");
  const notice = deliveredTo("mb@myhomebuilderllc.com").at(-1);
  assert.equal(notice.subject, "Invoice from Reyes Drywall LLC: $4,250.00");
  assert.match(notice.text, /partial conditional waiver/u);

  // The same invoice number cannot be sent twice; a final invoice gets the full waiver.
  const again = await request("/clients/crew/bills", crewForm({ job: "muskegon-addition", invoiceNumber: "r-101", invoiceDate: today, amount: "10", through: today, description: "More" }, null, cookie));
  assert.equal(again.status, 400);
  assert.match(await again.text(), /already sent invoice r-101/u);
  const final = await request("/clients/crew/bills", crewForm({ job: "muskegon-addition", invoiceNumber: "R-102", invoiceDate: today, amount: "750", through: today, description: "Punch list", final: "yes" }, null, cookie));
  assert.match(await (await request(final.headers.get("Location"), { headers: { Cookie: cookie } })).text(), /FULL CONDITIONAL WAIVER/u);
  assert.equal(worker.kind, "subcontractor");
});

test("approving labor to a job books its cost, paying clears what is owed, and the books balance", async () => {
  const adminCookie = await loginAsAdmin();
  await withSite(adminCookie);
  const { cookie } = await addCrew(adminCookie, { kind: "subcontractor", name: "Dana Reyes", email: "dana@example.com", company: "Reyes Drywall LLC" });
  const today = todayInMichigan();
  const sent = await request("/clients/crew/bills", crewForm({ job: "muskegon-addition", invoiceNumber: "R-7", invoiceDate: today, amount: "1000", through: today, description: "Drywall" }, null, cookie));
  await request(sent.headers.get("Location"), form({ property: "Site", provided: "Drywall", claimant: "Reyes Drywall LLC", address: "12 Pine St", phone: "231-555-0101", coversAll: "no", name: "Dana Reyes", consent: "yes" }, cookie));
  const [entry] = await laborRecords();

  const labor = await (await request("/clients/admin/labor", { headers: { Cookie: adminCookie } })).text();
  assert.match(labor, /Waiting for approval/u);
  assert.match(labor, /Invoice R-7/u);
  const approved = await request(`/clients/admin/labor/entries/${entry.id}/approve`, form({ job: "muskegon-addition" }, adminCookie));
  assert.equal(approved.headers.get("Location"), "/clients/admin/labor?notice=approved");
  assert.deepEqual(await ledgerBalances(), { 2000: -100000, 5100: 100000 });
  const cost = await db("mhb_journal_entries").where({ item_id: entry.id, part: "cost" }).first();
  assert.equal(cost.client_slug, "muskegon-addition");

  const paid = await request(`/clients/admin/labor/entries/${entry.id}/paid`, form({ method: "check", reference: "#2044", paidOn: today }, adminCookie));
  assert.equal(paid.headers.get("Location"), "/clients/admin/labor?notice=labor-paid");
  assert.deepEqual(await ledgerBalances(), { 1000: -100000, 5100: 100000 });
  const unpaid = await request(`/clients/admin/labor/entries/${entry.id}/unpaid`, form({}, adminCookie));
  assert.equal(unpaid.headers.get("Location"), "/clients/admin/labor?notice=labor-unpaid");
  assert.deepEqual(await ledgerBalances(), { 2000: -100000, 5100: 100000 });

  const books = await (await request("/clients/admin/books", { headers: { Cookie: adminCookie } })).text();
  assert.match(books, /The books balance\./u);
  assert.match(books, /Owed to crew/u);
  assert.match(books, /books-jobs/u);
  assert.match(books, /Subcontractors/u);
  // Paying twice, or approving what is already approved, is refused.
  assert.equal((await request(`/clients/admin/labor/entries/${entry.id}/approve`, form({ job: "" }, adminCookie))).headers.get("Location"), "/clients/admin/labor?notice=not-waiting");
});

test("an employee's hours are costed at their rate on approval, and returned hours show the note", async () => {
  const adminCookie = await loginAsAdmin();
  const { worker, cookie } = await addCrew(adminCookie, { kind: "employee", name: "Sam Ortiz", email: "sam@example.com", rate: "28.50", startDate: todayInMichigan() });
  assert.equal(worker.hourlyRateCents, 2850);
  const today = todayInMichigan();
  for (const hours of ["8", "7:30"]) {
    const sent = await request("/clients/crew/hours", form({ workDate: today, job: "muskegon-addition", hours, description: "Framing" }, cookie));
    assert.equal(sent.headers.get("Location"), "/clients/crew?notice=hours-sent");
  }
  const bad = await request("/clients/crew/hours", form({ workDate: today, job: "", hours: "25" }, cookie));
  assert.equal(bad.status, 400);
  assert.equal((await request("/clients/crew/bills", crewForm({ job: "" }, null, cookie))).headers.get("Location"), "/clients/crew", "employees send hours, not invoices");

  const entries = await laborRecords();
  const eight = entries.find((entry) => entry.hours === 800);
  const half = entries.find((entry) => entry.hours === 750);
  assert.ok(eight && half);
  const labor = await (await request("/clients/admin/labor", { headers: { Cookie: adminCookie } })).text();
  assert.match(labor, /value="228\.00"/u, "8 hours at $28.50");
  assert.match(labor, /value="213\.75"/u, "7.5 hours at $28.50");

  assert.equal((await request(`/clients/admin/labor/entries/${eight.id}/approve`, form({ job: "muskegon-addition", amount: "" }, adminCookie))).headers.get("Location"), "/clients/admin/labor?notice=amount-required");
  await request(`/clients/admin/labor/entries/${eight.id}/approve`, form({ job: "muskegon-addition", amount: "228.00" }, adminCookie));
  assert.deepEqual(await ledgerBalances(), { 2300: -22800, 5000: 22800 });
  await request(`/clients/admin/labor/entries/${half.id}/return`, form({ note: "That day was 6 hours" }, adminCookie));
  const home = await (await request("/clients/crew", { headers: { Cookie: cookie } })).text();
  assert.match(home, /Returned/u);
  assert.match(home, /That day was 6 hours/u);

  // Undoing an approval takes its cost back out.
  await request(`/clients/admin/labor/entries/${eight.id}/unapprove`, form({}, adminCookie));
  assert.deepEqual(await ledgerBalances(), {});
  assert.match(await (await request("/clients/admin/books", { headers: { Cookie: adminCookie } })).text(), /The books balance\./u);
});

test("paperwork is filled out and signed on the site, stored encrypted, and the I-9 is completed by the admin", async () => {
  const adminCookie = await loginAsAdmin();
  const { worker, cookie } = await addCrew(adminCookie, { kind: "employee", name: "Sam Ortiz", email: "sam@example.com", startDate: todayInMichigan() });
  const w4 = await (await request("/clients/crew/forms/w4", { headers: { Cookie: cookie } })).text();
  assert.match(w4, /Employee&#39;s Withholding Certificate/u);
  assert.match(w4, /name="firstName"[^>]*value="Sam"/u);

  const answers = { firstName: "Sam", lastName: "Ortiz", address: "44 Oak Ave", cityStateZip: "Muskegon, MI 49441", ssn: "123-45-6789", filingStatus: "single", children: "1", name: "Sam Ortiz", consent: "yes" };
  const noSsn = await request("/clients/crew/forms/w4", form({ ...answers, ssn: "12345" }, cookie));
  assert.equal(noSsn.status, 400);
  assert.match(await noSsn.text(), /9-digit Social Security number/u);
  const signed = await request("/clients/crew/forms/w4", form(answers, cookie));
  assert.equal(signed.headers.get("Location"), "/clients/crew?notice=form-signed");

  const secure = await db("mhb_secure").where({ key: `crew/${worker.id}/w4.json` }).first();
  assert.equal(secure.key_id, "session");
  assert.ok(!Buffer.from(secure.ciphertext).toString("latin1").includes("123-45-6789"), "the answers are encrypted");
  const download = await request("/clients/crew/forms/w4/pdf", { headers: { Cookie: cookie } });
  assert.equal(download.status, 200);
  const bytes = new Uint8Array(await download.arrayBuffer());
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  assert.equal((await PDFDocument.load(bytes)).getForm().getFields().length, 0, "the signed form is flat");
  assert.ok((await workerRecord("sam@example.com")).paperwork.w4.signedAt);
  // Filling it out again starts without the Social Security number.
  assert.doesNotMatch(await (await request("/clients/crew/forms/w4", { headers: { Cookie: cookie } })).text(), /123-45-6789/u);

  // The admin's download is logged.
  assert.equal((await request(`/clients/admin/labor/workers/${worker.id}/forms/w4/pdf`, { headers: { Cookie: adminCookie } })).status, 200);
  assert.ok(await db("mhb_activity").where({ action: "crew.paperwork-opened" }).first());

  // I-9: the employee signs Section 1, the admin Section 2.
  const i9 = { lastName: "Ortiz", firstName: "Sam", address: "44 Oak Ave", city: "Muskegon", state: "mi", zip: "49441", birthDate: "1990-04-02", status: "citizen", name: "Sam Ortiz", consent: "yes" };
  assert.equal((await request("/clients/crew/forms/i9", form(i9, cookie))).headers.get("Location"), "/clients/crew?notice=form-signed");
  assert.equal((await request("/clients/crew/forms/i9", { headers: { Cookie: cookie } })).headers.get("Location"), "/clients/crew?notice=not-open", "Section 1 is signed once");
  const workerPage = await (await request(`/clients/admin/labor/workers/${worker.id}`, { headers: { Cookie: adminCookie } })).text();
  assert.match(workerPage, /Complete Section 2/u);
  assert.match(workerPage, /mi-newhire\.com/u);
  const section2 = `/clients/admin/labor/workers/${worker.id}/forms/i9/section2`;
  const noDocs = await request(section2, form({ firstDay: todayInMichigan(), employerSigner: "Plant, Zadock, Owner", name: "Zadock Plant", consent: "yes" }, adminCookie));
  assert.equal(noDocs.status, 400);
  assert.match(await noDocs.text(), /one List A document/u);
  const done = await request(section2, form({ listA1Title: "U.S. Passport", listA1Authority: "U.S. Department of State", listA1Number: "X1234567", listA1Expires: "2031-05-01", firstDay: todayInMichigan(), employerSigner: "Plant, Zadock, Owner", name: "Zadock Plant", consent: "yes" }, adminCookie));
  assert.equal(done.headers.get("Location"), `/clients/admin/labor/workers/${worker.id}?notice=section2-signed`);
  assert.equal((await workerRecord("sam@example.com")).paperwork.i9.status, "complete");
});

test("deactivating ends a crew member's session, and crew see only their own work and documents", async () => {
  const adminCookie = await loginAsAdmin();
  const first = await addCrew(adminCookie, { kind: "subcontractor", name: "Dana Reyes", email: "dana@example.com" });
  const second = await addCrew(adminCookie, { kind: "subcontractor", name: "Lee Park", email: "lee@example.com" });
  const today = todayInMichigan();
  await request("/clients/crew/bills", crewForm({ job: "", invoiceNumber: "S-1", invoiceDate: today, amount: "300", through: today, description: "Shop shelving" }, { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), name: "s-1.png", type: "image/png" }, first.cookie));
  const [entry] = await laborRecords();
  assert.equal(entry.status, "submitted", "shop work has no lien waiver");
  assert.equal((await request(`/clients/crew/bills/${entry.id}/file`, { headers: { Cookie: first.cookie } })).status, 200);
  assert.equal((await request(`/clients/crew/bills/${entry.id}/file`, { headers: { Cookie: second.cookie } })).status, 404);

  const shared = await request(`/clients/admin/labor/workers/${first.worker.id}/documents`, multipart({ section: "agreements", requiresClientSignature: "yes" }, { bytes: await samplePdf(), name: "Subcontract.pdf", type: "application/pdf" }, adminCookie));
  assert.match(shared.headers.get("Location"), /notice=document-shared$/u);
  const [document] = await db("mhb_documents").where({ client_slug: `crew:${first.worker.id}` }).select("data");
  const documentId = json(document.data).id;
  assert.equal(json(document.data).section, "agreements");
  assert.equal((await request(`/clients/crew/documents/${documentId}`, { headers: { Cookie: second.cookie } })).status, 404);
  const sign = await request(`/clients/crew/documents/${documentId}/sign`, form({ name: "Dana Reyes", consent: "yes" }, first.cookie));
  assert.equal(sign.headers.get("Location"), "/clients/crew?notice=signed");
  assert.ok(await db("mhb_activity").where({ actor: "crew", action: "document.signed" }).first());
  assert.doesNotMatch(await (await request("/clients/admin/documents", { headers: { Cookie: adminCookie } })).text(), /Subcontract\.pdf/u, "crew documents stay off the client Documents page");

  await request(`/clients/admin/labor/workers/${first.worker.id}/active`, form({ active: "no" }, adminCookie));
  assert.match(await (await request("/clients/crew", { headers: { Cookie: first.cookie } })).text(), /Crew and subcontractors\./u, "signed out");
  assert.equal((await request("/clients/crew/login", form({ email: "dana@example.com", password: "crew-password-2026" }))).status, 401);
  assert.match(await (await request("/clients/crew", { headers: { Cookie: second.cookie } })).text(), /Hi, Lee\./u);
});

test("the admin cannot add the same email twice, and employer details must be complete", async () => {
  const adminCookie = await loginAsAdmin();
  await addCrew(adminCookie, { kind: "employee", name: "Sam Ortiz", email: "sam@example.com" });
  const again = await request("/clients/admin/labor/workers", form({ kind: "subcontractor", name: "Sam O", email: "SAM@example.com" }, adminCookie));
  assert.equal(again.status, 400);
  assert.match(await again.text(), /sam@example\.com is already in Labor/u);
  const employer = { legalName: "My Home Builder LLC", ein: "123456789", street: "6749 Fulton St E, Ste A #2333", city: "Ada", state: "mi", zip: "49301", contactName: "Zadock Plant", contactPhone: "616-555-0100" };
  assert.equal((await request("/clients/admin/labor/employer", form({ ...employer, ein: "1234" }, adminCookie))).status, 400);
  assert.equal((await request("/clients/admin/labor/employer", form(employer, adminCookie))).headers.get("Location"), "/clients/admin/labor?notice=employer-saved");
  const saved = json((await db("mhb_settings").where({ key: "employer" }).first()).data);
  assert.equal(saved.ein, "12-3456789");
  assert.equal(saved.state, "MI");
});

test("invoice numbers follow their dates, the same date in the order entered, and the admin panel puts any out of order back", async () => {
  const adminCookie = await loginAsAdmin();
  const { item: late } = await postInvoice(adminCookie, { title: "Late", amount: "300", issuedOn: "2026-09-20" });
  const { item: early } = await postInvoice(adminCookie, { title: "Early", amount: "100", issuedOn: "2026-09-01" });
  const { item: sameFirst } = await postInvoice(adminCookie, { title: "Same day, entered first", amount: "200", issuedOn: "2026-09-10" });
  const { item: sameSecond } = await postInvoice(adminCookie, { title: "Same day, entered second", amount: "250", issuedOn: "2026-09-10" });
  const numbers = async () => Object.fromEntries(await Promise.all([late, early, sameFirst, sameSecond].map(async (item) => [(await stored(item)).title, (await stored(item)).number])));
  assert.deepEqual(await numbers(), { Early: "1", "Same day, entered first": "2", "Same day, entered second": "3", Late: "4" });
  const list = async () => (await request("/clients/admin?client=muskegon-addition", { headers: { Cookie: adminCookie } })).text();
  const order = (page) => [...page.matchAll(/<td><span class="portal-number">(\d+)<\/span><\/td>/gu)].map((match) => match[1]);
  assert.deepEqual(order(await list()), ["4", "3", "2", "1"], "newest first; on the same date, the later entry first");

  // Numbers changed outside the portal are put back when the admin panel opens.
  await db("mhb_billing").where({ id: early.id }).update({ number: "9", data: db.raw("jsonb_set(data, '{number}', '\"9\"')") });
  const page = await list();
  assert.match(page, /Invoice numbers were updated to keep them in date order\./u);
  assert.equal((await stored(early)).number, "1");
  assert.doesNotMatch(await list(), /Invoice numbers were updated/u, "nothing to fix the second time");
});
