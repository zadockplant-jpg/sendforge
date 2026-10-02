// Export Client to PDF (the client portal page, and its right-click menu): a breakdown of every
// project in a client portal, clean enough to show investors or potential clients.
//
// - With `costs` (for investors): what each project invoiced and was paid, what is outstanding, its
//   payments, its costs by category and its gross profit and margin (books.js jobBook).
// - Without (for a potential client): each project's work and price, and nothing about payments,
//   balances, costs or profit.
// - With `photos`: up to six of each project's photos that its client portal shows (JPEG and PNG).
//
// Drawn with pdfkit's own fonts: no remote fetches and no user HTML. Client emails, logins,
// documents and the admin's notes are never in it.
import PDFDocument from "pdfkit";
import { balanceDue, billingLabel, billingLineItems, issuedDate, quantityText } from "./billing.js";
import { jobBook } from "./books.js";
import { formatDate, money } from "./format.js";
import { BUILDER_LICENSE, BUSINESS_ADDRESS, INSURANCE, photoDate } from "./pages.js";
import { getFile, listBilling, listPhotos } from "./store.js";

const PHOTOS_PER_PROJECT = 6;
// Photos go in as they are stored, so their bytes are capped for the whole PDF: small enough to
// email (attachments are limited to about 25 MB once encoded).
const PHOTO_BYTES = 15 * 1024 * 1024;

// US Letter, in points.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const SIDE = 54;
const TOP = 54;
const CONTINUED_TOP = 70;
const BOTTOM = 72;
const WIDTH = PAGE_WIDTH - SIDE * 2;

const INK = "#111111";
const SOFT = "#555555";
const FAINT = "#888888";
const RULE = "#DDDDDD";
const PANEL = "#F4F4F4";
const ACCENT = "#085858";
const DARK = "#00212B";
const LOSS = "#9D174D";

// The MB mark (the site's /assets/mb-logo.svg), drawn as its strokes.
const MARK_BOX = { x: 170, y: 95, width: 1250, height: 665, stroke: 108 };
const MARK_PATHS = [
  "M300 195 L345 205 L240 690",
  "M345 205 L500 480 L800 165",
  "M800 165 L680 650",
  "M1000 190 L900 645",
  "M1000 190 C1180 170 1380 190 1330 275 C1300 360 1120 380 965 385",
  "M965 385 C1150 385 1400 400 1345 500 C1290 600 1080 650 900 645"
];

// The characters pdfkit's own fonts print (Windows-1252). Anything else is written without its
// accents where that helps, or as "?", so no text comes out garbled.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
function printable(value) {
  return Array.from(String(value ?? "")).map((character) => {
    const code = character.codePointAt(0);
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(character)) return character;
    if (character === "\n" || character === "\t") return " ";
    const plain = character.normalize("NFKD").replaceAll(/[̀-ͯ]/gu, "");
    return plain && Array.from(plain).every((part) => part.codePointAt(0) >= 0x20 && part.codePointAt(0) <= 0x7e) ? plain : "?";
  }).join("");
}

const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);

// ---------- What goes in ----------

// Reads everything the PDF shows: each project's quotes and invoices (not void, and not a quote
// already made into an invoice, whose invoice carries its work), its job book with `costs`, and its
// photos with `photos`.
export async function clientBreakdown(store, { root, projects, costs = false, photos = false, today }) {
  let photoBytes = 0;
  const entries = [];
  for (const project of projects) {
    const billing = (await listBilling(store, project.slug))
      .filter((item) => item.status !== "void" && !(item.kind === "quote" && item.invoiceId))
      .sort((left, right) => issuedDate(left).localeCompare(issuedDate(right)) || String(left.createdAt).localeCompare(String(right.createdAt)));
    const book = costs ? await jobBook(store, project.slug) : null;
    const pictures = [];
    if (photos) {
      const shown = (await listPhotos(store, project.slug)).filter((photo) => !photo.hidden && /^image\/(jpeg|png)$/u.test(photo.file?.type || ""));
      for (const photo of shown.slice(0, PHOTOS_PER_PROJECT)) {
        if (photoBytes + (photo.file.size || 0) > PHOTO_BYTES) break;
        const file = await getFile(store, photo.file.key);
        if (!file) continue;
        photoBytes += file.size;
        pictures.push({ bytes: Buffer.from(file.body), note: photo.note || "", date: photoDate(photo) });
      }
    }
    entries.push({ project, billing, book, pictures, figures: figuresOf(billing, book) });
  }
  return { root, entries, costs, today };
}

// A project's money: invoiced, paid and outstanding as its list totals them, what open quotes
// add, and from its job book its gross income, gross expenses, gross profit and margin.
function figuresOf(billing, book) {
  const invoices = billing.filter((item) => item.kind === "invoice");
  const invoiced = sum(invoices, (item) => item.amountCents);
  const outstanding = sum(invoices, (item) => balanceDue(item));
  const income = book?.totals.income ?? 0;
  const expenses = book?.totals.expenses ?? 0;
  const profit = book?.totals.profit ?? 0;
  const dates = billing.map((item) => issuedDate(item)).filter(Boolean).sort();
  return {
    invoiced, outstanding, paid: invoiced - outstanding,
    quoted: sum(billing.filter((item) => item.kind === "quote"), (item) => item.amountCents),
    income, expenses, profit, since: dates[0] || ""
  };
}

function marginText(profit, income) {
  return income > 0 ? `${Math.round((profit / income) * 1000) / 10}%` : "—";
}

// ---------- The PDF ----------

export function breakdownPdf({ root, entries, costs, today }) {
  const doc = new PDFDocument({
    size: "LETTER", margins: { top: TOP, bottom: BOTTOM, left: SIDE, right: SIDE }, bufferPages: true,
    info: { Title: printable(`${root.name} · Project breakdown`), Author: "My Home Builder LLC", Subject: "Project breakdown", Creator: "My Home Builder client portal" }
  });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  let y = TOP;
  const bottom = PAGE_HEIGHT - BOTTOM;
  const style = ({ font = "Helvetica", size = 9, color = INK } = {}) => doc.font(font).fontSize(size).fillColor(color);
  const measure = (text, width, options = {}) => {
    style(options);
    return doc.heightOfString(printable(text), { width, lineGap: options.lineGap ?? 1.5, characterSpacing: options.spacing ?? 0 });
  };
  // Text at a place, within `width`: one line (cut short with an ellipsis) unless `wrap`.
  const put = (text, x, top, options = {}) => {
    style(options);
    doc.text(printable(text), x, top, {
      width: options.width, align: options.align || "left", lineGap: options.lineGap ?? 1.5, characterSpacing: options.spacing ?? 0,
      ...(options.wrap ? {} : { height: (options.size || 9) * 1.35, ellipsis: true })
    });
  };
  const line = (top, { color = RULE, width = 0.75, from = SIDE, to = SIDE + WIDTH } = {}) => {
    doc.moveTo(from, top).lineTo(to, top).lineWidth(width).strokeColor(color).stroke();
  };

  // Pages after the first carry a running header.
  const newPage = () => {
    doc.addPage();
    put("MY HOME BUILDER LLC", SIDE, 34, { font: "Helvetica-Bold", size: 7.5, color: DARK, spacing: 1.2, width: 200 });
    put(`Project breakdown · ${root.name}`, SIDE + WIDTH - 320, 34, { size: 7.5, color: SOFT, width: 320, align: "right" });
    line(48, { color: RULE, width: 0.75 });
    y = CONTINUED_TOP;
  };
  const ensure = (height) => {
    if (y + height > bottom) newPage();
  };

  const drawMark = (x, top, width, color) => {
    const scale = width / MARK_BOX.width;
    doc.save();
    doc.translate(x, top).scale(scale).translate(-MARK_BOX.x, -MARK_BOX.y);
    doc.lineWidth(MARK_BOX.stroke).lineCap("round").lineJoin("round").strokeColor(color);
    for (const path of MARK_PATHS) doc.path(path).stroke();
    doc.restore();
  };

  // A row of figure cards, three to a row: [label, value, tone].
  const cards = (items, { height = 62 } = {}) => {
    const gap = 12;
    const width = (WIDTH - gap * 2) / 3;
    for (let start = 0; start < items.length; start += 3) {
      ensure(height + gap);
      items.slice(start, start + 3).forEach(([label, value, tone], index) => {
        const x = SIDE + index * (width + gap);
        doc.rect(x, y, width, height).fill(PANEL);
        doc.rect(x, y, 3, height).fill(ACCENT);
        put(label.toUpperCase(), x + 15, y + 13, { font: "Helvetica-Bold", size: 7, color: SOFT, spacing: 1, width: width - 24 });
        put(value, x + 15, y + 28, { font: "Helvetica-Bold", size: height < 60 ? 15 : 18, color: tone === "loss" ? LOSS : INK, width: width - 24 });
      });
      y += height + gap;
    }
  };

  // A section's heading moves to the next page with the start of what follows it (`keep`).
  const section = (title, keep = 30) => {
    ensure(40 + keep);
    y += 8;
    put(title, SIDE, y, { font: "Helvetica-Bold", size: 12, color: DARK, width: WIDTH });
    y += 19;
    line(y, { color: DARK, width: 1 });
    y += 10;
  };

  // A table: columns [{ label, width, align }] (the one without a width takes what is left), rows
  // of cells (a string, or { text, bold, color }). Long cells wrap; the header repeats on a new page.
  const table = (columns, rows, { total = null, size = 8.5 } = {}) => {
    const fixed = sum(columns.filter((column) => column.width), (column) => column.width);
    const widths = columns.map((column) => column.width || WIDTH - fixed);
    const lefts = widths.map((_, index) => SIDE + sum(widths.slice(0, index), (width) => width));
    const cellOf = (cell) => (typeof cell === "object" && cell !== null ? cell : { text: String(cell ?? "") });
    const header = () => {
      const height = Math.max(...columns.map((column, index) => measure(column.label.toUpperCase(), widths[index] - 8, { font: "Helvetica-Bold", size: 6.6, spacing: 0.6 })));
      ensure(height + 26);
      columns.forEach((column, index) => {
        style({ font: "Helvetica-Bold", size: 6.6, color: FAINT });
        doc.text(printable(column.label.toUpperCase()), lefts[index] + (index ? 4 : 0), y, { width: widths[index] - (index ? 8 : 4), align: column.align || "left", characterSpacing: 0.6, lineGap: 1 });
      });
      y += height + 5;
      line(y, { color: RULE, width: 0.75 });
      y += 6;
    };
    const draw = (cells, { bold = false } = {}) => {
      const parsed = cells.map(cellOf);
      const height = Math.max(...parsed.map((cell, index) => measure(cell.text, widths[index] - (index ? 8 : 4), { font: bold || cell.bold ? "Helvetica-Bold" : "Helvetica", size })));
      if (y + height + 8 > bottom) {
        newPage();
        header();
      }
      parsed.forEach((cell, index) => {
        style({ font: bold || cell.bold ? "Helvetica-Bold" : "Helvetica", size, color: cell.color || INK });
        doc.text(printable(cell.text), lefts[index] + (index ? 4 : 0), y, { width: widths[index] - (index ? 8 : 4), align: columns[index].align || "left", lineGap: 1.5 });
      });
      y += height + 6;
    };
    header();
    for (const row of rows) {
      draw(row);
      line(y - 3, { color: "#EEEEEE", width: 0.5 });
    }
    if (total) {
      line(y - 2, { color: DARK, width: 0.75 });
      y += 3;
      draw(total, { bold: true });
    }
    y += 4;
  };

  // Amounts by category as bars, largest first.
  const bars = (items) => {
    const largest = Math.max(...items.map((item) => item.amount), 1);
    const nameWidth = 170;
    const amountWidth = 80;
    const track = WIDTH - nameWidth - amountWidth - 16;
    for (const item of items) {
      ensure(20);
      put(item.name, SIDE, y + 1, { size: 8.5, color: INK, width: nameWidth - 8 });
      doc.rect(SIDE + nameWidth, y + 2, track, 8).fill(PANEL);
      doc.rect(SIDE + nameWidth, y + 2, Math.max(2, (track * Math.max(item.amount, 0)) / largest), 8).fill(ACCENT);
      put(money(item.amount), SIDE + WIDTH - amountWidth, y + 1, { size: 8.5, color: INK, width: amountWidth, align: "right" });
      y += 18;
    }
    y += 4;
  };

  const status = (item) => {
    if (item.kind === "quote") return item.status === "accepted" ? "Quote, accepted" : "Quote";
    if (item.status === "paid") return "Paid";
    if (item.status === "processing") return "Payment processing";
    return balanceDue(item) < item.amountCents ? `Partly paid · ${money(balanceDue(item), item.currency)} due` : `Due${item.dueDate ? ` ${formatDate(item.dueDate)}` : ""}`;
  };

  // ---------- The first page ----------

  const projectCount = `${entries.length} project${entries.length === 1 ? "" : "s"}`;
  drawMark(SIDE, TOP + 2, 64, DARK);
  put("MY HOME BUILDER LLC", SIDE + 80, TOP + 1, { font: "Helvetica-Bold", size: 11, color: DARK, spacing: 1.4, width: 260 });
  put(BUSINESS_ADDRESS.join(", "), SIDE + 80, TOP + 17, { size: 8.5, color: SOFT, width: 260 });
  put(`myhomebuilderllc.com · ${BUILDER_LICENSE}`, SIDE + 80, TOP + 29, { size: 8.5, color: SOFT, width: 260 });
  put("PROJECT BREAKDOWN", SIDE + WIDTH - 200, TOP + 2, { font: "Helvetica-Bold", size: 8, color: ACCENT, spacing: 2, width: 200, align: "right" });
  put(`Prepared ${formatDate(today)}`, SIDE + WIDTH - 200, TOP + 17, { size: 9, color: SOFT, width: 200, align: "right" });
  line(TOP + 52, { color: DARK, width: 1.5 });
  y = TOP + 72;
  const titleHeight = measure(root.name, WIDTH, { font: "Times-Roman", size: 32, lineGap: 0 });
  style({ font: "Times-Roman", size: 32, color: INK });
  doc.text(printable(root.name), SIDE, y, { width: WIDTH, lineGap: 0 });
  y += titleHeight + 6;
  put([projectCount, root.siteAddress].filter(Boolean).join(" · "), SIDE, y, { size: 10.5, color: SOFT, width: WIDTH, wrap: true });
  y += measure([projectCount, root.siteAddress].filter(Boolean).join(" · "), WIDTH, { size: 10.5 }) + 22;

  const all = {
    invoiced: sum(entries, (entry) => entry.figures.invoiced),
    paid: sum(entries, (entry) => entry.figures.paid),
    outstanding: sum(entries, (entry) => entry.figures.outstanding),
    quoted: sum(entries, (entry) => entry.figures.quoted),
    income: sum(entries, (entry) => entry.figures.income),
    expenses: sum(entries, (entry) => entry.figures.expenses),
    profit: sum(entries, (entry) => entry.figures.profit),
    since: entries.map((entry) => entry.figures.since).filter(Boolean).sort()[0] || ""
  };
  if (costs) {
    cards([
      ["Invoiced", money(all.invoiced)],
      ["Paid", money(all.paid)],
      ["Outstanding", money(all.outstanding)],
      ["Gross expenses", money(all.expenses)],
      ["Gross profit", money(all.profit), all.profit < 0 ? "loss" : ""],
      ["Margin", marginText(all.profit, all.income), all.profit < 0 ? "loss" : ""]
    ]);
  } else {
    cards([
      ["Project value", money(all.invoiced)],
      ["Projects", String(entries.length)],
      ["Since", all.since ? formatDate(all.since) : "—"]
    ]);
  }

  section("Projects");
  if (costs) {
    table(
      [{ label: "Project" }, { label: "Invoiced", width: 64, align: "right" }, { label: "Paid", width: 64, align: "right" }, { label: "Outstanding", width: 66, align: "right" }, { label: "Gross expenses", width: 66, align: "right" }, { label: "Gross profit", width: 64, align: "right" }, { label: "Margin", width: 46, align: "right" }],
      entries.map(({ project, figures }) => [
        project.name, money(figures.invoiced), money(figures.paid), money(figures.outstanding), money(figures.expenses),
        { text: money(figures.profit), color: figures.profit < 0 ? LOSS : INK }, marginText(figures.profit, figures.income)
      ]),
      { total: ["All projects", money(all.invoiced), money(all.paid), money(all.outstanding), money(all.expenses), { text: money(all.profit), color: all.profit < 0 ? LOSS : INK }, marginText(all.profit, all.income)] }
    );
  } else {
    table(
      [{ label: "Project" }, { label: "Since", width: 110, align: "right" }, { label: "Project value", width: 110, align: "right" }],
      entries.map(({ project, figures }) => [project.name, figures.since ? formatDate(figures.since) : "—", money(figures.invoiced)]),
      { total: ["All projects", all.since ? formatDate(all.since) : "", money(all.invoiced)] }
    );
  }

  if (costs) {
    const categories = new Map();
    for (const entry of entries) {
      for (const category of entry.book?.categories || []) categories.set(category.name, (categories.get(category.name) || 0) + category.amount);
    }
    const list = [...categories].map(([name, amount]) => ({ name, amount })).filter((item) => item.amount).sort((left, right) => right.amount - left.amount);
    if (list.length) {
      section("Gross expenses by category");
      bars(list);
    }
  }

  const note = costs
    ? `Figures as recorded in My Home Builder's books on ${formatDate(today)}. Invoiced, paid and outstanding come from each project's invoices. Gross expenses are the job's own costs (materials, labor, subcontractors and other job costs) and leave out overhead; margin is gross profit over gross income.${all.quoted ? ` Open quotes add ${money(all.quoted)} not yet invoiced.` : ""}`
    : `Project values are the totals of each project's invoices as of ${formatDate(today)}.${all.quoted ? ` Open quotes add ${money(all.quoted)}.` : ""}`;
  ensure(60);
  y += 10;
  put(note, SIDE, y, { size: 8, color: SOFT, width: WIDTH, wrap: true, lineGap: 2 });
  y += measure(note, WIDTH, { size: 8, lineGap: 2 }) + 8;
  put(INSURANCE, SIDE, y, { size: 8, color: SOFT, width: WIDTH, wrap: true });

  // ---------- Each project ----------

  entries.forEach(({ project, billing, book, pictures, figures }, index) => {
    newPage();
    put(`PROJECT ${index + 1} OF ${entries.length}`, SIDE, y, { font: "Helvetica-Bold", size: 7.5, color: ACCENT, spacing: 2, width: WIDTH });
    y += 16;
    const nameHeight = measure(project.name, WIDTH, { font: "Times-Roman", size: 24, lineGap: 0 });
    style({ font: "Times-Roman", size: 24, color: INK });
    doc.text(printable(project.name), SIDE, y, { width: WIDTH, lineGap: 0 });
    y += nameHeight + 4;
    const meta = [project.siteAddress, figures.since ? `Since ${formatDate(figures.since)}` : ""].filter(Boolean).join(" · ");
    if (meta) {
      put(meta, SIDE, y, { size: 9.5, color: SOFT, width: WIDTH, wrap: true });
      y += measure(meta, WIDTH, { size: 9.5 }) + 4;
    }
    y += 12;
    if (costs) {
      cards([
        ["Invoiced", money(figures.invoiced)],
        ["Paid", money(figures.paid)],
        ["Outstanding", money(figures.outstanding)],
        ["Gross expenses", money(figures.expenses)],
        ["Gross profit", money(figures.profit), figures.profit < 0 ? "loss" : ""],
        ["Margin", marginText(figures.profit, figures.income), figures.profit < 0 ? "loss" : ""]
      ], { height: 52 });
    } else {
      cards([["Project value", money(figures.invoiced)], ["Since", figures.since ? formatDate(figures.since) : "—"]], { height: 52 });
    }

    // The work: each invoice and quote with its lines.
    section(costs ? "Invoices and quotes" : "Scope of work", 70);
    if (!billing.length) {
      ensure(20);
      put("Nothing has been quoted or invoiced yet.", SIDE, y, { size: 9, color: SOFT, width: WIDTH });
      y += 20;
    }
    for (const item of billing) {
      const title = item.title || billingLabel(item);
      const detail = costs
        ? [billingLabel(item), `Issued ${formatDate(issuedDate(item))}`, status(item)].join(" · ")
        : [item.kind === "quote" ? "Quote" : "Invoice", formatDate(issuedDate(item))].join(" · ");
      const titleHeight = measure(title, WIDTH - 110, { font: "Helvetica-Bold", size: 10 });
      ensure(titleHeight + 40);
      put(title, SIDE, y, { font: "Helvetica-Bold", size: 10, color: INK, width: WIDTH - 110, wrap: true });
      put(money(item.amountCents, item.currency), SIDE + WIDTH - 110, y, { font: "Helvetica-Bold", size: 10, color: INK, width: 110, align: "right" });
      y += titleHeight + 2;
      put(detail, SIDE, y, { size: 8, color: SOFT, width: WIDTH });
      y += 14;
      const lines = billingLineItems(item);
      const plain = lines.length === 1 && lines[0].description === item.title && Number(lines[0].quantity) === 1;
      if (lines.length && !plain) {
        table(
          [{ label: "Description" }, { label: "Qty", width: 50, align: "right" }, { label: "Unit price", width: 84, align: "right" }, { label: "Amount", width: 84, align: "right" }],
          lines.map((entry) => [entry.description, quantityText(entry.quantity), money(entry.unitCents, item.currency), money(entry.amountCents, item.currency)]),
          { size: 8 }
        );
      }
      y += 8;
    }

    if (costs) {
      // What was paid, and when.
      const payments = [];
      for (const item of billing.filter((entry) => entry.kind === "invoice")) {
        for (const installment of item.installments || []) payments.push([installment.paidOn, billingLabel(item), installment.label || "Payment", installment.amountCents, item.currency]);
        if (item.status === "paid" && item.payment) payments.push([String(item.paidAt || "").slice(0, 10), billingLabel(item), item.payment.label || (item.payment.source === "stripe" ? "Online" : "Payment"), item.payment.amountCents ?? item.amountCents, item.currency]);
        for (const refund of (item.payment?.refunds || []).filter((entry) => entry.amountCents > 0 && !["failed", "canceled"].includes(entry.status))) {
          payments.push([String(refund.refundedAt || "").slice(0, 10), billingLabel(item), "Refund", -refund.amountCents, item.currency]);
        }
      }
      if (payments.length) {
        payments.sort((left, right) => String(left[0]).localeCompare(String(right[0])));
        section("Payments received");
        table(
          [{ label: "Date", width: 96 }, { label: "Invoice", width: 110 }, { label: "How" }, { label: "Amount", width: 96, align: "right" }],
          payments.map(([date, label, how, amount, currency]) => [formatDate(date), label, how, { text: money(amount, currency), color: amount < 0 ? LOSS : INK }]),
          { total: ["Paid", "", "", money(sum(payments, (payment) => payment[3]))] }
        );
      }

      // What the job cost, and what it made.
      section("Gross expenses");
      if (book?.categories.length) {
        bars(book.categories);
        table(
          [{ label: "Expense" }, { label: "Date", width: 76 }, { label: "Paid to", width: 110 }, { label: "Category", width: 96 }, { label: "Amount", width: 76, align: "right" }],
          book.expenses.slice().reverse().map((row) => [row.what, formatDate(row.date), row.paidTo || "", row.category, money(row.amount)]),
          { total: ["Gross expenses", "", "", "", money(book.totals.expenses)], size: 8 }
        );
      } else {
        ensure(20);
        put("No job costs are recorded yet.", SIDE, y, { size: 9, color: SOFT, width: WIDTH });
        y += 20;
      }
      ensure(30);
      const summary = `Gross income ${money(figures.income)}, less gross expenses ${money(figures.expenses)}: gross profit ${money(figures.profit)} (${marginText(figures.profit, figures.income)} margin)`;
      put(summary, SIDE, y, { font: "Helvetica-Bold", size: 9, color: figures.profit < 0 ? LOSS : DARK, width: WIDTH, wrap: true });
      y += measure(summary, WIDTH, { font: "Helvetica-Bold", size: 9 }) + 6;
    }

    if (pictures.length) {
      const gap = 14;
      const cellWidth = (WIDTH - gap) / 2;
      const imageHeight = 168;
      section("Photos", imageHeight + 30);
      for (let start = 0; start < pictures.length; start += 2) {
        const pair = pictures.slice(start, start + 2);
        const captions = pair.map((picture) => [picture.note, picture.date ? formatDate(picture.date) : ""].filter(Boolean).join(" · "));
        const captionHeight = Math.max(0, ...captions.map((caption) => (caption ? measure(caption, cellWidth, { size: 8 }) + 4 : 0)));
        ensure(imageHeight + captionHeight + gap);
        pair.forEach((picture, column) => {
          const x = SIDE + column * (cellWidth + gap);
          doc.rect(x, y, cellWidth, imageHeight).fill(PANEL);
          try {
            doc.image(picture.bytes, x, y, { fit: [cellWidth, imageHeight], align: "center", valign: "center" });
          } catch {
            put("This photo could not be shown.", x + 10, y + imageHeight / 2 - 5, { size: 8, color: SOFT, width: cellWidth - 20, align: "center" });
          }
          if (captions[column]) put(captions[column], x, y + imageHeight + 5, { size: 8, color: SOFT, width: cellWidth, wrap: true });
        });
        y += imageHeight + captionHeight + gap;
      }
    }
  });

  // Every page's footer: the business, and the page number.
  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page += 1) {
    doc.switchToPage(page);
    doc.page.margins.bottom = 0;
    line(PAGE_HEIGHT - 48, { color: RULE, width: 0.75 });
    put(`My Home Builder LLC · myhomebuilderllc.com · ${BUILDER_LICENSE}`, SIDE, PAGE_HEIGHT - 40, { size: 7.5, color: SOFT, width: 360 });
    put(`Page ${page - range.start + 1} of ${range.count}`, SIDE + WIDTH - 120, PAGE_HEIGHT - 40, { size: 7.5, color: SOFT, width: 120, align: "right" });
  }
  doc.end();
  return finished;
}
