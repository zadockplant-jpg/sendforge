import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { app } from "../src/app.js";

async function withApp(callback) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("first-party ForgePass UI is isolated by strict browser headers", async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/forgepass/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/html/u);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");

    const csp = response.headers.get("content-security-policy") || "";
    assert.match(csp, /default-src 'self'/u);
    assert.match(csp, /frame-ancestors 'none'/u);
    assert.match(csp, /object-src 'none'/u);
    assert.match(csp, /script-src 'self'/u);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/u);

    const permissions = response.headers.get("permissions-policy") || "";
    assert.match(permissions, /publickey-credentials-create=\(self\)/u);
    assert.match(permissions, /publickey-credentials-get=\(self\)/u);
    assert.match(html, /ForgePass authentication, end to end\./u);
    assert.match(html, /allow it so SendForge can\s+confirm the ForgePass device identifier/u);
    assert.doesNotMatch(html, /https?:\/\//u);
  });
});

test("ForgePass UI keeps its session tab-scoped and has no remote assets", async () => {
  await withApp(async (base) => {
    const [scriptResponse, styleResponse] = await Promise.all([
      fetch(`${base}/forgepass/app.js`),
      fetch(`${base}/forgepass/styles.css`),
    ]);
    const [script, styles] = await Promise.all([
      scriptResponse.text(),
      styleResponse.text(),
    ]);

    assert.equal(scriptResponse.status, 200);
    assert.equal(styleResponse.status, 200);
    assert.match(script, /window\.sessionStorage/u);
    assert.doesNotMatch(script, /localStorage/u);
    assert.doesNotMatch(script, /https?:\/\//u);
    assert.match(script, /did not recognize this authenticator as ForgePass/u);
    assert.match(script, /registration could not be verified/u);
    assert.match(script, /could not verify that sign-in/u);
    assert.doesNotMatch(styles, /url\s*\(/u);
    assert.match(styles, /--white:\s*#FFFFFF/u);
  });
});
