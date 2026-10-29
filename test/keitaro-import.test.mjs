import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUrl, convertUrl } from '../scripts/import-keitaro-offers.mjs';
import { startTestServer } from './test-server.mjs';

test('Keitaro offer URL + network params are converted to Umbrella macros', () => {
  const url = buildUrl('https://net.example/o/1?x=1', 'source_id={campaign_id}&sub1={subid}&sub10={sub_id_10}&adv1={sub_id_17}&os={os}');
  assert.equal(url, 'https://net.example/o/1?x=1&source_id={campaign_id}&sub1={subid}&sub10={sub_id_10}&adv1={sub_id_17}&os={os}');
  const { url: converted, dropped } = convertUrl(url);
  assert.equal(converted, 'https://net.example/o/1?x=1&source_id={campaign}&sub1={click_id}&sub10={sub_id_10}&adv1={sub_id_17}&os=');
  assert.deepEqual(dropped, ['os']);
  assert.equal(buildUrl('https://a.example/', ''), 'https://a.example/');
  assert.equal(buildUrl('https://a.example/p', '?s={subid}'), 'https://a.example/p?s={subid}');
  assert.equal(buildUrl('https://a.example/p?', 's=1'), 'https://a.example/p?s=1');
});

test('offers keep a name through create, update and listing', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-offer-name-'));
  const server = await startTestServer(dir);
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const send = (path, body, method = 'POST') => fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send('/api/offers', { id: 'kt-313', name: 'Global - Dynamic Special Flow [#2211][19.99€]', url: 'https://n.example/?s={click_id}' })).status, 201);
  assert.equal((await (await fetch(server.url + '/api/offers')).json()).offers['kt-313'].name, 'Global - Dynamic Special Flow [#2211][19.99€]');
  await send('/api/offers/kt-313', { url: 'https://n.example/v2' }, 'PATCH');
  assert.equal((await (await fetch(server.url + '/api/offers')).json()).offers['kt-313'].name, 'Global - Dynamic Special Flow [#2211][19.99€]', 'PATCH without name keeps it');
  await send('/api/offers/kt-313', { name: 'Renamed' }, 'PATCH');
  assert.equal((await (await fetch(server.url + '/api/offers')).json()).offers['kt-313'].name, 'Renamed');
});
