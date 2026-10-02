// Sign-in protection per visitor address (mhb_login_guard, 20261012_myhomebuilder_portal_login_guard.js).
//
// Failed sign-ins in a row from one address (a wrong client login, crew password or admin code):
// the 5th blocks the address for 20 minutes, the 10th for 60 minutes and the 15th for good. A
// successful sign-in starts the count again. While an address is blocked it cannot sign in anywhere
// in the portal or ask for an admin code, and nothing it sends is checked, so a block also stops
// it from using up the admin's live codes. Sessions already open keep working. The admin panel's
// Blocked sign-ins page lists the addresses and unblocks them.
//
// An IPv6 address counts by its /64 network, which one household or phone holds, so changing the
// last half of the address does not start a new count.
import { isIP } from "node:net";

const QUERY_TIMEOUT_MS = 5000;
// [failures in a row, minutes blocked]; PERMANENT_AFTER failures in a row block for good.
export const BLOCKS = [[5, 20], [10, 60]];
export const PERMANENT_AFTER = 15;

// An IPv6 address's eight groups, with :: filled in and an IPv4 tail as two groups.
function ipv6Groups(address) {
  let text = address;
  const tail = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text = `${text.slice(0, -tail[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  if (rest === undefined) return left;
  const right = rest ? rest.split(":") : [];
  return [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
}

// The address a sign-in counts against: an IPv4 address, an IPv6 /64 network, or "" for none.
export function guardAddress(ip) {
  let address = String(ip || "").trim().toLowerCase();
  if (address.includes("%")) address = address.slice(0, address.indexOf("%"));
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return "";
  const groups = ipv6Groups(address).map((group) => parseInt(group, 16));
  // An IPv4 address written as IPv6 (::ffff:198.51.100.7) is that IPv4 address.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

// The block on a row now: { permanent: true }, { permanent: false, until, minutes left }, or null.
function blockOf(row) {
  if (!row) return null;
  if (row.permanent) return { permanent: true };
  const until = row.blocked_until ? new Date(row.blocked_until) : null;
  if (!until || until.getTime() <= Date.now()) return null;
  return { permanent: false, until: until.toISOString(), minutes: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60000)) };
}

// The block on a visitor's address now, or null.
export async function signInBlock(store, ip) {
  const address = guardAddress(ip);
  if (!store || !address) return null;
  return blockOf(await store.db("mhb_login_guard").where({ address }).first("permanent", "blocked_until").timeout(QUERY_TIMEOUT_MS));
}

// Counts a failed sign-in (`where`: client, crew or admin), in one statement so attempts sent at
// once cannot share a count. Returns { address, failures, block, started }: `started` (the
// minutes blocked, or "permanent") when this failure began a block.
export async function signInFailed(store, ip, where) {
  const address = guardAddress(ip);
  if (!store || !address) return null;
  const steps = BLOCKS.map(() => "WHEN mhb_login_guard.failures + 1 = ?::integer THEN now() + (?::integer * interval '1 minute')").join(" ");
  const result = await store.db.raw(
    `INSERT INTO mhb_login_guard (address, failures, last_where, first_failed_at, last_failed_at) VALUES (?, 1, ?, now(), now())
     ON CONFLICT (address) DO UPDATE SET
       failures = mhb_login_guard.failures + 1,
       last_where = excluded.last_where,
       last_failed_at = now(),
       blocked_until = CASE ${steps} ELSE mhb_login_guard.blocked_until END,
       permanent = mhb_login_guard.permanent OR mhb_login_guard.failures + 1 >= ?::integer
     RETURNING failures, permanent, blocked_until`,
    [address, String(where).slice(0, 16), ...BLOCKS.flat(), PERMANENT_AFTER]
  ).timeout(QUERY_TIMEOUT_MS);
  const row = result.rows[0];
  const failures = Number(row.failures);
  const step = BLOCKS.find(([count]) => count === failures);
  const started = failures === PERMANENT_AFTER ? "permanent" : step ? step[1] : null;
  return { address, failures, block: blockOf(row), started };
}

// A successful sign-in starts the count again.
export async function signInSucceeded(store, ip) {
  const address = guardAddress(ip);
  if (!store || !address) return;
  await store.db("mhb_login_guard").where({ address, permanent: false }).del().timeout(QUERY_TIMEOUT_MS);
}

// Every address with failed sign-ins in a row: blocked for good first, then blocked now, then the
// rest, latest first.
export async function listSignInGuard(store) {
  const rows = await store.db("mhb_login_guard")
    .select("address", "failures", "permanent", "blocked_until", "last_where", "first_failed_at", "last_failed_at")
    .orderBy([{ column: "permanent", order: "desc" }, { column: "blocked_until", order: "desc", nulls: "last" }, { column: "last_failed_at", order: "desc" }])
    .timeout(QUERY_TIMEOUT_MS);
  const iso = (value) => (value instanceof Date ? value.toISOString() : value || null);
  return rows.map((row) => ({
    address: row.address,
    failures: Number(row.failures),
    block: blockOf(row),
    lastWhere: row.last_where || "",
    firstFailedAt: iso(row.first_failed_at),
    lastFailedAt: iso(row.last_failed_at)
  }));
}

// How many addresses are blocked now (for the admin panel's footer).
export async function countSignInBlocks(store) {
  const row = await store.db("mhb_login_guard")
    .where({ permanent: true })
    .orWhere("blocked_until", ">", store.db.fn.now())
    .count({ total: "*" })
    .first()
    .timeout(QUERY_TIMEOUT_MS);
  return Number(row?.total || 0);
}

// Unblock on the admin panel: the address can sign in again, with a new count. Returns the row
// removed (address, failures, permanent), or null.
export async function liftSignInBlock(store, address) {
  const rows = await store.db("mhb_login_guard").where({ address: String(address || "") }).del().returning(["address", "failures", "permanent"]).timeout(QUERY_TIMEOUT_MS);
  return rows[0] || null;
}
