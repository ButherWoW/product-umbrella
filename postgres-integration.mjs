import test from 'node:test';
import assert from 'node:assert/strict';

const connectionString = process.env.DATABASE_URL;

test('PostgreSQL schema integration: migrations and management tables', { skip: !connectionString }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    `, [['campaigns', 'offers', 'sources', 'networks', 'clicks', 'conversions']]);
    const names = new Set(rows.map((row) => row.table_name));
    for (const name of ['campaigns', 'offers', 'sources', 'networks', 'clicks', 'conversions']) assert.ok(names.has(name), `missing table: ${name}`);

    const { rows: offerColumns } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='offers' AND column_name = ANY($1::text[])
    `, [['network_id', 'group']]);
    assert.deepEqual(new Set(offerColumns.map((row) => row.column_name)), new Set(['network_id', 'group']));

    const { rows: sourceColumns } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='sources'
    `);
    for (const name of ['param_map', 'cost_model', 'cpc', 'cost_from_param']) assert.ok(sourceColumns.some((row) => row.column_name === name), `missing sources column: ${name}`);
  } finally {
    await pool.end();
  }
});
