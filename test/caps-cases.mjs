// Click caps and deduplication under concurrent clicks, shared by test/caps.test.mjs (JSONL) and
// test/postgres-caps.test.mjs (PostgreSQL). 50 clicks arrive at once; a cap of N must let exactly N through.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

const TOKEN = 'caps-test-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runCapCases(t, environment = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-caps-'));
  const server = await startTestServer(dir, { ADMIN_TOKEN: TOKEN, TRUST_PROXY: '1', ...environment });
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  const id = (name) => `${name}-${run}`;
  const api = (path, body, method = 'POST') => fetch(server.url + path, { method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const clicks = async (campaign) => (await (await fetch(`${server.url}/stats?campaign=${campaign}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).clicks;
  // Reports in PostgreSQL mode read the asynchronous mirror: wait until the count settles.
  const settled = async (campaigns, expected) => {
    const total = async () => (await Promise.all([campaigns].flat().map(clicks))).reduce((a, b) => a + b, 0);
    for (let i = 0; i < 40 && await total() !== expected; i++) await sleep(50);
    await sleep(100); // and no extra click shows up afterwards
    return total();
  };
  // 50 distinct visitors at once (different IPs, so deduplication and rate limits do not interfere).
  const burst = async (path, n = 50, ip = (i) => `198.51.100.${i + 1}`) => {
    const codes = {};
    await Promise.all(Array.from({ length: n }, async (_, i) => {
      const r = await fetch(server.url + path, { redirect: 'manual', headers: { 'x-forwarded-for': ip(i), 'user-agent': `Burst ${i}` } });
      await r.arrayBuffer();
      codes[r.status] = (codes[r.status] || 0) + 1;
    }));
    return codes;
  };
  const offer = id('cap-offer');
  assert.equal((await api('/api/offers', { id: offer, url: 'https://example.com/capped' })).status, 201);
  const campaign = async (name, extra) => {
    const res = await api('/api/campaigns', { id: id(name), name, streams: [{ name: 'main', offers: [{ offerId: offer }] }], ...extra });
    assert.equal(res.status, 201, await res.text());
    return id(name);
  };

  await t.test('totalCap: 50 concurrent clicks, cap 10 → exactly 10 recorded, campaign paused', async () => {
    const c = await campaign('total', { totalCap: 10 });
    const codes = await burst(`/r/${c}`);
    assert.equal(codes[302], 10, JSON.stringify(codes));
    assert.equal(codes[302] + (codes[429] || 0) + (codes[404] || 0), 50, JSON.stringify(codes));
    assert.equal(await settled(c, 10), 10);
    const stored = (await (await fetch(`${server.url}/api/campaigns`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).campaigns[c];
    assert.equal(stored.active, false, 'reaching totalCap pauses the campaign');
  });

  await t.test('dailyCap: 50 concurrent clicks, cap 7 → exactly 7 recorded, the rest go to capUrl', async () => {
    const c = await campaign('daily', { dailyCap: 7, capUrl: 'https://example.com/cap-page' });
    const codes = await burst(`/r/${c}`);
    assert.deepEqual(codes, { 302: 50 });
    assert.equal(await settled(c, 7), 7);
    const after = await fetch(`${server.url}/r/${c}`, { redirect: 'manual', headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.equal(after.headers.get('location'), 'https://example.com/cap-page');
  });

  await t.test('offer dailyCap is shared by campaigns: 2 × 25 concurrent clicks, cap 5 → 5 recorded in total', async () => {
    const shared = id('shared-offer');
    assert.equal((await api('/api/offers', { id: shared, url: 'https://example.com/shared', dailyCap: 5 })).status, 201);
    const mk = async (name) => { assert.equal((await api('/api/campaigns', { id: id(name), name, streams: [] })).status, 201); return id(name); };
    const a = await mk('offer-a'), b = await mk('offer-b');
    const [ca, cb] = await Promise.all([burst(`/r/${a}/${shared}`, 25), burst(`/r/${b}/${shared}`, 25, (i) => `198.51.101.${i + 1}`)]);
    assert.equal((ca[302] || 0) + (cb[302] || 0), 5, JSON.stringify({ ca, cb }));
    assert.equal((ca[429] || 0) + (cb[429] || 0), 45);
    assert.equal(await settled([a, b], 5), 5);
  });

  await t.test('dedupeWindow: 20 concurrent clicks from one IP → one click; another IP still counts', async () => {
    const c = await campaign('dedupe', { dedupeWindow: 30 });
    const codes = await burst(`/r/${c}`, 20, () => '192.0.2.50');
    assert.deepEqual(codes, { 302: 20 }, 'duplicates are redirected, just not counted');
    assert.equal(await settled(c, 1), 1);
    const again = await fetch(`${server.url}/r/${c}`, { redirect: 'manual', headers: { 'x-forwarded-for': '192.0.2.50' } });
    assert.ok(!new URL(again.headers.get('location')).searchParams.has('click_id'), 'a duplicate gets no click_id');
    const other = await fetch(`${server.url}/r/${c}`, { redirect: 'manual', headers: { 'x-forwarded-for': '192.0.2.51' } });
    assert.ok(new URL(other.headers.get('location')).searchParams.has('click_id'));
    assert.equal(await settled(c, 2), 2);
  });

  await t.test('geoCapUrl: a visitor from a country outside allowGeos goes to geoCapUrl (simulation)', async () => {
    const c = await campaign('geo', { allowGeos: ['DE'], geoCapUrl: 'https://example.com/other-geo' });
    const sim = async (country) => (await (await api('/api/simulate', { campaign: c, country, userAgent: 'Mozilla/5.0' })).json()).result;
    const foreign = await sim('FR');
    assert.equal(foreign.outcome, 'redirect');
    assert.equal(foreign.url, 'https://example.com/other-geo');
    assert.notEqual((await sim('DE')).url, 'https://example.com/other-geo');
  });

  return server;
}
