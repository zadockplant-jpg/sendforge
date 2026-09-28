import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import express from "express";

// A stand-in for the GitHub release: serves fixed bytes, honours Range.
const FILE = Buffer.from("MZ" + "rose".repeat(1000));
const upstream = http.createServer((req, res) => {
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : FILE.length - 1;
    res.writeHead(206, {
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${FILE.length}`,
      "Accept-Ranges": "bytes",
    });
    return res.end(FILE.subarray(start, end + 1));
  }
  res.writeHead(200, { "Content-Length": FILE.length, "Accept-Ranges": "bytes" });
  res.end(FILE);
});

let server;
let base;
let routes;
const OWNER = "owner-1";

before(async () => {
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const stand = `http://127.0.0.1:${upstream.address().port}`;
  process.env.DOWNLOAD_SOURCE_ROSE_COLORED_GLASSES = `${stand}/asset`;
  process.env.DOWNLOAD_SOURCE_FORGEDROP = `${stand}/forgedrop`;
  process.env.DOWNLOAD_SOURCE_FORGEDROP_UPDATE = `${stand}/notice`;
  process.env.DOWNLOAD_SOURCE_KEYFROGGER = `${stand}/keyfrogger`;
  process.env.JWT_SECRET ||= "downloads-test-secret-at-least-32-bytes-long";
  routes = await import("../src/routes/downloads.routes.js");
  // The real routes with a stand-in session: "Bearer <user>" signs in as
  // <user>, and only OWNER owns anything.
  const router = routes.createDownloadsRouter({
    auth: (req, res, next) => {
      const user = /^Bearer (\S+)$/.exec(req.headers.authorization || "")?.[1];
      if (!user) return res.status(401).json({ error: "missing_token" });
      req.user = { sub: user };
      return next();
    },
    hasEntitlement: async (userId, product) => userId === OWNER && ["forgedrop", "rose-colored-glasses"].includes(product),
    siteUrl: "https://sendforge.app",
    // The install tokens' own tests use a database (install-tokens.test.js).
    installTokenFor: async ({ userId, slug }) => (userId === OWNER && slug === "forgedrop" ? "K7Q2M9XD" : null),
    redeemToken: async (token) => (token === "K7Q2M9XD"
      ? { productSlug: "forgedrop", activationCode: "FD-ABCD-EFGH-JKLM" }
      : { error: token ? "unknown_install_token" : "invalid_input" }),
  });
  const app = express();
  app.use(express.json());
  app.use("/v1/downloads", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  upstream.close();
});

const ticketFor = (slug, userId = OWNER, now) => routes.issueDownloadTicket({ userId, slug, now }).ticket;

test("the installer downloads under its real name, spaces and all", async () => {
  const res = await fetch(`${base}/v1/downloads/rose-colored-glasses?ticket=${ticketFor("rose-colored-glasses")}`);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("content-disposition"),
    `attachment; filename="Install Rose Colored Glasses.exe"; filename*=UTF-8''Install%20Rose%20Colored%20Glasses.exe`
  );
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(Number(res.headers.get("content-length")), FILE.length);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), FILE);
});

test("an interrupted download can resume", async () => {
  const res = await fetch(`${base}/v1/downloads/rose-colored-glasses?ticket=${ticketFor("rose-colored-glasses")}`, {
    headers: { Range: "bytes=100-" },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes 100-${FILE.length - 1}/${FILE.length}`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), FILE.subarray(100));
});

test("a paid installer is for buyers only: without a ticket a browser is sent to the product page", async () => {
  for (const slug of ["forgedrop", "rose-colored-glasses"]) {
    const page = await fetch(`${base}/v1/downloads/${slug}`, { headers: { Accept: "text/html" }, redirect: "manual" });
    assert.equal(page.status, 302, slug);
    assert.equal(page.headers.get("location"), `https://sendforge.app/products/${slug}/index.html#download`);
    const api = await fetch(`${base}/v1/downloads/${slug}`);
    assert.equal(api.status, 403, slug);
    assert.deepEqual(await api.json(), { error: "purchase_required" });
  }
});

test("a ticket opens only its own product, only for half an hour, and only as signed", async () => {
  const refused = async (slug, ticket) => (await fetch(`${base}/v1/downloads/${slug}?ticket=${encodeURIComponent(ticket)}`)).status;
  assert.equal(await refused("forgedrop", ticketFor("rose-colored-glasses")), 403, "another product's ticket");
  assert.equal(await refused("forgedrop", ticketFor("forgedrop", OWNER, Date.now() - 31 * 60 * 1000)), 403, "a stale ticket");
  const [claims, mac] = ticketFor("forgedrop").split(".");
  const forged = Buffer.from(JSON.stringify({ s: "forgedrop", u: "someone", e: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  assert.equal(await refused("forgedrop", `${forged}.${mac}`), 403, "claims changed under the same signature");
  assert.equal(await refused("forgedrop", `${claims}.${"A".repeat(mac.length)}`), 403, "a made-up signature");
  assert.equal(await refused("forgedrop", "not-a-ticket"), 403);
  assert.equal(routes.readDownloadTicket(ticketFor("forgedrop"), "forgedrop")?.userId, OWNER);
});

test("an owner gets a ticket from the site; anyone else is told to buy", async () => {
  const ask = (slug, user) => fetch(`${base}/v1/downloads/${slug}/ticket`, {
    method: "POST",
    headers: user ? { Authorization: `Bearer ${user}` } : {},
  });
  assert.equal((await ask("forgedrop")).status, 401, "signed out");
  const stranger = await ask("forgedrop", "someone-else");
  assert.equal(stranger.status, 403);
  assert.deepEqual(await stranger.json(), { error: "purchase_required" });
  assert.equal((await ask("keyfrogger", OWNER)).status, 404, "free downloads need no ticket");
  const granted = await ask("forgedrop", OWNER);
  assert.equal(granted.status, 200);
  const body = await granted.json();
  assert.equal(body.ok, true);
  assert.ok(Date.parse(body.expiresAt) - Date.now() > 29 * 60 * 1000, "lasts half an hour");
  const res = await fetch(`${base}/v1/downloads/forgedrop?ticket=${encodeURIComponent(body.ticket)}`);
  assert.equal(res.status, 200);
  // The buyer's own copy: its name carries the token that fills in the code.
  assert.match(res.headers.get("content-disposition"), /filename="Install DropForge \(K7Q2M9XD\)\.exe"/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), FILE);
});

test("the DropForge app trades the token in its installer's name for the activation code", async () => {
  const trade = (body) => fetch(`${base}/v1/downloads/install-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await trade({ token: "K7Q2M9XD" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { ok: true, productSlug: "forgedrop", activationCode: "FD-ABCD-EFGH-JKLM" });
  assert.equal((await trade({ token: "AAAAAAAA" })).status, 404);
  assert.deepEqual(await (await trade({})).json(), { error: "invalid_input" });
  // Rose Colored Glasses signs in instead, so its file keeps its plain name.
  const rcg = await fetch(`${base}/v1/downloads/rose-colored-glasses?ticket=${encodeURIComponent(ticketFor("rose-colored-glasses"))}`);
  assert.match(rcg.headers.get("content-disposition"), /filename="Install Rose Colored Glasses\.exe"/);
  await rcg.arrayBuffer();
});

test("DropForge's release notice is relayed for its updater, to anyone", async () => {
  // DropForge asks /v1/downloads/forgedrop-update before falling back to GitHub.
  const res = await fetch(`${base}/v1/downloads/forgedrop-update`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /filename="forgedrop-update\.json"/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), FILE);
});

test("KeyFrogger, a free tool, downloads for anyone", async () => {
  const res = await fetch(`${base}/v1/downloads/keyfrogger`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /filename="KeyFrogger-Setup\.exe"/);
});

test("only known products download", async () => {
  const res = await fetch(`${base}/v1/downloads/..%2F..%2Fetc`);
  assert.equal(res.status, 404);
});

test("with a token, release files come through GitHub's API, and the token never reaches storage", async () => {
  const calls = [];
  const replies = [
    { json: { assets: [{ id: 11, name: "Other.exe" }, { id: 42, name: "Install.ForgeDrop.exe" }] } },
    { status: 302, location: "https://objects.githubusercontent.com/signed?sig=1" },
    { status: 206, body: "bytes" },
  ];
  const fetchStub = async (url, options = {}) => {
    calls.push({ url, headers: { ...options.headers }, redirect: options.redirect });
    const reply = replies.shift();
    if (reply.json) return new Response(JSON.stringify(reply.json), { status: 200 });
    if (reply.location) return new Response(null, { status: reply.status, headers: { location: reply.location } });
    return new Response(reply.body, { status: reply.status });
  };
  const res = await routes.fetchReleaseAsset(
    "https://github.com/zadockplant-jpg/sendforge-downloads/releases/download/forgedrop-v1.6.3/Install.ForgeDrop.exe",
    { range: "bytes=10-", token: "ghp_test", fetch: fetchStub },
  );
  assert.equal(res.status, 206);
  assert.equal(calls[0].url, "https://api.github.com/repos/zadockplant-jpg/sendforge-downloads/releases/tags/forgedrop-v1.6.3");
  assert.equal(calls[0].headers.Authorization, "Bearer ghp_test");
  assert.equal(calls[1].url, "https://api.github.com/repos/zadockplant-jpg/sendforge-downloads/releases/assets/42");
  assert.equal(calls[1].headers.Accept, "application/octet-stream");
  assert.equal(calls[1].headers.Range, "bytes=10-");
  assert.equal(calls[1].redirect, "manual");
  assert.equal(calls[2].url, "https://objects.githubusercontent.com/signed?sig=1");
  assert.equal(calls[2].headers.Authorization, undefined, "the signed storage link gets no token");
  assert.equal(calls[2].headers.Range, "bytes=10-");
});

test("a replaced asset is looked up again, and a missing one answers 404", async () => {
  let assetIdNow = 7;
  const calls = [];
  const fetchStub = async (url) => {
    calls.push(url);
    if (url.endsWith("/releases/tags/tools")) {
      return new Response(JSON.stringify({ assets: [{ id: assetIdNow, name: "KeyFrogger-Setup.exe" }] }), { status: 200 });
    }
    if (url.endsWith("/releases/tags/nowhere")) return new Response("{}", { status: 404 });
    return url.endsWith(`/assets/${assetIdNow}`) ? new Response("ok", { status: 200 }) : new Response(null, { status: 404 });
  };
  const source = { tag: "tools", name: "KeyFrogger-Setup.exe" };
  assert.equal((await routes.fetchReleaseAsset(source, { token: "t", fetch: fetchStub })).status, 200);
  assetIdNow = 8; // a new build replaced the asset
  assert.equal((await routes.fetchReleaseAsset(source, { token: "t", fetch: fetchStub })).status, 200);
  assert.deepEqual(calls.map((url) => url.replace("https://api.github.com/repos/zadockplant-jpg/sendforge-downloads", "")), [
    "/releases/tags/tools", "/releases/assets/7",
    "/releases/assets/7", "/releases/tags/tools", "/releases/assets/8",
  ]);
  assert.equal((await routes.fetchReleaseAsset({ tag: "nowhere", name: "x.exe" }, { token: "t", fetch: fetchStub })).status, 404);
});

test("without a token, release files come straight from their public links, as before", async () => {
  const calls = [];
  const fetchStub = async (url, options) => { calls.push([url, options.redirect]); return new Response("ok"); };
  await routes.fetchReleaseAsset({ tag: "forgedrop-v1.6.3", name: "Install.ForgeDrop.exe" }, { token: "", fetch: fetchStub });
  assert.deepEqual(calls, [["https://github.com/zadockplant-jpg/sendforge-downloads/releases/download/forgedrop-v1.6.3/Install.ForgeDrop.exe", "follow"]]);
});

test("the app mounts the downloads route, with the real sign-in and ownership check", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  // Once lost when app.js was rewritten from an older copy: the site's
  // Download button then 404s with nothing else looking wrong.
  assert.match(app, /import \{ downloadsRouter \} from "\.\/routes\/downloads\.routes\.js";/);
  assert.match(app, /app\.use\("\/v1\/downloads", downloadsRouter\);/);
  const source = await readFile(new URL("../src/routes/downloads.routes.js", import.meta.url), "utf8");
  assert.match(source, /auth = requireAuth,\s*hasEntitlement = hasProductEntitlement,/);
  assert.match(source, /export const downloadsRouter = createDownloadsRouter\(\);/);
});
