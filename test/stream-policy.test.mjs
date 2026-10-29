// No-cloaking policy: streams may not send bots, ad reviewers or data centers somewhere else than people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloakingCondition, streamPolicyError } from '../src/stream-policy.js';
import { startTestServer } from './test-server.mjs';

test('cloakingCondition: data centers, bot/reviewer User-Agents, ad-platform and cloud ISPs (also under НЕ)', () => {
  for (const conditions of [
    { connections: ['datacenter'] }, { connections: ['datacenter'], not: ['connections'] }, { connections: ['mobile', 'broadband'] },
    { userAgents: ['facebookexternalhit'] }, { userAgents: ['googlebot'] }, { userAgents: ['adsbot-google'] }, { userAgents: ['bingbot'] },
    { userAgents: ['bytespider'] }, { userAgents: ['tiktok'] }, { userAgents: ['crawler'] }, { userAgents: ['headlesschrome'] }, { userAgents: ['google'] },
    { userAgents: ['meta-externalagent'], not: ['userAgents'] },
    { isps: ['facebook'] }, { isps: ['meta'] }, { isps: ['google'] }, { isps: ['microsoft'] }, { isps: ['amazon'] }, { isps: ['tiktok'] },
    { isps: ['bytedance'] }, { isps: ['apple'] }, { isps: ['cloudflare'] }, { isps: ['digitalocean'] }, { isps: ['ovh'] }, { isps: ['hetzner'] },
    { isps: ['orange', 'hosting'] }, { isps: ['google'], not: ['isps'] },
  ]) assert.ok(cloakingCondition(conditions), JSON.stringify(conditions));
  for (const conditions of [
    {}, undefined, { connections: ['mobile'] }, { connections: ['broadband'] }, { connections: ['mobile'], not: ['connections'] },
    { userAgents: ['iphone os 17', 'fban', 'chrome', 'safari', 'android'] }, { isps: ['orange', 'free mobile', 'sfr', 'bouygues', 'vodafone', 'comcast'] },
    { countries: ['FR'], devices: ['mobile'], referrers: ['facebook.com'] },
  ]) assert.equal(cloakingCondition(conditions), null, JSON.stringify(conditions));
  const err = streamPolicyError([{ name: 'ok', conditions: {} }, { name: 'Боты', conditions: { userAgents: ['Googlebot'] } }]);
  assert.deepEqual([err.error, err.stream, err.condition], ['cloaking_condition_not_allowed', 'Боты', 'userAgents']);
  assert.match(err.message, /клоакинг не допускается/);
  assert.equal(streamPolicyError([{ name: 'x', enabled: false, disabledBy: 'policy', conditions: { isps: ['google'] } }]), null, 'a stream switched off by the policy may stay');
});

test('cloaking streams are refused on save (POST, PATCH, PUT streams)', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-policy-'));
  const server = await startTestServer(dir);
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const send = async (method, path, body) => { const r = await fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const cloak = { name: 'Reviewers', type: 'forced', conditions: { userAgents: ['facebookexternalhit'] }, action: 'url', url: 'https://white.example.net/' };
  const people = { name: 'People', conditions: { countries: ['FR'] }, action: 'url', url: 'https://shop.example.net/' };

  const created = await send('POST', '/api/campaigns', { id: 'pol', name: 'Pol', streams: [people, cloak] });
  assert.deepEqual([created.status, created.json.error, created.json.stream], [400, 'cloaking_condition_not_allowed', 'Reviewers']);
  assert.match(created.json.message, /Поток «Reviewers»/);
  assert.equal((await send('POST', '/api/campaigns', { id: 'pol', name: 'Pol', streams: [people] })).status, 201);
  const patched = await send('PATCH', '/api/campaigns/pol', { streams: [people, { ...cloak, conditions: { isps: ['Google'], not: ['isps'] } }] });
  assert.deepEqual([patched.status, patched.json.condition], [400, 'isps']);
  const put = await send('PUT', '/api/campaigns/pol/streams', { streams: [{ ...cloak, conditions: { connections: ['datacenter'] } }] });
  assert.deepEqual([put.status, put.json.condition], [400, 'connections']);
  assert.equal((await send('PATCH', '/api/campaigns/pol', { name: 'Renamed' })).status, 200, 'campaign edits without streams are unaffected');
  const stored = (await (await fetch(server.url + '/api/campaigns')).json()).campaigns.pol;
  assert.deepEqual(stored.streams.map((s) => s.name), ['People'], 'nothing was saved');
  // The panel's copy of the rule is the same module.
  const asset = await fetch(server.url + '/admin/stream-policy.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(await asset.text(), /export function cloakingCondition/);
});

test('stored campaigns with cloaking streams: kept, switched off with the reason, audited once', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'campaigns.json'), JSON.stringify({ legacy: { name: 'Legacy', active: true, streams: [
    { name: 'Bots', type: 'forced', conditions: { userAgents: ['googlebot'] }, action: 'url', url: 'https://white.example.net/' },
    { name: 'People', type: 'regular', conditions: {}, action: 'url', url: 'https://shop.example.net/' },
  ] } }));
  let server = await startTestServer(dir);
  const read = async () => (await (await fetch(server.url + '/api/campaigns')).json()).campaigns.legacy;
  const c = await read();
  assert.equal(c.streams.length, 2, 'the stream is kept');
  assert.deepEqual([c.streams[0].enabled, c.streams[0].disabledBy], [false, 'policy']);
  assert.match(c.streams[0].disabledReason, /User-Agent.*googlebot/);
  assert.ok(!('enabled' in c.streams[1]), 'other streams untouched');
  const hit = await fetch(server.url + '/r/legacy', { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } });
  assert.equal(new URL(hit.headers.get('location')).host, 'shop.example.net', 'the bot now gets what people get');
  const audit = (await (await fetch(server.url + '/api/audit?entity=campaign&id=legacy')).json()).entries;
  assert.equal(audit.filter((e) => e.action === 'disable_stream' && e.actor === 'system').length, 1);
  // The rest of the campaign stays editable with the switched-off stream in it; switching it back on is refused.
  const save = (streams) => fetch(server.url + '/api/campaigns/legacy', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Legacy 2', streams }) });
  assert.equal((await save(c.streams)).status, 200);
  const { enabled, disabledBy, disabledReason, ...on } = c.streams[0];
  assert.equal((await save([on, c.streams[1]])).status, 400);
  await server.stop();
  // A restart does not audit again.
  server = await startTestServer(dir);
  t.after(() => server.stop());
  assert.equal((await read()).streams[0].disabledBy, 'policy');
  const again = (await (await fetch(server.url + '/api/audit?entity=campaign&id=legacy')).json()).entries;
  assert.equal(again.filter((e) => e.action === 'disable_stream').length, 1);
  assert.ok(JSON.parse(await readFile(join(dir, 'campaigns.json'), 'utf8')).legacy.streams[0].disabledReason, 'persisted');
});
