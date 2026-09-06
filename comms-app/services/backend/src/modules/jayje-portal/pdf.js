import PDFDocument from 'pdfkit';
import { isoDate } from './service.js';

const money=(cents,currency='usd')=>new Intl.NumberFormat('en-US',{style:'currency',currency:currency.toUpperCase()}).format(cents/100);
// PDFs use built-in fonts and text only: no remote fetches or user HTML.
export function documentPdf(invoice,payment=null) {
  return new Promise((resolve,reject)=>{
    const pdf=new PDFDocument({size:'LETTER',margin:54,bufferPages:true,info:{Title:`JayJe ${invoice.reference}`,Author:'JayJe'}});
    const chunks=[];pdf.on('data',c=>chunks.push(c));pdf.on('end',()=>resolve(Buffer.concat(chunks)));pdf.on('error',reject);
    pdf.font('Helvetica-Bold').fontSize(30).fillColor('#080808').text('JayJe');
    pdf.font('Helvetica').fontSize(10).fillColor('#555555').text('Muskegon, Michigan  |  jayje.com').moveDown(2);
    pdf.font('Helvetica-Bold').fontSize(21).fillColor('#080808').text(payment?'PAYMENT RECEIPT':invoice.kind.toUpperCase());
    pdf.font('Helvetica').fontSize(11).text(invoice.reference).text(`Status: ${payment?payment.status:invoice.status}`).moveDown();
    pdf.font('Helvetica-Bold').text(invoice.title).moveDown();
    pdf.font('Helvetica').text(invoice.customer.name).text(invoice.customer.email);
    if(invoice.customer.address) pdf.text(invoice.customer.address);
    if(invoice.due_date) pdf.text(`${invoice.kind==='quote'?'Valid through':'Due'}: ${isoDate(invoice.due_date)}`);
    pdf.moveDown(2);
    for(const item of invoice.items) {
      const detail=`${item.quantity_milli/1000} × ${money(item.unit_cents)}  =  ${money(item.total_cents)}`;
      const height=pdf.heightOfString(item.description,{width:500})+35;
      if(pdf.y+height>700)pdf.addPage();
      pdf.font('Helvetica-Bold').fontSize(11).text(item.description);
      pdf.font('Helvetica').fontSize(10).fillColor('#555555').text(detail).fillColor('#080808').moveDown();
    }
    if(pdf.y>580)pdf.addPage();
    pdf.moveDown().font('Helvetica').text(`Subtotal: ${money(invoice.subtotal_cents)}`,{align:'right'});
    pdf.text(`Tax (${invoice.tax_bps/100}%): ${money(invoice.tax_cents)}`,{align:'right'});
    pdf.font('Helvetica-Bold').fontSize(15).text(`Total: ${money(invoice.total_cents)}`,{align:'right'}).moveDown();
    if(payment) {
      pdf.font('Helvetica').fontSize(11).text(`Payment confirmed: ${new Date(payment.paid_at).toISOString().slice(0,10)}`);
      pdf.text(`Amount paid: ${money(payment.amount_cents)}`);
      pdf.text(`Receipt: ${payment.id}`);
      if(payment.refunded_cents)pdf.text(`Amount refunded: ${money(payment.refunded_cents)}`);
    }
    if(invoice.notes)pdf.moveDown().font('Helvetica').fontSize(10).text(invoice.notes);
    const {count}=pdf.bufferedPageRange();
    for(let i=0;i<count;i++){pdf.switchToPage(i);pdf.font('Helvetica').fontSize(9).fillColor('#555555').text(`${invoice.reference}  ·  ${i+1} / ${count}`,54,740,{lineBreak:false});}
    pdf.end();
  });
}
