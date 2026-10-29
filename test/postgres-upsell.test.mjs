// G6 in PostgreSQL: conversions unique by (click_id, tid), upsells summed per click without duplicating clicks,
// postback sub_id_N written into clicks.params. Runs only with TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { checkUpsells } from './upsell.test.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const TOKEN = 'pg-upsell-token';

test('PostgreSQL: postback tid upsells and sub_id_N', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 30000 }, async (t) => {
  const dirs = [];
  const start = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgups-')); dirs.push(dir);
    return startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN });
  };
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  let server = await start();
  const call = (path, body) => fetch(server.url + path, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try { await checkUpsells(server, call, run); } finally { await server.stop(); }

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT cv.tid, cv.status, cv.revenue::float AS revenue FROM conversions cv JOIN clicks c USING (click_id)
      WHERE c.campaign = $1 ORDER BY cv.tid`, [`ups-cmp-${run}`]);
    assert.deepEqual(rows.map((r) => [r.tid, r.status, r.revenue]), [['', 'sale', 10], ['order-2', 'sale', 4], ['order-3', 'rejected', 6]]);
    const { rows: [click] } = await client.query('SELECT params FROM clicks WHERE campaign = $1', [`ups-cmp-${run}`]);
    assert.deepEqual(click.params, { sub_id_3: 'from-network', sub_id_7: 'net7' });
  } finally { await client.end(); }

  // Empty data directory: the report can only come from PostgreSQL.
  server = await start();
  try {
    const stats = await (await call(`/stats?campaign=ups-cmp-${run}`)).json();
    assert.deepEqual([stats.clicks, stats.conversions, stats.revenue], [1, 2, 14]);
    const params = await (await call(`/stats/params?field=sub_id_3&campaign=ups-cmp-${run}`)).json();
    assert.deepEqual(params.rows.map((r) => [r.value, r.clicks, r.conversions]), [['from-network', 1, 2]]);
  } finally { await server.stop(); }
});
