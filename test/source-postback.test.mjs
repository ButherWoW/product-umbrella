// Postback to the traffic source: macros, statuses, once per (click, status), campaign override, retries, SSRF guard.
// Every request goes to a local mock HTTP server; nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { sendPostback, isBlockedAddress, fillPostbackMacros, parsePostbackStatuses, parsePostbackUrl, deliverWithRetry } from '../src/source-postback.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mockServer(t, respond = () => 200) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(new URL(req.url, 'http://mock'));
    res.writeHead(respond(hits.length, req)); res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { hits, base: `http://127.0.0.1:${server.address().port}` };
}

async function tracker(t, environment = { SOURCE_POSTBACK_ALLOW_PRIVATE: '1' }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-source-pb-'));
  const server = await startTestServer(dataDir, environment);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const call = (path, body, method = body ? 'POST' : 'GET') => fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const click = async (campaign, query = '') => {
    const response = await fetch(`${server.url}/r/${campaign}${query}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    return new URL(response.headers.get('location')).searchParams.get('click_id');
  };
  const postback = (clickId, params = {}) => fetch(`${server.url}/postback?${new URLSearchParams({ click_id: clickId, secret: 'conversion-test-secret', ...params })}`);
  const journal = async () => (await readFile(join(dataDir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const sourceEvents = async (clickId) => (await journal()).filter((e) => e.type === 'source_postback' && e.clickId === clickId);
  return { call, click, postback, sourceEvents, url: server.url };
}

async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await check()) return true;
  return false;
}

const streams = [{ name: 'main', offers: [{ offerId: 'offer-1' }] }];

test('sale fires once with macros substituted and is logged without the query string', { timeout: 20000 }, async (t) => {
  const mock = await mockServer(t);
  const { call, click, postback, sourceEvents } = await tracker(t);
  const created = await call('/api/sources', { id: 'fb', name: 'Facebook', postbackUrl: `${mock.base}/fb?cid={external_id}&click={click_id}&s={status}&p={payout}&cur={currency}&ad={sub_id_1}&keep={unknown}` });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).postbackStatuses, ['sale'], 'default statuses');
  assert.equal((await call('/api/campaigns', { id: 'fbc', name: 'FB', sourceId: 'fb', streams })).status, 201);
  const id = await click('fbc', '?external_id=fbclid%20123&sub_id_1=ad-7');
  const started = Date.now();
  const response = await postback(id, { status: 'sale', revenue: '12.5', currency: 'usd' });
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started < 2000, '/postback is not blocked by the source postback');
  assert.ok(await until(async () => (await sourceEvents(id)).length === 1), 'source_postback event recorded');
  assert.equal(mock.hits.length, 1);
  const hit = mock.hits[0];
  assert.equal(hit.pathname, '/fb');
  assert.deepEqual(Object.fromEntries(hit.searchParams), { cid: 'fbclid 123', click: id, s: 'sale', p: '12.5', cur: 'USD', ad: 'ad-7', keep: '{unknown}' });
  const [logged] = await sourceEvents(id);
  assert.deepEqual([logged.campaign, logged.status, logged.httpStatus, logged.error, logged.url], ['fbc', 'sale', 200, null, `${mock.base}/fb`]);
  assert.equal((await (await postback(id, { status: 'sale' })).json()).duplicate, true);
  await sleep(300);
  assert.equal(mock.hits.length, 1, 'duplicate sale does not fire again');
});

test('lead is not sent with statuses [sale]; lead → sale sends once; sale again after rejected is not repeated', { timeout: 20000 }, async (t) => {
  const mock = await mockServer(t);
  const { call, click, postback, sourceEvents } = await tracker(t);
  assert.equal((await call('/api/sources', { id: 'tt', name: 'TikTok', postbackUrl: `${mock.base}/tt?s={status}`, postbackStatuses: ['sale', 'bogus'] })).status, 201);
  assert.deepEqual((await (await call('/api/sources')).json()).sources.tt.postbackStatuses, ['sale']);
  assert.equal((await call('/api/campaigns', { id: 'ttc', name: 'TT', sourceId: 'tt', streams })).status, 201);
  const id = await click('ttc');
  assert.equal((await postback(id, { status: 'lead', revenue: '5' })).status, 200);
  await sleep(400);
  assert.equal(mock.hits.length, 0, 'lead is not in the list');
  assert.equal((await postback(id, { status: 'sale' })).status, 200);
  assert.ok(await until(async () => (await sourceEvents(id)).length === 1));
  assert.deepEqual(mock.hits.map((h) => h.searchParams.get('s')), ['sale']);
  assert.equal((await postback(id, { status: 'rejected' })).status, 200);
  assert.equal((await postback(id, { status: 'sale' })).status, 200);
  await sleep(400);
  assert.equal(mock.hits.length, 1, 'once per (click, status)');
  assert.equal((await sourceEvents(id)).length, 1);
});

test('campaign override wins over the source URL and statuses', { timeout: 20000 }, async (t) => {
  const mock = await mockServer(t);
  const { call, click, postback, sourceEvents } = await tracker(t);
  assert.equal((await call('/api/sources', { id: 'src', name: 'Src', postbackUrl: `${mock.base}/source?s={status}`, postbackStatuses: ['sale'] })).status, 201);
  assert.equal((await call('/api/campaigns', { id: 'ovr', name: 'Override', sourceId: 'src', streams })).status, 201);
  const patched = await call('/api/campaigns/ovr', { sourcePostbackUrl: `${mock.base}/campaign?s={status}&c={campaign}`, sourcePostbackStatuses: ['lead'] }, 'PATCH');
  assert.equal(patched.status, 200);
  assert.deepEqual((await patched.json()).sourcePostbackStatuses, ['lead']);
  assert.equal((await call('/api/campaigns/ovr', { sourcePostbackUrl: 'ftp://x/y' }, 'PATCH')).status, 400);
  const id = await click('ovr');
  assert.equal((await postback(id, { status: 'lead' })).status, 200);
  assert.ok(await until(async () => (await sourceEvents(id)).length === 1));
  assert.equal((await postback(id, { status: 'sale' })).status, 200);
  await sleep(400);
  assert.deepEqual(mock.hits.map((h) => `${h.pathname}:${h.searchParams.get('s')}:${h.searchParams.get('c')}`), ['/campaign:lead:ovr']);
});

test('500 twice then 200 is delivered on the third attempt', { timeout: 20000 }, async (t) => {
  const mock = await mockServer(t, (n) => (n <= 2 ? 500 : 200));
  const { call, click, postback, sourceEvents } = await tracker(t);
  assert.equal((await call('/api/sources', { id: 'flaky', name: 'Flaky', postbackUrl: `${mock.base}/pb?cid={click_id}` })).status, 201);
  assert.equal((await call('/api/campaigns', { id: 'flc', name: 'Flaky', sourceId: 'flaky', streams })).status, 201);
  const id = await click('flc');
  assert.equal((await postback(id)).status, 200, 'no status = sale');
  assert.ok(await until(async () => (await sourceEvents(id)).length === 1, 8000));
  assert.equal(mock.hits.length, 3);
  const [logged] = await sourceEvents(id);
  assert.deepEqual([logged.httpStatus, logged.error, logged.attempts], [200, null, 3]);
});

test('retry helper stops on 4xx and on SSRF refusal', async () => {
  const statuses = [404];
  let calls = 0;
  const r = await deliverWithRetry(async () => { calls += 1; return { httpStatus: statuses[0], error: 'http_404' }; }, { sleep: async () => {} });
  assert.deepEqual([r.attempts, calls], [1, 1]);
  const failed = await deliverWithRetry(async () => ({ httpStatus: null, error: 'ECONNRESET' }), { sleep: async () => {} });
  assert.deepEqual([failed.attempts, failed.error], [3, 'ECONNRESET']);
  const refused = await deliverWithRetry(async () => ({ httpStatus: null, error: 'private_address_refused', noRetry: true }), { sleep: async () => {} });
  assert.equal(refused.attempts, 1);
});

test('private addresses are refused without SOURCE_POSTBACK_ALLOW_PRIVATE', { timeout: 20000 }, async (t) => {
  const mock = await mockServer(t);
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1'])
    assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(isBlockedAddress(ip), false, ip);
  assert.equal(isBlockedAddress('127.0.0.1', { allowPrivate: true }), false);
  assert.equal(isBlockedAddress('10.0.0.1', { allowPrivate: true }), true, 'the flag opens loopback only');
  const port = new URL(mock.base).port;
  assert.equal((await sendPostback(`http://127.0.0.1:${port}/x`)).error, 'private_address_refused');
  assert.equal((await sendPostback(`http://[::ffff:7f00:1]:${port}/x`)).error, 'private_address_refused');
  assert.equal((await sendPostback(`http://localhost:${port}/x`)).error, 'private_address_refused', 'checked after DNS resolution');
  assert.equal((await sendPostback(`file:///etc/passwd`)).error, 'invalid_scheme');
  assert.equal((await sendPostback(`http://127.0.0.1:${port}/ok`, { allowPrivate: true })).httpStatus, 200);
  assert.equal(mock.hits.length, 1);

  // Through the admin button: refused without the flag, and plain http sources are not accepted.
  const strict = await tracker(t, {});
  const tested = await (await strict.call('/api/sources/postback-test', { url: `${mock.base}/btn?s={status}` })).json();
  assert.deepEqual([tested.ok, tested.httpStatus, tested.error], [false, null, 'private_address_refused']);
  assert.equal((await strict.call('/api/sources', { id: 'plain', name: 'P', postbackUrl: `${mock.base}/pb` })).status, 400, 'https only in production mode');
  assert.equal(mock.hits.length, 1);

  const open = await tracker(t);
  const ok = await (await open.call('/api/sources/postback-test', { url: `${mock.base}/btn?s={status}&cid={external_id}&tok=secret` })).json();
  assert.deepEqual([ok.ok, ok.httpStatus, ok.url], [true, 200, `${mock.base}/btn`]);
  assert.equal(mock.hits.at(-1).searchParams.get('cid'), 'test_external_id');
});

test('pure helpers', () => {
  assert.deepEqual(parsePostbackStatuses(['trash', 'SALE', 'x']), ['sale', 'trash']);
  assert.deepEqual(parsePostbackStatuses(undefined), ['sale']);
  assert.deepEqual(parsePostbackStatuses(undefined, []), []);
  assert.equal(parsePostbackUrl('http://a.example/x'), null);
  assert.equal(parsePostbackUrl('https://a.example/x?c={click_id}'), 'https://a.example/x?c={click_id}');
  assert.equal(fillPostbackMacros('https://a/?a={sub_id_30}&b={revenue}&c={nope}', { sub_id_30: 'x&y=1' }), 'https://a/?a=x%26y%3D1&b=&c={nope}');
});
