// Quote and invoice math. Amounts are integer cents and quantities are parsed from text so totals never drift.

export const MAX_LINE_ITEMS = 40;
export const MAX_LINE_DESCRIPTION = 300;
export const MAX_TITLE = 140;
export const MAX_NOTES = 2000;
export const MAX_TEMPLATE_NAME = 80;
// Stripe's largest single USD charge ($999,999.99) and smallest ($0.50).
export const MAX_TOTAL_CENTS = 99999999;
export const MIN_INVOICE_CENTS = 50;

export const PAYMENT_METHODS = {
  check: "Check",
  cash: "Cash",
  bank: "Bank transfer",
  other: "Other"
};

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
  const dueInDaysText = String(form.get("dueInDays") || "").trim();
  const name = String(form.get("templateName") || "").trim();

  const values = { kind: kind || "invoice", title, description, dueDate, dueInDays: dueInDaysText, templateName: name };
  const lines = form.has("amount") && !form.has("itemDescription") ? singleAmountLine(form.get("amount"), title) : parseLineItems(form);
  values.lineItems = lines.lineItems || rawLineItems(form);

  if (!kind) return { values, error: "Choose invoice or quote." };
  if (template && (!name || name.length > MAX_TEMPLATE_NAME)) return { values, error: `Give the template a name of ${MAX_TEMPLATE_NAME} characters or fewer.` };
  if (!title || title.length > MAX_TITLE) return { values, error: `Enter a title of ${MAX_TITLE} characters or fewer.` };
  if (description.length > MAX_NOTES) return { values, error: `Keep notes and terms under ${MAX_NOTES} characters.` };
  if (!template && dueDate && !isValidDate(dueDate)) return { values, error: "Enter a valid date." };
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
      dueInDays,
      templateName: name,
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

// One Checkout line for the invoice total keeps Stripe's amount identical to the invoice,
// including credits and fractional quantities that Checkout line items cannot express.
export function checkoutLine(item) {
  const names = billingLineItems(item).map((line) => line.description).join(", ");
  return {
    name: `${billingLabel(item)} · ${item.title}`.slice(0, 250),
    description: names.length > 500 ? `${names.slice(0, 497)}...` : names,
    unitCents: item.amountCents
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

export function isPayable(item) {
  return item.kind === "invoice" && item.status === "open";
}

export function isEditable(item) {
  return item.status === "open";
}
