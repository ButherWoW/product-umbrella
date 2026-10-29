import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { createBindingStore, boundChoice, streamRef, parseBindMode, parseBindTtl } from '../src/visitor-binding.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const OTHER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

test('binding store: TTL from the last visit, LRU bound, validity rules', () => {
  const store = createBindingStore({ limit: 2 });
  const hour = 3600 * 1000;
  const t0 = Date.UTC(2026, 0, 1);
  store.set('a', { stream: { index: 0, name: 'A' } }, t0);
  assert.ok(store.get('a', 2 * hour, t0 + hour), 'inside TTL');
  assert.equal(store.get('a', 2 * hour, t0 + 2 * hour), null, 'TTL elapsed');
  store.set('a', { stream: { index: 0, name: 'A' } }, t0 + 2 * hour);
  assert.ok(store.get('a', 2 * hour, t0 + 3 * hour), 'a new visit restarts the TTL');
  store.set('b', {}, t0); store.set('c', {}, t0);
  assert.equal(store.size, 2, 'LRU bound');
  assert.equal(store.get('a', 2 * hour, t0 + 3 * hour), null, 'oldest evicted');

  assert.equal(parseBindMode('nope'), 'off');
  assert.equal(parseBindTtl(0), 24); assert.equal(parseBindTtl(721), 24); assert.equal(parseBindTtl(5), 5);

  const streams = [{ name: 'A', offers: [{ offerId: 'o1', weight: 1 }, { offerId: 'o2', weight: 1 }] }, { name: 'B', offers: [{ offerId: 'o3', weight: 1 }] }];
  const first = (list) => list[0];
  const binding = { stream: streamRef(streams, streams[0]), offerId: 'o2', landingId: null };
  const args = { binding, streams, matches: () => true, pickOffer: first, pickLanding: first };
  assert.equal(boundChoice({ ...args, mode: 'off' }), null);
  assert.equal(boundChoice({ ...args, mode: 'stream' }).offerId, 'o1', 'stream mode re-picks the offer');
  assert.equal(boundChoice({ ...args, mode: 'stream_offer' }).offerId, 'o2', 'stream_offer keeps the offer');
  assert.equal(boundChoice({ ...args, mode: 'stream_offer', excluded: new Set(['o2']) }), null, 'capped bound offer → rebind');
  assert.equal(boundChoice({ ...args, mode: 'stream', excluded: new Set(['o2']) }).offerId, 'o1', 'stream mode survives a capped offer');
  assert.equal(boundChoice({ ...args, mode: 'stream', matches: () => false }), null, 'conditions no longer match');
  assert.equal(boundChoice({ ...args, mode: 'stream', streams: [{ ...streams[0], enabled: false }, streams[1]] }), null, 'disabled');
  assert.equal(boundChoice({ ...args, mode: 'stream', streams: [streams[1], streams[0]] }), null, 'reordered streams drop the binding');
});

test('visitor binding over HTTP: sticky stream, rebind on disable, simulate reports it', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-bind-'));
  const server = await startTestServer(dir);
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const send = (path, body, method = 'POST') => fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const hit = async (campaign, ua = UA) => {
    const res = await fetch(`${server.url}/r/${campaign}`, { redirect: 'manual', headers: { 'user-agent': ua } });
    assert.equal(res.status, 302);
    return new URL(res.headers.get('location')).hostname;
  };
  const hits = async (campaign, n = 20, ua = UA) => { const out = new Set(); for (let i = 0; i < n; i++) out.add(await hit(campaign, ua)); return out; };

  await send('/api/offers', { id: 'oa', url: 'https://a.example.net/' });
  await send('/api/offers', { id: 'ob', url: 'https://b.example.net/' });
  await send('/api/offers', { id: 'oc', url: 'https://c.example.net/' });
  const streams = [
    { name: 'A', weight: 1, offers: [{ offerId: 'oa', weight: 1 }] },
    { name: 'B', weight: 1, offers: [{ offerId: 'ob', weight: 1 }] },
  ];
  assert.equal((await send('/api/campaigns', { id: 'free', name: 'Free', streams })).status, 201);
  assert.equal((await send('/api/campaigns', { id: 'sticky', name: 'Sticky', bindVisitors: 'stream', bindTtlHours: 2, streams })).status, 201);
  const saved = (await (await fetch(server.url + '/api/campaigns')).json()).campaigns;
  assert.deepEqual([saved.free.bindVisitors, saved.free.bindTtlHours, saved.sticky.bindVisitors, saved.sticky.bindTtlHours], ['off', 24, 'stream', 2]);

  // Off: 20 hits at 50/50 spread over both streams (all on one: probability 2^-19).
  assert.equal((await hits('free')).size, 2, 'without binding the same visitor rotates');
  const sticky = await hits('sticky');
  assert.equal(sticky.size, 1, 'with binding all 20 hits land on one stream');
  const boundHost = [...sticky][0];
  const boundName = boundHost === 'a.example.net' ? 'A' : 'B';

  // Simulation shows the binding only for a concrete visitor (ip + userAgent).
  const sim = await (await send('/api/simulate', { campaign: 'sticky', ip: '127.0.0.1', userAgent: UA })).json();
  assert.equal(sim.steps[0].binding.applies, true);
  assert.equal(sim.steps[0].binding.stream, boundName);
  assert.deepEqual(sim.steps[0].chosen, [{ stream: boundName, share: 100 }]);
  assert.equal(sim.result.stream, boundName);
  const stranger = await (await send('/api/simulate', { campaign: 'sticky', ip: '127.0.0.1', userAgent: OTHER_UA })).json();
  assert.equal(stranger.steps[0].binding.applies, false, 'another browser has no binding');
  const anonymous = await (await send('/api/simulate', { campaign: 'sticky' })).json();
  assert.equal(anonymous.steps[0].binding, undefined, 'no ip/userAgent → binding not evaluated');
  const later = await (await send('/api/simulate', { campaign: 'sticky', ip: '127.0.0.1', userAgent: UA, at: new Date(Date.now() + 3 * 3600 * 1000).toISOString() })).json();
  assert.equal(later.steps[0].binding.applies, false, 'TTL (2h) elapsed at the simulated time');

  // Bound stream disabled → normal selection and the visitor is rebound to the other stream.
  const disabled = streams.map((s) => (s.name === boundName ? { ...s, enabled: false } : s));
  assert.equal((await send('/api/campaigns/sticky', { streams: disabled }, 'PATCH')).status, 200);
  const rebound = await hits('sticky', 5);
  assert.equal(rebound.size, 1);
  assert.notEqual([...rebound][0], boundHost, 'rebound to the remaining stream');
  // Re-enabled: the new binding holds (it was updated), the visitor stays on the new stream.
  assert.equal((await send('/api/campaigns/sticky', { streams }, 'PATCH')).status, 200);
  assert.deepEqual(await hits('sticky', 10), rebound, 'binding was updated to the new stream');

  // stream_offer: the same offer inside a multi-offer stream; an archived bound offer rebinds.
  await send('/api/campaigns', { id: 'sticky-offer', name: 'Sticky offer', bindVisitors: 'stream_offer',
    streams: [{ name: 'Mix', offers: [{ offerId: 'oa', weight: 1 }, { offerId: 'oc', weight: 1 }] }] });
  const offerHits = await hits('sticky-offer');
  assert.equal(offerHits.size, 1, 'same offer every time');
  const boundOffer = [...offerHits][0] === 'a.example.net' ? 'oa' : 'oc';
  const simOffer = await (await send('/api/simulate', { campaign: 'sticky-offer', ip: '127.0.0.1', userAgent: UA })).json();
  assert.equal(simOffer.steps[0].binding.offerId, boundOffer);
  assert.deepEqual(simOffer.result.destinations.map((d) => d.offerId), [boundOffer]);
  assert.equal((await send(`/api/offers/${boundOffer}`, { archived: true }, 'PATCH')).status, 200);
  const afterArchive = await hits('sticky-offer', 5);
  assert.deepEqual(afterArchive, new Set([boundOffer === 'oa' ? 'c.example.net' : 'a.example.net']), 'archived offer → rebound to the other offer');
});
