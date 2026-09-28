import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SERVICE_NAMES } from '../jayje/config.js';
import { fail } from './service.js';

// Reusable quote and invoice shells the owner keeps for the work JayJe repeats.
// A template is only ever copied into a new draft, so editing or removing one
// never changes a document that was already prepared, issued or paid.
export const templateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['quote', 'invoice']).default('quote'),
  title: z.string().trim().min(1).max(180),
  // The same line shape a document uses, so a template drops straight into the form.
  items: z.array(z.object({
    description: z.string().trim().min(1).max(500),
    quantity_milli: z.number().int().min(1).max(1000000),
    // A template may carry no price yet; the document itself still has a minimum.
    unit_cents: z.number().int().min(0).max(99999999),
    category: z.enum(Object.keys(SERVICE_NAMES)).nullable().default(null),
  }).strict()).min(1).max(40),
  tax_bps: z.number().int().min(0).max(10000).default(0),
  notes: z.string().trim().max(5000).default(''),
  valid_days: z.number().int().min(0).max(365).nullable().default(null),
}).strict();

const PUBLIC_FIELDS = ['id', 'name', 'kind', 'title', 'items', 'tax_bps', 'notes', 'valid_days', 'created_at', 'updated_at'];
const present = row => PUBLIC_FIELDS.reduce((out, key) => Object.assign(out, { [key]: row[key] }), {});
const nameTaken = error => { throw error?.code === '23505' ? fail(409, 'template_name_taken') : error; };

export function createTemplates({ db, audit }) {
  const live = async (id, trx = db) => {
    const row = await trx('jayje_document_templates').where({ id }).whereNull('archived_at').first();
    if (!row) throw fail(404, 'template_not_found');
    return row;
  };
  const columns = data => ({ ...data, items: JSON.stringify(data.items) });
  return {
    async list() {
      const rows = await db('jayje_document_templates').whereNull('archived_at').orderBy('name', 'asc').limit(200);
      return { templates: rows.map(present) };
    },
    async create(actor, input) {
      const data = templateSchema.parse(input);
      return db.transaction(async trx => {
        let row;
        try {
          [row] = await trx('jayje_document_templates')
            .insert({ id: randomUUID(), ...columns(data), created_by: actor.sub }).returning('*');
        } catch (error) { nameTaken(error); }
        await audit(trx, actor, 'template_created', row.id);
        return present(row);
      });
    },
    async update(actor, id, input) {
      const data = templateSchema.parse(input);
      return db.transaction(async trx => {
        await live(id, trx);
        let row;
        try {
          [row] = await trx('jayje_document_templates').where({ id }).whereNull('archived_at')
            .update({ ...columns(data), updated_at: trx.fn.now() }).returning('*');
        } catch (error) { nameTaken(error); }
        if (!row) throw fail(404, 'template_not_found');
        await audit(trx, actor, 'template_updated', id);
        return present(row);
      });
    },
    async remove(actor, id) {
      return db.transaction(async trx => {
        await live(id, trx);
        const removed = await trx('jayje_document_templates').where({ id }).whereNull('archived_at')
          .update({ archived_at: trx.fn.now(), updated_at: trx.fn.now() });
        if (!removed) throw fail(404, 'template_not_found');
        await audit(trx, actor, 'template_removed', id);
        return { ok: true };
      });
    },
  };
}
