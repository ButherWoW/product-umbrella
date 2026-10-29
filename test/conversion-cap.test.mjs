import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { localMidnight, resolveOffer, createConversionCapCounter } from '../src/conversion-cap.js';

const SECRET = 'conversion-test-secret';

test('local midnight in the cap time zone, DST included', () => {
  assert.equal(localMidnight('UTC', new Date('2026-10-30T15:00:00Z')).toISOString(), '2026-10-30T00:00:00.000Z');
  // 00:30 in Paris (UTC+1 in winter) is already the next local day while it is still 23:30 UTC.
  assert.equal(localMidnight('Europe/Paris', new Date('2026-11-02T23:30:00Z')).toISOString(), '2026-11-02T23:00:00.000Z');
  assert.equal(localMidnight('Europe/Paris', new Date('2026-11-02T22:59:00Z')).toISOString(), '2026-11-01T23:00:00.000Z');
  assert.equal(localMidnight('America/New_York', new Date('2026-07-01T03:00:00Z')).toISOString(), '2026-06-30T04:00:00.000Z');
  // DST change day in Paris (29 March 2026: 02:00 → 03:00): midnight was still UTC+1.
  assert.equal(localMidnight('Europe/Paris', new Date('2026-03-29T20:00:00Z')).toISOString(), '2026-03-28T23:00:00.000Z');
});

test('alternative chain: substitution, hops, loops and unusable alternatives', () => {
  const offers = { a: { alt: 'b', state: 'conversion_cap' }, b: { alt: 'c', state: 'conversion_cap' }, c: { state: null },
    x: { alt: 'y', state: 'conversion_cap' }, y: { alt: 'x', state: 'conversion_cap' },
    p: { alt: 'q', state: 'conversion_cap' }, q: { alt: 'r', state: 'archived' }, r: { state: null },
    k: { alt: 'b', state: 'click_cap' }, m: { alt: 'gone', state: 'conversion_cap' },
    h1: { alt: 'h2', state: 'conversion_cap' }, h2: { alt: 'h3', state: 'conversion_cap' }, h3: { alt: 'h4', state: 'conversion_cap' }, h4: { alt: 'h5', state: 'conversion_cap' }, h5: { state: null } };
  const deps = { stateOf: (id) => (offers[id] ? offers[id].state : 'missing'), altOf: (id) => offers[id]?.alt || null };
  assert.equal(resolveOffer('c', deps).offerId, 'c');
  assert.deepEqual(resolveOffer('a', deps), { offerId: 'c', reason: 'conversion_cap', path: ['a', 'b', 'c'] }, 'chain of two');
  assert.equal(resolveOffer('x', deps).offerId, null, 'loop x → y → x has no usable offer');
  assert.equal(resolveOffer('p', deps).offerId, 'r', 'archived alternative is skipped');
  assert.deepEqual(resolveOffer('k', deps), { offerId: null, reason: 'click_cap', path: ['k'] }, 'click cap does not use the alternative');
  assert.equal(resolveOffer('m', deps).offerId, null, 'missing alternative');
  assert.equal(resolveOffer('h1', deps).offerId, null, 'more than three hops');
  assert.equal(resolveOffer('h2', deps).offerId, 'h5', 'three hops are fine');
});

test('JSONL count: lead + sale since local midnight, latest status wins, cached', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-capcount-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl');
  const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
  const lines = [
    { type: 'click', clickId: id(1), offerId: 'o1', at: '2026-11-02T20:00:00Z' },
    { type: 'click', clickId: id(2), offerId: 'o1', at: '2026-11-02T20:00:00Z' },
    { type: 'click', clickId: id(3), offerId: 'o1', at: '2026-11-02T20:00:00Z' },
    { type: 'click', clickId: id(4), offerId: 'o1', at: '2026-11-02T20:00:00Z' },
    { type: 'click', clickId: id(5), offerId: 'o2', at: '2026-11-02T20:00:00Z' },
    { type: 'conversion', clickId: id(1), at: '2026-11-02T22:30:00Z' }, // before Paris midnight (23:00Z)
    { type: 'conversion', clickId: id(2), status: 'lead', at: '2026-11-02T23:10:00Z' },
    { type: 'conversion', clickId: id(3), status: 'sale', at: '2026-11-02T23:20:00Z' },
    { type: 'conversion', clickId: id(4), status: 'sale', at: '2026-11-02T23:21:00Z' },
    { type: 'conversion', clickId: id(4), status: 'rejected', at: '2026-11-02T23:22:00Z' },
    { type: 'conversion', clickId: id(5), status: 'sale', at: '2026-11-02T23:23:00Z' },
  ];
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  let now = new Date('2026-11-02T23:30:00Z');
  const counter = createConversionCapCounter({ eventsFile: file, now: () => now });
  assert.equal(await counter.count('o1', 'Europe/Paris'), 2, 'lead + sale after local midnight; rejected and yesterday excluded');
  assert.equal(await counter.count('o1', 'UTC'), 3, 'UTC day starts earlier');
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n' + JSON.stringify({ type: 'conversion', clickId: id(1), status: 'rejected', at: '2026-11-02T23:25:00Z' }) + '\n');
  assert.equal(await counter.count('o1', 'UTC'), 3, 'cached for 30 s');
  counter.invalidate('o1');
  assert.equal(await counter.count('o1', 'UTC'), 2, 'recounted after invalidation');
  now = new Date('2026-11-03T23:30:00Z');
  assert.equal(await counter.count('o1', 'Europe/Paris'), 0, 'next local day starts from zero');
});

test('conversion cap sends traffic to the alternative offer', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-convcap-'));
  const server = await startTestServer(dir);
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const send = (path, body, method = 'POST') => fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const click = async (path) => {
    const response = await fetch(server.url + path, { redirect: 'manual' });
    if (response.status !== 302) return { status: response.status, body: await response.json() };
    const location = new URL(response.headers.get('location'));
    return { status: 302, host: location.hostname, clickId: location.searchParams.get('click_id') };
  };
  const postback = (clickId, status = 'sale') => fetch(`${server.url}/postback?click_id=${clickId}&secret=${SECRET}&status=${status}`);

  for (const id of ['main', 'alt1', 'alt2']) assert.equal((await send('/api/offers', { id, url: `https://${id}.example.net/` })).status, 201);
  assert.equal((await send('/api/offers/main', { conversionCap: 1, capTz: 'Europe/Paris', altOfferId: 'alt1' }, 'PATCH')).status, 200);
  assert.equal((await send('/api/offers/main', { conversionCap: 0 }, 'PATCH')).status, 400, 'cap must be ≥ 1');
  assert.equal((await send('/api/offers/main', { capTz: 'Mars/Olympus' }, 'PATCH')).status, 400, 'unknown time zone');
  assert.equal((await send('/api/offers/main', { altOfferId: 'nope' }, 'PATCH')).status, 400, 'unknown alternative');
  assert.equal((await send('/api/offers/main', { altOfferId: 'main' }, 'PATCH')).status, 400, 'offer cannot be its own alternative');
  const { offers } = await (await fetch(server.url + '/api/offers')).json();
  assert.deepEqual([offers.main.conversionCap, offers.main.capTz, offers.main.altOfferId], [1, 'Europe/Paris', 'alt1']);
  assert.equal(offers.alt1.capTz, 'UTC', 'default time zone');

  await send('/api/campaigns', { id: 'cc', name: 'Cap', streams: [{ name: 'Main', offers: [{ offerId: 'main', weight: 1 }] }] });
  const first = await click('/r/cc');
  assert.equal(first.host, 'main.example.net');
  assert.equal((await postback(first.clickId, 'lead')).status, 200);
  const second = await click('/r/cc');
  assert.equal(second.host, 'alt1.example.net', 'a lead counts: cap 1 reached → alternative');
  const log = await (await fetch(server.url + '/api/clicks?campaign=cc')).json();
  assert.equal(log.clicks.find((c) => c.clickId === second.clickId).offerId, 'alt1', 'click recorded with the offer actually used');
  assert.equal((await click('/r/cc/main')).host, 'alt1.example.net', 'explicit offer route uses the alternative too');

  // A rejected conversion no longer counts: the offer is open again.
  assert.equal((await postback(first.clickId, 'rejected')).status, 200);
  assert.equal((await click('/r/cc')).host, 'main.example.net');
  assert.equal((await postback(first.clickId, 'sale')).status, 200);

  // Chain of two: alt1 is capped too → alt2.
  await send('/api/offers/alt1', { conversionCap: 1, altOfferId: 'alt2' }, 'PATCH');
  assert.equal((await postback(second.clickId)).status, 200);
  const third = await click('/r/cc');
  assert.equal(third.host, 'alt2.example.net', 'main → alt1 → alt2');

  const sim = await (await send('/api/simulate', { campaign: 'cc' })).json();
  assert.deepEqual(sim.steps[0].streams[0].cappedOffers, [{ offerId: 'main', reason: 'conversion_cap', altOfferId: 'alt2' }]);
  assert.deepEqual(sim.result.destinations.map((d) => [d.offerId, d.insteadOf, d.share]), [['alt2', 'main', 100]]);

  // Loop: alt2 → main, everything capped → the stream behaves as if the offer were capped.
  await send('/api/offers/alt2', { conversionCap: 1, altOfferId: 'main' }, 'PATCH');
  assert.equal((await postback(third.clickId)).status, 200);
  const looped = await click('/r/cc');
  assert.deepEqual([looped.status, looped.body.error], [404, 'no_matching_stream'], 'loop main → alt1 → alt2 → main has no usable offer');
  const explicit = await click('/r/cc/main');
  assert.deepEqual([explicit.status, explicit.body.error], [429, 'offer_conversion_cap_reached']);
  const simLoop = await (await send('/api/simulate', { campaign: 'cc' })).json();
  assert.equal(simLoop.result.outcome, 'no_stream');
  assert.deepEqual(simLoop.steps[0].streams[0].cappedOffers, [{ offerId: 'main', reason: 'conversion_cap', altOfferId: null }]);

  // Without an alternative a fallback stream takes the traffic.
  await send('/api/offers/main', { altOfferId: null }, 'PATCH');
  await send('/api/offers', { id: 'spare', url: 'https://spare.example.net/' });
  await send('/api/campaigns/cc/streams', { streams: [{ name: 'Main', offers: [{ offerId: 'main' }] }, { name: 'Spare', type: 'fallback', offers: [{ offerId: 'spare' }] }] }, 'PUT');
  assert.equal((await click('/r/cc')).host, 'spare.example.net');
});
