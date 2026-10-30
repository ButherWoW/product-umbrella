// Personal API keys (Bearer umb_…) and the ADMIN_ALLOWED_IPS allowlist for the panel and APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

async function boot(t, environment = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-keys-'));
  const server = await startTestServer(dataDir, environment);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, { method = 'GET', body, cookie, csrf = true, bearer, headers: extra = {} } = {}) => {
    const headers = { ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-requested-with'] = 'umbrella';
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetch(server.url + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, cookie: (String(res.headers.get('set-cookie') || '').match(/umb_session=([^;]*)/) || [])[0] || null };
  };
  return { call, dataDir };
}

test('API keys: owner and buyer keys act as their user, secret shown once, revocation, audit', { timeout: 30000 }, async (t) => {
  const { call, dataDir } = await boot(t, { ADMIN_TOKEN: 'keys-admin-token', REQUIRE_LOGIN: '1' });
  const owner = (await call('/api/auth/setup', { method: 'POST', bearer: 'keys-admin-token', body: { email: 'o@example.com', password: 'owner-password' } })).cookie;
  await call('/api/users', { method: 'POST', cookie: owner, body: { email: 'ann@example.com', password: 'buyer-password' } });
  await call('/api/users', { method: 'POST', cookie: owner, body: { email: 'bob@example.com', password: 'buyer-password' } });
  const ann = (await call('/api/auth/login', { method: 'POST', body: { email: 'ann@example.com', password: 'buyer-password' } })).cookie;
  const bob = (await call('/api/auth/login', { method: 'POST', body: { email: 'bob@example.com', password: 'buyer-password' } })).cookie;
  await call('/api/campaigns', { method: 'POST', cookie: ann, body: { id: 'ann-camp', name: 'Ann' } });
  await call('/api/campaigns', { method: 'POST', cookie: bob, body: { id: 'bob-camp', name: 'Bob' } });
  await call('/r/ann-camp/offer-1'); await call('/r/bob-camp/offer-1');

  assert.equal((await call('/api/keys', { method: 'POST', cookie: owner, body: { name: '' } })).json.error, 'invalid_key_name');
  assert.equal((await call('/api/keys', { method: 'POST', cookie: owner, csrf: false, body: { name: 'x' } })).status, 403, 'cookie writes still need the CSRF header');
  const ownerKey = await call('/api/keys', { method: 'POST', cookie: owner, body: { name: 'Скрипт отчётов' } });
  assert.equal(ownerKey.status, 201);
  assert.match(ownerKey.json.secret, /^umb_[A-Za-z0-9_-]{43}$/, 'umb_ + 32 random bytes in base64url');
  assert.equal(ownerKey.json.key.last4, ownerKey.json.secret.slice(-4));
  const annKey = await call('/api/keys', { method: 'POST', cookie: ann, body: { name: 'ann bot' } });
  assert.equal(annKey.status, 201);

  // Owner key: full access, writes without the CSRF header.
  assert.equal((await call('/api/auth/me', { bearer: ownerKey.json.secret, csrf: false })).json.user.email, 'o@example.com');
  assert.equal((await call('/stats', { bearer: ownerKey.json.secret, csrf: false })).json.clicks, 2);
  assert.equal((await call('/api/campaigns', { method: 'POST', bearer: ownerKey.json.secret, csrf: false, body: { id: 'by-key', name: 'K' } })).status, 201);
  assert.equal((await call('/api/users', { bearer: ownerKey.json.secret })).status, 200);

  // Buyer key: same scope as the buyer's session.
  assert.deepEqual(Object.keys((await call('/api/campaigns', { bearer: annKey.json.secret })).json.campaigns), ['ann-camp']);
  assert.equal((await call('/stats', { bearer: annKey.json.secret })).json.clicks, 1);
  assert.equal((await call('/stats?campaign=bob-camp', { bearer: annKey.json.secret })).status, 403);
  assert.equal((await call('/api/clicks?campaign=bob-camp', { bearer: annKey.json.secret })).status, 403);
  assert.equal((await call('/api/campaigns/bob-camp', { method: 'PATCH', bearer: annKey.json.secret, csrf: false, body: { name: 'hijack' } })).status, 403);
  assert.equal((await call('/api/users', { bearer: annKey.json.secret })).status, 403);
  assert.equal((await call('/api/keys?all=1', { bearer: annKey.json.secret })).status, 403);
  assert.equal((await call('/api/keys', { method: 'POST', bearer: annKey.json.secret, csrf: false, body: { name: 'more' } })).json.error, 'session_required', 'a key cannot mint keys');

  // Listing never returns the secret or its hash.
  const annList = await call('/api/keys', { cookie: ann });
  assert.deepEqual(annList.json.keys.map((k) => k.name), ['ann bot'], 'buyers list only their own keys');
  assert.ok(annList.json.keys[0].lastUsedAt, 'lastUsedAt is recorded');
  const all = await call('/api/keys?all=1', { cookie: owner });
  assert.equal(all.json.keys.length, 2);
  assert.ok(all.json.keys.some((k) => k.email === 'ann@example.com'));
  for (const text of [annList.text, all.text, (await call('/api/keys', { bearer: 'keys-admin-token' })).text]) {
    assert.ok(!text.includes(ownerKey.json.secret) && !text.includes(annKey.json.secret), 'secret is not returned by GET');
    assert.ok(!text.includes('key_hash') && !/[0-9a-f]{64}/.test(text), 'hash is not returned by GET');
  }
  const stored = await readFile(join(dataDir, 'api_keys.json'), 'utf8');
  assert.ok(!stored.includes(ownerKey.json.secret) && !stored.includes(annKey.json.secret), 'only hashes are stored');

  // Wrong / unknown keys.
  assert.equal((await call('/api/campaigns', { bearer: 'umb_' + 'A'.repeat(43) })).status, 401);
  assert.equal((await call('/api/campaigns', { bearer: ownerKey.json.secret.slice(0, -1) + 'x' })).json.error, 'invalid_api_key');
  assert.equal((await call('/api/campaigns', { bearer: 'wrong-admin-token' })).status, 401);
  assert.equal((await call('/api/campaigns', { bearer: 'keys-admin-token' })).status, 200, 'ADMIN_TOKEN keeps working');

  // Revocation: someone else's key is invisible to a buyer; the owner may revoke any.
  assert.equal((await call(`/api/keys/${ownerKey.json.key.id}`, { method: 'DELETE', cookie: bob })).status, 404);
  assert.equal((await call(`/api/keys/${annKey.json.key.id}`, { method: 'DELETE', cookie: owner })).status, 200);
  assert.equal((await call('/api/campaigns', { bearer: annKey.json.secret })).status, 401, 'deleted key → 401');
  assert.equal((await call(`/api/keys/${ownerKey.json.key.id}`, { method: 'DELETE', cookie: owner })).status, 200);
  assert.equal((await call('/stats', { bearer: ownerKey.json.secret })).status, 401);

  const log = (await call('/api/audit?entity=api_key', { cookie: owner })).json.entries;
  assert.deepEqual(log.map((e) => e.action).sort(), ['create', 'create', 'delete', 'delete']);
  const raw = await readFile(join(dataDir, 'events.jsonl'), 'utf8');
  assert.ok(!raw.includes(ownerKey.json.secret) && !raw.includes(annKey.json.secret), 'secrets never reach the journal');
});

test('API keys: deleting a user revokes their keys', { timeout: 20000 }, async (t) => {
  const { call } = await boot(t);
  const owner = (await call('/api/auth/setup', { method: 'POST', body: { email: 'o@example.com', password: 'owner-password' } })).cookie;
  const buyer = (await call('/api/users', { method: 'POST', cookie: owner, body: { email: 'b@example.com', password: 'buyer-password' } })).json.user;
  const session = (await call('/api/auth/login', { method: 'POST', body: { email: 'b@example.com', password: 'buyer-password' } })).cookie;
  const { secret } = (await call('/api/keys', { method: 'POST', cookie: session, body: { name: 'k' } })).json;
  assert.equal((await call('/api/campaigns', { bearer: secret })).status, 200);
  await call(`/api/users/${buyer.id}`, { method: 'DELETE', cookie: owner });
  assert.equal((await call('/api/campaigns', { bearer: secret })).status, 401);
  assert.deepEqual((await call('/api/keys?all=1', { cookie: owner })).json.keys, []);
});

test('ADMIN_ALLOWED_IPS: panel and APIs only from listed IPs, tracking stays open', { timeout: 20000 }, async (t) => {
  const { call } = await boot(t, { TRUST_PROXY: '1', ADMIN_ALLOWED_IPS: '203.0.113.7, 198.51.100.0/24', ADMIN_TOKEN: 'ip-token' });
  const from = (ip) => ({ 'x-forwarded-for': ip });
  assert.equal((await call('/api/campaigns', { headers: from('203.0.113.7') })).status, 200);
  assert.equal((await call('/api/campaigns', { headers: from('198.51.100.42') })).status, 200, 'CIDR match');
  const denied = await call('/api/campaigns', { headers: from('192.0.2.1') });
  assert.deepEqual([denied.status, denied.json.error], [403, 'admin_ip_not_allowed']);
  assert.equal((await call('/api/campaigns', { headers: from('192.0.2.1'), bearer: 'ip-token' })).status, 403, 'even with ADMIN_TOKEN');
  assert.equal((await call('/stats', { headers: from('192.0.2.1') })).status, 403);
  assert.equal((await call('/admin', { headers: from('192.0.2.1') })).status, 403);
  assert.equal((await call('/campaigns', { headers: from('192.0.2.1') })).status, 403, 'panel pages follow ADMIN_ALLOWED_IPS');
  assert.equal((await call('/api/auth/login', { method: 'POST', headers: from('192.0.2.1'), body: { email: 'a@example.com', password: 'whatever-123' } })).status, 403);
  assert.equal((await call('/api/campaigns', { headers: from('192.0.2.1, 203.0.113.7') })).status, 200, 'the proxy-appended address counts');
  assert.equal((await call('/api/campaigns', { headers: from('203.0.113.7, 192.0.2.1') })).status, 403, 'a spoofed left entry does not');
  assert.equal((await call('/r/demo/offer-1', { headers: from('192.0.2.1') })).status, 302, 'clicks are never restricted');
  assert.equal((await call('/health', { headers: from('192.0.2.1') })).status, 200);
  const security = await call('/api/security', { headers: from('203.0.113.7'), bearer: 'ip-token' });
  assert.deepEqual(security.json.adminAllowedIps, ['203.0.113.7', '198.51.100.0/24']);
  assert.equal(security.json.clientIp, '203.0.113.7');
});

test('ADMIN_ALLOWED_IPS: an invalid rule stops the server instead of opening the panel', { timeout: 20000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-keys-bad-'));
  try { await assert.rejects(startTestServer(dataDir, { ADMIN_ALLOWED_IPS: '10.0.0.1, not-an-ip' }), /not-an-ip/); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
});
