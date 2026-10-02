// Quote and invoice math. Amounts are integer cents and quantities are parsed from text so totals never drift.

export const MAX_LINE_ITEMS = 40;
export const MAX_LINE_DESCRIPTION = 300;
export const MAX_TITLE = 140;
export const MAX_NOTES = 2000;
export const MAX_TEMPLATE_NAME = 80;
// Stripe's largest single USD charge ($999,999.99) and smallest ($0.50).
export const MAX_TOTAL_CENTS = 99999999;
export const MIN_INVOICE_CENTS = 50;

// Ways a payment arrives outside Stripe. For "other" the admin types the method's name.
export const PAYMENT_METHODS = {
  check: "Check",
  cash: "Cash",
  zelle: "Zelle",
  venmo: "Venmo",
  cashapp: "Cash App",
  paypal: "PayPal",
  bank: "Bank transfer (ACH)",
  wire: "Wire transfer",
  card: "Credit or debit card",
  money_order: "Money order",
  other: "Other"
};
export const MAX_METHOD_NAME = 60;
export const MAX_PAYMENT_REFERENCE = 80;
export const MAX_PAYMENT_NOTE = 200;

const MONEY_PATTERN = /^(-)?(\d{1,7})(?:\.(\d{1,2}))?$/u;
const QUANTITY_PATTERN = /^(\d{1,6})(?:\.(\d{1,2}))?$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function parseMoney(value, { allowNegative = false, allowZero = false } = {}) {
  if (typeof value !== "string") return null;
  const match = value.replaceAll(/[$,\s]/gu, "").match(MONEY_PATTERN);
  if (!match) return null;
  const [, minus, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (minus && !allowNegative) return null;
  if (cents === 0 && !allowZero) return null;
  return minus ? -cents : cents;
}

function parseQuantityHundredths(value) {
  const match = String(value).replaceAll(/[,\s]/gu, "").match(QUANTITY_PATTERN);
  if (!match) return null;
  const hundredths = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  return hundredths > 0 ? hundredths : null;
}

// Rounds half away from zero using integer math only.
function lineAmount(quantityHundredths, unitCents) {
  const product = quantityHundredths * unitCents;
  return Math.sign(product) * Math.floor((Math.abs(product) + 50) / 100);
}

export function quantityText(quantity) {
  return String(Number(Number(quantity).toFixed(2)));
}

export function moneyInput(cents) {
  if (!Number.isInteger(cents)) return "";
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

export function isValidDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

// Reads the repeated itemDescription / itemQuantity / itemUnitPrice fields of the line editor.
export function parseLineItems(form) {
  const descriptions = form.getAll("itemDescription");
  const quantities = form.getAll("itemQuantity");
  const prices = form.getAll("itemUnitPrice");
  const rows = Math.max(descriptions.length, quantities.length, prices.length);
  const lineItems = [];

  for (let index = 0; index < rows; index += 1) {
    const description = String(descriptions[index] || "").trim();
    const quantityValue = String(quantities[index] || "").trim();
    const priceValue = String(prices[index] || "").trim();
    if (!description && !priceValue) continue;

    const line = index + 1;
    if (!description) return { error: `Line ${line} needs a description.` };
    if (description.length > MAX_LINE_DESCRIPTION) return { error: `Line ${line} description is longer than ${MAX_LINE_DESCRIPTION} characters.` };
    const quantityHundredths = quantityValue ? parseQuantityHundredths(quantityValue) : 100;
    if (quantityHundredths === null) return { error: `Line ${line} quantity must be a positive number with up to 2 decimals.` };
    if (!priceValue) return { error: `Line ${line} needs a unit price. Use 0 for included items.` };
    const unitCents = parseMoney(priceValue, { allowNegative: true, allowZero: true });
    if (unitCents === null) return { error: `Line ${line} unit price is not a dollar amount.` };

    lineItems.push({
      description,
      quantity: quantityHundredths / 100,
      unitCents,
      amountCents: lineAmount(quantityHundredths, unitCents)
    });
  }

  if (!lineItems.length) return { error: "Add at least one line item." };
  if (lineItems.length > MAX_LINE_ITEMS) return { error: `Use ${MAX_LINE_ITEMS} line items or fewer.` };
  return { lineItems, totalCents: lineItems.reduce((sum, item) => sum + item.amountCents, 0) };
}

// Validates the shared quote/invoice/template editor. Returns the cleaned values or an error message.
export function parseBillingForm(form, { template = false } = {}) {
  const kind = form.get("kind") === "quote" ? "quote" : form.get("kind") === "invoice" ? "invoice" : null;
  const title = String(form.get("title") || "").trim();
  const description = String(form.get("description") || "").trim();
  const dueDate = String(form.get("dueDate") || "").trim();
  const issuedOn = String(form.get("issuedOn") || "").trim();
  const dueInDaysText = String(form.get("dueInDays") || "").trim();
  const name = String(form.get("templateName") || "").trim();
  // Create new beside Notes and terms: the name its text is saved under (handler.js).
  const notesTemplateName = String(form.get("notesTemplateName") || "").trim().replaceAll(/\s+/gu, " ").slice(0, MAX_TEMPLATE_NAME);

  const values = { kind: kind || "invoice", title, description, dueDate, issuedOn, dueInDays: dueInDaysText, templateName: name, notesTemplateName };
  const lines = form.has("amount") && !form.has("itemDescription") ? singleAmountLine(form.get("amount"), title) : parseLineItems(form);
  values.lineItems = lines.lineItems || rawLineItems(form);

  if (!kind) return { values, error: "Choose invoice or quote." };
  if (template && (!name || name.length > MAX_TEMPLATE_NAME)) return { values, error: `Give the template a name of ${MAX_TEMPLATE_NAME} characters or fewer.` };
  if (!title || title.length > MAX_TITLE) return { values, error: `Enter a title of ${MAX_TITLE} characters or fewer.` };
  if (description.length > MAX_NOTES) return { values, error: `Keep notes and terms under ${MAX_NOTES} characters.` };
  if (!template && dueDate && !isValidDate(dueDate)) return { values, error: "Enter a valid date." };
  if (!template && issuedOn && !isValidDate(issuedOn)) return { values, error: "Enter a valid date for the quote or invoice." };
  let dueInDays = null;
  if (template && dueInDaysText) {
    if (!/^\d{1,3}$/u.test(dueInDaysText)) return { values, error: "Days until due must be a whole number from 0 to 999." };
    dueInDays = Number(dueInDaysText);
  }
  if (lines.error) return { values, error: lines.error };
  if (lines.totalCents <= 0) return { values, error: "The total must be more than $0.00." };
  if (lines.totalCents > MAX_TOTAL_CENTS) return { values, error: "The total must be $999,999.99 or less. Split larger amounts into more than one invoice." };
  if (kind === "invoice" && lines.totalCents < MIN_INVOICE_CENTS) return { values, error: "Invoices must be at least $0.50 so they can be paid online." };

  return {
    values: {
      kind,
      title,
      description,
      dueDate: template ? "" : dueDate,
      issuedOn: template ? "" : issuedOn,
      dueInDays,
      templateName: name,
      notesTemplateName,
      lineItems: lines.lineItems,
      amountCents: lines.totalCents
    }
  };
}

// The admin form before line items posted one amount; it becomes a single line named after the title.
function singleAmountLine(amount, title) {
  const cents = parseMoney(String(amount || ""));
  if (cents === null) return { error: "Enter the amount as a dollar value, for example 12,500.00." };
  return { lineItems: [{ description: title || "Amount", quantity: 1, unitCents: cents, amountCents: cents }], totalCents: cents };
}

// Keeps what the admin typed so a rejected form can be shown again without losing work.
function rawLineItems(form) {
  const descriptions = form.getAll("itemDescription");
  const quantities = form.getAll("itemQuantity");
  const prices = form.getAll("itemUnitPrice");
  const rows = Math.min(Math.max(descriptions.length, quantities.length, prices.length), MAX_LINE_ITEMS + 5);
  const items = [];
  for (let index = 0; index < rows; index += 1) {
    const description = String(descriptions[index] || "").slice(0, MAX_LINE_DESCRIPTION);
    const quantity = String(quantities[index] || "").slice(0, 12);
    const price = String(prices[index] || "").slice(0, 16);
    if (description || price) items.push({ description, quantityInput: quantity, priceInput: price });
  }
  return items;
}

// Quotes and invoices created before line items existed carry a single amount.
export function billingLineItems(item) {
  if (Array.isArray(item.lineItems) && item.lineItems.length) return item.lineItems;
  return [{ description: item.title, quantity: 1, unitCents: item.amountCents, amountCents: item.amountCents }];
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Today's date in the builder's time zone, as YYYY-MM-DD.
export function todayInMichigan(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Detroit", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// The date a quote or invoice carries (YYYY-MM-DD): the one entered with it, or, for those saved
// before dates were entered, the day it was created in Michigan. Invoices are numbered in this order.
export function issuedDate(item) {
  return isValidDate(item?.issuedOn || "") ? item.issuedOn : todayInMichigan(new Date(item?.createdAt || Date.now()));
}

// Payments toward an invoice before it is paid off (a client paying down a bill), recorded by
// hand: item.installments, each { id, method, label, reference, amountCents, paidOn, ... }. The
// invoice stays open until they reach its total; the payment that settles the rest is
// item.payment, as for an invoice paid at once.
export function installmentsTotal(item) {
  return (item?.installments || []).reduce((sum, entry) => sum + (Number.isInteger(entry.amountCents) ? entry.amountCents : 0), 0);
}

// What is still owed: the total less every payment received (a paid invoice's settling payment
// covers the rest, unless Stripe charged less).
export function balanceDue(item) {
  const earlier = installmentsTotal(item);
  const settled = item?.status === "paid" ? (item.payment?.amountCents ?? item.amountCents - earlier) : 0;
  return Math.max(0, item.amountCents - earlier - settled);
}

// One Checkout line for what is due keeps Stripe's amount identical to the invoice's balance,
// including credits and fractional quantities that Checkout line items cannot express.
export function checkoutLine(item) {
  const names = billingLineItems(item).map((line) => line.description).join(", ");
  const partly = installmentsTotal(item) > 0;
  return {
    name: `${billingLabel(item)} · ${item.title}${partly ? " · balance due" : ""}`.slice(0, 250),
    description: names.length > 500 ? `${names.slice(0, 497)}...` : names,
    unitCents: balanceDue(item)
  };
}

// Invoices and quotes are numbered 1, 2, 3 … in their own sequences: no prefix, dash or leading zeros.
export function billingNumber(sequence) {
  return String(sequence);
}

// The name used wherever a number appears on its own: "Invoice 12", "Quote 3".
export function billingLabel(item) {
  return `${item.kind === "invoice" ? "Invoice" : "Quote"} ${item.number}`;
}

// Open and payable online: Stripe takes at least $0.50, so a smaller balance is recorded by hand.
export function isPayable(item) {
  return item.kind === "invoice" && item.status === "open" && balanceDue(item) >= MIN_INVOICE_CENTS;
}

// Open quotes and invoices can be edited, and so can paid invoices (to correct a title, a line
// or the notes). Void ones and bank payments still clearing cannot.
export function isEditable(item) {
  return item.status === "open" || (item.kind === "invoice" && item.status === "paid");
}

// Payments already received, listed on a new invoice's form (a deposit, earlier checks): rows of
// paymentAmount, paymentMethod, paymentMethodName (for Other), paymentPaidOn and paymentNote
// (paymentReference too, from forms before notes). Rows without an amount are skipped. Returns
// { payments, typed } or { error, typed } (typed: the rows as entered).
const LISTED_PAYMENT_PROBLEMS = {
  invalid: "Check each payment's method (up to 60 characters).",
  "payment-other-required": "Type the payment method for each payment marked Other.",
  "payment-date-invalid": "Enter the date each payment was received."
};
export function parseListedPayments(form) {
  const column = (name) => form.getAll(name).map((value) => String(value ?? ""));
  const methods = column("paymentMethod");
  const names = column("paymentMethodName");
  const references = column("paymentReference");
  const dates = column("paymentPaidOn");
  const notes = column("paymentNote");
  const typed = column("paymentAmount").map((amount, index) => ({
    amount: amount.trim(), method: methods[index] || "check", methodName: (names[index] || "").trim(), reference: (references[index] || "").trim(), paidOn: (dates[index] || "").trim(),
    note: (notes[index] || "").trim().replaceAll(/\s+/gu, " ")
  }));
  const payments = [];
  for (const row of typed) {
    if (!row.amount) continue;
    const amountCents = parseMoney(row.amount);
    if (!amountCents) return { error: "Enter each payment's amount, like 500 or 500.00.", typed };
    if (row.note.length > MAX_PAYMENT_NOTE) return { error: `Keep each payment's notes to ${MAX_PAYMENT_NOTE} characters.`, typed };
    const fields = new Map([["method", row.method], ["methodName", row.methodName], ["reference", row.reference], ["paidOn", row.paidOn]]);
    const entered = parseManualPayment({ get: (name) => fields.get(name) ?? "" });
    if (entered.error) return { error: LISTED_PAYMENT_PROBLEMS[entered.error] || LISTED_PAYMENT_PROBLEMS.invalid, typed };
    payments.push({ ...entered, amountCents, ...(row.note ? { note: row.note } : {}) });
  }
  return { payments, typed };
}

// Reads the record-payment and edit-payment forms. Returns the payment fields and the label shown
// on the invoice ("Zelle", "Check #1042", or the typed name for Other), or { error } with a notice code.
export function parseManualPayment(form) {
  const method = String(form?.get("method") || "");
  const methodName = String(form?.get("methodName") || "").trim().replaceAll(/\s+/gu, " ");
  const reference = String(form?.get("reference") || "").trim().replaceAll(/\s+/gu, " ");
  const paidOn = String(form?.get("paidOn") || "").trim();
  if (!Object.hasOwn(PAYMENT_METHODS, method)) return { error: "invalid" };
  if (method === "other" && !methodName) return { error: "payment-other-required" };
  if (methodName.length > MAX_METHOD_NAME || reference.length > MAX_PAYMENT_REFERENCE) return { error: "invalid" };
  if (!isValidDate(paidOn)) return { error: "payment-date-invalid" };
  const name = method === "other" ? methodName : PAYMENT_METHODS[method];
  return {
    method,
    methodName: method === "other" ? methodName : "",
    reference,
    paidOn,
    label: [name, reference].filter(Boolean).join(" ")
  };
}
