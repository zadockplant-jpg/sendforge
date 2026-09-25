import { PDFDocument, StandardFonts, rgb } from "./vendor/pdf-lib.js";

const INK = rgb(0.07, 0.07, 0.07);
const SOFT = rgb(0.35, 0.35, 0.35);
const LINE = rgb(0.75, 0.75, 0.75);
const WHITE = rgb(1, 1, 1);

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toUTCString();
}

function partyLabel(party) {
  return party === "admin" ? "My Home Builder LLC" : "Client";
}

export function isPdf(bytes) {
  const head = new Uint8Array(bytes.slice ? bytes.slice(0, 5) : bytes.subarray(0, 5));
  return head.length === 5 && String.fromCharCode(...head) === "%PDF-";
}

export async function signDocument(originalBytes, documentName, signatures, loadImage) {
  const pdf = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const script = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const prepared = [];
  for (const signature of signatures) {
    const png = signature.imageKey ? await loadImage(signature.imageKey) : null;
    prepared.push({ ...signature, image: png ? await pdf.embedPng(png) : null });
  }

  const pages = pdf.getPages();
  const last = pages[pages.length - 1];
  const { width } = last.getSize();
  const margin = 36;
  const blockHeight = 78;
  const boxWidth = (width - margin * 3) / 2;

  prepared.forEach((signature, index) => {
    const x = margin + (index % 2) * (boxWidth + margin);
    const y = margin + Math.floor(index / 2) * (blockHeight + 12);
    last.drawRectangle({ x: x - 4, y: y - 4, width: boxWidth + 8, height: blockHeight + 8, color: WHITE, opacity: 0.92 });
    last.drawLine({ start: { x, y: y + 26 }, end: { x: x + boxWidth, y: y + 26 }, thickness: 0.8, color: LINE });
    if (signature.image) {
      const scale = Math.min((boxWidth - 8) / signature.image.width, 46 / signature.image.height);
      last.drawImage(signature.image, { x: x + 4, y: y + 28, width: signature.image.width * scale, height: signature.image.height * scale });
    } else {
      last.drawText(signature.name, { x: x + 6, y: y + 36, size: 20, font: script, color: INK });
    }
    last.drawText(`${partyLabel(signature.party)}: ${signature.name}`, { x, y: y + 12, size: 8.5, font: bold, color: INK });
    last.drawText(`Signed ${formatDate(signature.signedAt)}`, { x, y: y + 2, size: 7.5, font: regular, color: SOFT });
  });

  const audit = pdf.addPage();
  let cursor = audit.getSize().height - 64;
  audit.drawText("Signature certificate", { x: margin, y: cursor, size: 20, font: bold, color: INK });
  cursor -= 26;
  audit.drawText(`Document: ${documentName}`, { x: margin, y: cursor, size: 10, font: regular, color: SOFT });
  cursor -= 34;
  for (const signature of prepared) {
    audit.drawText(`${partyLabel(signature.party)} signature`, { x: margin, y: cursor, size: 11, font: bold, color: INK });
    cursor -= 16;
    audit.drawText(`Name: ${signature.name}`, { x: margin, y: cursor, size: 10, font: regular, color: INK });
    cursor -= 14;
    audit.drawText(`Signed: ${formatDate(signature.signedAt)}`, { x: margin, y: cursor, size: 10, font: regular, color: INK });
    cursor -= 14;
    audit.drawText(`Origin: ${signature.ip || "unknown"}`, { x: margin, y: cursor, size: 10, font: regular, color: INK });
    cursor -= 14;
    audit.drawText(`Method: ${signature.image ? "drawn" : "typed"} signature accepted through the My Home Builder client portal`, {
      x: margin, y: cursor, size: 10, font: regular, color: SOFT
    });
    cursor -= 30;
  }

  return pdf.save();
}
