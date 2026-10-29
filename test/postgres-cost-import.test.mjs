// FB spend import against PostgreSQL: clicks are matched in the clicks table, import keys live in cost_imports,
// and a re-import after a restart with an empty data directory still replaces instead of adding.
// Runs only with TEST_DATABASE_URL (after `node src/migrate.js`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { TOKEN, buyerSession, importClicks, checkCostImport, createImportCampaigns } from './cost-import.test.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL: FB spend import, idempotent across restarts', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 40000 }, async (t) => {
  const dirs = [];
  const start = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgimp-')); dirs.push(dir);
    return startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN });
  };
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  t.after(() => client.end());
  const run = Date.now().toString(36);
  let server = await start();
  const call = (path, body) => fetch(server.url + path, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let campaign, seed;
  try {
    const buyer = await buyerSession(server, call, `buyer-pgimp-${run}@example.com`);
    let other;
    ({ campaign, other } = await createImportCampaigns(call, run));
    seed = importClicks(campaign, other);
    for (const c of seed.clicks) {
      await client.query(`INSERT INTO clicks (click_id, campaign, offer_id, stream, params, cost, is_unique_campaign, created_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,0,true,$6)`, [c.clickId, c.campaign, c.offerId, c.stream, JSON.stringify(c.params), c.at]);
    }
    await checkCostImport({ call, buyer, campaign, other, ...seed });
  } finally { await server.stop(); }

  const { rows } = await client.query('SELECT import_key, cardinality(click_ids) AS n, cost FROM cost_imports WHERE campaign = $1 ORDER BY import_key', [campaign]);
  assert.equal(rows.length, 4, 'one row per imported ad set and day (a key that never had clicks is not stored)');
  assert.deepEqual(rows.map((r) => Number(r.n)), [2, 1, 1, 3], 'clicks of the last import per key (A/d1, A/d2, B/d1, B/d2)');

  // Restart with an empty data directory: the import keys come from PostgreSQL, so a re-import still replaces.
  server = await start();
  try {
    const before = Number((await (await call(`/stats?campaign=${campaign}`)).json()).cost);
    const again = await (await call('/api/costs/import', { campaign, param: 'sub_id_2', tz: 'UTC',
      rows: [{ date: seed.d1, id: 'A', amount: 6, currency: 'EUR' }, { date: seed.d2, id: 'B', amount: 3, currency: 'EUR' }] })).json();
    assert.ok(again.results.every((r) => r.replaced), 'previous imports found in PostgreSQL');
    assert.equal(Number((await (await call(`/stats?campaign=${campaign}`)).json()).cost), before, 'no double counting after a restart');
  } finally { await server.stop(); }
});
