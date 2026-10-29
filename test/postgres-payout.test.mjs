// G5 in PostgreSQL: payout fields survive a restart with an empty data directory, CPA fallback and CPC click revenue
// are reported from the database. Runs only with TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const TOKEN = 'pg-payout-token';

test('PostgreSQL: offer payout (CPA fallback, CPC per click) persists and is reported', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 30000 }, async (t) => {
  const dirs = [];
  const start = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgpay-')); dirs.push(dir);
    return startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN });
  };
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  const ids = { cpa: `pay-cpa-${run}`, cpc: `pay-cpc-${run}`, cpaCampaign: `pay-a-${run}`, cpcCampaign: `pay-c-${run}` };
  let server = await start();
  const call = (path, body, method = body ? 'POST' : 'GET') => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const click = async (campaign) => new URL((await fetch(`${server.url}/r/${campaign}`, { redirect: 'manual' })).headers.get('location')).searchParams.get('click_id');
  try {
    assert.equal((await call('/api/offers', { id: ids.cpa, url: 'https://cpa.example.com/', payoutType: 'cpa', payout: 12.5, payoutCurrency: 'EUR' })).status, 201);
    assert.equal((await call('/api/offers', { id: ids.cpc, url: 'https://cpc.example.com/', payoutType: 'cpc', payout: 0.4 })).status, 201);
    assert.equal((await call('/api/campaigns', { id: ids.cpaCampaign, name: 'A', streams: [{ name: 'm', offers: [{ offerId: ids.cpa }] }] })).status, 201);
    assert.equal((await call('/api/campaigns', { id: ids.cpcCampaign, name: 'C', streams: [{ name: 'm', offers: [{ offerId: ids.cpc }] }] })).status, 201);
    const cpaClick = await click(ids.cpaCampaign);
    await click(ids.cpcCampaign); await click(ids.cpcCampaign); await click(ids.cpcCampaign);
    assert.equal((await fetch(`${server.url}/postback?click_id=${cpaClick}&secret=conversion-test-secret`)).status, 200);
  } finally { await server.stop(); }

  server = await start();
  try {
    const { offers } = await (await call('/api/offers')).json();
    assert.deepEqual([offers[ids.cpa]?.payoutType, offers[ids.cpa]?.payout, offers[ids.cpa]?.payoutCurrency], ['cpa', 12.5, 'EUR']);
    assert.deepEqual([offers[ids.cpc]?.payoutType, offers[ids.cpc]?.payout], ['cpc', 0.4]);
    const cpa = await (await call(`/stats?campaign=${ids.cpaCampaign}`)).json();
    assert.deepEqual([cpa.conversions, cpa.revenue], [1, 12.5], 'CPA payout used as revenue');
    const cpc = await (await call(`/stats?campaign=${ids.cpcCampaign}`)).json();
    assert.equal(cpc.clicks, 3);
    assert.ok(Math.abs(cpc.revenue - 1.2) < 1e-9, `CPC revenue from clicks.revenue: ${cpc.revenue}`);
    const series = await (await call(`/stats/timeseries?campaign=${ids.cpcCampaign}`)).json();
    assert.ok(Math.abs(series.series.reduce((sum, b) => sum + b.revenue, 0) - 1.2) < 1e-9);
  } finally { await server.stop(); }
});
