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
