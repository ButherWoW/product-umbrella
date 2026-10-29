// End-to-end check against a real PostgreSQL: data written by one server must come back from the database
// after a restart with an empty data directory (so nothing can be read from the JSONL files).
// Runs only with TEST_DATABASE_URL (CI starts a throwaway PostgreSQL; locally: docker run postgres:16).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const TOKEN = 'pg-e2e-token';

test('PostgreSQL: campaigns, offers, clicks and conversions survive a restart', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 30000 }, async (t) => {
  const dirs = [];
  const start = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-pg-')); dirs.push(dir);
    return startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN });
  };
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  const offerId = `pg-offer-${run}`, campaignId = `pg-camp-${run}`;

  let server = await start();
  const call = (path, body, method = body ? 'POST' : 'GET') => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await (await fetch(server.url + '/health')).json()).storage, 'postgres');
    assert.equal((await call('/api/offers', { id: offerId, url: 'https://example.com/pg', name: 'PG offer' })).status, 201);
    assert.equal((await call('/api/campaigns', { id: campaignId, name: 'PG campaign', costModel: 'cpc', cpc: 0.25,
      streams: [{ name: 'main', offers: [{ offerId }] }] })).status, 201);
    const hit = await fetch(`${server.url}/r/${campaignId}?sub_id_1=abc`, { redirect: 'manual' });
    const clickId = new URL(hit.headers.get('location')).searchParams.get('click_id');
    assert.ok(clickId);
    const pb = await fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${clickId}&revenue=12.5&currency=EUR`);
    assert.equal(pb.status, 200);
  } finally { await server.stop(); }

  // Fresh data directory: everything below must come from PostgreSQL.
  server = await start();
  try {
    const { campaigns } = await (await call('/api/campaigns')).json();
    assert.equal(campaigns[campaignId]?.name, 'PG campaign');
    assert.equal(campaigns[campaignId]?.cpc, 0.25);
    const { offers } = await (await call('/api/offers')).json();
    assert.equal(offers[offerId]?.url, 'https://example.com/pg');
    const s = await (await call(`/stats?campaign=${campaignId}`)).json();
    assert.deepEqual([s.clicks, s.conversions, s.revenue, s.cost], [1, 1, 12.5, 0.25]);
    const params = await (await call(`/stats/params?field=sub_id_1&campaign=${campaignId}`)).json();
    assert.equal(params.rows[0].value, 'abc');
  } finally { await server.stop(); }
});

// «Очистка статистики» and RETENTION_DAYS delete from PostgreSQL too: a restart with an empty data
// directory must not bring the removed clicks, conversions and bots back.
async function pgPool() {
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: databaseUrl, max: 2 });
}
const oldAt = '2026-01-10T10:00:00.000Z';
async function insertClick(pool, campaign, { at = oldAt, converted = false, lp = false } = {}) {
  const { randomUUID } = await import('node:crypto');
  const clickId = randomUUID();
  await pool.query('INSERT INTO clicks (click_id, campaign, offer_id, created_at, lp_clicked_at) VALUES ($1,$2,$3,$4,$5)', [clickId, campaign, 'offer-1', at, lp ? at : null]);
  if (converted) await pool.query('INSERT INTO conversions (click_id, revenue, currency, created_at) VALUES ($1, 3, $2, $3)', [clickId, 'EUR', at]);
  return clickId;
}

test('PostgreSQL: clear-stats deletes one campaign\'s rows (with `before`), others stay', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 30000 }, async (t) => {
  const dirs = [];
  const start = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgclear-')); dirs.push(dir);
    return startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN });
  };
  const pool = await pgPool();
  t.after(async () => { await pool.end(); for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  const a = `pg-clr-a-${run}`, b = `pg-clr-b-${run}`;

  let server = await start();
  const call = (path, body, method = body ? 'POST' : 'GET') => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const hit = async (campaign) => new URL((await fetch(`${server.url}/r/${campaign}`, { redirect: 'manual' })).headers.get('location')).searchParams.get('click_id');
  try {
    for (const id of [a, b]) assert.equal((await call('/api/campaigns', { id, name: id, streams: [{ name: 'main', offers: [{ offerId: 'offer-1' }] }] })).status, 201);
    await insertClick(pool, a, { converted: true, lp: true });
    await insertClick(pool, a);
    await insertClick(pool, b, { converted: true });
    await pool.query('INSERT INTO bots (campaign, reason, created_at) VALUES ($1, $3, $4), ($2, $3, $4)', [a, b, 'ua', oldAt]);
    const live = await hit(a);
    await hit(b);
    assert.equal((await fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${live}&revenue=4`)).status, 200);

    assert.equal((await call(`/api/campaigns/${a}/clear-stats`, { confirm: b })).status, 400);
    const partial = await (await call(`/api/campaigns/${a}/clear-stats`, { confirm: a, before: '2026-06-01' })).json();
    assert.deepEqual(partial.removed.postgres, { clicks: 2, conversions: 1, lpClicks: 1, bots: 1 });
    let s = await (await call(`/stats?campaign=${a}`)).json();
    assert.deepEqual([s.clicks, s.conversions], [1, 1], 'clicks after `before` stay');
    const all = await (await call(`/api/campaigns/${a}/clear-stats`, { confirm: a })).json();
    assert.deepEqual([all.removed.postgres.clicks, all.removed.postgres.conversions, all.removed.clicks], [1, 1, 1], 'database and journal both cleared');
    await hit(b);
  } finally { await server.stop(); }

  server = await start();
  try {
    const sa = await (await call(`/stats?campaign=${a}`)).json();
    assert.deepEqual([sa.clicks, sa.conversions, sa.revenue], [0, 0, 0], 'nothing comes back from PostgreSQL');
    const sb = await (await call(`/stats?campaign=${b}`)).json();
    assert.deepEqual([sb.clicks, sb.conversions], [3, 1], 'other campaign intact, clicks after the clear recorded');
    const bots = await pool.query('SELECT campaign FROM bots WHERE campaign = ANY($1)', [[a, b]]);
    assert.deepEqual(bots.rows.map((r) => r.campaign), [b]);
  } finally { await server.stop(); }
});

test('PostgreSQL: RETENTION_DAYS deletes old unconverted clicks and bots, converted clicks stay', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgret-'));
  const pool = await pgPool();
  t.after(async () => { await pool.end(); await rm(dir, { recursive: true, force: true }); });
  const campaign = `pg-ret-${Date.now().toString(36)}`;
  const paid = await insertClick(pool, campaign, { converted: true });
  const unpaid = await insertClick(pool, campaign, { lp: true });
  const recent = await insertClick(pool, campaign, { at: new Date().toISOString() });
  await pool.query('INSERT INTO bots (campaign, reason, created_at) VALUES ($1, $2, $3), ($1, $2, now())', [campaign, 'ua', oldAt]);
  const server = await startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN, RETENTION_DAYS: '30', RETENTION_DELAY_MS: '0' });
  try {
    let left = [];
    for (let i = 0; i < 100; i++) {
      left = (await pool.query('SELECT click_id FROM clicks WHERE campaign = $1', [campaign])).rows.map((r) => r.click_id);
      if (!left.includes(unpaid)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(left.sort(), [paid, recent].sort(), 'only the old unconverted click is gone');
    assert.equal((await pool.query('SELECT 1 FROM conversions WHERE click_id = $1', [paid])).rowCount, 1, 'conversion kept');
    assert.equal((await pool.query('SELECT 1 FROM bots WHERE campaign = $1', [campaign])).rowCount, 1, 'old bot removed, recent kept');
  } finally { await server.stop(); }
});

test('PostgreSQL: click connection type persists in its column and groups the report', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 30000 }, async (t) => {
  const { default: pg } = await import('pg');
  const { createEventMirror } = await import('../src/event-mirror.js');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-pg-'));
  t.after(async () => { await pool.end(); await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  const campaign = `pg-conn-${run}`;
  // The mirror writes exactly what a live click with an ASN lookup writes (CI has no ASN database).
  const mirror = createEventMirror({ query: (sql, values) => pool.query(sql, values), onError: (type, error) => { throw error; } });
  const ids = [];
  for (const connection of ['mobile', 'mobile', 'broadband', null]) {
    const clickId = crypto.randomUUID(); ids.push(clickId);
    await mirror.enqueue({ type: 'click', at: new Date().toISOString(), clickId, campaign, offerId: 'offer-1', asn: connection === 'mobile' ? 21928 : null,
      isp: connection === 'mobile' ? 'T-Mobile USA, Inc.' : null, datacenter: connection ? false : null, connection });
  }
  await mirror.drain();
  const { rows } = await pool.query('SELECT connection, COUNT(*)::int AS n FROM clicks WHERE campaign = $1 GROUP BY 1 ORDER BY 1', [campaign]);
  assert.deepEqual(rows, [{ connection: 'broadband', n: 1 }, { connection: 'mobile', n: 2 }, { connection: null, n: 1 }]);

  const server = await startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN });
  try {
    const call = (path) => fetch(server.url + path, { headers: { authorization: `Bearer ${TOKEN}` } });
    const report = await (await call(`/stats/params?field=connection&campaign=${campaign}`)).json();
    assert.deepEqual(Object.fromEntries(report.rows.map((r) => [r.value, r.clicks])), { mobile: 2, broadband: 1, '': 1 }, 'report reads the column');
    const { clicks } = await (await call(`/api/clicks?campaign=${campaign}`)).json();
    assert.equal(clicks.find((c) => c.clickId === ids[0])?.connection, 'mobile', 'click log returns the column');
  } finally { await server.stop(); }
});
