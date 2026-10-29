import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

async function boot(t, environment = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-auth-'));
  const server = await startTestServer(dataDir, environment);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, { method = 'GET', body, cookie, csrf = true, bearer } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-requested-with'] = 'umbrella';
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetch(server.url + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) })
      .catch((error) => { throw new Error(`${method} ${path}: ${error.cause?.message || error.message}`); });
    const setCookie = res.headers.get('set-cookie') || '';
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, setCookie, cookie: (setCookie.match(/umb_session=([^;]*)/) || [])[0] || null, location: res.headers.get('location') };
  };
  return { call, dataDir };
}

test('first owner, sessions, CSRF header and closed writes once accounts exist', { timeout: 20000 }, async (t) => {
  const { call, dataDir } = await boot(t);
  const me0 = await call('/api/auth/me');
  assert.deepEqual([me0.json.setupRequired, me0.json.loginRequired, me0.json.user], [true, false, null]);
  assert.equal((await call('/api/campaigns', { method: 'POST', body: { id: 'open-dev', name: 'dev' } })).status, 201, 'fresh dev install stays open');

  assert.equal((await call('/api/auth/setup', { method: 'POST', csrf: false, body: { email: 'boss@example.com', password: 'long-password-1' } })).status, 403);
  assert.equal((await call('/api/auth/setup', { method: 'POST', body: { email: 'boss@example.com', password: 'short' } })).json.error, 'password_too_short');
  const setup = await call('/api/auth/setup', { method: 'POST', body: { email: 'Boss@Example.com', password: 'long-password-1' } });
  assert.equal(setup.status, 201);
  assert.equal(setup.json.user.role, 'owner');
  assert.equal(setup.json.user.email, 'boss@example.com', 'email is normalized');
  assert.match(setup.setCookie, /HttpOnly/);
  assert.match(setup.setCookie, /SameSite=Lax/);
  assert.equal((await call('/api/auth/setup', { method: 'POST', body: { email: 'x@example.com', password: 'long-password-2' } })).status, 409);
  const mode = (await stat(join(dataDir, 'users.json'))).mode & 0o777;
  assert.equal(mode, 0o600, 'user file is private');

  assert.equal((await call('/api/campaigns', { method: 'POST', body: { id: 'anon', name: 'anon' } })).status, 401, 'anonymous writes close once a user exists');
  assert.equal((await call('/api/campaigns', { method: 'POST', cookie: setup.cookie, csrf: false, body: { id: 'nocsrf', name: 'x' } })).status, 401, 'cookie write without header is rejected');
  assert.equal((await call('/api/campaigns', { method: 'POST', cookie: setup.cookie, body: { id: 'owned', name: 'ok' } })).status, 201);
  assert.equal((await call('/api/auth/me', { cookie: setup.cookie })).json.user.email, 'boss@example.com');

  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'boss@example.com', password: 'wrong-password' } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'whatever-123' } })).json.error, 'invalid_credentials');
  const login = await call('/api/auth/login', { method: 'POST', body: { email: 'boss@example.com', password: 'long-password-1' } });
  assert.equal(login.status, 200);
  await call('/api/auth/logout', { method: 'POST', cookie: login.cookie });
  assert.equal((await call('/api/auth/me', { cookie: login.cookie })).json.user, null, 'logout kills the session');
  assert.equal((await call('/api/auth/me', { cookie: setup.cookie })).json.user.email, 'boss@example.com', 'other sessions survive');
});

test('owner manages buyers; buyers cannot manage users', { timeout: 20000 }, async (t) => {
  const { call } = await boot(t);
  const owner = (await call('/api/auth/setup', { method: 'POST', body: { email: 'o@example.com', password: 'owner-password' } })).cookie;
  const created = await call('/api/users', { method: 'POST', cookie: owner, body: { email: 'b@example.com', password: 'buyer-password' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.user.role, 'buyer');
  assert.equal((await call('/api/users', { method: 'POST', cookie: owner, body: { email: 'b@example.com', password: 'buyer-password' } })).status, 409, 'duplicate email');
  assert.equal((await call('/api/users', { method: 'POST', cookie: owner, body: { email: 'c@example.com', password: 'buyer-password', role: 'admin' } })).json.error, 'invalid_role');

  const buyer = (await call('/api/auth/login', { method: 'POST', body: { email: 'b@example.com', password: 'buyer-password' } })).cookie;
  assert.equal((await call('/api/users', { cookie: buyer })).status, 403);
  assert.equal((await call('/api/campaigns', { method: 'POST', cookie: buyer, body: { id: 'buyer-camp', name: 'b' } })).status, 201, 'buyers work with campaigns');

  const list = (await call('/api/users', { cookie: owner })).json.users;
  assert.equal(list.length, 2);
  assert.ok(list.every((u) => !('password_hash' in u)), 'hashes never leave the server');
  const ownerId = list.find((u) => u.role === 'owner').id;
  assert.equal((await call(`/api/users/${ownerId}`, { method: 'DELETE', cookie: owner })).json.error, 'cannot_delete_self');
  const buyerId = created.json.user.id;
  assert.equal((await call(`/api/users/${buyerId}`, { method: 'DELETE', cookie: owner })).status, 200);
  assert.equal((await call('/api/auth/me', { cookie: buyer })).json.user, null, 'deleting a user ends their sessions');
});

test('REQUIRE_LOGIN + ADMIN_TOKEN: private reports, public tracking, token-gated setup, login rate limit', { timeout: 20000 }, async (t) => {
  const { call } = await boot(t, { ADMIN_TOKEN: 'setup-token', REQUIRE_LOGIN: '1' });
  assert.equal((await call('/stats')).status, 401);
  assert.equal((await call('/api/campaigns')).status, 401);
  assert.equal((await call('/stats/timeseries')).status, 401);
  assert.equal((await call('/dashboard')).status, 302);
  assert.equal((await call('/admin')).status, 200, 'login page stays reachable');
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/r/demo/offer-1')).status, 302, 'tracking stays public');
  assert.equal((await call('/api/auth/me')).json.loginRequired, true);

  assert.equal((await call('/api/auth/setup', { method: 'POST', body: { email: 'o@example.com', password: 'owner-password' } })).status, 401, 'setup needs ADMIN_TOKEN');
  const owner = (await call('/api/auth/setup', { method: 'POST', bearer: 'setup-token', body: { email: 'o@example.com', password: 'owner-password' } })).cookie;
  assert.equal((await call('/stats', { cookie: owner })).status, 200);
  assert.equal((await call('/stats', { bearer: 'setup-token' })).status, 200, 'admin token still works for scripts');

  for (let i = 0; i < 10; i++) await call('/api/auth/login', { method: 'POST', body: { email: 'o@example.com', password: 'bad-password-x' } });
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'o@example.com', password: 'owner-password' } })).status, 429, 'brute force is throttled');
});

test('audit log: who changed what, never passwords', { timeout: 20000 }, async (t) => {
  const { call } = await boot(t);
  const owner = (await call('/api/auth/setup', { method: 'POST', body: { email: 'o@example.com', password: 'owner-password' } })).cookie;
  await call('/api/campaigns', { method: 'POST', cookie: owner, body: { id: 'aud', name: 'Before', totalCap: 1 } });
  await call('/api/campaigns/aud', { method: 'PATCH', cookie: owner, body: { name: 'After', dailyCap: 5 } });
  await call('/api/users', { method: 'POST', cookie: owner, body: { email: 'b@example.com', password: 'buyer-password' } });
  await call('/api/auth/login', { method: 'POST', body: { email: 'b@example.com', password: 'buyer-password' } });
  await call('/r/aud/offer-1');
  const all = (await call('/api/audit', { cookie: owner })).json.entries;
  assert.ok(!JSON.stringify(all).includes('password'), 'no passwords in the log');
  const camp = (await call('/api/audit?entity=campaign&id=aud', { cookie: owner })).json.entries;
  assert.deepEqual(camp.map((e) => e.action), ['pause', 'update', 'create'], 'newest first, auto-pause by totalCap included');
  assert.equal(camp[1].actor, 'o@example.com');
  assert.deepEqual(camp[1].changes.name, ['Before', 'After']);
  assert.deepEqual(camp[1].changes.dailyCap, [null, 5]);
  assert.equal(camp[0].actor, 'system');
  assert.ok(all.some((e) => e.action === 'login' && e.actor === 'b@example.com'));
  assert.equal((await call('/api/audit')).status, 401, 'anonymous cannot read the log');
});

test('buyer share setting: owner only, validated, audited', { timeout: 20000 }, async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('/api/settings')).json.buyerSharePct, 35, 'default 35%');
  const owner = (await call('/api/auth/setup', { method: 'POST', body: { email: 'o@example.com', password: 'owner-password' } })).cookie;
  await call('/api/users', { method: 'POST', cookie: owner, body: { email: 'b@example.com', password: 'buyer-password' } });
  const buyer = (await call('/api/auth/login', { method: 'POST', body: { email: 'b@example.com', password: 'buyer-password' } })).cookie;
  assert.equal((await call('/api/settings', { method: 'PATCH', cookie: buyer, body: { buyerSharePct: 90 } })).status, 403, 'buyers cannot raise their own share');
  assert.equal((await call('/api/settings', { method: 'PATCH', cookie: owner, body: { buyerSharePct: 150 } })).status, 400);
  assert.equal((await call('/api/settings', { method: 'PATCH', cookie: owner, body: { buyerSharePct: 40 } })).json.buyerSharePct, 40);
  assert.equal((await call('/api/settings')).json.buyerSharePct, 40);
  const log = (await call('/api/audit?entity=settings', { cookie: owner })).json.entries;
  assert.deepEqual(log[0].changes.buyerSharePct, [35, 40]);
});
