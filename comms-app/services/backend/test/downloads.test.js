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

before(async () => {
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.DOWNLOAD_SOURCE_ROSE_COLORED_GLASSES = `http://127.0.0.1:${upstream.address().port}/asset`;
  const { downloadsRouter } = await import("../src/routes/downloads.routes.js");
  const app = express();
  app.use("/v1/downloads", downloadsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  upstream.close();
});

test("the installer downloads under its real name, spaces and all", async () => {
  const res = await fetch(`${base}/v1/downloads/rose-colored-glasses`);
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
  const res = await fetch(`${base}/v1/downloads/rose-colored-glasses`, {
    headers: { Range: "bytes=100-" },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes 100-${FILE.length - 1}/${FILE.length}`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), FILE.subarray(100));
});

test("only known products download", async () => {
  const res = await fetch(`${base}/v1/downloads/..%2F..%2Fetc`);
  assert.equal(res.status, 404);
});

test("the app actually mounts the downloads route", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  // Once lost when app.js was rewritten from an older copy: the site's
  // Download button then 404s with nothing else looking wrong.
  assert.match(app, /import \{ downloadsRouter \} from "\.\/routes\/downloads\.routes\.js";/);
  assert.match(app, /app\.use\("\/v1\/downloads", downloadsRouter\);/);
});
