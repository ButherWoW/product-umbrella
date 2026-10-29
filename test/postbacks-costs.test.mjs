// G7: postback journals (incoming, outgoing S2S with retries, no credentials stored) and G8: manual cost updates.
// The checks are shared with test/postgres-postbacks-costs.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

export const TOKEN = 'pb-cost-token';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what) {
  for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await wait(50); }
  assert.fail(`timed out waiting for ${what}`);
}

// HTTPS network mock (offer postback URLs must be https): answers 500 to the first `failures` requests, then 200.
export async function startNetworkMock(dir, failures = 2) {
  const key = join(dir, 'mock.key'), cert = join(dir, 'mock.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const requests = [];
  const server = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    requests.push(req.url);
    res.writeHead(requests.length <= failures ? 500 : 200); res.end('ok');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `https://127.0.0.1:${server.address().port}`, cert, requests, stop: () => new Promise((resolve) => server.close(resolve)) };
}

export function hasOpenssl() { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } }

export async function buyerSession(server, call, email) {
  assert.equal((await call('/api/users', { email, password: 'buyer-password-1' })).status, 201);
  const login = await fetch(`${server.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'umbrella' },
    body: JSON.stringify({ email, password: 'buyer-password-1' }) });
  const cookie = (login.headers.get('set-cookie').match(/umb_session=[^;]*/) || [])[0];
  return (path, body) => fetch(server.url + path, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'umbrella', cookie }, body: body ? JSON.stringify(body) : undefined });
}

export async function checkPostbackLogs({ server, call, buyer, mock, run }) {
  const offer = `pb-off-${run}`, campaign = `pb-cmp-${run}`;
  assert.equal((await call('/api/offers', { id: offer, url: 'https://offer.example.com/',
    postbackUrl: `${mock.url}/pb?cid={click_id}&status={status}&key=network-key-1&token=network-token-1` })).status, 201);
  assert.equal((await call('/api/campaigns', { id: campaign, name: 'PB', streams: [{ name: 'm', offers: [{ offerId: offer }] }] })).status, 201);
  const clickId = new URL((await fetch(`${server.url}/r/${campaign}`, { redirect: 'manual' })).headers.get('location')).searchParams.get('click_id');

  assert.equal((await fetch(`${server.url}/postback?click_id=${clickId}&secret=conversion-test-secret&revenue=3&tid=t1`)).status, 200);
  await until(() => mock.requests.length >= 3, 'three S2S attempts');
  assert.ok(mock.requests.every((u) => u.includes('key=network-key-1')), 'the network itself gets the full URL');

  const out = await until(async () => { const r = await (await call(`/api/postbacks?direction=out&campaign=${campaign}`)).json(); return r.postbacks.length >= 3 && r; }, 'outgoing log');
  assert.deepEqual(out.postbacks.map((p) => [p.attempt, p.statusCode]), [[3, 200], [2, 500], [1, 500]], 'failed S2S was retried');
  assert.equal(out.postbacks[2].error, 'HTTP 500');
  for (const p of out.postbacks) {
    assert.equal(p.clickId, clickId); assert.equal(p.campaign, campaign); assert.equal(p.tid, 't1');
    assert.ok(!p.url.includes('network-key-1') && !p.url.includes('network-token-1'), `credentials stripped: ${p.url}`);
    assert.match(p.url, /key=\*\*\*/);
  }

  const unknown = randomUUID(); // a click that does not exist (unique per run: the PostgreSQL test database is shared)
  assert.equal((await fetch(`${server.url}/postback?click_id=${unknown}&secret=conversion-test-secret`)).status, 404);
  assert.equal((await fetch(`${server.url}/postback?click_id=${clickId}&secret=wrong-secret`)).status, 401);
  const incoming = await until(async () => { const r = await (await call('/api/postbacks?direction=in')).json(); return r.postbacks.filter((p) => [clickId, unknown].includes(p.clickId)).length >= 3 && r; }, 'incoming log');
  const mine = incoming.postbacks.filter((p) => [clickId, unknown].includes(p.clickId));
  assert.deepEqual(mine.map((p) => p.statusCode).sort(), [200, 401, 404]);
  const notFound = mine.find((p) => p.statusCode === 404);
  assert.equal(notFound.error, 'click_not_found');
  assert.equal(notFound.campaign, null);
  const ok = mine.find((p) => p.statusCode === 200);
  assert.deepEqual([ok.campaign, ok.offerId, ok.tid, ok.revenue], [campaign, offer, 't1', '3']);
  for (const p of mine) assert.ok(!p.url.includes('conversion-test-secret') && !p.url.includes('wrong-secret'), `secret stripped: ${p.url}`);
  assert.equal((await call('/api/postbacks?direction=sideways')).status, 400);

  // A buyer sees only postbacks of their own campaigns.
  assert.equal((await buyer(`/api/postbacks?campaign=${campaign}`)).status, 403);
  assert.deepEqual((await (await buyer('/api/postbacks?direction=in')).json()).postbacks, []);
}

export async function checkCosts({ server, call, buyer, run }) {
  const offer = `cost-off-${run}`, campaign = `cost-cmp-${run}`;
  assert.equal((await call('/api/offers', { id: offer, url: 'https://cost.example.com/' })).status, 201);
  assert.equal((await call('/api/campaigns', { id: campaign, name: 'Cost', streams: [{ name: 'm', offers: [{ offerId: offer }] }] })).status, 201);
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const hit = await fetch(`${server.url}/r/${campaign}${i < 2 ? '?sub_id_2=adset-a' : ''}`, { redirect: 'manual' });
    ids.push(new URL(hit.headers.get('location')).searchParams.get('click_id'));
  }
  assert.equal((await fetch(`${server.url}/postback?click_id=${ids[9]}&secret=conversion-test-secret&revenue=10`)).status, 200);
  const today = new Date().toISOString().slice(0, 10);
  const costs = (body) => call('/api/costs', { campaign, from: today, to: today, tz: 'UTC', ...body });
  const report = async () => (await call(`/stats?campaign=${campaign}`)).json();

  const all = await (await costs({ amount: 5, currency: 'EUR' })).json();
  assert.deepEqual([all.updated, all.perClick, all.cost], [10, 0.5, 5]);
  let stats = await until(async () => { const s = await report(); return s.revenue === 10 && s; }, 'conversion in the report');
  assert.equal(stats.cost, 5);
  assert.equal(stats.roi, 1, 'ROI recalculated: (10 - 5) / 5');

  // Filters: by sub_id (2 clicks), a foreign offer (none), unique clicks only (the same visitor → only the first is unique).
  assert.equal((await (await costs({ amount: 3, filters: { sub_id_2: 'adset-a' } })).json()).updated, 2);
  assert.equal((await report()).cost, 5 - 1 + 3);
  assert.equal((await (await costs({ amount: 3, filters: { offer: 'other-offer' } })).json()).updated, 0);
  assert.equal((await (await costs({ amount: 2, uniqueOnly: true })).json()).updated, 1);
  // Rounding remainder on the last click: the sum stays exact.
  const exact = await (await costs({ amount: 1 })).json();
  assert.equal(exact.perClick, 0.1);
  assert.ok(Math.abs((await report()).cost - 1) < 1e-9);
  const thirds = await (await costs({ amount: 1, filters: { sub_id_2: 'adset-a' } })).json();
  assert.equal(thirds.perClick, 0.5);
  assert.ok(Math.abs((await report()).cost - (0.8 + 1)) < 1e-9);
  const log = await (await call(`/api/clicks?campaign=${campaign}&limit=100`)).json();
  assert.ok(Math.abs(log.clicks.reduce((sum, c) => sum + c.cost, 0) - 1.8) < 1e-9, 'click log shows updated costs');

  // A date range outside the clicks, in another time zone, matches nothing.
  assert.equal((await (await costs({ amount: 1, from: '2020-01-01', to: '2020-01-02', tz: 'Asia/Dubai' })).json()).updated, 0);
  // Validation
  assert.equal((await call('/api/costs', { campaign, amount: 1 })).status, 400, 'dates required');
  assert.equal((await costs({ amount: -1 })).status, 400);
  assert.equal((await costs({ amount: 1, tz: 'Mars/Base' })).status, 400);
  assert.equal((await costs({ amount: 1, filters: { country: 'FR' } })).status, 400);
  assert.equal((await call('/api/costs', { campaign: 'missing-campaign', from: today, to: today, amount: 1 })).status, 404);
  // A buyer cannot update another owner's campaign.
  assert.equal((await buyer('/api/costs', { campaign, from: today, to: today, amount: 1 })).status, 403);
  const audit = await (await call(`/api/audit?entity=costs&id=${campaign}`)).json();
  assert.ok(audit.entries.length >= 5, 'every cost update is in the audit log');
  return { campaign, today };
}

test('postback journals with S2S retries and manual cost updates (JSONL)', { skip: !hasOpenssl() && 'openssl not available', timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-pbcost-'));
  const mock = await startNetworkMock(dir);
  const server = await startTestServer(dir, { ADMIN_TOKEN: TOKEN, S2S_RETRY_MS: '20', S2S_ALLOW_PRIVATE: '1', NODE_EXTRA_CA_CERTS: mock.cert });
  t.after(async () => { await server.stop(); await mock.stop(); await rm(dir, { recursive: true, force: true }); });
  const call = (path, body) => fetch(server.url + path, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: body ? JSON.stringify(body) : undefined });
  const buyer = await buyerSession(server, call, 'buyer-pb@example.com');
  await checkPostbackLogs({ server, call, buyer, mock, run: 'j' });
  await checkCosts({ server, call, buyer, run: 'j' });
  // The offer itself keeps its postback URL; the postback journal entries must not.
  const journal = (await readFile(join(dir, 'events.jsonl'), 'utf8')).split('\n').filter((l) => l.includes('"postback_'));
  assert.ok(journal.length >= 6);
  for (const secret of ['conversion-test-secret', 'wrong-secret', 'network-key-1', 'network-token-1']) assert.ok(!journal.some((l) => l.includes(secret)), `${secret} is not stored`);
});
