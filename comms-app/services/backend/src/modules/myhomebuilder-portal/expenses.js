// Job expenses: costs of a client portal's job recorded by hand from its panel (Add expense), such
// as materials bought with cash or a card, a permit fee, or an equipment rental. Table from
// 20261007_myhomebuilder_portal_expenses.js; books.js posts each one (expenseParts). A bank
// withdrawal for the same amount can be matched to it on the Banking page (bank.js), which then
// posts nothing more, so the cost is counted once.

const QUERY_TIMEOUT_MS = 5000;

// What an expense can be: the job cost accounts.
export const EXPENSE_CATEGORIES = [["5200", "Materials"], ["5300", "Equipment rental"], ["5400", "Permits and fees"], ["5900", "Other job costs"]];

export function categoryName(code) {
  return EXPENSE_CATEGORIES.find(([key]) => key === code)?.[1] || "Job cost";
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

function data(row) {
  if (!row) return null;
  return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
}

function toExpense(row) {
  const saved = data(row);
  const spentOn = row.spent_on instanceof Date ? row.spent_on.toISOString().slice(0, 10) : String(row.spent_on).slice(0, 10);
  return { ...saved, id: row.id, clientSlug: row.client_slug, spentOn, amountCents: Number(row.amount_cents) };
}

function expenseQuery(store) {
  return store.db("mhb_expenses").select("id", "client_slug", "amount_cents", "data", store.db.raw("to_char(spent_on, 'YYYY-MM-DD') AS spent_on"));
}

// Newest first; on the same day, the latest added first.
export async function listExpenses(store, slug) {
  const rows = await expenseQuery(store).where({ client_slug: slug }).orderBy([{ column: "spent_on", order: "desc" }, { column: "created_at", order: "desc" }]).timeout(QUERY_TIMEOUT_MS);
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
  const row = { id, client_slug: clientSlug, spent_on: spentOn, amount_cents: amountCents, data: JSON.stringify(rest) };
  await store.db("mhb_expenses").insert(row).onConflict("id").merge({ ...row, updated_at: store.db.fn.now() }).timeout(QUERY_TIMEOUT_MS);
}

export async function deleteExpense(store, id) {
  await store.db("mhb_expenses").where({ id }).del().timeout(QUERY_TIMEOUT_MS);
}
