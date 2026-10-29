import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

const BOT_UA = 'Googlebot/2.1 (+http://www.google.com/bot.html)';
const BUYER_TOKEN = 'buyer-test-token';

test('GET /api/bots returns bot records with reason field', { timeout: 15000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-botlog-'));
  const server = await startTestServer(dataDir);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });

  const post = (path, body) => fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const hit = (path, ua) => fetch(server.url + path, { redirect: 'manual', headers: { 'user-agent': ua } });

  await post('/api/campaigns', {
    id: 'owned', name: 'Owned', botFilter: true,
    streams: [{ name: 'main', action: 'url', url: 'https://example.com/?cid={click_id}' }],
  });

  // 2 bot requests
  await hit('/r/owned', BOT_UA);
  await hit('/r/owned', BOT_UA);

  const res = await fetch(server.url + '/api/bots?campaign=owned');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.bots.length, 2, 'two bot records expected');
  assert.ok(data.bots.every((b) => b.reason === 'user_agent'), 'reason must be user_agent for UA-based bots');
  assert.ok(data.bots.every((b) => b.campaign === 'owned'));
  assert.ok(data.bots[0].at, 'at timestamp must be present');
});

test('GET /api/bots: buyer scope isolates campaigns', { timeout: 15000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-botscope-'));
  const server = await startTestServer(dataDir, { ADMIN_TOKEN: BUYER_TOKEN });
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });

  const admin = (path, body, method = 'POST') => fetch(server.url + path, {
    method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + BUYER_TOKEN }, body: JSON.stringify(body),
  });
  const hit = (path, ua) => fetch(server.url + path, { redirect: 'manual', headers: { 'user-agent': ua } });

  // Create owner account
  await fetch(server.url + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'umbrella', authorization: 'Bearer ' + BUYER_TOKEN }, body: JSON.stringify({ email: 'owner@test.com', password: 'ownerpassword1' }) });
  // Create buyer account
  await admin('/api/users', { email: 'buyer@test.com', password: 'buyerpassword1', role: 'buyer' });

  // Owner creates a campaign (not owned by buyer)
  await admin('/api/campaigns', { id: 'foreign', name: 'Foreign', botFilter: true, streams: [{ name: 'main', action: 'url', url: 'https://example.com/' }] });

  // Send bots to foreign campaign
  await hit('/r/foreign', BOT_UA);

  // Login as buyer
  const loginRes = await fetch(server.url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'umbrella' }, body: JSON.stringify({ email: 'buyer@test.com', password: 'buyerpassword1' }) });
  const cookie = loginRes.headers.get('set-cookie');

  // Buyer requests /api/bots — should get empty list (doesn't own 'foreign')
  const buyerRes = await fetch(server.url + '/api/bots', { headers: { cookie, 'x-requested-with': 'umbrella' } });
  assert.equal(buyerRes.status, 200);
  const buyerData = await buyerRes.json();
  assert.equal(buyerData.bots.length, 0, 'buyer must not see bots from campaigns they do not own');
});
