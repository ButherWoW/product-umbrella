// Secret-carrying reads need a login whatever REQUIRE_LOGIN says; password change and reset; the per-email login limit
// cannot lock out an address the owner already logged in from; demo entities are optional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { createLoginLimiter } from '../src/rate-limit.js';

async function boot(t, environment = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-acct-'));
  const server = await startTestServer(dataDir, environment);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, { method = 'GET', body, cookie, bearer } = {}) => {
    const headers = { 'x-requested-with': 'umbrella' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetch(server.url + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, cookie: ((res.headers.get('set-cookie') || '').match(/umb_session=([^;]*)/) || [])[0] || null };
  };
  return { call, server };
}

test('/api/offers and /api/sources are closed to anonymous visitors once any credential exists, even without REQUIRE_LOGIN', { timeout: 20000 }, async (t) => {
  const { call } = await boot(t, { ADMIN_TOKEN: 'carrier-token' }); // no REQUIRE_LOGIN
  for (const path of ['/api/offers', '/api/sources', '/api/offers/offer-1']) assert.equal((await call(path)).status, 401, path);
  assert.equal((await call('/api/offers', { bearer: 'carrier-token' })).status, 200);
  assert.equal((await call('/api/sources', { bearer: 'carrier-token' })).status, 200);
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/r/demo/offer-1')).status, 302, 'tracking stays public');
});

test('a fresh install without any credential stays open (first run, tests)', { timeout: 20000 }, async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('/api/offers')).status, 200);
  const owner = await call('/api/auth/setup', { method: 'POST', body: { email: 'boss@example.com', password: 'long-password-1' } });
  assert.equal(owner.status, 201);
  assert.equal((await call('/api/offers')).status, 401, 'closed as soon as the first user exists');
  assert.equal((await call('/api/offers', { cookie: owner.cookie })).status, 200);
});

test('password: own change needs the current one and ends other sessions; the owner can reset a buyer', { timeout: 30000 }, async (t) => {
  const { call } = await boot(t, { ADMIN_TOKEN: 'pw-token' });
  const owner = (await call('/api/auth/setup', { method: 'POST', bearer: 'pw-token', body: { email: 'boss@example.com', password: 'long-password-1' } })).cookie;
  const created = await call('/api/users', { method: 'POST', cookie: owner, body: { email: 'buyer@example.com', password: 'buyer-password-1' } });
  assert.equal(created.status, 201);
  const buyerId = created.json.user.id;
  const login = (email, password) => call('/api/auth/login', { method: 'POST', body: { email, password } });
  const first = (await login('buyer@example.com', 'buyer-password-1')).cookie;
  const second = (await login('buyer@example.com', 'buyer-password-1')).cookie;

  assert.equal((await call('/api/auth/password', { method: 'POST', body: { currentPassword: 'x', newPassword: 'another-password-2' } })).status, 401);
  assert.equal((await call('/api/auth/password', { method: 'POST', cookie: first, body: { currentPassword: 'wrong-password-0', newPassword: 'another-password-2' } })).json.error, 'invalid_current_password');
  assert.equal((await call('/api/auth/password', { method: 'POST', cookie: first, body: { currentPassword: 'buyer-password-1', newPassword: 'short' } })).json.error, 'password_too_short');
  assert.equal((await call('/api/auth/password', { method: 'POST', cookie: first, body: { currentPassword: 'buyer-password-1', newPassword: 'another-password-2' } })).status, 200);
  assert.equal((await call('/api/auth/me', { cookie: first })).json.user.email, 'buyer@example.com', 'the session that changed it stays');
  assert.equal((await call('/api/auth/me', { cookie: second })).json.user, null, 'other sessions end');
  assert.equal((await login('buyer@example.com', 'buyer-password-1')).status, 401, 'old password is gone');
  const again = await login('buyer@example.com', 'another-password-2');
  assert.equal(again.status, 200);

  // Owner reset: buyer-only 403, short password 400, sessions end, ownership is untouched (same id).
  assert.equal((await call(`/api/users/${buyerId}`, { method: 'PATCH', cookie: first, body: { password: 'reset-password-33' } })).status, 403);
  assert.equal((await call(`/api/users/${buyerId}`, { method: 'PATCH', cookie: owner, body: { password: 'short' } })).json.error, 'password_too_short');
  const reset = await call(`/api/users/${buyerId}`, { method: 'PATCH', cookie: owner, body: { password: 'reset-password-33' } });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.user.id, buyerId);
  assert.equal((await call('/api/auth/me', { cookie: first })).json.user, null);
  assert.equal((await call('/api/auth/me', { cookie: again.cookie })).json.user, null);
  assert.equal((await login('buyer@example.com', 'reset-password-33')).status, 200);
  const audit = await call('/api/audit?entity=user', { cookie: owner });
  assert.equal(JSON.stringify(audit.json).includes('reset-password-33'), false, 'the password is never audited');
});

test('login limiter: guesses from other addresses cannot lock out an address that already logged in', () => {
  const limiter = createLoginLimiter({ perPair: 10, perEmail: 5, perIp: 100 });
  const owner = '198.51.100.1';
  limiter.success(limiter.reserve('boss@example.com', owner)); // a successful login from the owner's address
  for (let i = 0; i < 20; i++) limiter.reserve('boss@example.com', `203.0.113.${i}`); // an attacker's guesses
  assert.equal(limiter.reserve('boss@example.com', '203.0.113.99'), null, 'unknown addresses are blocked by the per-email limit');
  assert.ok(limiter.reserve('boss@example.com', owner), 'the owner\'s known address still gets in');
  // The known address is still limited per pair: guessing from it is not free.
  const pair = createLoginLimiter({ perPair: 3, perEmail: 5, perIp: 100 });
  pair.success(pair.reserve('a@example.com', '1.1.1.1'));
  for (let i = 0; i < 3; i++) assert.ok(pair.reserve('a@example.com', '1.1.1.1'));
  assert.equal(pair.reserve('a@example.com', '1.1.1.1'), null);
});

test('SEED_DEMO=0: no demo campaign / offer-1 to click', { timeout: 20000 }, async (t) => {
  const { call } = await boot(t, { SEED_DEMO: '0' });
  assert.equal((await call('/r/demo/offer-1')).status, 404);
  assert.deepEqual(Object.keys((await call('/api/offers')).json.offers || {}).filter((id) => id === 'offer-1'), []);
});
