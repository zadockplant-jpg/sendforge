// Additive JayJe table for reusable quote and invoice templates.
// Render applies this migration on deploy. Do not run it locally.
export async function up(k) {
  await k.schema.createTable('jayje_document_templates', t => {
    t.uuid('id').primary();
    t.string('name', 120).notNullable();
    // The kind a new draft starts as. Either kind can still be changed on the form.
    t.string('kind', 10).notNullable().defaultTo('quote');
    t.string('title', 180).notNullable();
    t.jsonb('items').notNullable();
    t.integer('tax_bps').notNullable().defaultTo(0);
    t.text('notes').notNullable().defaultTo('');
    // Days from the day a draft is prepared to its due or valid-through date.
    t.integer('valid_days');
    t.uuid('created_by').notNullable().references('id').inTable('users');
    // Removal is a soft delete, so an audit row always points at a surviving record.
    t.timestamp('archived_at', { useTz: true });
    t.timestamps(true, true);
    t.index(['archived_at', 'name']);
  });
  // Two live templates cannot share a name, and archiving one frees its name.
  await k.raw('CREATE UNIQUE INDEX jayje_template_live_name ON jayje_document_templates(lower(name)) WHERE archived_at IS NULL');
}
export async function down(k) {
  await k.raw('DROP INDEX IF EXISTS jayje_template_live_name');
  await k.schema.dropTableIfExists('jayje_document_templates');
}
