// A stand-in for Cloudflare R2, in process: the S3 calls Cloud pickup makes
// (PutObject, UploadPart, GetObject, HeadObject, DeleteObject and the three
// multipart calls), path-style under one bucket, objects in memory.
//
// It checks every request's SigV4 signature as R2 would, recomputed from the
// request as it arrived. That uses the signer under test, so it cannot prove
// the signer right (AWS's published examples do that, in
// forgedrop-pickup.test.js). What it proves is that what was signed is what
// was sent: the host with its port, the path, the query, and the
// Content-Length a presigned PUT pins.

import crypto from "node:crypto";
import { once } from "node:events";
import http from "node:http";

import { signV4, UNSIGNED_PAYLOAD } from "../../src/modules/forgedrop-pickup/r2.js";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const etagOf = (body) => `"${crypto.createHash("md5").update(body).digest("hex")}"`;
const bare = (etag) => String(etag).replace(/^"|"$/g, "");
const unescapeXml = (text) =>
  text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function operationOf(method, query) {
  if (method === "PUT") return query.has("partNumber") ? "UploadPart" : "PutObject";
  if (method === "POST") return query.has("uploads") ? "CreateMultipartUpload" : "CompleteMultipartUpload";
  if (method === "DELETE") return query.has("uploadId") ? "AbortMultipartUpload" : "DeleteObject";
  if (method === "HEAD") return "HeadObject";
  return "GetObject";
}

export async function startFakeR2({ bucket, accessKeyId, secretAccessKey, region = "auto" }) {
  const objects = new Map(); // key -> Buffer
  const uploads = new Map(); // uploadId -> { key, parts: Map(number -> { etag, body }) }
  const requests = []; // { operation, key, auth }
  const faults = []; // { operation, status, code, times }

  function reply(res, status, code) {
    res.writeHead(status, { "content-type": "application/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  }

  function signatureMatches(req, url, path, body) {
    const query = url.searchParams;
    const valueOf = (names) => Object.fromEntries(names.map((name) => [name, req.headers[name] ?? ""]));
    if (query.has("X-Amz-Signature")) {
      if (!String(query.get("X-Amz-Credential")).startsWith(`${accessKeyId}/`)) return null;
      const signed = signV4({
        secretAccessKey,
        region,
        amzDate: query.get("X-Amz-Date") || "",
        method: req.method,
        path,
        query: [...query.entries()].filter(([name]) => name !== "X-Amz-Signature"),
        headers: valueOf(String(query.get("X-Amz-SignedHeaders")).split(";")),
        payloadHash: UNSIGNED_PAYLOAD,
      });
      return signed.signature === query.get("X-Amz-Signature") ? "presigned" : null;
    }
    const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/[^,]+, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      req.headers.authorization || ""
    );
    if (!auth || auth[1] !== accessKeyId) return null;
    const payloadHash = req.headers["x-amz-content-sha256"];
    if (payloadHash !== sha256(body)) return null;
    const signed = signV4({
      secretAccessKey,
      region,
      amzDate: req.headers["x-amz-date"] || "",
      method: req.method,
      path,
      query: [...query.entries()],
      headers: valueOf(auth[2].split(";")),
      payloadHash,
    });
    return signed.signature === auth[3] ? "header" : null;
  }

  function handle(req, res, body) {
    const url = new URL(req.url, "http://fake-r2");
    const prefix = `/${bucket}/`;
    if (!url.pathname.startsWith(prefix)) return reply(res, 404, "NoSuchBucket");
    const path = url.pathname.split("/").map(decodeURIComponent).join("/");
    const key = path.slice(prefix.length);
    const query = url.searchParams;
    const operation = operationOf(req.method, query);

    const auth = signatureMatches(req, url, path, body);
    if (!auth) return reply(res, 403, "SignatureDoesNotMatch");
    requests.push({ operation, key, auth });

    const fault = faults.find((entry) => entry.operation === operation && entry.times > 0);
    if (fault) {
      fault.times -= 1;
      return reply(res, fault.status, fault.code);
    }

    switch (operation) {
      case "PutObject": {
        objects.set(key, body);
        res.writeHead(200, { etag: etagOf(body) });
        return res.end();
      }
      case "UploadPart": {
        const upload = uploads.get(query.get("uploadId"));
        if (!upload || upload.key !== key) return reply(res, 404, "NoSuchUpload");
        const etag = etagOf(body);
        upload.parts.set(Number(query.get("partNumber")), { etag, body });
        res.writeHead(200, { etag });
        return res.end();
      }
      case "CreateMultipartUpload": {
        const uploadId = crypto.randomBytes(24).toString("base64url");
        uploads.set(uploadId, { key, parts: new Map() });
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(
          `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`
        );
      }
      case "CompleteMultipartUpload": {
        const upload = uploads.get(query.get("uploadId"));
        if (!upload || upload.key !== key) return reply(res, 404, "NoSuchUpload");
        const listed = [
          ...body.toString("utf8").matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag><\/Part>/g),
        ].map((match) => ({ number: Number(match[1]), etag: unescapeXml(match[2]) }));
        const whole = listed.length === upload.parts.size && listed.every((part, index) => part.number === index + 1);
        const same = listed.every((part) => bare(upload.parts.get(part.number)?.etag) === bare(part.etag));
        if (!whole || !same) return reply(res, 400, "InvalidPart");
        const assembled = Buffer.concat(listed.map((part) => upload.parts.get(part.number).body));
        objects.set(key, assembled);
        uploads.delete(query.get("uploadId"));
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(
          `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Key>${key}</Key><ETag>${etagOf(assembled)}</ETag></CompleteMultipartUploadResult>`
        );
      }
      case "AbortMultipartUpload": {
        if (!uploads.delete(query.get("uploadId"))) return reply(res, 404, "NoSuchUpload");
        res.writeHead(204);
        return res.end();
      }
      case "DeleteObject": {
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      case "HeadObject": {
        const found = objects.get(key);
        if (!found) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { "content-length": found.length, etag: etagOf(found) });
        return res.end();
      }
      default: {
        const found = objects.get(key);
        if (!found) return reply(res, 404, "NoSuchKey");
        res.writeHead(200, { "content-length": found.length, etag: etagOf(found) });
        return res.end(found);
      }
    }
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => handle(req, res, Buffer.concat(chunks)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    objects,
    uploads,
    requests,
    /** The next `times` calls of `operation` fail with `status` and `code`. */
    fail(operation, { status = 500, code = "InternalError", times = 1 } = {}) {
      faults.push({ operation, status, code, times });
    },
    /** Keys under a pickup, as R2 holds them. */
    keysOf(pickupId) {
      return [...objects.keys()].filter((key) => key.startsWith(`pickups/${pickupId}/`)).sort();
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
