/**
 * The shapes and limits of Cloud pickup's API. The contract is
 * ForgeDrop/docs/pickup.md, and the desktop's side of it is
 * forgedrop/core/pickup_transfer.py, so these numbers are its as much as
 * ours.
 */

import { isPlainObject } from "../forgedrop-link/shapes.js";
import { TB } from "./plans.js";

const MiB = 1024 * 1024;

export const PICKUP_LIMITS = Object.freeze({
  // Per pickup, whatever the plan: 10,000 files and 1 TB of sealed bytes.
  maxObjects: 10_000,
  maxTotalBytes: TB,
  // The sealed list of files goes up in one PUT, and the desktop reads it
  // back whole.
  maxManifestBytes: 64 * MiB,
  // Up to 64 MiB an object is one PUT; above, a multipart upload in 64 MiB
  // parts. R2 takes at most 10,000 parts, all but the last the same size, so
  // an object too big for 10,000 of them gets bigger parts, in whole MiB.
  partBytes: 64 * MiB,
  maxParts: 10_000,
  keepMs: 7 * 24 * 60 * 60 * 1000,
  // An upload not finished within a day is abandoned, and the sweep takes it
  // away. Its links last as long, so a slow connection can use them to the end.
  staleUploadMs: 24 * 60 * 60 * 1000,
  uploadUrlSeconds: 24 * 60 * 60,
  downloadUrlSeconds: 60 * 60,
  sweepEveryMs: 10 * 60 * 1000,
  // A done body lists an ETag per part: about 26,000 of them at the most.
  bodyBytes: 4 * MiB,
  sealedKeyBytes: 4 * 1024,
  licenceCacheMs: 60_000,
  // Requests to R2 one pickup keeps in flight at once.
  r2Concurrency: 16,
  rate: Object.freeze({
    // Per account.
    createPerMinute: 20,
    requestsPerMinute: 240,
  }),
});

/** A refusal the desktop is told about: `{ error: code, ...extra }`. */
export class Refusal extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.name = "Refusal";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const objectKey = (id, n) => `pickups/${id}/${n}`;
export const manifestKey = (id) => `pickups/${id}/manifest`;

/** How an object of `size` bytes goes up: null for one PUT, else its parts. */
export function partPlan(size, { partBytes = PICKUP_LIMITS.partBytes, maxParts = PICKUP_LIMITS.maxParts } = {}) {
  if (size <= partBytes) return null;
  const needed = Math.ceil(size / maxParts);
  const partSize = needed <= partBytes ? partBytes : Math.ceil(needed / MiB) * MiB;
  return { partSize, count: Math.ceil(size / partSize) };
}

/** The size of part `index` (from 0): partSize, but the last is what is left. */
export function partLength(size, plan, index) {
  return index < plan.count - 1 ? plan.partSize : size - plan.partSize * (plan.count - 1);
}

const FINGERPRINT = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){3}$/;

/** A ForgeDrop fingerprint, "8bca-e027-17b3-b84f", in that spelling; else null. */
export function parseFingerprint(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  return FINGERPRINT.test(text) ? text : null;
}

const isSize = (value) => Number.isSafeInteger(value) && value >= 1;

/**
 * POST / :
 *   { recipient: { fingerprint } | { link: true },
 *     objects: [sealed size, ...], manifestSize, sealedKey? }
 * sealedKey is the file key sealed to the recipient computer; a link pickup
 * has none, because its key rides in the link.
 */
export function parseCreate(body, limits = PICKUP_LIMITS) {
  const request = isPlainObject(body) ? body : {};

  const recipient = request.recipient;
  let fingerprint = null;
  if (!isPlainObject(recipient)) throw new Refusal(400, "bad_recipient");
  if (recipient.fingerprint !== undefined) {
    fingerprint = parseFingerprint(recipient.fingerprint);
    if (!fingerprint || recipient.link !== undefined) throw new Refusal(400, "bad_recipient");
  } else if (recipient.link !== true) {
    throw new Refusal(400, "bad_recipient");
  }

  const objects = request.objects;
  if (!Array.isArray(objects) || objects.length === 0) throw new Refusal(400, "bad_objects");
  if (objects.length > limits.maxObjects) throw new Refusal(413, "too_many_objects");
  if (!objects.every(isSize)) throw new Refusal(400, "bad_objects");

  const manifestSize = request.manifestSize;
  if (!isSize(manifestSize)) throw new Refusal(400, "bad_manifest_size");
  if (manifestSize > limits.maxManifestBytes) throw new Refusal(413, "manifest_too_large");

  let totalBytes = manifestSize;
  for (const size of objects) {
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) throw new Refusal(413, "pickup_too_large");
  }

  let sealedKey = null;
  const given = request.sealedKey;
  if (fingerprint) {
    if (!isPlainObject(given)) throw new Refusal(400, "bad_sealed_key");
    sealedKey = JSON.stringify(given);
    if (Buffer.byteLength(sealedKey, "utf8") > limits.sealedKeyBytes) throw new Refusal(400, "bad_sealed_key");
  } else if (given !== undefined && given !== null) {
    throw new Refusal(400, "bad_sealed_key");
  }

  return { fingerprint, objects, manifestSize, totalBytes, sealedKey };
}

/**
 * POST /:id/done : { parts: { "<n>": [etag, ...] } }, object indices as
 * strings. Only multipart objects need theirs; a single PUT's one ETag may
 * be there too and is not needed.
 */
export function parseParts(body) {
  const parts = isPlainObject(body) ? body.parts : undefined;
  if (parts === undefined || parts === null) return {};
  if (!isPlainObject(parts)) throw new Refusal(400, "bad_parts");
  return parts;
}

/** An ETag as R2 hands them out: printable, quotes and all. */
export function isEtag(value) {
  return typeof value === "string" && /^[\x20-\x7e]{1,256}$/.test(value);
}
