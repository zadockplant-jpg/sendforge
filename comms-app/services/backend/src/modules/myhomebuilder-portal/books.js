// The My Home Builder books: an activity log of everything done in the portal (admin, client and
// Stripe), and a double-entry journal of its money that always balances. Tables from
// 20260930_myhomebuilder_portal_books.js; the admin panel's Books page reads them.
//
// Each invoice's journal follows its current state. syncInvoiceBooks compares what the journal
// holds for an invoice with what its state calls for, and posts only the difference: a reversal
// of each part that no longer matches (on that part's own date) and a posting of the part as it
// is now. An edit, a void, a payment recorded, corrected or removed, and a delete each leave the
// journal right, a repeated Stripe event posts nothing, and anything missed shows in checkBooks.
//
//   issue    Dr Accounts receivable, Cr Sales, on the invoice date (none once voided or deleted)
//   payment  Dr Stripe balance or Payments received outside Stripe, Cr Accounts receivable, on the
//            payment date. A deleted invoice's hand-recorded payment goes with it; its Stripe
//            payment stays, as Unapplied payments, since Stripe still holds the money.
//   fee      Dr Stripe fees, Cr Stripe balance
//   refund:<Stripe refund id>
//            Dr Refunds, Cr Stripe balance, on the refund date; one part per refund. A deleted
//            invoice's refund comes out of Unapplied payments instead.
//   dispute  Dr Funds held in disputes (what Stripe withdrew) and Dispute losses and fees (its
//            fee), Cr Stripe balance, on the day the dispute opened
//   dispute-close
//            won: Dr Stripe balance, Cr Funds held in disputes (and Cr Dispute losses and fees for
//            a returned fee); lost: Dr Dispute losses and fees, Cr Funds held in disputes
//
// A refund of money not on an invoice (a second payment, a deleted invoice's) posts
// Dr Unapplied payments, Cr Stripe balance, once per refund.
//
// Labor (labor.js) follows the same way, for each hours entry or subcontractor invoice:
//   cost     approved: Dr Job labor (hours) or Subcontractors (invoices), or Shop and overhead
//            labor when not on a job, Cr Wages payable or Accounts payable, on the work or
//            invoice date, tagged with the job
//   paid     paid by hand: Dr Wages payable or Accounts payable, Cr Business checking
//
// Entries carry a source, an external id and labels, so bank transactions can join the journal
// later (the business account) and be labeled and categorized against new accounts.
import { billingLabel, issuedDate, todayInMichigan } from "./billing.js";
import { money } from "./format.js";
import { LABOR_PAYMENT_METHODS, hoursText } from "./labor.js";

const RECEIVABLE = "1100";
const STRIPE = "1200";
const DISPUTED = "1250";
const RECEIVED = "1300";
const UNAPPLIED = "2100";
const SALES = "4000";
const REFUNDS = "4200";
const STRIPE_FEES = "6100";
const DISPUTE_LOSSES = "6200";
const CHECKING = "1000";
const PAYABLE = "2000";
const WAGES = "2300";
const JOB_LABOR = "5000";
const SUBCONTRACTORS = "5100";
const SHOP_LABOR = "6450";
const QUERY_TIMEOUT_MS = 5000;

// A part's kind: every "refund:<id>" part is a refund.
export const partKind = (part) => (String(part).startsWith("refund:") ? "refund" : part);
const PART_ORDER = ["issue", "payment", "fee", "refund", "dispute", "dispute-close", "cost", "paid"];
const PART_WORDS = { issue: "invoice", payment: "payment", fee: "Stripe fee", refund: "refund", dispute: "dispute", "dispute-close": "dispute outcome", cost: "labor cost", paid: "labor payment" };
const disputeWon = (dispute) => ["won", "warning_closed"].includes(dispute?.status);

function data(row) {
  if (!row) return null;
  return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
}

// A payment date may be a calendar date (recorded by hand) or a timestamp (Stripe).
function calendarDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ""))) return value;
  const date = new Date(value || Date.now());
  return todayInMichigan(Number.isNaN(date.getTime()) ? new Date() : date);
}

// ---------- What an invoice's books should hold ----------

// The parts of an invoice's books, each a date and its lines ([account, debit, credit]).
export function bookParts(item, { deleted = false } = {}) {
  const parts = {};
  if (!item || item.kind !== "invoice") return parts;
  if (!deleted && item.status !== "void" && item.amountCents > 0) {
    parts.issue = { date: issuedDate(item), lines: [[RECEIVABLE, item.amountCents, 0], [SALES, 0, item.amountCents]] };
  }
  const payment = item.status === "paid" ? item.payment : null;
  if (payment) {
    const stripe = payment.source === "stripe";
    const amount = payment.amountCents ?? item.amountCents;
    const date = calendarDate(item.paidAt);
    if (amount > 0 && (!deleted || stripe)) {
      parts.payment = { date, lines: [[stripe ? STRIPE : RECEIVED, amount, 0], [deleted ? UNAPPLIED : RECEIVABLE, 0, amount]] };
    }
    if (stripe && Number.isInteger(payment.feeCents) && payment.feeCents > 0) {
      parts.fee = { date, lines: [[STRIPE_FEES, payment.feeCents, 0], [STRIPE, 0, payment.feeCents]] };
    }
    if (stripe) {
      for (const refund of payment.refunds || []) {
        if (!(refund.amountCents > 0) || ["failed", "canceled"].includes(refund.status)) continue;
        parts[`refund:${refund.id}`] = { date: calendarDate(refund.refundedAt), lines: [[deleted ? UNAPPLIED : REFUNDS, refund.amountCents, 0], [STRIPE, 0, refund.amountCents]] };
      }
      const dispute = payment.dispute;
      if (dispute?.id && dispute.amountCents > 0 && dispute.openedAt) {
        const fee = dispute.feeCents > 0 ? dispute.feeCents : 0;
        parts.dispute = { date: calendarDate(dispute.openedAt), lines: [[DISPUTED, dispute.amountCents, 0], ...(fee ? [[DISPUTE_LOSSES, fee, 0]] : []), [STRIPE, 0, dispute.amountCents + fee]] };
        if (dispute.closedAt) {
          const returned = dispute.feeReturnedCents > 0 ? dispute.feeReturnedCents : 0;
          parts["dispute-close"] = {
            date: calendarDate(dispute.closedAt),
            lines: disputeWon(dispute)
              ? [[STRIPE, dispute.amountCents + returned, 0], [DISPUTED, 0, dispute.amountCents], ...(returned ? [[DISPUTE_LOSSES, 0, returned]] : [])]
              : [[DISPUTE_LOSSES, dispute.amountCents, 0], [DISPUTED, 0, dispute.amountCents]]
          };
        }
      }
    }
  }
  return parts;
}

// ---------- What labor's books should hold ----------

export function laborParts(entry) {
  const parts = {};
  const amount = Number(entry?.amountCents || 0);
  if (!entry || !["approved", "paid"].includes(entry.status) || amount <= 0) return parts;
  const hours = entry.kind === "hours";
  const cost = !entry.clientSlug ? SHOP_LABOR : hours ? JOB_LABOR : SUBCONTRACTORS;
  const owed = hours ? WAGES : PAYABLE;
  parts.cost = { date: entry.workDate, lines: [[cost, amount, 0], [owed, 0, amount]] };
  if (entry.status === "paid" && entry.payment && entry.payment.source !== "bank") {
    parts.paid = { date: calendarDate(entry.payment.paidOn || entry.paidAt), lines: [[owed, amount, 0], [CHECKING, 0, amount]] };
  }
  return parts;
}

export function laborName(entry) {
  const who = entry.workerName || "A worker";
  return entry.kind === "hours" ? `${who} · ${hoursText(entry.hours)} on ${entry.workDate}` : `${who} · invoice ${entry.invoiceNumber || ""}`.trim();
}

function laborMemo(entry, part, { reversal = false, reason = "" } = {}) {
  const name = laborName(entry);
  if (reversal) return `${name} · ${PART_WORDS[partKind(part)] || "entry"} ${({ returned: "returned", unapproved: "approval undone", "payment-removed": "marked unpaid" })[reason] || "changed"}`;
  if (part === "paid") return `${name} · paid by ${LABOR_PAYMENT_METHODS[entry.payment?.method] || entry.payment?.label || "hand"}`;
  return name;
}

// For an invoice deleted without its last state at hand: what its held parts become. Its sale
// goes, a Stripe payment stays as Unapplied payments (and its refunds come out of them), and
// Stripe's fee and any dispute stay as they were.
function deletedParts(held) {
  const parts = {};
  for (const [part, entries] of Object.entries(held)) {
    const entry = entries[0];
    if (!entry || part === "issue") continue;
    if (part === "payment") {
      const stripe = entry.lines.find(([account, debit]) => account === STRIPE && debit > 0);
      if (stripe) parts.payment = { date: entry.date, lines: [[STRIPE, stripe[1], 0], [UNAPPLIED, 0, stripe[1]]] };
      continue;
    }
    parts[part] = { date: entry.date, lines: partKind(part) === "refund" ? entry.lines.map(([account, debit, credit]) => [account === REFUNDS ? UNAPPLIED : account, debit, credit]) : entry.lines };
  }
  return parts;
}

// The parts whose journal entries do not match what they should be, in posting order.
function offParts(held, wanted) {
  const rank = (part) => PART_ORDER.indexOf(partKind(part));
  return [...new Set([...Object.keys(held), ...Object.keys(wanted)])]
    .filter((part) => {
      const have = held[part] || [];
      const want = wanted[part] || null;
      return !(have.length === (want ? 1 : 0) && (!want || signature(have[0]) === signature(want)));
    })
    .sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}

function signature(part) {
  if (!part) return "";
  return JSON.stringify([part.date, [...part.lines].sort((left, right) => `${left}`.localeCompare(`${right}`))]);
}

function memoFor(item, part, { deleted = false, reversal = false, reason = "" } = {}) {
  const label = item?.kind ? billingLabel(item) : item?.number ? `Invoice ${item.number}` : "An invoice";
  const kind = partKind(part);
  if (reversal) {
    const why = { voided: "voided", deleted: "deleted", "payment-removed": "marked unpaid", opening: "opening" }[reason] || "changed";
    return `${label} · ${PART_WORDS[kind] || "entry"} ${why}`;
  }
  if (kind === "issue") return `${label} · ${item.title || "invoiced"}`;
  if (kind === "fee") return `${label} · Stripe fee`;
  if (kind === "refund") return `${label} · refunded through Stripe`;
  if (kind === "dispute") return `${label} · dispute opened; Stripe is holding the payment`;
  if (kind === "dispute-close") return `${label} · dispute ${disputeWon(item?.payment?.dispute) ? "won" : "lost"}`;
  const payment = item?.payment || {};
  if (deleted) return `${label} · Stripe payment kept after the invoice was deleted`;
  return payment.source === "stripe"
    ? `${label} · paid online${payment.label ? ` (${payment.label})` : ""}`
    : `${label} · paid by ${payment.label || "hand"}`;
}

// ---------- Journal ----------

async function post(trx, { kind, part = null, reverses = null, date, memo, item = null, clientSlug = null, lines, source, externalId = null, activityId = null, data: extra = {} }) {
  const debits = lines.reduce((sum, [, debit]) => sum + debit, 0);
  const credits = lines.reduce((sum, [, , credit]) => sum + credit, 0);
  if (debits !== credits || debits <= 0) throw new Error(`journal entry does not balance: ${debits} vs ${credits}`);
  const slug = item?.clientSlug ?? clientSlug ?? null;
  const query = trx("mhb_journal_entries").insert({
    entry_date: date,
    kind,
    part,
    reverses,
    memo: String(memo).slice(0, 300),
    client_slug: slug,
    item_id: item?.id ?? null,
    item_number: item?.number ?? null,
    source,
    external_id: externalId,
    activity_id: activityId,
    data: JSON.stringify(extra)
  });
  const rows = await (externalId ? query.onConflict(["kind", "external_id"]).ignore() : query).returning("id").timeout(QUERY_TIMEOUT_MS);
  if (!rows.length) return null;
  const entryId = Number(rows[0].id ?? rows[0]);
  await trx("mhb_journal_lines")
    .insert(lines.map(([account, debit, credit]) => ({ entry_id: entryId, account, debit_cents: debit, credit_cents: credit, client_slug: slug, item_id: item?.id ?? null })))
    .timeout(QUERY_TIMEOUT_MS);
  return entryId;
}

// The parts the journal holds now for an invoice: postings not yet reversed, by part.
async function heldParts(trx, itemId) {
  const rows = await trx.raw(
    `SELECT e.id, e.part, e.client_slug, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, l.account, l.debit_cents, l.credit_cents
     FROM mhb_journal_entries e JOIN mhb_journal_lines l ON l.entry_id = e.id
     WHERE e.item_id = ? AND e.part IS NOT NULL AND e.reverses IS NULL
       AND NOT EXISTS (SELECT 1 FROM mhb_journal_entries r WHERE r.reverses = e.id)
     ORDER BY e.id, l.id`,
    [itemId]
  ).timeout(QUERY_TIMEOUT_MS);
  const entries = new Map();
  for (const row of rows.rows) {
    const id = Number(row.id);
    if (!entries.has(id)) entries.set(id, { id, part: row.part, date: row.entry_date, clientSlug: row.client_slug, lines: [] });
    entries.get(id).lines.push([row.account, Number(row.debit_cents), Number(row.credit_cents)]);
  }
  const held = {};
  for (const entry of entries.values()) (held[entry.part] ||= []).push(entry);
  return held;
}

// Brings one item's journal in line with what it should hold: `wanted(held)` returns the parts,
// and each part that no longer matches is reversed (on its own date, under the job it was posted
// to) and posted as it is now.
async function syncParts(trx, { itemId, subject, wanted, memo, reason, source, activityId }) {
  await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`mhb-books:${itemId}`]).timeout(QUERY_TIMEOUT_MS);
  const held = await heldParts(trx, itemId);
  const want = wanted(held);
  let posted = 0;
  for (const part of offParts(held, want)) {
    for (const entry of held[part] || []) {
      await post(trx, {
        kind: "reversal", part, reverses: entry.id, date: entry.date, item: { ...subject, clientSlug: entry.clientSlug ?? subject.clientSlug },
        memo: memo(part, { reversal: true, reason }), lines: entry.lines.map(([account, debit, credit]) => [account, credit, debit]), source, activityId
      });
      posted += 1;
    }
    if (want[part]) {
      await post(trx, { kind: partKind(part), part, date: want[part].date, item: subject, memo: memo(part, {}), lines: want[part].lines, source, activityId });
      posted += 1;
    }
  }
  return posted;
}

// Brings an invoice's journal in line with its state (see the top of this file). `item` is the
// invoice as it is now, or as it was when deleted; with deleted and no item, the held parts decide.
async function syncInvoiceBooks(trx, { item = null, itemId = item?.id, itemNumber = null, clientSlug = null, deleted = false, reason = "changed", source = "portal", activityId = null }) {
  const subject = item || { id: itemId, number: itemNumber, clientSlug };
  return syncParts(trx, {
    itemId, subject, reason, source, activityId,
    wanted: (held) => (item ? bookParts(item, { deleted }) : deletedParts(held)),
    memo: (part, options) => memoFor(subject, part, { ...options, deleted })
  });
}

// Brings an hours entry's or a subcontractor invoice's journal in line with its state.
export async function syncLaborBooks(trx, entry, { reason = "changed", source = "portal", activityId = null } = {}) {
  return syncParts(trx, {
    itemId: entry.id, subject: { id: entry.id, number: null, clientSlug: entry.clientSlug || null }, reason, source, activityId,
    wanted: () => laborParts(entry),
    memo: (part, options) => laborMemo(entry, part, options)
  });
}

// ---------- Activity ----------

async function insertActivity(db, event) {
  const rows = await db("mhb_activity").insert({
    ...(event.at ? { at: event.at } : {}),
    actor: event.actor || "admin",
    action: String(event.action).slice(0, 48),
    client_slug: event.item?.clientSlug ?? event.clientSlug ?? null,
    item_id: event.item?.id ?? null,
    item_kind: event.item?.kind ?? null,
    item_number: event.item?.number ?? null,
    amount_cents: Number.isInteger(event.amountCents) ? event.amountCents : null,
    summary: String(event.summary || event.action).slice(0, 500),
    ip: event.ip ? String(event.ip).slice(0, 64) : null,
    data: JSON.stringify(event.data || {})
  }).returning("id").timeout(QUERY_TIMEOUT_MS);
  return Number(rows[0]?.id ?? rows[0]);
}

// What an item's saved fields tell of its past, for the log's start (marked from records).
function historyOf(item, clientName) {
  const label = billingLabel(item);
  const amount = money(item.amountCents, item.currency);
  const at = (value) => (/^\d{4}-\d{2}-\d{2}$/u.test(String(value)) ? `${value}T12:00:00Z` : value);
  const entries = [{ at: item.createdAt, actor: "admin", action: `${item.kind}.created`, amountCents: item.amountCents, summary: `Created ${label} · ${item.title} · ${amount}` }];
  if (item.movedFrom?.movedAt) entries.push({ at: item.movedFrom.movedAt, actor: "admin", action: `${item.kind}.moved`, summary: `Sent ${label} from ${item.movedFrom.name} to ${clientName}` });
  if (item.sentAt) entries.push({ at: item.sentAt, actor: "admin", action: `${item.kind}.emailed`, summary: `Emailed ${label} to ${item.sentTo}` });
  if (item.acceptedAt) entries.push({ at: item.acceptedAt, actor: item.acceptedVia === "admin" ? "admin" : "client", action: "quote.accepted", summary: `${label} accepted${item.acceptedBy ? ` by ${item.acceptedBy}` : ""}` });
  if (item.processingAt) entries.push({ at: item.processingAt, actor: "stripe", action: "stripe.processing", amountCents: item.amountCents, summary: `Bank payment started for ${label}` });
  if (item.paymentFailedAt) entries.push({ at: item.paymentFailedAt, actor: "stripe", action: "stripe.failed", summary: `Bank payment failed for ${label}` });
  if (item.status === "paid" && item.paidAt) {
    const paid = money(item.payment?.amountCents ?? item.amountCents, item.currency);
    entries.push(item.payment?.source === "stripe"
      ? { at: at(item.paidAt), actor: "stripe", action: "stripe.paid", amountCents: item.payment?.amountCents ?? item.amountCents, summary: `Stripe payment of ${paid} for ${label}` }
      : { at: at(item.paidAt), actor: "admin", action: "payment.recorded", amountCents: item.payment?.amountCents ?? item.amountCents, summary: `Recorded a ${item.payment?.label || "hand"} payment of ${paid} for ${label}` });
  }
  if (item.reopenedAt) entries.push({ at: item.reopenedAt, actor: "admin", action: "payment.removed", summary: `Marked ${label} unpaid` });
  if (item.voidedAt) entries.push({ at: item.voidedAt, actor: "admin", action: `${item.kind}.voided`, summary: `Voided ${label}` });
  return entries.filter((entry) => entry.at).map((entry) => ({ ...entry, item, data: { fromRecords: true } }));
}

// The books start from what the portal already holds: the first time they are used, every
// invoice gets its opening entries and every quote and invoice its history in the log.
async function ensureBooksOpened(store) {
  const opened = await store.db("mhb_counters").where({ name: "books-opened" }).first().timeout(QUERY_TIMEOUT_MS);
  if (opened) return;
  await store.db.transaction(async (trx) => {
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext('mhb-books-open'))").timeout(QUERY_TIMEOUT_MS);
    if (await trx("mhb_counters").where({ name: "books-opened" }).first().timeout(QUERY_TIMEOUT_MS)) return;
    const clients = new Map((await trx("mhb_clients").select("slug", "data").timeout(QUERY_TIMEOUT_MS)).map((row) => [row.slug, data(row)?.name || row.slug]));
    const items = (await trx("mhb_billing").select("data").timeout(QUERY_TIMEOUT_MS)).map(data)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || String(left.id).localeCompare(String(right.id)));
    for (const item of items) {
      for (const event of historyOf(item, clients.get(item.clientSlug) || (item.clientSlug === "muskegon-addition" ? "Muskegon Addition" : item.clientSlug))) {
        await insertActivity(trx, event);
      }
      if (item.kind === "invoice") await syncInvoiceBooks(trx, { item, source: "opening", reason: "opening" });
    }
    await trx("mhb_counters").insert({ name: "books-opened", value: 1 }).timeout(QUERY_TIMEOUT_MS);
  });
}

// ---------- Recording ----------

// Logs what happened and keeps the journal in step, in one transaction. It never fails the action
// it follows: an error is logged, and the Books page's balance check shows anything missed.
//   event: { action, summary, actor (admin|client|crew|stripe|system), ip, item, clientSlug,
//            amountCents, data, deleted, reason, unapplied: { externalId, amountCents, date,
//            item, clientSlug, memo }, unappliedRefund: { the same, for a refund of money
//            not on an invoice }, moved: true, labor: an hours entry or subcontractor invoice }
export async function record(store, event) {
  if (!store) return;
  try {
    await ensureBooksOpened(store);
    await store.db.transaction(async (trx) => {
      // A repeated Stripe event for money not tied to an invoice was recorded the first time.
      if (event.unapplied && (await trx("mhb_journal_entries").where({ kind: "unapplied", external_id: event.unapplied.externalId }).first().timeout(QUERY_TIMEOUT_MS))) return;
      if (event.unappliedRefund && (await trx("mhb_journal_entries").where({ kind: "unapplied-refund", external_id: event.unappliedRefund.externalId }).first().timeout(QUERY_TIMEOUT_MS))) return;
      const activityId = await insertActivity(trx, event);
      if (event.moved && event.item) {
        await trx("mhb_journal_entries").where({ item_id: event.item.id }).update({ client_slug: event.item.clientSlug }).timeout(QUERY_TIMEOUT_MS);
        await trx("mhb_journal_lines").where({ item_id: event.item.id }).update({ client_slug: event.item.clientSlug }).timeout(QUERY_TIMEOUT_MS);
      }
      if (event.item?.kind === "invoice") {
        await syncInvoiceBooks(trx, { item: event.item, deleted: Boolean(event.deleted), reason: event.reason || "changed", source: event.actor === "stripe" ? "stripe" : "portal", activityId });
      }
      if (event.labor) await syncLaborBooks(trx, event.labor, { reason: event.reason || "changed", activityId });
      if (event.unapplied) {
        const { externalId, amountCents, date, item, clientSlug, memo } = event.unapplied;
        await post(trx, {
          kind: "unapplied", date: date || todayInMichigan(), item: item || null, clientSlug, memo, externalId,
          lines: [[STRIPE, amountCents, 0], [UNAPPLIED, 0, amountCents]], source: "stripe", activityId
        });
      }
      if (event.unappliedRefund) {
        const { externalId, amountCents, date, item, clientSlug, memo } = event.unappliedRefund;
        await post(trx, {
          kind: "unapplied-refund", date: date || todayInMichigan(), item: item || null, clientSlug, memo, externalId,
          lines: [[UNAPPLIED, amountCents, 0], [STRIPE, 0, amountCents]], source: "stripe", activityId
        });
      }
    });
  } catch (error) {
    console.error(JSON.stringify({ message: "books not recorded", action: event.action, error: error instanceof Error ? error.message : "Unknown error" }));
  }
}

// ---------- Checking and correcting ----------

// Whether the books balance: every entry's debits equal its credits, and each invoice's journal
// holds what its state calls for (a deleted invoice's: no receivable or sales left).
export async function checkBooks(store) {
  await ensureBooksOpened(store);
  const items = (await store.db("mhb_billing").where({ kind: "invoice" }).select("data").timeout(QUERY_TIMEOUT_MS)).map(data);
  const totals = (await store.db("mhb_journal_lines").sum({ debits: "debit_cents", credits: "credit_cents" }).first().timeout(QUERY_TIMEOUT_MS)) || {};
  const debits = Number(totals.debits || 0);
  const credits = Number(totals.credits || 0);
  const problems = [];
  const known = new Set();
  for (const item of items) {
    known.add(item.id);
    const held = await heldParts(store.db, item.id);
    const off = offParts(held, bookParts(item));
    if (off.length) problems.push({ itemId: item.id, clientSlug: item.clientSlug, label: billingLabel(item), parts: [...new Set(off.map(partKind))] });
  }
  // Hours and subcontractor invoices.
  const labor = (await store.db("mhb_labor").select("data").timeout(QUERY_TIMEOUT_MS)).map(data);
  for (const entry of labor) {
    known.add(entry.id);
    const off = offParts(await heldParts(store.db, entry.id), laborParts(entry));
    if (off.length) problems.push({ itemId: entry.id, labor: true, clientSlug: entry.clientSlug || null, label: laborName(entry), parts: [...new Set(off.map(partKind))] });
  }
  const orphans = await store.db.raw(
    `SELECT item_id, max(item_number) AS item_number, max(client_slug) AS client_slug
     FROM mhb_journal_entries WHERE item_id IS NOT NULL AND part IS NOT NULL
     GROUP BY item_id`
  ).timeout(QUERY_TIMEOUT_MS);
  for (const row of orphans.rows) {
    if (known.has(row.item_id)) continue;
    const held = await heldParts(store.db, row.item_id);
    const off = offParts(held, deletedParts(held));
    if (off.length) problems.push({ itemId: row.item_id, number: row.item_number, clientSlug: row.client_slug, label: `Invoice ${row.item_number} (deleted)`, parts: [...new Set(off.map(partKind))], deleted: true });
  }
  return { balanced: debits === credits && problems.length === 0, debits, credits, problems };
}

// Posts what the journal is missing (or holds wrongly) so it matches every invoice again.
export async function correctBooks(store, { ip = null } = {}) {
  const { problems } = await checkBooks(store);
  if (!problems.length) return 0;
  const items = new Map((await store.db("mhb_billing").where({ kind: "invoice" }).select("data").timeout(QUERY_TIMEOUT_MS)).map(data).map((item) => [item.id, item]));
  const labor = new Map((await store.db("mhb_labor").select("data").timeout(QUERY_TIMEOUT_MS)).map(data).map((entry) => [entry.id, entry]));
  let posted = 0;
  await store.db.transaction(async (trx) => {
    const activityId = await insertActivity(trx, {
      actor: "admin", action: "books.corrected", ip,
      summary: `Posted corrections for ${problems.map((problem) => problem.label).join(", ")} to balance the books`
    });
    for (const problem of problems) {
      if (problem.labor) {
        posted += await syncLaborBooks(trx, labor.get(problem.itemId), { activityId });
        continue;
      }
      const item = items.get(problem.itemId);
      posted += await syncInvoiceBooks(trx, item ? { item, reason: "changed", activityId } : { itemId: problem.itemId, itemNumber: problem.number, clientSlug: problem.clientSlug, deleted: true, reason: "deleted", activityId });
    }
  });
  return posted;
}

// ---------- Reading ----------

// The journal and activity for the Books page and its downloads, optionally for one client
// portal (`slug`) and a date range (`from`, `to`, inclusive, YYYY-MM-DD).
export async function booksReport(store, { slug = "", from = "", to = "" } = {}) {
  await ensureBooksOpened(store);
  const [accountRows, entryRows, lineRows, itemRows, activityRows] = await Promise.all([
    store.db("mhb_accounts").orderBy("sort").select("code", "name", "type").timeout(QUERY_TIMEOUT_MS),
    store.db("mhb_journal_entries").select("id", store.db.raw("to_char(entry_date, 'YYYY-MM-DD') AS entry_date"), "recorded_at", "kind", "part", "memo", "client_slug", "item_id", "item_number", "source", "external_id").orderBy([{ column: "entry_date" }, { column: "id" }]).timeout(QUERY_TIMEOUT_MS),
    store.db("mhb_journal_lines").select("entry_id", "account", "debit_cents", "credit_cents", "client_slug").orderBy("id").timeout(QUERY_TIMEOUT_MS),
    store.db("mhb_billing").select("id", "data").timeout(QUERY_TIMEOUT_MS),
    (() => {
      const query = store.db("mhb_activity").orderBy([{ column: "at", order: "desc" }, { column: "id", order: "desc" }]).limit(5000);
      if (slug) query.where({ client_slug: slug });
      return query.select("id", "at", "actor", "action", "client_slug", "item_id", "item_kind", "item_number", "amount_cents", "summary", "ip").timeout(QUERY_TIMEOUT_MS);
    })()
  ]);
  const items = new Map(itemRows.map((row) => [row.id, data(row)]));
  const linesByEntry = new Map();
  for (const line of lineRows) {
    if (slug && line.client_slug !== slug) continue;
    const entryId = Number(line.entry_id);
    if (!linesByEntry.has(entryId)) linesByEntry.set(entryId, []);
    linesByEntry.get(entryId).push({ account: line.account, debit: Number(line.debit_cents), credit: Number(line.credit_cents) });
  }
  const net = (lines, accounts) => lines.filter((line) => accounts.includes(line.account)).reduce((sum, line) => sum + line.debit - line.credit, 0);
  const balances = new Map(accountRows.map((account) => [account.code, { debit: 0, credit: 0 }]));
  const opening = { receivable: 0 };
  const period = { invoiced: 0, received: 0, fees: 0, refunds: 0 };
  const entries = [];
  for (const row of entryRows) {
    const lines = linesByEntry.get(Number(row.id));
    if (!lines?.length || (to && row.entry_date > to)) continue;
    for (const line of lines) {
      const balance = balances.get(line.account) || { debit: 0, credit: 0 };
      balance.debit += line.debit;
      balance.credit += line.credit;
      balances.set(line.account, balance);
    }
    // Received counts payments (and money not on an invoice); cash is every entry's effect on the
    // Stripe balance and payments received outside Stripe.
    const kind = row.part ? partKind(row.part) : row.kind;
    const change = {
      invoiced: -net(lines, [SALES]),
      received: kind === "payment" || row.kind === "unapplied" ? net(lines, [STRIPE, RECEIVED]) : 0,
      fees: net(lines, [STRIPE_FEES]),
      refunds: net(lines, [REFUNDS]) + (row.kind === "unapplied-refund" ? net(lines, [UNAPPLIED]) : 0),
      cash: net(lines, [STRIPE, RECEIVED]),
      receivable: net(lines, [RECEIVABLE])
    };
    if (from && row.entry_date < from) {
      opening.receivable += change.receivable;
      continue;
    }
    period.invoiced += change.invoiced;
    period.received += change.received;
    period.fees += change.fees;
    period.refunds += change.refunds;
    const item = row.item_id ? items.get(row.item_id) : null;
    entries.push({
      id: Number(row.id),
      date: row.entry_date,
      recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
      kind: row.kind,
      memo: row.memo,
      clientSlug: row.client_slug,
      itemId: row.item_id,
      itemLabel: item ? billingLabel(item) : row.item_number ? `Invoice ${row.item_number}` : "",
      itemExists: Boolean(item),
      source: row.source,
      externalId: row.external_id || "",
      lines,
      ...change
    });
  }
  let running = opening.receivable;
  for (const entry of entries) {
    running += entry.receivable;
    entry.owed = running;
  }
  // Each job's (client portal's) sales and costs in the period, for the job profit table.
  const entryDates = new Map(entryRows.map((row) => [Number(row.id), row.entry_date]));
  const jobs = new Map();
  for (const line of lineRows) {
    if (!line.client_slug || line.client_slug.startsWith("crew:") || (slug && line.client_slug !== slug)) continue;
    const day = entryDates.get(Number(line.entry_id));
    if (!day || (from && day < from) || (to && day > to)) continue;
    const job = jobs.get(line.client_slug) || { slug: line.client_slug, invoiced: 0, labor: 0, subcontractors: 0, otherCosts: 0 };
    const amount = Number(line.debit_cents) - Number(line.credit_cents);
    if (line.account === SALES || line.account === REFUNDS) job.invoiced -= amount;
    else if (line.account === JOB_LABOR) job.labor += amount;
    else if (line.account === SUBCONTRACTORS) job.subcontractors += amount;
    else if (String(line.account).startsWith("5")) job.otherCosts += amount;
    jobs.set(line.client_slug, job);
  }
  const jobList = [...jobs.values()]
    .map((job) => ({ ...job, costs: job.labor + job.subcontractors + job.otherCosts, profit: job.invoiced - job.labor - job.subcontractors - job.otherCosts }))
    .filter((job) => job.invoiced || job.costs);

  const accounts = accountRows.map((account) => ({ ...account, ...balances.get(account.code) }));
  const debits = accounts.reduce((sum, account) => sum + account.debit, 0);
  const credits = accounts.reduce((sum, account) => sum + account.credit, 0);
  const balanceOf = (code) => {
    const account = balances.get(code) || { debit: 0, credit: 0 };
    return account.debit - account.credit;
  };
  return {
    slug, from, to,
    entries,
    accounts,
    debits,
    credits,
    summary: {
      ...period,
      outstanding: balanceOf(RECEIVABLE),
      unapplied: -balanceOf(UNAPPLIED),
      disputed: balanceOf(DISPUTED),
      owedToCrew: -(balanceOf(PAYABLE) + balanceOf(WAGES)),
      stripeBalance: balanceOf(STRIPE),
      receivedOutsideStripe: balanceOf(RECEIVED)
    },
    items,
    jobs: jobList,
    activity: activityRows.filter((row) => {
      const day = calendarDate(row.at instanceof Date ? row.at.toISOString() : row.at);
      return (!from || day >= from) && (!to || day <= to);
    }).map((row) => ({
      id: Number(row.id),
      at: row.at instanceof Date ? row.at.toISOString() : row.at,
      actor: row.actor,
      action: row.action,
      clientSlug: row.client_slug,
      itemId: row.item_id,
      itemLabel: row.item_id && items.get(row.item_id) ? billingLabel(items.get(row.item_id)) : row.item_number ? `${row.item_kind === "quote" ? "Quote" : "Invoice"} ${row.item_number}` : "",
      itemExists: Boolean(row.item_id && items.get(row.item_id)),
      amountCents: row.amount_cents === null || row.amount_cents === undefined ? null : Number(row.amount_cents),
      summary: row.summary,
      ip: row.ip || ""
    }))
  };
}

// ---------- Downloads ----------

// Spreadsheet programs run a cell that starts with = + - @ as a formula; such cells are quoted
// with a leading apostrophe, since memos and names can hold text a client typed.
function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return /[",\n\r]/u.test(safe) ? `"${safe.replaceAll("\"", "\"\"")}"` : safe;
}

function csv(rows) {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

const dollars = (cents) => (cents ? (cents / 100).toFixed(2) : "");

// One row per journal line, for an accountant or a spreadsheet.
export function ledgerCsv(report, clientNames) {
  const names = new Map(report.accounts.map((account) => [account.code, account.name]));
  const rows = [["Date", "Entry", "Kind", "Client portal", "Document", "Account", "Account name", "Debit", "Credit", "Memo", "Source", "External id", "Recorded at"]];
  for (const entry of report.entries) {
    for (const line of entry.lines) {
      rows.push([
        entry.date, entry.id, entry.kind, clientNames.get(entry.clientSlug) || entry.clientSlug || "", entry.itemLabel,
        line.account, names.get(line.account) || "", dollars(line.debit), dollars(line.credit), entry.memo, entry.source, entry.externalId, entry.recordedAt
      ]);
    }
  }
  return csv(rows);
}

export function activityCsv(report, clientNames) {
  const rows = [["Time", "Who", "Action", "Client portal", "Document", "Amount", "What happened", "IP address"]];
  for (const entry of report.activity) {
    rows.push([entry.at, entry.actor, entry.action, clientNames.get(entry.clientSlug) || entry.clientSlug || "", entry.itemLabel, entry.amountCents === null ? "" : dollars(entry.amountCents) || "0.00", entry.summary, entry.ip]);
  }
  return csv(rows);
}
