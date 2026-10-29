import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { probe, isPrivateAddress, expandForCheck, displayUrl } from '../src/monitor.js';

// Offers must be https, so the fake offer site serves TLS with this throwaway self-signed certificate for 127.0.0.1
// (test-only key, valid until 2126). The tracker trusts it through NODE_EXTRA_CA_CERTS.
const CERT = `-----BEGIN CERTIFICATE-----
MIIBbjCCARWgAwIBAgIUZXTMqTqZBOIjXedst3qhaeND3vQwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAyOTIwMzc0NVoYDzIxMjYxMDA1
MjAzNzQ1WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAT021rddRJiq+LRCkEY0a1p+BWGBkXavFM2vLfd8hMBBzvQwQCO1wix
22/DuOZZQoLH0yubctQC+quznheXx7Bko0MwQTAdBgNVHQ4EFgQUgO7yxQd+ZxGC
TKztBc9j8FenUgowDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMAoG
CCqGSM49BAMCA0cAMEQCIAb3PgbpbjX6YdIyf1RPcD+9dZZuqtPP4gCXY7GO+/aE
AiA0OMRETlY2Hr1L0hJWtPuFnbQb2EXR6dlZFP/3vgaDWg==
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg9MZINAKJPNnopYtx
7/FBQjzv2qVBBepaR0AdnOgJI/qhRANCAAT021rddRJiq+LRCkEY0a1p+BWGBkXa
vFM2vLfd8hMBBzvQwQCO1wix22/DuOZZQoLH0yubctQC+quznheXx7Bk
-----END PRIVATE KEY-----
`;

// Fake offer site: each path answers with the status set in `status` (default 200).
async function offerSite(t) {
  const status = {};
  const seen = [];
  const handler = (req, res) => {
    seen.push({ url: req.url, ua: req.headers['user-agent'] });
    const path = req.url.split('?')[0];
    if (path === '/to-private') { res.writeHead(302, { location: 'http://10.255.255.1/admin' }); return res.end(); }
    if (path === '/to-ok') { res.writeHead(301, { location: '/ok' }); return res.end(); }
    res.writeHead(status[path] ?? 200, { 'content-type': 'text/html' });
    res.end('<html>offer</html>');
  };
  const server = https.createServer({ cert: CERT, key: KEY }, handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { base: `https://127.0.0.1:${server.address().port}`, status, seen };
}

async function boot(t, environment = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-monitor-'));
  const certFile = join(dataDir, 'test-ca.pem');
  await writeFile(certFile, CERT);
  const server = await startTestServer(dataDir, { NODE_EXTRA_CA_CERTS: certFile, MONITOR_ALLOW_PRIVATE: '127.0.0.1', ...environment });
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, { method = 'GET', body, cookie } = {}) => {
    const headers = { 'x-requested-with': 'umbrella' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(server.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, cookie: ((res.headers.get('set-cookie') || '').match(/umb_session=([^;]*)/) || [])[0] || null };
  };
  const events = async (type) => {
    try { return (await readFile(join(dataDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.type === type); }
    catch { return []; }
  };
  return { call, events };
}

const campaign = (id, offerIds, extra = {}) => ({ id, name: id, streams: [{ name: 'Main', type: 'regular', weight: 1, conditions: {}, offers: offerIds.map((offerId) => ({ offerId, weight: 1 })) }], ...extra });

test('SSRF guard: private ranges, macros and query-less display URLs', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  assert.equal(expandForCheck('https://x.test/?c={click_id}&s={sub_id_1}&k={keyword}'), 'https://x.test/?c=monitor-check&s=&k=');
  assert.equal(displayUrl('https://x.test/path?token=secret'), 'https://x.test/path');
  assert.equal((await probe('ftp://example.com/')).error, 'unsupported_protocol');

  const site = http.createServer((req, res) => {
    if (req.url === '/private') { res.writeHead(302, { location: 'http://192.168.0.10/' }); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    res.writeHead(200); res.end('ok');
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const base = `http://127.0.0.1:${site.address().port}`;
  try {
    assert.equal((await probe(base + '/')).error, 'private_address', 'loopback is refused by default');
    const allow = new Set(['127.0.0.1']);
    assert.deepEqual(await probe(base + '/', { allowPrivate: allow }), { ok: true, status: 200, error: null });
    assert.equal((await probe(base + '/private', { allowPrivate: allow })).error, 'private_address', 'redirect into a private range is not followed');
    assert.equal((await probe(base + '/loop', { allowPrivate: allow })).error, 'too_many_redirects');
  } finally { site.close(); }
});

test('notify mode: event and audit only after two failed checks, on the timer', { timeout: 20000 }, async (t) => {
  const site = await offerSite(t);
  site.status['/down'] = 500;
  const { call, events } = await boot(t, { MONITOR: '1', MONITOR_INTERVAL_MS: '1000' });
  assert.equal((await call('/api/offers', { method: 'POST', body: { id: 'dead', url: `${site.base}/down?aff=secret&cid={click_id}` } })).status, 201);
  assert.equal((await call('/api/campaigns', { method: 'POST', body: campaign('notify-c', ['dead']) })).json.monitoring, 'notify', 'default mode');

  let state;
  for (let i = 0; i < 40; i += 1) {
    state = (await call('/api/monitor')).json;
    if (state.targets[0]?.failures >= 1) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(state.targets[0].failures, 1);
  assert.equal(state.targets[0].ok, true, 'one failure is not "down" yet');
  assert.equal((await events('monitor')).length, 0);
  assert.ok(site.seen.every((s) => /Mozilla\/5\.0/.test(s.ua)), 'browser User-Agent');
  assert.ok(site.seen.some((s) => s.url === '/down?aff=secret&cid=monitor-check'), 'macros replaced');

  for (let i = 0; i < 40 && !(await events('monitor')).length; i += 1) await new Promise((r) => setTimeout(r, 100));
  const [ev] = await events('monitor');
  assert.deepEqual({ campaign: ev.campaign, stream: ev.stream, target: ev.target, url: ev.url, status: ev.status, error: ev.error, state: ev.state },
    { campaign: 'notify-c', stream: 'Main', target: 'offer:dead', url: `${site.base}/down`, status: 500, error: 'http_500', state: 'down' });
  const target = (await call('/api/monitor')).json.targets[0];
  assert.equal(target.ok, false);
  assert.equal(target.url, `${site.base}/down`, 'no query string in the API');
  assert.ok(target.downSince);
  assert.deepEqual(target.campaigns.map((c) => [c.campaign, c.stream, c.target]), [['notify-c', 'Main', 'offer:dead']]);
  const audit = (await call('/api/audit?entity=campaign&id=notify-c')).json.entries.find((e) => e.action === 'monitor_down');
  assert.equal(audit.actor, 'system');
  assert.deepEqual(audit.changes.target, [null, 'offer:dead']);
  const camp = (await call('/api/campaigns')).json.campaigns['notify-c'];
  assert.equal(camp.streams[0].enabled, undefined, 'notify mode leaves the stream on');

  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await events('monitor')).length, 1, 'still down: no repeated notification');
});

test('disable mode switches the stream off and back on; hand-disabled streams stay off', { timeout: 20000 }, async (t) => {
  const site = await offerSite(t);
  const { call, events } = await boot(t);
  await call('/api/offers', { method: 'POST', body: { id: 'flaky', url: `${site.base}/flaky` } });
  await call('/api/offers', { method: 'POST', body: { id: 'fine', url: `${site.base}/to-ok` } });
  await call('/api/landings', { method: 'POST', body: { id: 'lp', url: `${site.base}/lp` } });
  const streams = [
    { name: 'Main', type: 'regular', weight: 1, conditions: {}, offers: [{ offerId: 'flaky', weight: 1 }], landings: [{ landingId: 'lp', weight: 1 }] },
    { name: 'Manual off', type: 'regular', weight: 1, conditions: {}, offers: [{ offerId: 'flaky', weight: 1 }], enabled: false },
    { name: 'Other', type: 'fallback', weight: 1, conditions: {}, offers: [{ offerId: 'fine', weight: 1 }] },
  ];
  assert.equal((await call('/api/campaigns', { method: 'POST', body: { id: 'dis-c', name: 'Disable', streams } })).status, 201);
  assert.equal((await call('/api/campaigns/dis-c', { method: 'PATCH', body: { monitoring: 'disable' } })).json.monitoring, 'disable');
  assert.equal((await call('/api/campaigns/dis-c', { method: 'PATCH', body: { monitoring: 'bogus' } })).json.monitoring, 'notify', 'unknown mode falls back to notify');
  await call('/api/campaigns/dis-c', { method: 'PATCH', body: { monitoring: 'disable' } });
  const streamsOf = async () => (await call('/api/campaigns')).json.campaigns['dis-c'].streams;

  const first = (await call('/api/monitor/check', { method: 'POST' })).json;
  assert.equal(first.checked, 3, 'flaky offer, landing and redirecting offer');
  assert.ok(first.targets.every((x) => x.ok));
  assert.equal(first.targets.find((x) => x.url.endsWith('/to-ok')).status, 200, 'redirect followed');

  site.status['/flaky'] = 503;
  await call('/api/monitor/check', { method: 'POST' });
  assert.equal((await streamsOf())[0].enabled, undefined, 'one failure is not enough');
  await call('/api/monitor/check', { method: 'POST' });
  let s = await streamsOf();
  assert.equal(s[0].enabled, false);
  assert.equal(s[0].disabledBy, 'monitor');
  assert.equal(s[1].disabledBy, undefined, 'hand-disabled stream is not taken over');
  assert.equal(s[2].enabled, undefined, 'stream with a live offer stays on');
  const audit = (await call('/api/audit?entity=campaign&id=dis-c')).json.entries;
  assert.ok(audit.some((e) => e.action === 'disable_stream' && e.actor === 'system' && e.changes.enabled?.[1] === false && /flaky/.test(e.changes.reason?.[1])));
  assert.equal((await events('monitor')).filter((e) => e.state === 'down').length, 1);

  site.status['/flaky'] = 200;
  await call('/api/monitor/check', { method: 'POST' });
  s = await streamsOf();
  assert.equal(s[0].enabled, undefined, 're-enabled after one success');
  assert.equal(s[0].disabledBy, undefined);
  assert.equal(s[1].enabled, false, 'hand-disabled stream stays off');
  assert.ok((await call('/api/audit?entity=campaign&id=dis-c')).json.entries.some((e) => e.action === 'enable_stream' && e.actor === 'system'));
  assert.ok((await events('monitor')).some((e) => e.state === 'up' && e.action === 'enable'));
});

test('private redirect from an offer is not followed; buyers see only their campaigns', { timeout: 20000 }, async (t) => {
  const site = await offerSite(t);
  const { call } = await boot(t);
  const owner = (await call('/api/auth/setup', { method: 'POST', body: { email: 'boss@example.com', password: 'long-password-1' } })).cookie;
  const buyer = (await call('/api/users', { method: 'POST', cookie: owner, body: { email: 'buyer@example.com', password: 'long-password-2', role: 'buyer' } })).json.user;
  const buyerCookie = (await call('/api/auth/login', { method: 'POST', body: { email: 'buyer@example.com', password: 'long-password-2' } })).cookie;
  await call('/api/offers', { method: 'POST', cookie: owner, body: { id: 'sneaky', url: `${site.base}/to-private` } });
  await call('/api/offers', { method: 'POST', cookie: owner, body: { id: 'mine', url: `${site.base}/mine` } });
  await call('/api/campaigns', { method: 'POST', cookie: owner, body: campaign('owner-c', ['sneaky']) });
  await call('/api/campaigns', { method: 'POST', cookie: owner, body: campaign('buyer-c', ['mine'], { ownerId: buyer.id }) });

  assert.equal((await call('/api/monitor/check', { method: 'POST', cookie: buyerCookie })).status, 403, 'owner only');
  const run = await call('/api/monitor/check', { method: 'POST', cookie: owner });
  assert.equal(run.status, 200);
  const sneaky = run.json.targets.find((x) => x.url.endsWith('/to-private'));
  assert.equal(sneaky.error, 'private_address');
  assert.equal(sneaky.status, null);

  const all = (await call('/api/monitor', { cookie: owner })).json.targets;
  assert.deepEqual(all.flatMap((x) => x.campaigns.map((c) => c.campaign)).sort(), ['buyer-c', 'owner-c']);
  const mine = (await call('/api/monitor', { cookie: buyerCookie })).json.targets;
  assert.deepEqual(mine.map((x) => [x.url, x.campaigns.map((c) => c.campaign)]), [[`${site.base}/mine`, ['buyer-c']]]);
  assert.equal((await call('/api/monitor')).status, 401, 'anonymous');
});
