// Banking: the business bank account's transactions, linked through Stripe (Financial
// Connections, from Stripe's hosted page) or uploaded from statements (CSV, OFX or QFX), filed
// with one click to a job's costs, an overhead category, or what they were. Filing posts to the
// books (books.js bankParts); refiling or unfiling reverses and posts again.
//
// Money out filed to crew work (labor.js) pays it: the work is marked paid from the bank, or a
// payment already recorded by hand is matched to the withdrawal. Unfiling puts it back.
import { createHash } from "node:crypto";
import { randomId, readBoundedForm, readBoundedMultipart } from "./security.js";
import { listClients } from "./store.js";
import { isValidDate, todayInMichigan } from "./billing.js";
import { money } from "./format.js";
import { record } from "./books.js";
import { getLabor, getSetting, laborLabel, listLabor, putLabor, putSetting } from "./labor.js";
import { getExpense, listAllExpenses, putExpense } from "./expenses.js";
import {
  createBankLinkSession,
  createBooksCustomer,
  disconnectBankAccount,
  linkedBankAccount,
  listBankTransactions,
  refreshBankTransactions,
  stripeConfigured,
  subscribeBankTransactions
} from "./stripe.js";
import { adminBankPage } from "./bank-pages.js";

const QUERY_TIMEOUT_MS = 5000;
const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;
const MAX_FORM_BYTES = 64 * 1024;
// A linked account's transactions are fetched when the Banking page opens, at most this often.
const IMPORT_EVERY_MS = 6 * 60 * 60 * 1000;
const ID = "([A-Za-z0-9_-]{8,32})";
export const FINANCIAL_CONNECTIONS_SETTINGS = "https://dashboard.stripe.com/settings/financial-connections";

// ---------- What a transaction can be filed to ----------

export const JOB_COSTS = [["5200", "Materials"], ["5300", "Equipment rental"], ["5400", "Permits and fees"], ["5900", "Other job costs"]];
export const OVERHEAD = [
  ["6300", "Advertising and marketing"], ["6310", "Vehicles and fuel"], ["6320", "Insurance"],
  ["6330", "Office supplies and software"], ["6340", "Phone and internet"], ["6350", "Rent and utilities"],
  ["6360", "Legal and accounting"], ["6370", "Business licenses and dues"], ["6380", "Tools and small equipment"],
  ["6390", "Bank and card fees"], ["6400", "Meals"], ["6410", "Travel"], ["6420", "Payroll taxes"],
  ["6430", "Training and education"], ["6440", "Repairs and maintenance"], ["6490", "Other overhead"]
];
// direction: in (money in only), out (money out only) or both. account null posts nothing.
export const SPECIAL = {
  "stripe-payout": { name: "Stripe payout", account: "1200", direction: "in" },
  "client-deposit": { name: "Client payment deposited (check or cash)", account: "1300", direction: "in" },
  "other-income": { name: "Other income", account: "4300", direction: "in" },
  "owner-contribution": { name: "Owner contribution", account: "3000", direction: "in" },
  "owner-draw": { name: "Owner draw", account: "3100", direction: "out" },
  payroll: { name: "Payroll run", account: "2300", direction: "out" },
  transfer: { name: "Transfer between accounts", account: "1900", direction: "both" },
  recorded: { name: "Already in the books (posts nothing)", account: null, direction: "both" }
};

const direction = (amountCents) => (amountCents < 0 ? "out" : "in");
// amountCents null (the Banking page's File checked list) fits anything.
const fits = (entry, amountCents) => amountCents === null || entry.direction === "both" || entry.direction === direction(amountCents);

// Crew work a withdrawal of this amount could pay: approved and not paid yet, or paid by hand
// (not through payroll) and not matched to the bank yet.
function payableLabor(labor, amountCents) {
  if (amountCents === null || amountCents >= 0) return [];
  return labor.filter((entry) => entry.amountCents === -amountCents
    && (entry.status === "approved" || (entry.status === "paid" && entry.payment?.source !== "bank" && entry.payment?.method !== "payroll")));
}

// Job expenses recorded by hand, paid from this bank account, that a withdrawal of this amount
// could be: not matched to another transaction yet.
function payableExpenses(expenses, { amountCents, ledger }) {
  if (amountCents === null || amountCents >= 0) return [];
  return expenses.filter((expense) => expense.amountCents === -amountCents && !expense.bankTransactionId
    && expense.paidWith?.key?.startsWith("account:") && (!ledger || expense.paidWith.account === ledger));
}

function expenseName(expense, clients) {
  const what = expense.vendor || expense.description;
  if (!expense.clientSlug) return `Overhead expense · ${what}`;
  const client = clients.find((entry) => entry.slug === expense.clientSlug);
  return `Expense on ${client ? client.label || client.name : expense.clientSlug} · ${what}`;
}

// What `value` files the transaction to: { target, account, clientSlug, laborId, expenseId, name },
// or null when it does not fit (a job that is gone, money in filed as a payroll run...). An
// expense recorded by hand is already in the books, so matching it posts nothing (account null).
export function resolveTarget(value, { clients, labor, amountCents, expenses = [], ledger = null }) {
  const target = String(value || "");
  const expenseMatch = target.match(/^expense:([A-Za-z0-9_-]{8,32})$/u);
  if (expenseMatch) {
    const expense = payableExpenses(expenses, { amountCents, ledger }).find((candidate) => candidate.id === expenseMatch[1]);
    return expense ? { target, account: null, clientSlug: null, expenseId: expense.id, name: expenseName(expense, clients) } : null;
  }
  const job = target.match(/^job:([a-z0-9-]{1,64}):(\d{4})$/u);
  if (job) {
    const client = clients.find((entry) => entry.slug === job[1]);
    const cost = JOB_COSTS.find(([code]) => code === job[2]);
    return client && cost ? { target, account: cost[0], clientSlug: client.slug, name: `${client.label || client.name} · ${cost[1]}` } : null;
  }
  const overhead = target.match(/^overhead:(\d{4})$/u);
  if (overhead) {
    const category = OVERHEAD.find(([code]) => code === overhead[1]);
    return category ? { target, account: category[0], clientSlug: null, name: `Overhead · ${category[1]}` } : null;
  }
  const crew = target.match(/^labor:([A-Za-z0-9_-]{8,32})$/u);
  if (crew) {
    const entry = payableLabor(labor, amountCents).find((candidate) => candidate.id === crew[1]);
    return entry ? { target, account: entry.kind === "hours" ? "2300" : "2000", clientSlug: null, laborId: entry.id, name: `Pays ${laborLabel(entry)}` } : null;
  }
  const special = Object.hasOwn(SPECIAL, target) ? SPECIAL[target] : null;
  return special && fits(special, amountCents) ? { target, account: special.account, clientSlug: null, name: special.name } : null;
}

// The choices for a transaction's File to list, grouped.
export function targetGroups({ clients, labor, amountCents, expenses = [], ledger = null }) {
  const groups = [];
  const recorded = payableExpenses(expenses, { amountCents, ledger });
  if (recorded.length) groups.push({ label: "Recorded expenses", options: recorded.map((expense) => [`expense:${expense.id}`, `${expenseName(expense, clients)} · ${expense.spentOn}`]) });
  groups.push({ label: "Common", options: Object.entries(SPECIAL).filter(([, entry]) => fits(entry, amountCents)).map(([value, entry]) => [value, entry.name]) });
  const crew = payableLabor(labor, amountCents);
  if (crew.length) groups.push({ label: "Pay crew", options: crew.map((entry) => [`labor:${entry.id}`, `${laborLabel(entry)} · ${money(entry.amountCents)}${entry.status === "paid" ? " (paid by hand)" : ""}`]) });
  for (const client of clients) {
    const job = client.label || client.name;
    groups.push({ label: job, options: JOB_COSTS.map(([code, name]) => [`job:${client.slug}:${code}`, `${job} · ${name}`]) });
  }
  groups.push({ label: "Overhead", options: OVERHEAD.map(([code, name]) => [`overhead:${code}`, name]) });
  return groups;
}

// ---------- Suggestions ----------

const NOISE = new Set("POS DEBIT CREDIT PURCHASE CARD CHECKCARD CHK VISA MC ACH WEB ONLINE RECURRING PMT DBT WITHDRAWAL PPD CCD WEBID DES INDN CO ENTRY DESCR ID SQ TST TRANSFER XFER TO FROM THE AND OF".split(" "));

// The first words that name who a transaction was with (not the store's town or number), for
// learning how each is filed.
export function merchantKey(description) {
  return String(description || "").toUpperCase().replace(/[^A-Z& ]+/gu, " ").split(/\s+/u)
    .filter((word) => word.length > 1 && !NOISE.has(word)).slice(0, 2).join(" ");
}

const RULES = [
  [/\bSTRIPE\b/u, "in", "stripe-payout"],
  [/MOBILE DEPOSIT|REMOTE DEPOSIT|CHECK DEPOSIT|DEPOSIT.*CHECK|BRANCH DEPOSIT|ATM DEPOSIT/u, "in", "client-deposit"],
  [/SHELL|SPEEDWAY|MARATHON|CITGO|EXXON|MOBIL\b|SUNOCO|\bBP\b|CASEY'?S|FUEL|GAS STATION/u, "out", "overhead:6310"],
  [/VERIZON|AT&T|\bATT\b|T-?MOBILE|COMCAST|XFINITY|SPECTRUM/u, "out", "overhead:6340"],
  [/INSURANCE|STATE FARM|PROGRESSIVE|GEICO|ALLSTATE|HARTFORD|AUTO-?OWNERS|NEXT INS/u, "out", "overhead:6320"],
  [/ADOBE|MICROSOFT|MSFT|INTUIT|QUICKBOOKS|DROPBOX|ZOOM\.US|GOOGLE \*?(GSUITE|WORKSPACE)|STAPLES|OFFICE ?DEPOT|OFFICEMAX/u, "out", "overhead:6330"],
  [/FACEBK|FACEBOOK|META ?ADS|GOOGLE ?ADS|YELP|ANGI\b|HOMEADVISOR|THUMBTACK|NEXTDOOR/u, "out", "overhead:6300"],
  [/SERVICE CHARGE|SERVICE FEE|MONTHLY FEE|MAINTENANCE FEE|OVERDRAFT|NSF|WIRE FEE|ATM FEE/u, "out", "overhead:6390"],
  [/EFTPS|IRS USATAXPYMT/u, "out", "overhead:6420"],
  [/HARBOR FREIGHT|NORTHERN TOOL/u, "out", "overhead:6380"],
  [/MCDONALD|SUBWAY|STARBUCKS|TIM HORTONS|WENDY'?S|BURGER|PIZZA|DOORDASH|GRUBHUB|RESTAURANT|CAFE/u, "out", "overhead:6400"],
  [/AIRLINES|DELTA AIR|SOUTHWEST|MARRIOTT|HILTON|HOLIDAY INN|HAMPTON INN|AIRBNB|\bUBER\b|\bLYFT\b/u, "out", "overhead:6410"]
];

// A suggested filing for each unfiled transaction: crew work of the same amount, how the same
// merchant was filed last time, or a common merchant.
export function suggestTargets(transactions, { clients, labor, filed, expenses = [] }) {
  const learned = new Map();
  for (const txn of filed) {
    const key = `${txn.merchant}|${direction(txn.amountCents)}`;
    if (txn.merchant && !learned.has(key) && txn.filed?.target && !txn.filed.target.startsWith("labor:")) learned.set(key, txn.filed.target);
  }
  const suggestions = new Map();
  for (const txn of transactions) {
    const context = { clients, labor, amountCents: txn.amountCents, expenses, ledger: txn.ledger };
    const candidates = [
      ...payableExpenses(expenses, { amountCents: txn.amountCents, ledger: txn.ledger }).map((expense) => `expense:${expense.id}`),
      ...payableLabor(labor, txn.amountCents).filter((entry) => entry.status === "approved").map((entry) => `labor:${entry.id}`),
      learned.get(`${txn.merchant}|${direction(txn.amountCents)}`),
      ...RULES.filter(([pattern, way]) => way === direction(txn.amountCents) && pattern.test(String(txn.description).toUpperCase())).map(([, , target]) => target)
    ].filter(Boolean);
    for (const candidate of candidates) {
      const resolved = resolveTarget(candidate, context);
      if (resolved) {
        suggestions.set(txn.id, resolved);
        break;
      }
    }
  }
  return suggestions;
}

// ---------- Statements ----------

function toCents(value) {
  let text = String(value || "").trim().replace(/[$,\s]/gu, "");
  let negative = false;
  if (/^\(.*\)$/u.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }
  const match = text.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/u) || text.match(/^()\.(\d{1,2})$/u);
  if (!match) return null;
  const cents = Number(match[1] || 0) * 100 + Number((match[2] || "").padEnd(2, "0"));
  return negative ? -cents : cents;
}

function toDate(value) {
  const text = String(value || "").trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/u);
  let year;
  let month;
  let day;
  if (match) [, year, month, day] = match;
  else if ((match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b/u))) [, month, day, year] = match;
  else if ((match = text.match(/^(\d{4})(\d{2})(\d{2})/u))) [, year, month, day] = match;
  else return null;
  if (String(year).length === 2) year = `20${year}`;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isValidDate(iso) ? iso : null;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, 300);
}

function csvRecords(text) {
  const records = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim())) records.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) records.push(row);
  return records;
}

function parseCsv(text, { outPositive = false } = {}) {
  const records = csvRecords(text);
  const headerIndex = records.findIndex((record) => record.some((cell) => /date/iu.test(cell)) && record.some((cell) => /amount|debit|credit|withdrawal|deposit/iu.test(cell)));
  if (headerIndex < 0) return { error: "No header row with a date and an amount was found." };
  const header = records[headerIndex].map((cell) => cell.trim().toLowerCase());
  const find = (...patterns) => {
    for (const pattern of patterns) {
      const index = header.findIndex((cell) => pattern.test(cell));
      if (index >= 0) return index;
    }
    return -1;
  };
  const date = find(/^post(ed|ing)? date$/u, /^(transaction |trans\.? )?date$/u, /date/u);
  const description = find(/^description$/u, /description/u, /payee|merchant|^name$|memo|details/u);
  const amount = find(/^amount$/u, /amount/u);
  const debit = find(/debit|withdrawal|money out/u);
  const credit = find(/credit|deposit|money in/u);
  if (date < 0 || (amount < 0 && debit < 0 && credit < 0)) return { error: "The file needs a date column and an amount (or debit and credit) column." };
  const rows = [];
  for (const record of records.slice(headerIndex + 1)) {
    const postedOn = toDate(record[date]);
    let cents = null;
    if (amount >= 0 && String(record[amount] || "").trim()) {
      cents = toCents(record[amount]);
      if (cents !== null && outPositive) cents = -cents;
    } else {
      const out = debit >= 0 ? toCents(record[debit]) : null;
      const into = credit >= 0 ? toCents(record[credit]) : null;
      if (out) cents = -Math.abs(out);
      else if (into) cents = Math.abs(into);
    }
    if (!postedOn || !cents) continue;
    rows.push({ postedOn, amountCents: cents, description: cleanText(description >= 0 ? record[description] : "") || "Bank transaction", status: "posted" });
  }
  return { rows };
}

function parseOfx(text) {
  const tag = (block, name) => block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, "iu"))?.[1]?.trim() || "";
  const rows = [];
  for (const block of text.split(/<STMTTRN>/iu).slice(1).map((part) => part.split(/<\/STMTTRN>/iu)[0])) {
    const postedOn = toDate(tag(block, "DTPOSTED"));
    const cents = toCents(tag(block, "TRNAMT"));
    if (!postedOn || !cents) continue;
    const name = cleanText(tag(block, "NAME"));
    const memo = cleanText(tag(block, "MEMO"));
    rows.push({
      externalId: tag(block, "FITID").slice(0, 100) || null,
      postedOn,
      amountCents: cents,
      description: cleanText([name, memo && memo !== name ? memo : ""].filter(Boolean).join(" · ")) || "Bank transaction",
      status: "posted"
    });
  }
  const accountId = tag(text, "ACCTID");
  return { rows, last4: accountId ? accountId.slice(-4) : "", credit: /<CCSTMTRS>/iu.test(text) };
}

// A statement file's transactions, each with an id that stays the same when an overlapping
// statement is uploaded again (the bank's FITID, or a hash of the row and its repeat count).
export function parseStatement(text, { outPositive = false } = {}) {
  const content = String(text || "").replace(/^﻿/u, "");
  const parsed = /<OFX>|OFXHEADER/iu.test(content) ? parseOfx(content) : parseCsv(content, { outPositive });
  if (parsed.error) return parsed;
  if (!parsed.rows.length) return { error: "No transactions were found in that file." };
  const seen = new Map();
  for (const row of parsed.rows) {
    const key = `${row.postedOn}|${row.amountCents}|${row.description}`;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (!row.externalId) row.externalId = `h:${createHash("sha256").update(`${key}|${count}`).digest("hex").slice(0, 40)}`;
  }
  return parsed;
}

// ---------- Accounts and transactions ----------

function data(row) {
  if (!row) return null;
  return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
}

export async function listBankAccounts(store) {
  const rows = await store.db("mhb_bank_accounts").orderBy("created_at").select("data").timeout(QUERY_TIMEOUT_MS);
  return rows.map(data);
}

async function putBankAccount(store, account) {
  const row = { id: account.id, source: account.source, stripe_account_id: account.stripeAccountId || null, data: JSON.stringify(account) };
  await store.db("mhb_bank_accounts").insert(row).onConflict("id").merge({ ...row, updated_at: store.db.fn.now() }).timeout(QUERY_TIMEOUT_MS);
}

// The books account a new bank account posts to: 1000 Business checking for the first, then
// 1010, 1020... (or 2010, 2020... for a credit card), added to the chart with its name.
async function assignLedger(store, { name, credit }) {
  const used = new Set((await listBankAccounts(store)).map((account) => account.ledger));
  if (!credit && !used.has("1000")) return "1000";
  const base = credit ? 2010 : 1010;
  for (let code = base; code < base + 90; code += 10) {
    if (used.has(String(code))) continue;
    await store.db("mhb_accounts").insert({ code: String(code), name: name.slice(0, 80), type: credit ? "liability" : "asset", sort: credit ? 36 : 6 }).onConflict("code").ignore().timeout(QUERY_TIMEOUT_MS);
    return String(code);
  }
  throw new Error("too many bank accounts");
}

function toTransaction(row) {
  const saved = data(row);
  const postedOn = row.posted_on instanceof Date ? row.posted_on.toISOString().slice(0, 10) : String(row.posted_on).slice(0, 10);
  return { ...saved, id: row.id, accountId: row.account_id, externalId: row.external_id, postedOn, amountCents: Number(row.amount_cents), status: row.status };
}

const TXN_COLUMNS = ["id", "account_id", "external_id", "amount_cents", "status", "target", "data"];
function txnQuery(store) {
  return store.db("mhb_bank_transactions").select(...TXN_COLUMNS, store.db.raw("to_char(posted_on, 'YYYY-MM-DD') AS posted_on"));
}

async function getTransaction(store, id) {
  const row = await txnQuery(store).where({ id }).first().timeout(QUERY_TIMEOUT_MS);
  return row ? toTransaction(row) : null;
}

async function putTransaction(store, txn) {
  const { id, accountId, externalId, postedOn, amountCents, status, ...rest } = txn;
  const row = { id, account_id: accountId, external_id: externalId, posted_on: postedOn, amount_cents: amountCents, status, target: txn.filed?.target || null, data: JSON.stringify(rest) };
  await store.db("mhb_bank_transactions").insert(row).onConflict("id").merge({ ...row, updated_at: store.db.fn.now() }).timeout(QUERY_TIMEOUT_MS);
}

// Adds new transactions and updates changed ones (a pending one posting, or voided). A filed
// transaction that changes is brought up to date in the books.
async function importRows(store, account, rows, source) {
  let added = 0;
  let updated = 0;
  for (let start = 0; start < rows.length; start += 200) {
    const chunk = rows.slice(start, start + 200);
    const existing = new Map((await txnQuery(store).where({ account_id: account.id }).whereIn("external_id", chunk.map((row) => row.externalId)).timeout(QUERY_TIMEOUT_MS)).map((row) => [row.external_id, toTransaction(row)]));
    const fresh = [];
    for (const row of chunk) {
      const before = existing.get(row.externalId);
      if (!before) {
        fresh.push({
          id: randomId(12), accountId: account.id, externalId: row.externalId, postedOn: row.postedOn, amountCents: row.amountCents, status: row.status,
          description: row.description, merchant: merchantKey(row.description), transactedAt: row.transactedAt || null,
          ledger: account.ledger, source, filed: null, importedAt: new Date().toISOString()
        });
        continue;
      }
      if (before.status === row.status && before.amountCents === row.amountCents && before.postedOn === row.postedOn && before.description === row.description) continue;
      const changed = { ...before, status: row.status, amountCents: row.amountCents, postedOn: row.postedOn, description: row.description, merchant: merchantKey(row.description) };
      await putTransaction(store, changed);
      if (changed.filed) await record(store, { actor: "system", action: "bank.changed", summary: `The bank updated ${changed.description} (${money(Math.abs(changed.amountCents))}, ${changed.status})`, bank: changed, data: { transactionId: changed.id } });
      updated += 1;
    }
    for (const txn of fresh) {
      const { id, accountId, externalId, postedOn, amountCents, status, ...rest } = txn;
      await store.db("mhb_bank_transactions").insert({ id, account_id: accountId, external_id: externalId, posted_on: postedOn, amount_cents: amountCents, status, target: null, data: JSON.stringify(rest) }).onConflict(["account_id", "external_id"]).ignore().timeout(QUERY_TIMEOUT_MS);
      added += 1;
    }
  }
  return { added, updated };
}

function michiganDay(unixSeconds) {
  return Number.isInteger(unixSeconds) ? todayInMichigan(new Date(unixSeconds * 1000)) : null;
}

// Stripe's transactions for a linked account. A negative amount is money out.
async function importFromStripe(env, store, account) {
  const found = await listBankTransactions(env, account.stripeAccountId);
  const rows = found
    .filter((txn) => typeof txn.id === "string" && Number.isInteger(txn.amount) && txn.amount !== 0)
    .map((txn) => ({
      externalId: txn.id,
      postedOn: michiganDay(txn.status_transitions?.posted_at) || michiganDay(txn.transacted_at) || todayInMichigan(),
      amountCents: txn.amount,
      status: ["posted", "pending", "void"].includes(txn.status) ? txn.status : "pending",
      description: cleanText(txn.description) || "Bank transaction",
      transactedAt: Number.isInteger(txn.transacted_at) ? new Date(txn.transacted_at * 1000).toISOString() : null
    }));
  const result = await importRows(store, account, rows, "stripe");
  await putBankAccount(store, { ...account, lastImportAt: new Date().toISOString(), lastImportError: "" });
  return result;
}

async function importStale(env, store, accounts) {
  for (const account of accounts) {
    if (account.source !== "stripe" || account.status !== "active" || !stripeConfigured(env)) continue;
    if (account.lastImportAt && Date.now() - Date.parse(account.lastImportAt) < IMPORT_EVERY_MS) continue;
    try {
      await importFromStripe(env, store, account);
    } catch (error) {
      await putBankAccount(store, { ...account, lastImportAt: new Date().toISOString(), lastImportError: error instanceof Error ? error.message : "Stripe could not be reached" });
    }
  }
}

// ---------- Filing ----------

// Files `txn` to `resolved` (from resolveTarget), or unfiles it (null), keeping crew work it pays
// in step: work filed from the bank is paid from the bank; unfiled, it goes back to how it was.
async function fileTransaction(store, txn, resolved, { ip = null } = {}) {
  const was = txn.filed;
  if ((was?.target || null) === (resolved?.target || null)) return txn;
  if (was?.laborId) {
    const entry = await getLabor(store, was.laborId);
    if (entry?.payment?.bankTransactionId === txn.id) {
      const restored = was.laborBefore ? { ...entry, status: "paid", payment: was.laborBefore } : { ...entry, status: "approved", payment: null };
      await putLabor(store, restored);
      await record(store, { actor: "admin", ip, action: "labor.bank-unmatched", clientSlug: restored.clientSlug || null, reason: "payment-removed", labor: restored, summary: `${laborLabel(entry)} is no longer paid by the bank transaction ${txn.description}`, data: { laborId: entry.id, transactionId: txn.id } });
    }
  }
  // An expense it was matched to is free to be matched again.
  if (was?.expenseId) {
    const expense = await getExpense(store, null, was.expenseId);
    if (expense?.bankTransactionId === txn.id) await putExpense(store, { ...expense, bankTransactionId: null });
  }
  if (resolved?.expenseId) {
    const expense = await getExpense(store, null, resolved.expenseId);
    if (expense) await putExpense(store, { ...expense, bankTransactionId: txn.id });
  }
  let filed = resolved ? { ...resolved, filedAt: new Date().toISOString() } : null;
  if (resolved?.laborId) {
    const entry = await getLabor(store, resolved.laborId);
    const before = entry.status === "paid" ? entry.payment : null;
    filed = { ...filed, laborBefore: before };
    const paid = {
      ...entry,
      status: "paid",
      payment: { ...(before || { method: "bank", methodName: "", reference: "" }), source: "bank", paidOn: before?.paidOn || txn.postedOn, bankTransactionId: txn.id, recordedAt: new Date().toISOString() }
    };
    await putLabor(store, paid);
    await record(store, { actor: "admin", ip, action: "labor.bank-paid", clientSlug: paid.clientSlug || null, amountCents: paid.amountCents, labor: paid, summary: `${laborLabel(entry)} paid by the bank transaction ${txn.description} on ${txn.postedOn}`, data: { laborId: entry.id, transactionId: txn.id } });
  }
  const updated = { ...txn, filed };
  await putTransaction(store, updated);
  await record(store, {
    actor: "admin", ip, action: filed ? "bank.filed" : "bank.unfiled", clientSlug: filed?.clientSlug || was?.clientSlug || null, amountCents: Math.abs(txn.amountCents),
    summary: filed ? `Filed ${txn.description} (${txn.amountCents < 0 ? "−" : "+"}${money(Math.abs(txn.amountCents))}, ${txn.postedOn}) to ${filed.name}` : `Unfiled ${txn.description} (${money(Math.abs(txn.amountCents))}, ${txn.postedOn})`,
    bank: updated, data: { transactionId: txn.id }
  });
  return updated;
}

// Deleting an expense matched to a bank transaction unfiles that transaction (handler.js).
export async function unfileExpenseMatch(store, expense, { ip = null } = {}) {
  const txn = expense.bankTransactionId ? await getTransaction(store, expense.bankTransactionId) : null;
  if (!txn || txn.filed?.expenseId !== expense.id) return false;
  await fileTransaction(store, txn, null, { ip });
  return true;
}

// Mark unpaid on crew work paid from the bank unfiles that bank transaction (labor.js's Labor page).
export async function unfileLaborPayment(store, entry, { ip = null } = {}) {
  const txn = entry.payment?.bankTransactionId ? await getTransaction(store, entry.payment.bankTransactionId) : null;
  if (!txn || txn.filed?.laborId !== entry.id) return false;
  await fileTransaction(store, txn, null, { ip });
  return true;
}

// ---------- The Banking page ----------

const BANK_NOTICES = {
  "bank-linked": { text: "Bank account linked. Stripe sends its transactions within a few minutes; Refresh brings in the newest." },
  "bank-link-incomplete": { text: "The bank link was not finished, so nothing changed.", tone: "info" },
  filed: { text: "Filed. It's in the books." },
  unfiled: { text: "Unfiled. It's back under To file." },
  refreshed: { text: "Stripe is refreshing the transactions. New ones appear here within a few minutes." },
  "refresh-waiting": { text: "Stripe is still finishing its last refresh. Try again in a few minutes.", tone: "info" },
  disconnected: { text: "Disconnected. Its transactions stay here and in the books." },
  "target-invalid": { text: "That does not fit this transaction (money in or out, or its amount), so it was not filed.", tone: "error" },
  "statement-empty": { text: "Choose a statement file to upload.", tone: "error" },
  invalid: { text: "Please check the form and try again.", tone: "error" }
};

function bankNotice(url) {
  const code = url.searchParams.get("notice");
  const count = Number(url.searchParams.get("n") || 0);
  if (code === "filed-many") return { text: `Filed ${count} transaction${count === 1 ? "" : "s"}. They're in the books.` };
  if (code === "statement-imported") {
    const skipped = Number(url.searchParams.get("skipped") || 0);
    return { text: `Imported ${count} new transaction${count === 1 ? "" : "s"}${skipped ? `; ${skipped} already here were skipped` : ""}.` };
  }
  return BANK_NOTICES[code] || null;
}

async function bankPage(context, store, url, { status = null, code = 200 } = {}) {
  const env = context.env;
  let accounts = await listBankAccounts(store);
  await importStale(env, store, accounts);
  accounts = await listBankAccounts(store);
  const [clients, labor, expenses, unfiledRows, filedRows, counts] = await Promise.all([
    listClients(store),
    listLabor(store, { statuses: ["approved", "paid"] }),
    listAllExpenses(store),
    txnQuery(store).whereNull("target").whereNot({ status: "void" }).orderBy([{ column: "posted_on", order: "desc" }, { column: "created_at", order: "desc" }]).limit(300).timeout(QUERY_TIMEOUT_MS),
    txnQuery(store).whereNotNull("target").orderBy([{ column: "posted_on", order: "desc" }, { column: "updated_at", order: "desc" }]).limit(400).timeout(QUERY_TIMEOUT_MS),
    store.db("mhb_bank_transactions").select("account_id", store.db.raw("count(*) AS total"), store.db.raw("sum(CASE WHEN target IS NULL AND status <> 'void' THEN 1 ELSE 0 END) AS unfiled")).groupBy("account_id").timeout(QUERY_TIMEOUT_MS)
  ]);
  const active = clients.filter((client) => client.active !== false);
  const toFile = unfiledRows.map(toTransaction);
  const filed = filedRows.map(toTransaction);
  const suggestions = suggestTargets(toFile, { clients: active, labor, filed, expenses });
  return context.kit.scriptedHtmlResponse(adminBankPage({
    accounts, toFile, filed: filed.slice(0, 100), suggestions, settingsUrl: FINANCIAL_CONNECTIONS_SETTINGS,
    groupsFor: (amountCents, ledger = null) => targetGroups({ clients: active, labor, amountCents, expenses, ledger }),
    counts: new Map(counts.map((row) => [row.account_id, { total: Number(row.total), unfiled: Number(row.unfiled) }])),
    stripeReady: stripeConfigured(env), status: status || bankNotice(url)
  }), code);
}

async function startLink(context, store, url) {
  const { env, kit } = context;
  if (!stripeConfigured(env)) return bankPage(context, store, url, { status: { text: "Stripe is not set up for the portal, so a bank account cannot be linked yet. Upload a statement instead.", tone: "error" }, code: 400 });
  try {
    let settings = (await getSetting(store, "bank")) || {};
    if (!settings.customerId) {
      const customer = await createBooksCustomer(env);
      settings = { ...settings, customerId: customer.id };
      await putSetting(store, "bank", settings);
    }
    const session = await createBankLinkSession(env, {
      customerId: settings.customerId,
      successUrl: `${url.origin}/clients/admin/bank/linked?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${url.origin}/clients/admin/bank?notice=bank-link-incomplete`
    });
    await record(store, { actor: "admin", ip: kit.requestIp(context.request), action: "bank.link-started", summary: "Started linking a bank account through Stripe" });
    return kit.redirectResponse(session.url);
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Stripe request failed: /u, "") : "Stripe could not be reached";
    // Shown as the page's notice with a 200: Cloudflare replaces a 502 with its own error page.
    console.error(JSON.stringify({ message: "stripe bank link refused", error: message }));
    return bankPage(context, store, url, { status: { text: `Stripe did not open the bank link: ${message}`, tone: "error", link: FINANCIAL_CONNECTIONS_SETTINGS } });
  }
}

async function finishLink(context, store, url) {
  const { env, kit } = context;
  const sessionId = String(url.searchParams.get("session_id") || "");
  if (!/^cs_[A-Za-z0-9_]+$/u.test(sessionId) || !stripeConfigured(env)) return kit.redirectResponse("/clients/admin/bank?notice=bank-link-incomplete");
  let found;
  try {
    found = await linkedBankAccount(env, sessionId);
  } catch (error) {
    return bankPage(context, store, url, { status: { text: `Stripe could not confirm the bank link: ${error instanceof Error ? error.message.replace(/^Stripe request failed: /u, "") : "try again"}`, tone: "error" } });
  }
  if (!found) return kit.redirectResponse("/clients/admin/bank?notice=bank-link-incomplete");
  const accounts = await listBankAccounts(store);
  let account = accounts.find((entry) => entry.stripeAccountId === found.id);
  const credit = found.category === "credit";
  const name = cleanText(found.display_name || [found.institution_name, found.subcategory?.replaceAll("_", " ")].filter(Boolean).join(" ")) || "Bank account";
  if (!account) {
    account = {
      id: randomId(12), source: "stripe", stripeAccountId: found.id, name, institution: cleanText(found.institution_name), last4: String(found.last4 || ""),
      category: credit ? "credit" : "cash", status: "active", createdAt: new Date().toISOString(), lastImportAt: null, lastImportError: ""
    };
    account.ledger = await assignLedger(store, { name: `${name}${account.last4 ? ` ••${account.last4}` : ""}`, credit });
  } else {
    account = { ...account, status: "active" };
  }
  await putBankAccount(store, account);
  await record(store, { actor: "admin", ip: kit.requestIp(context.request), action: "bank.linked", summary: `Linked ${account.name}${account.last4 ? ` ••${account.last4}` : ""} through Stripe` });
  try {
    await subscribeBankTransactions(env, found.id);
    await importFromStripe(env, store, account);
  } catch (error) {
    await putBankAccount(store, { ...account, lastImportError: error instanceof Error ? error.message : "Stripe could not be reached" });
  }
  return kit.redirectResponse("/clients/admin/bank?notice=bank-linked");
}

async function uploadStatement(context, store, url) {
  const { kit } = context;
  const form = await readBoundedMultipart(context.request, MAX_STATEMENT_BYTES + 8192);
  const file = form?.get("file");
  if (!file || typeof file.text !== "function" || !file.size) return kit.redirectResponse("/clients/admin/bank?notice=statement-empty");
  if (file.size > MAX_STATEMENT_BYTES) return bankPage(context, store, url, { status: { text: "Statement files can be up to 5 MB.", tone: "error" }, code: 400 });
  const parsed = parseStatement(await file.text(), { outPositive: form.get("sign") === "out-positive" });
  if (parsed.error) return bankPage(context, store, url, { status: { text: `${parsed.error} Use your bank's CSV, OFX or QFX download.`, tone: "error" }, code: 400 });

  const accounts = await listBankAccounts(store);
  let account = accounts.find((entry) => entry.id === String(form.get("account") || "") && entry.source === "statement");
  if (!account) {
    const credit = form.get("kind") === "credit" || Boolean(parsed.credit);
    const typed = cleanText(form.get("name")).slice(0, 60);
    const name = typed || (credit ? "Business credit card" : "Business checking");
    account = { id: randomId(12), source: "statement", name, institution: "", last4: parsed.last4 || "", category: credit ? "credit" : "cash", status: "active", createdAt: new Date().toISOString() };
    account.ledger = await assignLedger(store, { name: `${name}${account.last4 ? ` ••${account.last4}` : ""}`, credit });
    await putBankAccount(store, account);
  }
  const { added } = await importRows(store, account, parsed.rows, "statement");
  await putBankAccount(store, { ...account, lastImportAt: new Date().toISOString() });
  await record(store, { actor: "admin", ip: kit.requestIp(context.request), action: "bank.statement-uploaded", summary: `Uploaded a statement for ${account.name}: ${added} new transaction${added === 1 ? "" : "s"} of ${parsed.rows.length}` });
  return kit.redirectResponse(`/clients/admin/bank?notice=statement-imported&n=${added}&skipped=${parsed.rows.length - added}`);
}

async function filingContext(store) {
  const [clients, labor, expenses] = await Promise.all([listClients(store), listLabor(store, { statuses: ["approved", "paid"] }), listAllExpenses(store)]);
  return { clients: clients.filter((client) => client.active !== false), labor, expenses };
}

async function fileOne(context, store, txn, value, { clients, labor, expenses }) {
  if (!value) {
    await fileTransaction(store, txn, null, { ip: context.kit.requestIp(context.request) });
    return "unfiled";
  }
  const resolved = resolveTarget(value, { clients, labor, amountCents: txn.amountCents, expenses, ledger: txn.ledger });
  if (!resolved) return "target-invalid";
  await fileTransaction(store, txn, resolved, { ip: context.kit.requestIp(context.request) });
  return "filed";
}

// Only reached with an admin session (handler.js checks it).
export async function handleAdminBank(context, store, pathname, url) {
  const { kit, env } = context;
  const method = context.request.method;
  const isRead = method === "GET" || method === "HEAD";

  if (pathname === "/clients/admin/bank") {
    if (!isRead) return kit.methodNotAllowedResponse(["GET", "HEAD"]);
    return bankPage(context, store, url);
  }
  if (pathname === "/clients/admin/bank/link") {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    return startLink(context, store, url);
  }
  if (pathname === "/clients/admin/bank/linked") {
    if (!isRead) return kit.methodNotAllowedResponse(["GET", "HEAD"]);
    return finishLink(context, store, url);
  }
  if (pathname === "/clients/admin/bank/upload") {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    return uploadStatement(context, store, url);
  }
  // Files the checked transactions to one place.
  if (pathname === "/clients/admin/bank/file") {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const value = String(form?.get("target") || "");
    const ids = [...new Set((form?.getAll("ids") || []).map(String))].slice(0, 300);
    // Crew work and recorded expenses are matched one transaction at a time, from their own row.
    if (!value || !ids.length || value.startsWith("labor:") || value.startsWith("expense:")) return kit.redirectResponse("/clients/admin/bank?notice=invalid");
    const filing = await filingContext(store);
    let filed = 0;
    for (const id of ids) {
      const txn = /^[A-Za-z0-9_-]{8,32}$/u.test(id) ? await getTransaction(store, id) : null;
      if (txn && (await fileOne(context, store, txn, value, filing)) === "filed") filed += 1;
    }
    return kit.redirectResponse(filed ? `/clients/admin/bank?notice=filed-many&n=${filed}` : "/clients/admin/bank?notice=target-invalid");
  }

  const txnMatch = pathname.match(new RegExp(`^/clients/admin/bank/transactions/${ID}/file$`, "u"));
  if (txnMatch) {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    const txn = await getTransaction(store, txnMatch[1]);
    if (!txn) return kit.notFound();
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const result = await fileOne(context, store, txn, String(form?.get("target") || ""), await filingContext(store));
    return kit.redirectResponse(`/clients/admin/bank?notice=${result}`);
  }

  const accountMatch = pathname.match(new RegExp(`^/clients/admin/bank/accounts/${ID}/(refresh|disconnect)$`, "u"));
  if (accountMatch) {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    const account = (await listBankAccounts(store)).find((entry) => entry.id === accountMatch[1]);
    if (!account || account.source !== "stripe") return kit.notFound();
    if (accountMatch[2] === "disconnect") {
      try {
        await disconnectBankAccount(env, account.stripeAccountId);
      } catch {
        // Already disconnected in Stripe; the portal stops fetching either way.
      }
      await putBankAccount(store, { ...account, status: "disconnected" });
      await record(store, { actor: "admin", ip: kit.requestIp(context.request), action: "bank.disconnected", summary: `Disconnected ${account.name} from Stripe` });
      return kit.redirectResponse("/clients/admin/bank?notice=disconnected");
    }
    let waiting = false;
    try {
      await refreshBankTransactions(env, account.stripeAccountId);
    } catch {
      waiting = true;
    }
    try {
      await importFromStripe(env, store, account);
    } catch (error) {
      await putBankAccount(store, { ...account, lastImportError: error instanceof Error ? error.message : "Stripe could not be reached" });
    }
    return kit.redirectResponse(`/clients/admin/bank?notice=${waiting ? "refresh-waiting" : "refreshed"}`);
  }

  return kit.notFound();
}
