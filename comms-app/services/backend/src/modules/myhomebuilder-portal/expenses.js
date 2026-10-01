// Expenses recorded by hand: a cost of a client portal's job (Add expense on its panel), such as
// materials bought with cash or a card, a permit fee, labor or the land, or overhead with no job
// (Add expense on the Books page). Tables from 20261007_myhomebuilder_portal_expenses.js and
// 20261009_myhomebuilder_portal_job_books.js; books.js posts each one (expenseParts). A bank
// withdrawal for the same amount can be matched to it on the Banking page (bank.js), which then
// posts nothing more, so the cost is counted once.

const QUERY_TIMEOUT_MS = 5000;

// The categories offered for a job's expenses and for overhead, each a books account. Any other
// category can be typed: it is kept as typed and posted to Other job costs (or Other overhead).
export const JOB_CATEGORIES = [
  ["5200", "Materials"], ["5000", "Labor"], ["5100", "Subcontractors"], ["5300", "Equipment rental"],
  ["5400", "Permits and fees"], ["5500", "Land"], ["5510", "House"], ["5520", "Commercial property"], ["5900", "Other job costs"]
];
export const OVERHEAD_CATEGORIES = [
  ["6300", "Advertising and marketing"], ["6310", "Vehicles and fuel"], ["6320", "Insurance"], ["6330", "Office supplies and software"],
  ["6340", "Phone and internet"], ["6350", "Rent and utilities"], ["6360", "Legal and accounting"], ["6370", "Business licenses and dues"],
  ["6380", "Tools and small equipment"], ["6390", "Bank and card fees"], ["6400", "Meals"], ["6410", "Travel"], ["6420", "Payroll taxes"],
  ["6430", "Training and education"], ["6440", "Repairs and maintenance"], ["6450", "Shop and overhead labor"], ["6490", "Other overhead"]
];
const OTHER_JOB_COSTS = "5900";
const OTHER_OVERHEAD = "6490";
const ALIASES = new Map([["job labor", "5000"], ["subcontractor", "5100"], ["permits", "5400"], ["permit", "5400"], ["equipment", "5300"], ["rental", "5300"], ["property", "5520"]]);
const MAX_CATEGORY = 60;

// What a typed or chosen category posts to: { code, name }. A known name (in any case) or account
// number is that account; anything else keeps its name under Other job costs, or Other overhead
// for an expense with no job. Null when it is too long.
export function resolveCategory(value, { overhead = false } = {}) {
  const typed = String(value || "").trim().replaceAll(/\s+/gu, " ");
  if (typed.length > MAX_CATEGORY) return null;
  const known = [...JOB_CATEGORIES, ...OVERHEAD_CATEGORIES];
  const byCode = known.find(([code]) => code === typed);
  if (byCode) return { code: byCode[0], name: byCode[1] };
  const lower = typed.toLowerCase();
  const byName = known.find(([, name]) => name.toLowerCase() === lower);
  if (byName) return { code: byName[0], name: byName[1] };
  if (ALIASES.has(lower)) {
    const code = ALIASES.get(lower);
    return { code, name: known.find(([key]) => key === code)[1] };
  }
  const fallback = overhead ? OTHER_OVERHEAD : OTHER_JOB_COSTS;
  return { code: fallback, name: typed || known.find(([key]) => key === fallback)[1] };
}

// The category an expense shows: its name as chosen or typed, or its account's.
export function categoryName(expense) {
  if (expense && typeof expense === "object" && expense.categoryName) return expense.categoryName;
  const code = typeof expense === "object" ? expense?.category : expense;
  return [...JOB_CATEGORIES, ...OVERHEAD_CATEGORIES].find(([key]) => key === code)?.[1] || "Job cost";
}

// What paid it: one of the business's bank accounts (its books account), the owner's own money
// (an owner contribution) or nothing yet (a bill to pay, in accounts payable). `accounts` are the
// Banking page's bank accounts; without any, Business checking.
export function paidWithOptions(accounts) {
  const banks = accounts.filter((account) => account.status !== "disconnected" && account.ledger)
    .map((account) => ({ key: `account:${account.ledger}`, account: account.ledger, label: `${account.name}${account.last4 ? ` ••${account.last4}` : ""}` }));
  if (!banks.some((option) => option.account === "1000")) banks.unshift({ key: "account:1000", account: "1000", label: "Business checking" });
  return [
    ...banks,
    { key: "personal", account: "3000", label: "The owner's own money" },
    { key: "unpaid", account: "2000", label: "Not paid yet (a bill to pay later)" }
  ];
}

// Who an expense can be paid to, for the Paid to suggestions: everyone in Labor (and their
// companies), then whoever earlier expenses were paid to, most recent first, without repeats.
export function paidToSuggestions({ workers = [], expenses = [] }) {
  const names = [];
  const seen = new Set();
  const add = (value) => {
    const name = String(value || "").trim();
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    names.push(name);
  };
  for (const worker of workers.filter((entry) => entry.active !== false)) {
    add(worker.name);
    add(worker.company);
  }
  const recent = expenses.slice().sort((left, right) => String(right.spentOn).localeCompare(String(left.spentOn)) || String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  for (const expense of recent) add(expense.vendor);
  return names.slice(0, 200);
}

function data(row) {
  if (!row) return null;
  return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
}

function toExpense(row) {
  const saved = data(row);
  const spentOn = row.spent_on instanceof Date ? row.spent_on.toISOString().slice(0, 10) : String(row.spent_on).slice(0, 10);
  return { ...saved, id: row.id, clientSlug: row.client_slug || null, spentOn, amountCents: Number(row.amount_cents) };
}

function expenseQuery(store) {
  return store.db("mhb_expenses").select("id", "client_slug", "amount_cents", "data", store.db.raw("to_char(spent_on, 'YYYY-MM-DD') AS spent_on"));
}

// Newest first; on the same day, the latest added first. No slug: the overhead expenses.
export async function listExpenses(store, slug) {
  const query = expenseQuery(store);
  if (slug) query.where({ client_slug: slug });
  else query.whereNull("client_slug");
  const rows = await query.orderBy([{ column: "spent_on", order: "desc" }, { column: "created_at", order: "desc" }]).timeout(QUERY_TIMEOUT_MS);
  return rows.map(toExpense);
}

export async function listAllExpenses(store) {
  return (await expenseQuery(store).timeout(QUERY_TIMEOUT_MS)).map(toExpense);
}

export async function getExpense(store, slug, id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,32}$/u.test(id)) return null;
  const row = await expenseQuery(store).where({ id, ...(slug ? { client_slug: slug } : {}) }).first().timeout(QUERY_TIMEOUT_MS);
  return row ? toExpense(row) : null;
}

export async function putExpense(store, expense) {
  const { id, clientSlug, spentOn, amountCents, ...rest } = expense;
  const row = { id, client_slug: clientSlug || null, spent_on: spentOn, amount_cents: amountCents, data: JSON.stringify(rest) };
  await store.db("mhb_expenses").insert(row).onConflict("id").merge({ ...row, updated_at: store.db.fn.now() }).timeout(QUERY_TIMEOUT_MS);
}

export async function deleteExpense(store, id) {
  await store.db("mhb_expenses").where({ id }).del().timeout(QUERY_TIMEOUT_MS);
}
