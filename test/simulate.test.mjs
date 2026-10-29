import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

test('traffic simulation explains the route and records nothing', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-sim-'));
  const server = await startTestServer(dir);
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const post = (path, body) => fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const simulate = async (body) => (await post('/api/simulate', body)).json();

  await post('/api/offers', { id: 'fr-a', url: 'https://a.example.net/?s={sub_id_1}&c={click_id}' });
  await post('/api/offers', { id: 'fr-b', url: 'https://b.example.net/' });
  await post('/api/campaigns', { id: 'tail', name: 'Tail', streams: [{ name: 'Tail', type: 'fallback', action: 'url', url: 'https://tail.example.net/' }] });
  await post('/api/campaigns', { id: 'sim', name: 'Sim', botFilter: true, paramMap: { sub_id_1: 'ad' }, streams: [
    { name: 'iOS', type: 'forced', conditions: { os: ['ios'] }, action: 'campaign', campaignId: 'tail' },
    { name: 'FR big', weight: 3, conditions: { countries: ['FR'] }, offers: [{ offerId: 'fr-a', weight: 1 }] },
    { name: 'FR small', weight: 1, conditions: { countries: ['FR'] }, offers: [{ offerId: 'fr-b', weight: 1 }] },
    { name: 'Rest', type: 'fallback', action: 'url', url: 'https://rest.example.net/' },
  ] });

  const fr = await simulate({ campaign: 'sim', country: 'FR', userAgent: WINDOWS, query: 'ad=creo7' });
  assert.equal(fr.result.outcome, 'click');
  assert.deepEqual(fr.steps[0].chosen, [{ stream: 'FR big', share: 75 }, { stream: 'FR small', share: 25 }], 'regular streams with their weight shares');
  assert.equal(fr.result.destinations[0].url, 'https://a.example.net/?s=creo7&c=SIMULATION', 'macros and paramMap applied');
  const ios = fr.steps[0].streams.find((s) => s.name === 'iOS');
  assert.deepEqual([ios.matches, ios.checks[0].condition, ios.checks[0].actual], [false, 'ОС', 'windows'], 'explains why a stream did not match');

  const iphone = await simulate({ campaign: 'sim', country: 'FR', userAgent: IPHONE });
  assert.deepEqual(iphone.steps.map((s) => s.campaign), ['sim', 'tail'], 'forced stream hands the click to another campaign');
  assert.equal(iphone.result.destinations[0].url, 'https://tail.example.net/');

  const de = await simulate({ campaign: 'sim', country: 'DE', userAgent: WINDOWS });
  assert.equal(de.result.stream, 'Rest', 'nothing matched → fallback');

  const bot = await simulate({ campaign: 'sim', country: 'FR', userAgent: 'Googlebot/2.1' });
  assert.equal(bot.result.outcome, 'bot', 'bots: same destination, not counted');

  await post('/api/campaigns', { id: 'sim-f', name: 'Filters', paramMap: { keyword: 'q' }, streams: [
    { name: 'FB not iOS', conditions: { referrers: ['facebook.com'], os: ['ios'], keywords: ['ninja'], params: { sub_id_2: ['a'] }, not: ['os'] }, action: 'url', url: 'https://fb.example.net/' },
    { name: 'Rest', type: 'fallback', action: 'url', url: 'https://rest.example.net/' },
  ] });
  const viaFb = await simulate({ campaign: 'sim-f', userAgent: WINDOWS, referrer: 'https://m.facebook.com/story', query: 'q=ninja+pro&sub_id_2=a' });
  assert.equal(viaFb.result.stream, 'FB not iOS', 'referrer, keyword (after paramMap), params and НЕ are simulated');
  const fbChecks = viaFb.steps[0].streams[0].checks;
  assert.deepEqual(fbChecks.map((c) => [c.condition, c.actual, c.ok, c.not || false]), [
    ['ОС', 'windows', true, true], ['реферер', 'm.facebook.com/story', true, false], ['ключевое слово', 'ninja pro', true, false], ['параметр sub_id_2', 'a', true, false]]);
  const iosFb = await simulate({ campaign: 'sim-f', userAgent: IPHONE, referrer: 'https://m.facebook.com/', query: 'q=ninja&sub_id_2=a' });
  assert.equal(iosFb.result.stream, 'Rest', 'НЕ iOS excludes iPhones');
  const noRef = await simulate({ campaign: 'sim-f', userAgent: WINDOWS, query: 'q=ninja&sub_id_2=a' });
  assert.deepEqual([noRef.result.stream, noRef.steps[0].streams[0].checks[1].actual], ['Rest', null], 'no referrer → no match');

  assert.equal((await post('/api/simulate', { campaign: 'nope' })).status, 200);
  const stats = await (await fetch(server.url + '/stats?campaign=sim')).json();
  assert.equal(stats.clicks, 0, 'simulation records no clicks');
});
