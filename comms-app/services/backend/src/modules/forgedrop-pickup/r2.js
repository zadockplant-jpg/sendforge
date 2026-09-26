/**
 * Cloudflare R2, spoken to as S3 with AWS Signature Version 4, on node:crypto
 * and fetch alone. No SDK: the package files are not this module's to change.
 *
 * Two kinds of signing:
 *
 *   - presigned links (query-string auth) handed to a desktop, which then
 *     uploads and downloads directly: GET, PUT and UploadPart;
 *   - requests this server makes itself (header auth): CreateMultipartUpload,
 *     CompleteMultipartUpload, AbortMultipartUpload, DeleteObject and
 *     HeadObject.
 *
 * R2 wants region "auto" and service "s3". Objects are addressed path-style,
 * https://<account>.r2.cloudflarestorage.com/<bucket>/<key>. Virtual-hosted
 * style is here only so AWS's published example can be checked against this
 * signer (test/forgedrop-pickup.test.js).
 *
 * A presigned PUT or UploadPart also signs Content-Length, so R2 refuses a
 * body of any other size: a desktop cannot store more than it declared, and
 * declared bytes are what the allowance counts.
 */

import crypto from "node:crypto";

export const R2_ENV = Object.freeze(["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]);

const ALGORITHM = "AWS4-HMAC-SHA256";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const ACCOUNT_ID = /^[A-Za-z0-9-]{1,63}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

// ------------------------------------------------------------------ config

function settingsFrom(env) {
  const value = (name) => String(env?.[name] ?? "").trim();
  return {
    accountId: value("R2_ACCOUNT_ID"),
    accessKeyId: value("R2_ACCESS_KEY_ID"),
    secretAccessKey: value("R2_SECRET_ACCESS_KEY"),
    bucket: value("R2_BUCKET"),
  };
}

/** Which R2 settings are missing or unusable, by name; empty when all is well. */
export function r2ConfigProblems(env = process.env) {
  const settings = settingsFrom(env);
  const problems = [];
  if (!settings.accountId) problems.push("R2_ACCOUNT_ID missing");
  else if (!ACCOUNT_ID.test(settings.accountId)) problems.push("R2_ACCOUNT_ID invalid");
  if (!settings.accessKeyId) problems.push("R2_ACCESS_KEY_ID missing");
  if (!settings.secretAccessKey) problems.push("R2_SECRET_ACCESS_KEY missing");
  if (!settings.bucket) problems.push("R2_BUCKET missing");
  else if (!BUCKET.test(settings.bucket)) problems.push("R2_BUCKET invalid");
  return problems;
}

/** The client's settings from the environment, or null if any are missing. */
export function readR2Config(env = process.env) {
  if (r2ConfigProblems(env).length) return null;
  const settings = settingsFrom(env);
  return {
    ...settings,
    endpoint: `https://${settings.accountId}.r2.cloudflarestorage.com`,
    region: "auto",
  };
}

// ----------------------------------------------------------------- signing

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

export const EMPTY_SHA256 = sha256Hex("");

/** RFC 3986 encoding, as SigV4 wants: all but A-Z a-z 0-9 - _ . ~ escaped. */
export function uriEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

const encodePath = (path) => path.split("/").map(uriEncode).join("/");

/** 20130524T000000Z */
export function amzDateOf(at) {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function canonicalQuery(params) {
  return params
    .map(([key, value]) => [uriEncode(key), uriEncode(value ?? "")])
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function canonicalHeaders(headers) {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, " ")])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    text: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signed: entries.map(([name]) => name).join(";"),
  };
}

const signingKeys = new Map();

function signingKey(secretAccessKey, dateStamp, region, service) {
  const cacheKey = `${sha256Hex(secretAccessKey)}/${dateStamp}/${region}/${service}`;
  let key = signingKeys.get(cacheKey);
  if (!key) {
    key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), "aws4_request");
    if (signingKeys.size > 64) signingKeys.clear();
    signingKeys.set(cacheKey, key);
  }
  return key;
}

export const credentialScope = (amzDate, region, service = "s3") =>
  `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`;

/**
 * SigV4 for one request. `path` is the raw object path ("/bucket/key"), and
 * `query` is [name, value] pairs, both unencoded; `headers` are exactly the
 * headers signed, host among them.
 */
export function signV4({
  secretAccessKey,
  region,
  service = "s3",
  amzDate,
  method,
  path,
  query = [],
  headers,
  payloadHash,
}) {
  const scope = credentialScope(amzDate, region, service);
  const { text, signed } = canonicalHeaders(headers);
  const canonicalRequest = [method, encodePath(path), canonicalQuery(query), text, signed, payloadHash].join("\n");
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(secretAccessKey, amzDate.slice(0, 8), region, service), stringToSign).toString("hex");
  return { scope, signedHeaders: signed, signature, canonicalRequest, stringToSign };
}

// ------------------------------------------------------------------ errors

export class R2Error extends Error {
  constructor(operation, status, code) {
    super(`R2 ${operation} failed: ${status || "no answer"} ${code || ""}`.trim());
    this.name = "R2Error";
    this.operation = operation;
    this.status = status;
    this.code = code || null;
  }

  /**
   * R2 refused the request for what it asked, not for its own trouble or
   * ours (credentials, rate, time-outs): a part that is not there, an upload
   * that is not as the desktop said.
   */
  get refused() {
    return this.status >= 400 && this.status < 500 && ![401, 403, 408, 429].includes(this.status);
  }
}

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xmlEscape = (value) => String(value).replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
const xmlUnescape = (value) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

function xmlValue(text, tag) {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(String(text || ""));
  return match ? xmlUnescape(match[1]) : null;
}

// ------------------------------------------------------------------ client

export function createR2Client({
  accessKeyId,
  secretAccessKey,
  bucket,
  endpoint,
  region = "auto",
  // "path": https://host/<bucket>/<key>, which R2 uses. "virtual":
  // https://<bucket>.host/<key>, for checking AWS's own examples.
  hostStyle = "path",
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 30_000,
  // Completing a multipart upload of thousands of parts takes R2 a while.
  completeTimeoutMs = 300_000,
}) {
  const base = new URL(endpoint);

  function locate(key) {
    if (hostStyle === "virtual") return { protocol: base.protocol, host: `${bucket}.${base.host}`, path: `/${key}` };
    return { protocol: base.protocol, host: base.host, path: `/${bucket}/${key}` };
  }

  const pairs = (query) => Object.entries(query).map(([name, value]) => [name, String(value)]);

  /** A link that lets whoever holds it make this one request until it expires. */
  function presign(method, key, { query = {}, headers = {}, expiresSeconds, at = now() }) {
    const { protocol, host, path } = locate(key);
    const amzDate = amzDateOf(at);
    const signedHeaders = { host };
    for (const [name, value] of Object.entries(headers)) signedHeaders[name.toLowerCase()] = String(value);
    const params = [
      ...pairs(query),
      ["X-Amz-Algorithm", ALGORITHM],
      ["X-Amz-Credential", `${accessKeyId}/${credentialScope(amzDate, region)}`],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(expiresSeconds)],
      ["X-Amz-SignedHeaders", Object.keys(signedHeaders).sort().join(";")],
    ];
    const { signature } = signV4({
      secretAccessKey,
      region,
      amzDate,
      method,
      path,
      query: params,
      headers: signedHeaders,
      payloadHash: UNSIGNED_PAYLOAD,
    });
    return `${protocol}//${host}${encodePath(path)}?${canonicalQuery(params)}&X-Amz-Signature=${signature}`;
  }

  /** A request this server makes, signed in its Authorization header. */
  async function send(operation, method, key, { query = {}, body, headers = {}, timeout = timeoutMs } = {}) {
    const { protocol, host, path } = locate(key);
    const amzDate = amzDateOf(now());
    const payload = body === undefined ? "" : body;
    const payloadHash = sha256Hex(payload);
    const signedHeaders = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    for (const [name, value] of Object.entries(headers)) signedHeaders[name.toLowerCase()] = String(value);
    const params = pairs(query);
    const signed = signV4({ secretAccessKey, region, amzDate, method, path, query: params, headers: signedHeaders, payloadHash });

    // fetch sets Host itself, from the URL: the same value that was signed.
    const { host: _host, ...sent } = signedHeaders;
    sent.authorization = `${ALGORITHM} Credential=${accessKeyId}/${signed.scope}, SignedHeaders=${signed.signedHeaders}, Signature=${signed.signature}`;
    const qs = canonicalQuery(params);
    let response;
    try {
      response = await fetchImpl(`${protocol}//${host}${encodePath(path)}${qs ? `?${qs}` : ""}`, {
        method,
        headers: sent,
        body: body === undefined ? undefined : payload,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new R2Error(operation, 0, error?.name === "TimeoutError" ? "timeout" : "network_error");
    }
    const text = method === "HEAD" ? "" : await response.text().catch(() => "");
    return { status: response.status, headers: response.headers, text };
  }

  const fail = (operation, answer) => new R2Error(operation, answer.status, xmlValue(answer.text, "Code"));

  return {
    bucket,

    presignGet(key, expiresSeconds) {
      return presign("GET", key, { expiresSeconds });
    },

    /**
     * One PUT of exactly `size` bytes. `at` is when the link's time starts,
     * now unless given: it lasts from `at` for `expiresSeconds`.
     */
    presignPut(key, size, expiresSeconds, at = now()) {
      return presign("PUT", key, { headers: { "content-length": size }, expiresSeconds, at });
    },

    /** Part `partNumber` (from 1) of a multipart upload, exactly `size` bytes. */
    presignUploadPart(key, uploadId, partNumber, size, expiresSeconds, at = now()) {
      return presign("PUT", key, {
        query: { partNumber, uploadId },
        headers: { "content-length": size },
        expiresSeconds,
        at,
      });
    },

    async createMultipartUpload(key) {
      const answer = await send("CreateMultipartUpload", "POST", key, { query: { uploads: "" } });
      const uploadId = answer.status === 200 ? xmlValue(answer.text, "UploadId") : null;
      if (!uploadId) throw fail("CreateMultipartUpload", answer);
      return uploadId;
    },

    /** `etags` in part order, as R2 returned them to the desktop. */
    async completeMultipartUpload(key, uploadId, etags) {
      const parts = etags
        .map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`)
        .join("");
      const answer = await send("CompleteMultipartUpload", "POST", key, {
        query: { uploadId },
        body: `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${parts}</CompleteMultipartUpload>`,
        headers: { "content-type": "application/xml" },
        timeout: completeTimeoutMs,
      });
      // S3 may say 200 and put an <Error> in the body when completion fails.
      if (answer.status !== 200 || /<Error>/.test(answer.text)) throw fail("CompleteMultipartUpload", answer);
    },

    /** An upload R2 no longer has counts as aborted. */
    async abortMultipartUpload(key, uploadId) {
      const answer = await send("AbortMultipartUpload", "DELETE", key, { query: { uploadId } });
      if (![200, 204, 404].includes(answer.status)) throw fail("AbortMultipartUpload", answer);
    },

    /** An object that is not there counts as deleted. */
    async deleteObject(key) {
      const answer = await send("DeleteObject", "DELETE", key);
      if (![200, 204, 404].includes(answer.status)) throw fail("DeleteObject", answer);
    },

    /** { size, etag }, or null if there is no such object. */
    async headObject(key) {
      const answer = await send("HeadObject", "HEAD", key);
      if (answer.status === 404) return null;
      if (answer.status !== 200) throw fail("HeadObject", answer);
      const size = Number(answer.headers.get("content-length"));
      if (!Number.isSafeInteger(size)) throw new R2Error("HeadObject", 502, "no_content_length");
      return { size, etag: answer.headers.get("etag") };
    },
  };
}
