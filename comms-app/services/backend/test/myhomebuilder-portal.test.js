// My Home Builder client portal: logins, the Muskegon project files, quotes, invoices,
// templates, Stripe pay links and receipts, documents and e-signing, and the admin panel.
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
const { myhomebuilderPortalRouter, portalEnv } = await import("../src/modules/myhomebuilder-portal/index.js");
const { handlePortalRequest } = await import("../src/modules/myhomebuilder-portal/handler.js");
const { hmacHex } = await import("../src/modules/myhomebuilder-portal/security.js");
const { parseLineItems, parseMoney, addDays, todayInMichigan } = await import("../src/modules/myhomebuilder-portal/billing.js");
const { STRIPE_API_VERSION } = await import("../src/modules/myhomebuilder-portal/stripe.js");
const { PDFDocument } = await import("../src/modules/myhomebuilder-portal/vendor/pdf-lib.js");

// ---------- Fakes for SendGrid and Stripe ----------

// email.failures holds statuses SendGrid returns for the next requests (outages and rate limits).
const email = { delivered: [], failures: [] };
const stripe = { created: [], expired: [], versions: new Set(), sessions: new Map() };
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
    const path = url.slice("https://api.stripe.com/v1".length);
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
      return Response.json({
        id: path.split("/")[2].split("?")[0],
        latest_charge: {
          receipt_url: "https://pay.stripe.com/receipts/test_receipt",
          payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } }
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

const MHB_TABLES = ["mhb_clients", "mhb_billing", "mhb_counters", "mhb_templates", "mhb_documents", "mhb_files", "mhb_sent_emails", "mhb_admin_challenges", "mhb_rate_limits"];
let server;
let base;

before(async () => {
  await attachPglite(db);
  await up(db);
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
  const challengeId = (await requested.text()).match(/name="challenge" type="hidden" value="([^"]+)"/u)[1];
  const code = email.delivered.at(-1).text.match(/Verification code: (\d{6})/u)[1];
  const verify = await request("/clients/admin/verify", form({ challenge: challengeId, code }, cookies), env);
  assert.equal(verify.status, 303);
  assert.equal(verify.headers.get("Location"), "/clients/admin");
  const adminCookie = cookieValue(verify);
  return cookies ? `${cookies}; ${adminCookie}` : adminCookie;
}

async function setClientEmail(adminCookie, address = "client@example.com") {
  const response = await request("/clients/admin/clients/muskegon-addition/profile", form({ email: address }, adminCookie));
  assert.equal(response.status, 303);
}

async function postInvoice(adminCookie, fields) {
  const before = new Set((await billingRecords()).map((item) => item.id));
  const response = await request("/clients/admin/clients/muskegon-addition/billing", form({ kind: "invoice", ...fields }, adminCookie));
  assert.equal(response.status, 303, await response.clone().text());
  const item = (await billingRecords()).find((entry) => !before.has(entry.id));
  return { response, item };
}

async function signedWebhook(type, session, { http = false } = {}) {
  const payload = JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object: session } });
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

test("throttles admin code requests per address and burns a challenge after too many wrong codes", async () => {
  const headers = { "CF-Connecting-IP": "198.51.100.7" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await request("/clients/admin/request", { method: "POST", headers })).status, 200);
  }
  const blocked = await request("/clients/admin/request", { method: "POST", headers });
  assert.equal(blocked.status, 429);
  assert.match(await blocked.text(), /Too many code requests/u);
  assert.equal((await request("/clients/admin/request", { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.8" } })).status, 200);

  const challenged = await request("/clients/admin/request", { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.9" } });
  const challengeId = (await challenged.text()).match(/name="challenge" type="hidden" value="([^"]+)"/u)[1];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await request("/clients/admin/verify", form({ challenge: challengeId, code: "000000" }))).status, 401);
  }
  assert.equal((await request("/clients/admin/verify", form({ challenge: challengeId, code: "000000" }))).status, 429);
  assert.equal(await db("mhb_admin_challenges").where({ id: challengeId }).first(), undefined);
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
  assert.equal((await request("/clients/admin/clients", form({ name: "Again", slug: "wolf-lake-views", password: "another-login-2026" }, adminCookie))).headers.get("Location"), "/clients/admin?notice=client-exists");
});

// ---------- Quotes, invoices and payments ----------

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
  assert.equal(item.number, "INV-0001");
  assert.equal(item.amountCents, 1250100);
  assert.equal(item.sentTo, "client@example.com");

  const invoiceEmail = deliveredTo("client@example.com").at(-1);
  assert.equal(invoiceEmail.subject, "Invoice INV-0001 from My Home Builder LLC");
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
  assert.equal(receipt.subject, "Receipt for invoice INV-0001 from My Home Builder LLC");
  assert.match(receipt.html, /Visa •••• 4242/u);
  assert.equal(deliveredTo("mb@myhomebuilderllc.com").at(-1).subject, "INV-0001 paid: $12,501.00 from Muskegon Addition");
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
  assert.equal(deliveredTo("mb@myhomebuilderllc.com").at(-1).subject, "Bank payment failed for INV-0001");

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
  assert.equal(deliveredTo("mb@myhomebuilderllc.com").at(-1).subject, "Check for a duplicate payment on INV-0001");
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
  assert.equal(quote.number, "QUO-0001");
  assert.ok(deliveredTo("quote@example.com").at(-1).html.includes(`/clients/quote/${quote.shareToken}`));

  const noName = await request(`/clients/quote/${quote.shareToken}/accept`, form({ name: " " }));
  assert.equal(noName.status, 400);
  const accepted = await request(`/clients/quote/${quote.shareToken}/accept`, form({ name: "Pat Client" }));
  assert.equal(accepted.headers.get("Location"), `/clients/quote/${quote.shareToken}?notice=accepted`);
  assert.equal((await stored(quote)).acceptedBy, "Pat Client");
  assert.equal(deliveredTo("mb@myhomebuilderllc.com").at(-1).subject, "QUO-0001 accepted by Muskegon Addition");

  const converted = await request(`/clients/admin/clients/muskegon-addition/billing/${quote.id}/invoice`, form({}, adminCookie));
  assert.match(converted.headers.get("Location"), /notice=invoice-created/u);
  const invoice = (await billingRecords()).find((entry) => entry.kind === "invoice");
  assert.equal(invoice.number, "INV-0001");
  assert.equal(invoice.amountCents, 2450000);
  assert.equal((await stored(quote)).invoiceNumber, "INV-0001");
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
  assert.deepEqual((await billingRecords()).map((item) => `${item.clientSlug}:${item.number}`).sort(), ["muskegon-addition:INV-0001", "wolf-lake-views:INV-0002"]);

  const clientCookie = await loginAsClient();
  const home = await (await request("/clients", { headers: { Cookie: clientCookie } })).text();
  assert.match(home, /INV-0001/u);
  assert.doesNotMatch(home, /INV-0002/u);
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

test("admin shares a contract, signs it, and the client countersigns into a signed PDF", async () => {
  const clientCookie = await loginAsClient();
  const adminCookie = await loginAsAdmin(portal(), clientCookie);
  const upload = await request("/clients/admin/clients/muskegon-addition/documents",
    multipart({ requiresClientSignature: "yes", requiresAdminSignature: "yes" }, { bytes: await samplePdf(), name: "Build Contract.pdf", type: "application/pdf" }, adminCookie));
  assert.match(upload.headers.get("Location"), /notice=uploaded/u);
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
