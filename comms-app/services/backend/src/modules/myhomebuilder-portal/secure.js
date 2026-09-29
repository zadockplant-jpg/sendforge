// Encrypted storage for paperwork: answers holding Social Security, tax id and bank numbers, and
// the signed forms (mhb_secure, AES-256-GCM).
//
// The key is MHB_DATA_KEY (32 random bytes, base64) when it is set. Until it is, a key derived
// from the session secret with HKDF is used, so paperwork works from the first deploy. Each blob
// records which key sealed it ("data" or "session"), so blobs sealed before MHB_DATA_KEY was added
// still open afterwards. Do not change or remove either secret once paperwork is stored: the
// blobs it sealed could no longer be opened.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const QUERY_TIMEOUT_MS = 5000;

function keys(env) {
  const found = new Map();
  const dataKey = Buffer.from(String(env.DATA_KEY || ""), "base64");
  if (dataKey.length === 32) found.set("data", dataKey);
  const secret = String(env.CLIENT_PORTAL_SESSION_SECRET || "");
  if (secret.length >= 16) {
    found.set("session", Buffer.from(hkdfSync("sha256", secret, "mhb-secure-storage", "mhb paperwork v1", 32)));
  }
  return found;
}

export function secureReady(env) {
  return keys(env).size > 0;
}

export function seal(env, bytes) {
  const available = keys(env);
  const keyId = available.has("data") ? "data" : "session";
  const key = available.get(keyId);
  if (!key) throw new Error("secure storage is not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()]);
  return { keyId, iv, tag: cipher.getAuthTag(), ciphertext };
}

export function unseal(env, sealed) {
  const key = keys(env).get(sealed.keyId);
  if (!key) throw new Error(`the key that sealed this record (${sealed.keyId}) is not configured`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv));
  decipher.setAuthTag(Buffer.from(sealed.tag));
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext)), decipher.final()]));
}

export async function putSecure(store, env, key, bytes) {
  const sealed = seal(env, bytes);
  const row = { key, key_id: sealed.keyId, iv: sealed.iv, tag: sealed.tag, ciphertext: sealed.ciphertext };
  await store.db("mhb_secure").insert(row).onConflict("key").merge(["key_id", "iv", "tag", "ciphertext"]).timeout(15000);
}

export async function getSecure(store, env, key) {
  const row = await store.db("mhb_secure").where({ key }).first().timeout(QUERY_TIMEOUT_MS);
  if (!row) return null;
  return unseal(env, { keyId: row.key_id, iv: row.iv, tag: row.tag, ciphertext: row.ciphertext });
}

export async function putSecureJson(store, env, key, value) {
  await putSecure(store, env, key, Buffer.from(JSON.stringify(value), "utf8"));
}

export async function getSecureJson(store, env, key) {
  const bytes = await getSecure(store, env, key);
  return bytes ? JSON.parse(Buffer.from(bytes).toString("utf8")) : null;
}
