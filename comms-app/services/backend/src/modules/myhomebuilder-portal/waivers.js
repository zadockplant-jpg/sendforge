// Michigan lien waivers: the four forms of the Construction Lien Act, MCL 570.1115(9), word for
// word, with the blanks filled in and underlined and the chosen "does" or "does not" circled.
//
// A subcontractor signs a partial conditional waiver with each invoice, or a full conditional
// waiver with the final invoice for a job. Both take effect only when the amount is paid
// (MCL 570.1115(4)). The unconditional forms are for after payment.
import { PDFDocument, StandardFonts, rgb } from "./vendor/pdf-lib.js";
import { slashDate } from "./forms.js";

const INK = rgb(0.05, 0.05, 0.1);

const AUTHENTICITY = "If the improvement is provided to property that is a residential structure and if the owner or lessee of the property or the owner's or lessee's designee has received a notice of furnishing from me/one of us or if I/we are not required to provide one, and the owner, lessee, or designee has not received this waiver directly from me/one of us, the owner, lessee, or designee may not rely upon it without contacting me/one of us, either in writing, by telephone, or personally, to verify that it is authentic.";

export const WAIVERS = {
  "partial-unconditional": { title: "PARTIAL UNCONDITIONAL WAIVER", name: "Partial unconditional waiver", clause: "(a)", full: false, conditional: false },
  "partial-conditional": { title: "PARTIAL CONDITIONAL WAIVER", name: "Partial conditional waiver", clause: "(b)", full: false, conditional: true },
  "full-unconditional": { title: "FULL UNCONDITIONAL WAIVER", name: "Full unconditional waiver", clause: "(c)", full: true, conditional: false },
  "full-conditional": { title: "FULL CONDITIONAL WAIVER", name: "Full conditional waiver", clause: "(d)", full: true, conditional: true }
};

export function waiverAmount(cents) {
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The statute's paragraphs as runs of text: { text, fill } for a filled-in blank, { circle } for
// the chosen "does" or "does not".
export function waiverParagraphs(kind, values) {
  const fill = (value) => ({ text: String(value), fill: true });
  const amount = waiverAmount(values.amountCents);
  const spec = WAIVERS[kind];
  if (!spec.full) {
    const opening = [
      { text: "I/we have a contract with " }, fill(values.party), { text: " to provide " }, fill(values.provided),
      { text: ` for the improvement to the property described as${spec.conditional ? ":" : ""} ` }, fill(values.property),
      { text: " , and by signing this waiver waive my/our construction lien to the amount of " }, fill(amount),
      { text: " , for labor/materials provided through " }, fill(slashDate(values.through)), { text: " ." }
    ];
    const coverage = [
      { text: "This waiver, together with all previous waivers, if any, (circle one)   " },
      { text: "does", circle: Boolean(values.coversAll) }, { text: "    " },
      { text: "does not", circle: !values.coversAll },
      { text: "   cover all amounts due to me/us for contract improvement provided through the date shown above." }
    ];
    if (spec.conditional) {
      return [opening, [...coverage, { text: " This waiver is conditioned on actual payment of the amount shown above." }], AUTHENTICITY];
    }
    return [opening, [...coverage, { text: ` ${AUTHENTICITY}` }]];
  }
  const opening = [
    { text: "My/our contract with " }, fill(values.party), { text: " to provide " }, fill(values.provided),
    { text: " for the improvement of the property described as: " }, fill(values.property),
    { text: " has been fully paid and satisfied. By signing this waiver, all my/our construction lien rights against the described property are waived and released." }
  ];
  if (spec.conditional) {
    return [opening, [{ text: "This waiver is conditioned on actual payment of " }, fill(amount), { text: ` . ${AUTHENTICITY}` }]];
  }
  return [opening, AUTHENTICITY];
}

// Lays out paragraphs of runs, underlining filled-in blanks and circling runs marked `circle`.
// Returns the y position below the last line.
function writeRuns(page, font, paragraphs, { x = 72, y, width = 468, size = 11, leading = 16 } = {}) {
  let cursor = y;
  for (const paragraph of paragraphs) {
    const runs = typeof paragraph === "string" ? [{ text: paragraph }] : paragraph;
    const words = [];
    runs.forEach((run, runIndex) => {
      for (const [index, word] of String(run.text).split(/(\s+)/u).entries()) {
        if (!word) continue;
        words.push({ text: word, fill: Boolean(run.fill), circle: run.circle ? runIndex : null, space: index % 2 === 1 });
      }
    });
    let line = [];
    let lineWidth = 0;
    const flush = () => {
      while (line.length && line[line.length - 1].space) line.pop();
      let left = x;
      const circles = new Map();
      for (const word of line) {
        const w = font.widthOfTextAtSize(word.space ? " ".repeat(word.text.length) : word.text, size);
        if (!word.space) page.drawText(word.text, { x: left, y: cursor, size, font, color: INK });
        if (word.fill) page.drawLine({ start: { x: left, y: cursor - 2.5 }, end: { x: left + w, y: cursor - 2.5 }, thickness: 0.6, color: INK });
        if (word.circle !== null) {
          const bounds = circles.get(word.circle) || { from: left, to: left };
          bounds.to = left + w;
          circles.set(word.circle, bounds);
        }
        left += w;
      }
      for (const { from, to } of circles.values()) {
        page.drawEllipse({ x: (from + to) / 2, y: cursor + size * 0.33, xScale: (to - from) / 2 + 4, yScale: size * 0.7, borderColor: INK, borderWidth: 0.9 });
      }
      cursor -= leading;
      line = [];
      lineWidth = 0;
    };
    for (const word of words) {
      const w = font.widthOfTextAtSize(word.space ? " ".repeat(word.text.length) : word.text, size);
      if (!word.space && lineWidth + w > width && line.length) flush();
      if (word.space && !line.length) continue;
      line.push(word);
      lineWidth += w;
    }
    if (line.length) flush();
    cursor -= leading * 0.6;
  }
  return cursor;
}

// A signed Michigan lien waiver. `values`: { party, provided, property, amountCents, through,
// coversAll, claimant, address, phone }; `signer`: { name, image (PNG bytes or null), signedOn };
// `reference` names the invoice; `audit` says how and when it was signed.
export async function typesetWaiver(kind, values, { signer, reference = "", audit = "" }) {
  const spec = WAIVERS[kind];
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const script = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const small = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText(spec.title, { x: (612 - bold.widthOfTextAtSize(spec.title, 15)) / 2, y: 712, size: 15, font: bold, color: INK });
  const lineY = writeRuns(page, regular, waiverParagraphs(kind, values), { y: 672 }) - 36;

  // Signature of the lien claimant on the right; the date signed on the left.
  if (signer.image) {
    const image = await pdf.embedPng(signer.image);
    const scale = Math.min(216 / image.width, 40 / image.height);
    page.drawImage(image, { x: 322, y: lineY + 2, width: image.width * scale, height: image.height * scale });
  } else {
    page.drawText(signer.name, { x: 324, y: lineY + 6, size: 18, font: script, color: INK });
  }
  page.drawLine({ start: { x: 320, y: lineY }, end: { x: 540, y: lineY }, thickness: 0.7, color: INK });
  page.drawText(values.claimant, { x: 322, y: lineY - 14, size: 10, font: regular, color: INK });
  page.drawText("(signature of lien claimant)", { x: 322, y: lineY - 27, size: 9, font: regular, color: INK });
  const signedOn = slashDate(signer.signedOn);
  page.drawText("Signed on:", { x: 72, y: lineY + 4, size: 11, font: regular, color: INK });
  page.drawText(signedOn, { x: 126, y: lineY + 4, size: 11, font: regular, color: INK });
  page.drawLine({ start: { x: 126, y: lineY + 1.5 }, end: { x: 126 + regular.widthOfTextAtSize(signedOn, 11), y: lineY + 1.5 }, thickness: 0.6, color: INK });
  page.drawText("(date)", { x: 126, y: lineY - 10, size: 9, font: regular, color: INK });
  let blockY = lineY - 52;
  for (const [label, value] of [["Address:", values.address], ["Telephone:", values.phone]]) {
    page.drawText(label, { x: 322, y: blockY, size: 11, font: regular, color: INK });
    page.drawText(String(value || ""), { x: 380, y: blockY, size: 10, font: regular, color: INK });
    page.drawLine({ start: { x: 380, y: blockY - 2.5 }, end: { x: 540, y: blockY - 2.5 }, thickness: 0.6, color: INK });
    blockY -= 20;
  }
  const warning = "DO NOT SIGN BLANK OR INCOMPLETE FORMS. RETAIN A COPY.";
  page.drawText(warning, { x: (612 - bold.widthOfTextAtSize(warning, 11)) / 2, y: blockY - 18, size: 11, font: bold, color: INK });

  const footer = [`Michigan Construction Lien Act, MCL 570.1115(9)${spec.clause}.${reference ? ` ${reference}` : ""}`, audit].filter(Boolean);
  footer.forEach((line, index) => page.drawText(line, { x: 72, y: 58 - index * 12, size: 8, font: small, color: INK }));
  pdf.setTitle(spec.name);
  pdf.setProducer("My Home Builder client portal");
  return pdf.save();
}
