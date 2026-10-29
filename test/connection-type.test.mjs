import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionType, MOBILE_ASNS } from '../src/connection-type.js';
import { startTestServer } from './test-server.mjs';

test('connection type classifier: mobile carriers, data centers, mixed carriers count as broadband', () => {
  assert.equal(connectionType({}), null, 'no ASN data → unknown');
  assert.equal(connectionType({ asn: null, isp: null }), null);
  // DB-IP names these after the parent company, so only the ASN list tells them apart.
  assert.equal(connectionType({ asn: 22394, isp: 'Verizon Business' }), 'mobile', 'Verizon Wireless ASN');
  assert.equal(connectionType({ asn: 701, isp: 'Verizon Business' }), 'broadband', 'Verizon wireline ASN');
  assert.equal(connectionType({ asn: 20057, isp: 'AT&T Enterprises, LLC' }), 'mobile', 'AT&T Mobility ASN');
  assert.equal(connectionType({ asn: '21928', isp: 'T-Mobile USA, Inc.' }), 'mobile', 'ASN as string');
  assert.equal(connectionType({ asn: 51207, isp: 'Free Mobile SAS' }), 'mobile');
  assert.equal(connectionType({ asn: 12322, isp: 'Free SAS' }), 'broadband', 'Free fixed line');
  // Name says mobile even without the ASN in the list.
  assert.equal(connectionType({ asn: 1, isp: 'Hutchison 3G UK Limited' }), 'mobile');
  assert.equal(connectionType({ asn: 1, isp: 'Example Cellular Networks' }), 'mobile');
  assert.equal(connectionType({ asn: 1, isp: 'Orange Mobile' }), 'mobile');
  assert.equal(connectionType({ isp: 'Some Wireless Co' }), 'mobile', 'name only');
  // Mixed carriers: one AS for fixed and mobile → broadband.
  for (const isp of ['Orange S.A.', 'Societe Francaise Du Radiotelephone - SFR SA', 'Bouygues Telecom SA', 'Deutsche Telekom AG', 'Mobilink Internet'])
    assert.equal(connectionType({ asn: 1, isp }), 'broadband', isp);
  assert.equal(connectionType({ asn: 16509, isp: 'Amazon.com, Inc.', datacenter: true }), 'datacenter');
  assert.equal(connectionType({ asn: 21928, isp: 'T-Mobile USA, Inc.', datacenter: true }), 'mobile', 'explicit mobile ASN wins');
  assert.ok(MOBILE_ASNS.size >= 5 && [...MOBILE_ASNS.keys()].every(Number.isInteger));
});

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

test('stream condition connections: stored only when set, НЕ, simulation with an injected connection', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-conn-'));
  const server = await startTestServer(dir, { GEOIP_ASN_DB: '' });
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const post = (path, body) => fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const simulate = async (body) => (await post('/api/simulate', body)).json();

  const created = await post('/api/campaigns', { id: 'conn', name: 'Conn', streams: [
    { name: 'mobile', conditions: { connections: ['MOBILE', 'satellite', 'mobile'] }, action: 'url', url: 'https://mobile.example.net/' },
    { name: 'not dc', conditions: { connections: ['datacenter'], not: ['connections'] }, action: 'url', url: 'https://home.example.net/' },
    { name: 'plain', type: 'fallback', action: 'url', url: 'https://rest.example.net/' },
  ], streamRotation: 'position' });
  assert.equal(created.status, 201);
  const streams = (await created.json()).streams;
  assert.deepEqual(streams[0].conditions.connections, ['mobile'], 'normalised, unknown values dropped, deduplicated');
  assert.deepEqual(streams[1].conditions.not, ['connections']);
  assert.ok(!('connections' in streams[2].conditions), 'not stored when unset');

  const mobile = await simulate({ campaign: 'conn', userAgent: WINDOWS, connection: 'mobile' });
  assert.equal(mobile.visitor.connection, 'mobile');
  assert.equal(mobile.result.stream, 'mobile');
  const check = mobile.steps[0].streams[0].checks[0];
  assert.deepEqual([check.condition, check.actual, check.ok], ['тип соединения', 'mobile', true]);

  const home = await simulate({ campaign: 'conn', userAgent: WINDOWS, connection: 'broadband' });
  assert.equal(home.result.stream, 'not dc', 'НЕ datacenter matches broadband');
  const dc = await simulate({ campaign: 'conn', userAgent: WINDOWS, isp: 'Amazon.com, Inc.' });
  assert.deepEqual([dc.visitor.connection, dc.result.stream], ['datacenter', 'plain'], 'connection derived from an explicit ISP name');
  const viaName = await simulate({ campaign: 'conn', userAgent: WINDOWS, isp: 'Free Mobile SAS' });
  assert.equal(viaName.result.stream, 'mobile');

  // Without GEOIP_ASN_DB the type is unknown: the positive condition does not match, the НЕ one does.
  const unknown = await simulate({ campaign: 'conn', userAgent: WINDOWS, ip: '172.56.0.1' });
  assert.deepEqual([unknown.visitor.connection, unknown.result.stream], [null, 'not dc']);
  const live = await fetch(server.url + '/r/conn', { redirect: 'manual', headers: { 'user-agent': WINDOWS } });
  assert.equal(new URL(live.headers.get('location')).host, 'home.example.net', 'live click: unknown connection, НЕ datacenter matches');
  const report = await (await fetch(server.url + '/stats/params?field=connection&campaign=conn')).json();
  assert.deepEqual(report.rows.map((r) => [r.value, r.clicks]), [['', 1]], 'report groups by connection; unknown is empty');
});

// Runs only with a real ASN database: GEOIP_TEST_ASN_DB=/path/to/dbip-asn-lite.mmdb npm test
test('connection type from the ASN database: stored on the click, stream condition, report', { timeout: 15000, skip: !process.env.GEOIP_TEST_ASN_DB && 'set GEOIP_TEST_ASN_DB to run' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-conn-'));
  const server = await startTestServer(dir, { GEOIP_ASN_DB: process.env.GEOIP_TEST_ASN_DB, TRUST_PROXY: '1' });
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const post = (path, body) => fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const hit = (ip) => fetch(server.url + '/r/conn-db', { redirect: 'manual', headers: { 'user-agent': WINDOWS, 'x-forwarded-for': ip } });
  const TMOBILE = '172.56.0.1'; const FREE_MOBILE = '37.164.0.1'; const ORANGE = '80.12.0.1'; const AWS = '52.95.110.1';
  await post('/api/campaigns', { id: 'conn-db', name: 'Conn DB', streams: [
    { name: 'mobile', conditions: { connections: ['mobile'] }, action: 'url', url: 'https://mobile.example.net/' },
    { name: 'rest', type: 'fallback', action: 'url', url: 'https://rest.example.net/' },
  ] });
  for (const [ip, host] of [[TMOBILE, 'mobile.example.net'], [FREE_MOBILE, 'mobile.example.net'], [ORANGE, 'rest.example.net'], [AWS, 'rest.example.net']])
    assert.equal(new URL((await hit(ip)).headers.get('location')).host, host, ip);
  const rows = (await (await fetch(server.url + '/stats/params?field=connection&campaign=conn-db')).json()).rows;
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.value, r.clicks])), { mobile: 2, broadband: 1, datacenter: 1 });
  const sim = await (await post('/api/simulate', { campaign: 'conn-db', userAgent: WINDOWS, ip: TMOBILE })).json();
  assert.deepEqual([sim.visitor.connection, sim.result.stream], ['mobile', 'mobile']);
});
