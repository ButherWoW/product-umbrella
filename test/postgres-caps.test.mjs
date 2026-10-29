// Same cases as test/caps.test.mjs against a real PostgreSQL (runs only with TEST_DATABASE_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { runCapCases } from './caps-cases.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL: click caps and deduplication hold under 50 concurrent clicks', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 60000 },
  (t) => runCapCases(t, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1' }));

// After a restart with an empty data directory the counters are seeded from PostgreSQL, not the (empty) journal.
test('PostgreSQL: caps and deduplication count clicks recorded before a restart', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 60000 }, async (t) => {
  const dirs = [];
  const start = async () => { const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgcap-')); dirs.push(dir);
    return startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: 'pgcap', TRUST_PROXY: '1' }); };
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  const offer = `pgcap-offer-${run}`, campaign = `pgcap-${run}`;
  const hit = (server, ip) => fetch(`${server.url}/r/${campaign}`, { redirect: 'manual', headers: { 'x-forwarded-for': ip } });
  let server = await start();
  try {
    const api = (path, body) => fetch(server.url + path, { method: 'POST', headers: { authorization: 'Bearer pgcap', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await api('/api/offers', { id: offer, url: 'https://example.com/pgcap' })).status, 201);
    assert.equal((await api('/api/campaigns', { id: campaign, name: 'pg cap', totalCap: 3, dedupeWindow: 60, streams: [{ name: 'main', offers: [{ offerId: offer }] }] })).status, 201);
    for (const ip of ['192.0.2.1', '192.0.2.2']) assert.ok(new URL((await hit(server, ip)).headers.get('location')).searchParams.has('click_id'));
  } finally { await server.stop(); }
  server = await start();
  try {
    const repeat = await hit(server, '192.0.2.1');
    assert.ok(!new URL(repeat.headers.get('location')).searchParams.has('click_id'), 'the IP clicked before the restart: duplicate');
    const codes = {};
    await Promise.all(Array.from({ length: 10 }, async (_, i) => { const r = await hit(server, `198.51.100.${i + 10}`); codes[r.status] = (codes[r.status] || 0) + 1; }));
    assert.equal(codes[302], 1, `only one click left under totalCap 3: ${JSON.stringify(codes)}`);
  } finally { await server.stop(); }
});
