/**
 * Cloud pickup's flows: leaving files, finishing the upload, listing,
 * collecting, cancelling, and the sweep that deletes what nobody collected
 * (ForgeDrop/docs/pickup.md).
 *
 * Objects live in R2 at pickups/<id>/<n> and pickups/<id>/manifest, each one
 * sealed on the sender's computer; nothing here can open one, or knows a
 * file's name. What the server decides is who may do what:
 *
 *   - the sending desktop leaves a pickup, finishes it or cancels it;
 *   - the recipient collects it. For a computer, that is the desktop that
 *     proved it holds the identity key the pickup is for. For a link, any
 *     licensed desktop that knows the id: the key is in the link, so the
 *     ciphertext alone is useless;
 *   - anyone else gets 404, whether or not the id exists, so ids cannot be
 *     probed.
 *
 * A change to one pickup (finish, collect, cancel, the sweep) runs under
 * that pickup's lock, one at a time, and reads the row afresh first.
 * SendForge runs one instance, as the link's store assumes; beyond that,
 * each status change only happens from the status that was read.
 */

import crypto from "node:crypto";
import { bytesSentThisMonth } from "./plans.js";
import { R2Error } from "./r2.js";
import {
  isEtag,
  manifestKey,
  objectKey,
  parseCreate,
  parseParts,
  partLength,
  partPlan,
  Refusal,
} from "./shapes.js";
import { CLOSED_STATUSES, SCRUBBED } from "./store.js";

const iso = (value) => new Date(value).toISOString();
const range = (count) => Array.from({ length: Number(count) }, (_, n) => n);
const describe = (error) => String(error?.message || error).slice(0, 300);

/** Runs `fn` for each item, `limit` at a time; stops starting new ones after a failure. */
export async function eachLimit(items, limit, fn) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}

/** One-at-a-time per key, in the order asked. */
export function createLocks() {
  const tails = new Map();
  return async function withLock(key, fn) {
    const before = tails.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => mine);
    tails.set(key, tail);
    await before;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

function parseSealedKey(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createPickupService({ db, r2, store, tierOf, sendWaitingEmail, now, log, limits }) {
  const withLock = createLocks();
  const notFound = () => new Refusal(404, "not_found");
  const keysOf = (id, count) => [...range(count).map((n) => objectKey(id, n)), manifestKey(id)];

  // After a pickup is over its row forgets the sending desktop, so what is
  // left is matched on the account alone; it only ever answers "over".
  const isSender = (row, caller) =>
    row.sender_user_id === caller.userId && (row.sender_device_id === null || row.sender_device_id === caller.deviceId);

  async function mayCollect(row, caller) {
    if (!row || row.status !== "waiting" || new Date(row.expires_at).getTime() <= now()) return false;
    if (row.recipient_kind === "link") return true;
    const me = await store.device(caller.userId, caller.deviceId);
    return Boolean(me?.fingerprint) && me.fingerprint === row.recipient_fingerprint;
  }

  // ------------------------------------------------------------- leave

  async function create(caller, body) {
    const request = parseCreate(body, limits);
    const sender = await store.device(caller.userId, caller.deviceId);
    // The licence check is cached for a minute; a slot freed since ends here.
    if (!sender) throw new Refusal(403, "device_inactive");

    let recipient = null;
    if (request.fingerprint) {
      // The recipient checks the sealed key's MAC with the sender's identity
      // key, which it may only have from us (someone met through a one-off
      // code): so it has to be a key the sender proved it holds.
      if (!sender.fingerprint) throw new Refusal(403, "sender_unproven");
      recipient = await store.provenDevice(request.fingerprint);
      if (!recipient) throw new Refusal(404, "recipient_unknown");
    }

    const tier = await tierOf(caller.userId);
    if (!tier) throw new Refusal(402, "plan_required");

    const at = now();
    const id = crypto.randomUUID();
    const row = {
      id,
      sender_user_id: caller.userId,
      sender_device_id: caller.deviceId,
      sender_name: sender.name,
      sender_fingerprint: sender.fingerprint,
      sender_identity_key: sender.identityKey,
      recipient_kind: request.fingerprint ? "device" : "link",
      recipient_user_id: recipient?.user_id ?? null,
      recipient_fingerprint: request.fingerprint,
      status: "uploading",
      object_count: request.objects.length,
      manifest_bytes: request.manifestSize,
      total_bytes: request.totalBytes,
      sealed_key: request.sealedKey,
      created_at: new Date(at),
      expires_at: new Date(at + limits.keepMs),
    };

    await db.transaction(async (trx) => {
      // One account's pickups are counted one at a time, so two left at
      // once cannot both fit in what is left of its month.
      await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`forgedrop-pickup:${caller.userId}`]);
      const used = await bytesSentThisMonth(trx, caller.userId, at);
      if (used + request.totalBytes > tier.bytes) {
        throw new Refusal(403, "allowance_used", { allowance: { bytes: tier.bytes, used } });
      }
      await store.insert(trx, row);
    });

    const plans = request.objects.map((size) => partPlan(size, limits));
    const uploadIds = new Map();
    try {
      const multipart = range(plans.length).filter((n) => plans[n]);
      await eachLimit(multipart, limits.r2Concurrency, async (n) => {
        uploadIds.set(n, await r2.createMultipartUpload(objectKey(id, n)));
      });
      await store.insertObjects(
        request.objects.map((size, n) => ({
          pickup_id: id,
          n,
          size,
          upload_id: uploadIds.get(n) ?? null,
          part_size: plans[n]?.partSize ?? null,
        }))
      );
    } catch (error) {
      await abandon(id, uploadIds);
      throw error;
    }

    // Every upload link is timed from created_at, so all of them stop working
    // exactly when the sweep may call the upload abandoned, and the sweep's
    // last pass after an early deletion knows when that is.
    const seconds = limits.uploadUrlSeconds;
    const uploads = request.objects.map((size, n) => {
      const plan = plans[n];
      const key = objectKey(id, n);
      if (!plan) return { url: r2.presignPut(key, size, seconds, at) };
      return {
        partSize: plan.partSize,
        urls: range(plan.count).map((index) =>
          r2.presignUploadPart(key, uploadIds.get(n), index + 1, partLength(size, plan, index), seconds, at)
        ),
      };
    });
    return {
      id,
      expiresAt: iso(row.expires_at),
      uploads,
      manifest: { url: r2.presignPut(manifestKey(id), request.manifestSize, seconds, at) },
    };
  }

  /** R2 failed before any link was handed out: give the bytes back, let go of what R2 started. */
  async function abandon(id, uploadIds) {
    try {
      if (await store.transition(id, "uploading", { status: "cancelled", ...SCRUBBED })) {
        await store.deleted(id, new Date(now()));
      }
    } catch (error) {
      log("error", "forgedrop_pickup_abandon_failed", { pickupId: id, message: describe(error) });
    }
    try {
      await eachLimit([...uploadIds], limits.r2Concurrency, ([n, uploadId]) =>
        r2.abortMultipartUpload(objectKey(id, n), uploadId)
      );
    } catch (error) {
      // R2 drops unfinished multipart uploads by itself after a while.
      log("error", "forgedrop_pickup_abort_failed", { pickupId: id, message: describe(error) });
    }
  }

  // ------------------------------------------------------------ finish

  const finished = (row) => ({ id: row.id, status: "waiting", expiresAt: iso(row.expires_at) });

  async function done(caller, id, body) {
    const parts = parseParts(body);
    return withLock(id, async () => {
      const row = await store.find(id);
      if (!row || !isSender(row, caller)) throw notFound();
      // Said twice (a reply lost on the way back): the same answer, no second email.
      if (row.status === "waiting") return finished(row);
      if (row.status !== "uploading") throw new Refusal(409, "pickup_closed", { status: row.status });

      const objects = await store.objects(id);
      const open = objects.filter((object) => object.upload_id && !object.completed_at);
      for (const object of open) {
        const etags = parts[String(object.n)];
        const plan = { partSize: Number(object.part_size), count: Math.ceil(Number(object.size) / Number(object.part_size)) };
        if (!Array.isArray(etags) || etags.length !== plan.count || !etags.every(isEtag)) {
          throw new Refusal(400, "bad_parts", { object: object.n });
        }
      }

      let mismatch = objects.length === Number(row.object_count) ? null : { object: objects.length };
      await eachLimit(open, limits.r2Concurrency, async (object) => {
        if (mismatch) return;
        const key = objectKey(id, object.n);
        try {
          await r2.completeMultipartUpload(key, object.upload_id, parts[String(object.n)]);
        } catch (error) {
          if (!(error instanceof R2Error && error.refused)) throw error;
          // Put together already, by a done whose note of it was lost? Then
          // the object is there, the size declared.
          const found = error.code === "NoSuchUpload" ? await r2.headObject(key) : null;
          if (!found || found.size !== Number(object.size)) {
            // A part missing, or not the one sent: not what was declared.
            mismatch ??= { object: object.n };
            return;
          }
        }
        // So that done, tried again after R2 had trouble, does not ask twice.
        await store.completed(id, object.n, new Date(now()));
      });

      if (!mismatch) {
        const declared = [
          ...objects.map((object) => [object.n, objectKey(id, object.n), Number(object.size)]),
          ["manifest", manifestKey(id), Number(row.manifest_bytes)],
        ];
        await eachLimit(declared, limits.r2Concurrency, async ([which, key, size]) => {
          if (mismatch) return;
          const found = await r2.headObject(key);
          if (!found || found.size !== size) {
            mismatch ??= { object: which, expected: size, found: found ? found.size : null };
          }
        });
      }

      if (mismatch) {
        // Not what was declared, and so not what the allowance was checked
        // against: refused, and none of it kept.
        await discard(row, "cancelled");
        throw new Refusal(422, "upload_mismatch", mismatch);
      }

      if (!(await store.transition(id, "uploading", { status: "waiting", uploaded_at: new Date(now()) }))) {
        throw new Refusal(409, "pickup_closed");
      }
      if (row.recipient_kind === "device") await notify(row);
      return finished(row);
    });
  }

  async function notify(row) {
    try {
      const account = await store.account(row.recipient_user_id);
      if (!account?.email || !account.email_verified) {
        log("warn", "forgedrop_pickup_email_skipped", {
          pickupId: row.id,
          reason: account ? "email_not_verified" : "account_missing",
        });
        return;
      }
      await sendWaitingEmail({
        to: account.email,
        fromName: row.sender_name,
        expiresAt: new Date(row.expires_at),
        pickupId: row.id,
      });
    } catch (error) {
      // The files are there either way, and the recipient's ForgeDrop lists them.
      log("error", "forgedrop_pickup_email_failed", { pickupId: row.id, message: describe(error) });
    }
  }

  // -------------------------------------------------------------- list

  async function waiting(caller) {
    const me = await store.device(caller.userId, caller.deviceId);
    // A computer that has not proved its key has nothing sealed to it.
    if (!me?.fingerprint) return { pickups: [] };
    const rows = await store.waitingFor(me.fingerprint, new Date(now()));
    return {
      pickups: rows.map((row) => ({
        id: row.id,
        fromName: row.sender_name ?? null,
        fromFingerprint: row.sender_fingerprint ?? null,
        // The sending desktop's proven identity key, as it was when the files
        // were left: what the sealed key's MAC is checked with.
        fromIdentity: row.sender_identity_key ?? null,
        sealedKey: parseSealedKey(row.sealed_key),
        objects: Number(row.object_count),
        totalBytes: Number(row.total_bytes),
        expiresAt: iso(row.expires_at),
      })),
    };
  }

  // ----------------------------------------------------------- collect

  async function downloads(caller, id) {
    const row = await store.find(id);
    if (!(await mayCollect(row, caller))) throw notFound();
    const seconds = limits.downloadUrlSeconds;
    return {
      id: row.id,
      expiresAt: iso(row.expires_at),
      manifest: r2.presignGet(manifestKey(id), seconds),
      objects: range(row.object_count).map((n) => r2.presignGet(objectKey(id, n), seconds)),
    };
  }

  async function pickedUp(caller, id) {
    return withLock(id, async () => {
      const row = await store.find(id);
      // Said twice: already done.
      if (row?.status === "picked_up") return;
      if (!(await mayCollect(row, caller))) throw notFound();
      await discard(row, "picked_up", { picked_up_at: new Date(now()) });
    });
  }

  async function cancel(caller, id) {
    return withLock(id, async () => {
      const row = await store.find(id);
      if (!row || !isSender(row, caller)) throw notFound();
      if (row.status === "cancelled") return;
      if (row.status !== "uploading" && row.status !== "waiting") {
        throw new Refusal(409, "pickup_closed", { status: row.status });
      }
      await discard(row, "cancelled");
    });
  }

  // ------------------------------------------------------------ delete

  /** End a pickup that is uploading or waiting, and delete its objects. */
  async function discard(row, status, extra = {}) {
    if (!(await store.transition(row.id, row.status, { status, ...extra, ...SCRUBBED }))) {
      throw new Refusal(409, "pickup_closed");
    }
    await removeObjects(row.id, row.object_count);
  }

  /**
   * Delete a pickup's objects from R2. False if R2 would not: the row keeps
   * deleted_at empty and the sweep tries again.
   */
  async function removeObjects(id, count) {
    try {
      const open = (await store.objects(id)).filter((object) => object.upload_id && !object.completed_at);
      await eachLimit(open, limits.r2Concurrency, (object) =>
        r2.abortMultipartUpload(objectKey(id, object.n), object.upload_id)
      );
      await eachLimit(keysOf(id, count), limits.r2Concurrency, (key) => r2.deleteObject(key));
      await store.deleted(id, new Date(now()));
      return true;
    } catch (error) {
      log("error", "forgedrop_pickup_delete_failed", { pickupId: id, message: describe(error) });
      return false;
    }
  }

  // ------------------------------------------------------------- sweep

  const BATCH = 50;

  async function sweepOnce() {
    const at = now();
    const counts = { expired: 0, abandoned: 0, deleted: 0, redeleted: 0 };

    // Waiting past its seven days.
    for (let round = 0; round < 100; round += 1) {
      const found = await store.expired(new Date(at), BATCH);
      for (const { id } of found) {
        await withLock(id, async () => {
          const row = await store.find(id);
          if (row?.status !== "waiting" || new Date(row.expires_at).getTime() > at) return;
          await discard(row, "expired");
          counts.expired += 1;
        });
      }
      if (found.length < BATCH) break;
    }

    // Still uploading after a day: abandoned. It never finished, so it ends
    // cancelled, and does not count against the allowance.
    const startedBefore = at - limits.staleUploadMs;
    for (let round = 0; round < 100; round += 1) {
      const found = await store.staleUploads(new Date(startedBefore), BATCH);
      for (const { id } of found) {
        await withLock(id, async () => {
          const row = await store.find(id);
          if (row?.status !== "uploading" || new Date(row.created_at).getTime() > startedBefore) return;
          await discard(row, "cancelled");
          counts.abandoned += 1;
        });
      }
      if (found.length < BATCH) break;
    }

    // Deletions R2 turned down before: once more.
    for (const { id } of await store.undeleted(200)) {
      await withLock(id, async () => {
        const row = await store.find(id);
        if (!row || !CLOSED_STATUSES.includes(row.status) || row.deleted_at) return;
        if (await removeObjects(row.id, row.object_count)) counts.deleted += 1;
      });
    }

    // Deleted while its upload links still worked, so the sender could have
    // put an object back since. Now that the links have run out, once more;
    // that moves deleted_at past them, so it happens once.
    const linkMs = limits.uploadUrlSeconds * 1000;
    const since = new Date(at - linkMs - limits.keepMs);
    for (const { id } of await store.deletedEarly(since, new Date(at - linkMs), limits.uploadUrlSeconds, 200)) {
      await withLock(id, async () => {
        const row = await store.find(id);
        if (!row?.deleted_at) return;
        const linksEnd = new Date(row.created_at).getTime() + linkMs;
        if (new Date(row.deleted_at).getTime() >= linksEnd || linksEnd > at) return;
        if (await removeObjects(row.id, row.object_count)) counts.redeleted += 1;
      });
    }

    if (counts.expired || counts.abandoned || counts.deleted || counts.redeleted) {
      log("info", "forgedrop_pickup_sweep", counts);
    }
    return counts;
  }

  let sweeping = null;

  /** One sweep at a time: a second call while one runs gets the same one. */
  function sweep() {
    if (!sweeping) {
      sweeping = sweepOnce().finally(() => {
        sweeping = null;
      });
    }
    return sweeping;
  }

  return { create, done, waiting, downloads, pickedUp, cancel, sweep };
}
