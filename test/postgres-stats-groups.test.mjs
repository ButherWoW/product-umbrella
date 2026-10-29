// G2/G3/G4: unique clicks in the parameter report, bySource/byNetwork groups and their CSV export,
// bot events in PostgreSQL. JSONL always; the same checks against PostgreSQL when TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

const TOKEN = 'stats-groups-token';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0';

async function scenario(t, env) {
  const dirs = [];
  const start = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-groups-')); dirs.push(dir);
    return startTestServer(dir, { ADMIN_TOKEN: TOKEN, ...env });
  };
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  const id = (name) => `${name}-${run}`;
  let server = await start();
  const call = (path, body) => fetch(server.url + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const hit = (campaign, ua, query = '') => fetch(`${server.url}/r/${campaign}${query}`, { redirect: 'manual', headers: { 'user-agent': ua } });
  try {
    assert.equal((await call('/api/sources', { id: id('fb'), name: 'Facebook' })).status, 201);
    assert.equal((await call('/api/sources', { id: id('tt'), name: 'TikTok' })).status, 201);
    assert.equal((await call('/api/networks', { id: id('net'), name: 'Net' })).status, 201);
    assert.equal((await call('/api/offers', { id: id('off'), url: 'https://example.com/o', networkId: id('net') })).status, 201);
    for (const [camp, source] of [['a', 'fb'], ['b', 'tt']]) {
      assert.equal((await call('/api/campaigns', { id: id(camp), name: camp, sourceId: id(source), botFilter: true, streams: [{ name: 'm', offers: [{ offerId: id('off') }] }] })).status, 201);
    }
    // Campaign a: 2 clicks from the same browser (1 unique) + 1 from another browser; campaign b: 1 click.
    const first = await hit(id('a'), CHROME, '?sub_id_1=x');
    await hit(id('a'), CHROME, '?sub_id_1=x');
    await hit(id('a'), FIREFOX, '?sub_id_1=x');
    await hit(id('b'), CHROME);
    await hit(id('a'), 'Googlebot/2.1');
    const clickId = new URL(first.headers.get('location')).searchParams.get('click_id');
    assert.equal((await fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${clickId}&revenue=10&currency=EUR`)).status, 200);

    const params = await (await call(`/stats/params?field=sub_id_1&campaign=${id('a')}`)).json();
    assert.deepEqual([params.rows[0].value, params.rows[0].clicks, params.rows[0].uniqueClicks], ['x', 3, 2], 'G2: unique clicks in the parameter report');

    const check = async () => {
      const s = await (await call('/stats')).json();
      assert.deepEqual([s.bySource[id('fb')]?.clicks, s.bySource[id('fb')]?.revenue, s.bySource[id('tt')]?.clicks], [3, 10, 1], 'G4: bySource');
      assert.deepEqual([s.byNetwork[id('net')]?.clicks, s.byNetwork[id('net')]?.conversions], [4, 1], 'G4: byNetwork');
      const csv = await (await call('/stats/export?format=csv&group=source')).text();
      assert.ok(csv.split('\n').some((line) => line.startsWith(id('fb')) && line.includes(',3,')), 'G4: CSV export by source');
      const bots = await (await call(`/stats/bots?campaign=${id('a')}`)).json();
      assert.equal(bots.byCampaign[id('a')], 1, 'G3: bot counted');
    };
    await check();
    if (env.DATABASE_URL) {
      // Fresh data directory: everything must come back from PostgreSQL.
      await server.stop();
      server = await start();
      await check();
    }
  } finally { await server.stop(); }
}

test('stats groups, unique param clicks and bots (JSONL)', { timeout: 30000 }, (t) => scenario(t, {}));
test('stats groups, unique param clicks and bots (PostgreSQL, survives restart)', { timeout: 30000, skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to run' },
  (t) => scenario(t, { DATABASE_URL: process.env.TEST_DATABASE_URL, REQUIRE_POSTGRES: '1' }));
