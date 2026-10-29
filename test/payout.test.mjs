// G5: offer payout (CPA/CPC). CPA: a postback without revenue earns offer.payout; `payout` is an alias of `revenue`.
// CPC: every counted click earns offer.payout; postbacks set statuses, their amounts are kept but not counted as revenue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

test('offer payout: CPA fallback, payout alias, CPC revenue per click, validation', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-payout-'));
  const server = await startTestServer(dir, { POSTBACK_SECRET: 'payout-secret', ADMIN_TOKEN: 'payout-token' });
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const call = (path, body, method = body ? 'POST' : 'GET') => fetch(server.url + path, { method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer payout-token' }, body: body ? JSON.stringify(body) : undefined });
  const click = async (campaign) => new URL((await fetch(`${server.url}/r/${campaign}`, { redirect: 'manual' })).headers.get('location')).searchParams.get('click_id');
  const postback = (query) => fetch(`${server.url}/postback?secret=payout-secret&${query}`);

  // Validation
  assert.equal((await call('/api/offers', { id: 'bad-type', url: 'https://example.test/o', payoutType: 'cpm' })).status, 400);
  assert.equal((await call('/api/offers', { id: 'bad-payout', url: 'https://example.test/o', payout: -1 })).status, 400);
  assert.equal((await call('/api/offers', { id: 'bad-cur', url: 'https://example.test/o', payout: 1, payoutCurrency: 'euro' })).status, 400);

  // CPA
  assert.equal((await call('/api/offers', { id: 'cpa-offer', url: 'https://example.test/cpa', payoutType: 'cpa', payout: 7.5, payoutCurrency: 'EUR' })).status, 201);
  const { offers } = await (await call('/api/offers')).json();
  assert.deepEqual([offers['cpa-offer'].payoutType, offers['cpa-offer'].payout, offers['cpa-offer'].payoutCurrency], ['cpa', 7.5, 'EUR']);
  assert.equal((await call('/api/campaigns', { id: 'cpa-campaign', name: 'CPA', streams: [{ offers: [{ offerId: 'cpa-offer', weight: 1 }] }] })).status, 201);
  const fallback = await click('cpa-campaign');
  assert.equal((await postback(`click_id=${fallback}`)).status, 200);
  const alias = await click('cpa-campaign');
  assert.equal((await postback(`click_id=${alias}&payout=3`)).status, 200);
  const explicit = await click('cpa-campaign');
  assert.equal((await postback(`click_id=${explicit}&revenue=2&currency=EUR`)).status, 200);
  let stats = await (await call('/stats?campaign=cpa-campaign')).json();
  assert.equal(stats.conversions, 3);
  assert.equal(stats.revenue, 7.5 + 3 + 2, 'fallback 7.5 + alias 3 + explicit 2');
  const log = await (await call('/api/conversions?campaign=cpa-campaign')).json();
  assert.equal(log.conversions.find((c) => c.clickId === fallback).revenue, 7.5);

  // A status update without revenue keeps the amount of the first postback (no second fallback).
  assert.equal((await postback(`click_id=${alias}&status=rejected`)).status, 200);
  stats = await (await call('/stats?campaign=cpa-campaign')).json();
  assert.equal(stats.revenue, 7.5 + 2);

  // PATCH keeps the payout fields unless they are sent
  assert.equal((await call('/api/offers/cpa-offer', { name: 'Renamed' }, 'PATCH')).status, 200);
  assert.equal((await (await call('/api/offers')).json()).offers['cpa-offer'].payout, 7.5);
  assert.equal((await call('/api/offers/cpa-offer', { payoutType: 'x' }, 'PATCH')).status, 400);

  // CPC: revenue on each click, none from the postback fallback
  assert.equal((await call('/api/offers', { id: 'cpc-offer', url: 'https://example.test/cpc', payoutType: 'cpc', payout: 0.25 })).status, 201);
  assert.equal((await call('/api/campaigns', { id: 'cpc-campaign', name: 'CPC', streams: [{ offers: [{ offerId: 'cpc-offer', weight: 1 }] }] })).status, 201);
  const first = await click('cpc-campaign');
  const second = await click('cpc-campaign');
  stats = await (await call('/stats?campaign=cpc-campaign')).json();
  assert.equal(stats.clicks, 2);
  assert.equal(stats.revenue, 0.5);
  assert.equal(stats.byOffer['cpc-offer'].revenue, 0.5);
  assert.equal(stats.conversions, 0);
  assert.equal((await postback(`click_id=${first}`)).status, 200);
  stats = await (await call('/stats?campaign=cpc-campaign')).json();
  assert.equal(stats.revenue, 0.5, 'a CPC offer gets no payout fallback on conversion');
  // A postback with an amount: counted as a sale (then a lead), its amount stays out of revenue and pendingRevenue.
  assert.equal((await postback(`click_id=${second}&revenue=3&currency=USD&status=lead`)).status, 200);
  stats = await (await call('/stats?campaign=cpc-campaign')).json();
  assert.deepEqual([stats.revenue, stats.pendingRevenue, stats.conversions, stats.sales, stats.leads], [0.5, 0, 2, 1, 1], 'CPC revenue comes only from clicks');
  const series = await (await call('/stats/timeseries?campaign=cpc-campaign')).json();
  assert.equal(series.series.reduce((sum, b) => sum + b.revenue, 0), 0.5);
  const params = await (await call('/stats/params?field=sub_id_1&campaign=cpc-campaign')).json();
  assert.equal(params.rows[0].revenue, 0.5);
  const cpcLog = await (await call('/api/conversions?campaign=cpc-campaign')).json();
  assert.deepEqual(cpcLog.conversions.map((c) => [c.clickId === second, c.revenue, c.revenueIgnored]).sort(), [[false, null, true], [true, 3, true]], 'amount kept, marked as ignored');
  const cpa = await (await call('/api/conversions?campaign=cpa-campaign')).json();
  assert.ok(cpa.conversions.every((c) => c.revenueIgnored === false));
});
