// Security hardening: S2S SSRF guard, login throttling, /lp/click and /postback limits, rejected postbacks
// aggregated in the journal, data file modes, CSV formula prefix, host-position macros.
// Every request goes to local mock servers; nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { sendPostback } from '../src/source-postback.js';
import { createLoginLimiter, createRateLimiter } from '../src/rate-limit.js';

const TOKEN = 'security-test-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) { const value = await check(); if (value) return value; }
  assert.fail(`timed out waiting for ${what}`);
}
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

async function tracker(t, environment = {}, prepare = async () => {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-security-'));
  await prepare(dataDir);
  const server = await startTestServer(dataDir, { ADMIN_TOKEN: TOKEN, ...environment });
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const call = (path, body, method = body ? 'POST' : 'GET') => fetch(server.url + path, { method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const click = async (campaign, query = '') => {
    const response = await fetch(`${server.url}/r/${campaign}${query}`, { redirect: 'manual' });
    assert.equal(response.status, 302, `click on ${campaign}${query}`);
    return new URL(response.headers.get('location')).searchParams.get('click_id');
  };
  const journal = async () => (await readFile(join(dataDir, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { server, dataDir, call, click, journal };
}

// HTTPS mock (offer postback URLs must be https). `respond(req)` returns [status, headers].
async function httpsMock(t, respond) {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-security-tls-'));
  const key = join(dir, 'mock.key'), cert = join(dir, 'mock.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const requests = [];
  const server = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    requests.push(req.url);
    const [status, headers = {}] = respond(req);
    res.writeHead(status, headers); res.end('ok');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { url: `https://127.0.0.1:${server.address().port}`, cert, requests };
}

async function httpMock(t) {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req.url); res.writeHead(200); res.end('internal'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function setupOffer(call, { offer = 'sec-offer', campaign = 'sec-campaign', url = 'https://offer.example.com/', postbackUrl } = {}) {
  assert.equal((await call('/api/offers', { id: offer, url, ...(postbackUrl ? { postbackUrl } : {}) })).status, 201);
  assert.equal((await call('/api/campaigns', { id: campaign, name: campaign, streams: [{ name: 'main', offers: [{ offerId: offer }] }] })).status, 201);
}

// ---------- 1. SSRF: offer S2S postbacks ----------

test('S2S postback to a private address is refused once, without retries, and journaled', { skip: !hasOpenssl && 'openssl not available', timeout: 30000 }, async (t) => {
  const mock = await httpsMock(t, () => [200]);
  // No S2S_ALLOW_PRIVATE: production mode. The mock on 127.0.0.1 must never be reached.
  const { server, call, click } = await tracker(t, { S2S_RETRY_MS: '20', NODE_EXTRA_CA_CERTS: mock.cert });
  await setupOffer(call, { postbackUrl: `${mock.url}/pb?cid={click_id}` });
  const clickId = await click('sec-campaign');
  assert.equal((await fetch(`${server.url}/postback?click_id=${clickId}&secret=conversion-test-secret`)).status, 200);
  const out = await until(async () => { const r = await (await call('/api/postbacks?direction=out')).json(); return r.postbacks.length && r.postbacks; }, 'outgoing journal');
  await sleep(200);
  const all = (await (await call('/api/postbacks?direction=out')).json()).postbacks;
  assert.equal(all.length, 1, 'a refusal is final: one attempt');
  assert.deepEqual([out[0].statusCode, out[0].error, out[0].attempt], [null, 'private_address_refused', 1]);
  assert.equal(mock.requests.length, 0, 'the private target was never contacted');
});

test('S2S postback does not follow a redirect (e.g. to the metadata address or an internal service)', { skip: !hasOpenssl && 'openssl not available', timeout: 30000 }, async (t) => {
  const internal = await httpMock(t);
  const mock = await httpsMock(t, () => [302, { location: `${internal.url}/latest/meta-data/` }]);
  // Loopback allowed only so that the local mock can play the network; the redirect must still not be followed.
  const { server, call, click } = await tracker(t, { S2S_RETRY_MS: '20', S2S_ALLOW_PRIVATE: '1', NODE_EXTRA_CA_CERTS: mock.cert });
  await setupOffer(call, { postbackUrl: `${mock.url}/pb?cid={click_id}` });
  const clickId = await click('sec-campaign');
  assert.equal((await fetch(`${server.url}/postback?click_id=${clickId}&secret=conversion-test-secret`)).status, 200);
  const out = await until(async () => { const r = await (await call('/api/postbacks?direction=out')).json(); return r.postbacks.length && r.postbacks; }, 'outgoing journal');
  await sleep(200);
  assert.deepEqual([out[0].statusCode, out[0].error, out[0].attempt], [302, 'HTTP 302', 1], '3xx is final, not followed');
  assert.equal(mock.requests.length, 1);
  assert.equal(internal.requests.length, 0, 'redirect target never contacted');
});

test('hardened sender: metadata and private ranges are refused even in the loopback test mode', async () => {
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'https://10.0.0.1/', 'https://[::ffff:127.0.0.1]/', 'https://192.168.1.1/'])
    assert.equal((await sendPostback(url, { allowPrivate: true, timeoutMs: 1000 })).error, 'private_address_refused', url);
  assert.equal((await sendPostback('https://127.0.0.1:1/', { allowPrivate: false, timeoutMs: 1000 })).error, 'private_address_refused');
});

// ---------- 2. Login throttling ----------

async function loginAs(server, email, password) {
  return (await fetch(`${server.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'umbrella' },
    body: JSON.stringify({ email, password }) })).status;
}

test('login: parallel guesses are counted before the password check', { timeout: 30000 }, async (t) => {
  const { server, call } = await tracker(t);
  assert.equal((await call('/api/users', { email: 'victim@example.com', password: 'victim-password-1' })).status, 201);
  const statuses = await Promise.all(Array.from({ length: 40 }, () => loginAs(server, 'victim@example.com', 'wrong-password-x')));
  const limited = statuses.filter((s) => s === 429).length;
  assert.ok(limited >= 30, `at least 30 of 40 parallel guesses throttled, got ${limited} (${statuses.join(',')})`);
  assert.ok(statuses.every((s) => s === 401 || s === 429));
  assert.equal(await loginAs(server, 'victim@example.com', 'victim-password-1'), 429, 'still throttled for the right password');
});

test('login: a success on your own account does not reset the counter of another account', { timeout: 30000 }, async (t) => {
  const { server, call } = await tracker(t);
  assert.equal((await call('/api/users', { email: 'victim2@example.com', password: 'victim-password-2' })).status, 201);
  assert.equal((await call('/api/users', { email: 'attacker@example.com', password: 'attacker-password' })).status, 201);
  for (let i = 0; i < 9; i++) assert.equal(await loginAs(server, 'victim2@example.com', `guess-${i}-xxxx`), 401);
  assert.equal(await loginAs(server, 'attacker@example.com', 'attacker-password'), 200, 'own account logs in');
  assert.equal(await loginAs(server, 'victim2@example.com', 'guess-9-xxxx'), 401, '10th guess');
  assert.equal(await loginAs(server, 'victim2@example.com', 'guess-10-xxxx'), 429, 'the 11th is throttled: the counter was not reset');
  assert.equal(await loginAs(server, 'attacker@example.com', 'attacker-password'), 200, 'other accounts from the same IP still work');
});

test('login limiter: per email across IPs, per IP across emails, success clears only its own pair', () => {
  const limiter = createLoginLimiter({ windowMs: 60000, perPair: 3, perEmail: 5, perIp: 7 });
  // One account guessed from many addresses: the per-email limit stops it.
  let allowed = 0;
  for (let i = 0; i < 20; i++) if (limiter.reserve('Target@Example.com', `198.51.100.${i}`)) allowed += 1;
  assert.equal(allowed, 5);
  assert.equal(limiter.reserve('target@example.com ', '203.0.113.9'), null, 'email normalized');
  // One address guessing many accounts: the per-IP limit stops it.
  allowed = 0;
  for (let i = 0; i < 20; i++) if (limiter.reserve(`user${i}@example.com`, '192.0.2.1')) allowed += 1;
  assert.equal(allowed, 7);
  // A success removes only its own pair counter.
  const other = createLoginLimiter({ windowMs: 60000, perPair: 2, perEmail: 100, perIp: 100 });
  other.reserve('a@example.com', '192.0.2.2'); other.reserve('a@example.com', '192.0.2.2');
  other.success(other.reserve('b@example.com', '192.0.2.2'));
  assert.equal(other.reserve('a@example.com', '192.0.2.2'), null);
  const generic = createRateLimiter({ limit: 2, windowMs: 1000 });
  assert.deepEqual([generic.hit('x', 0), generic.hit('x', 1), generic.hit('x', 2), generic.hit('x', 1001)], [false, false, true, false]);
});

// ---------- 3. /lp/click and /postback limits, rejected postbacks ----------

test('/lp/click and /postback have their own per-IP limits', { timeout: 30000 }, async (t) => {
  const { server, call, click } = await tracker(t, { LP_CLICK_RATE_LIMIT: '3', POSTBACK_RATE_LIMIT: '3' });
  await setupOffer(call);
  const clickId = await click('sec-campaign');
  const lp = [];
  for (let i = 0; i < 4; i++) lp.push((await fetch(`${server.url}/lp/click?click_id=${clickId}`, { redirect: 'manual' })).status);
  assert.deepEqual(lp, [302, 302, 302, 429]);
  const pb = [];
  for (let i = 0; i < 4; i++) pb.push((await fetch(`${server.url}/postback?click_id=${randomUUID()}&secret=conversion-test-secret`)).status);
  assert.deepEqual(pb, [404, 404, 404, 429]);
});

test('postbacks with a wrong secret: one journal event per IP and minute, the rest aggregated', { timeout: 30000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-security-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = await startTestServer(dataDir, { ADMIN_TOKEN: TOKEN });
  for (let i = 0; i < 6; i++) assert.equal((await fetch(`${server.url}/postback?click_id=${randomUUID()}&secret=wrong-${i}`)).status, 401);
  const call = (path) => fetch(server.url + path, { headers: { authorization: `Bearer ${TOKEN}` } });
  const incoming = (await (await call('/api/postbacks?direction=in')).json()).postbacks;
  assert.equal(incoming.length, 1, 'only the first rejection of the minute is journaled at once');
  assert.deepEqual([incoming[0].statusCode, incoming[0].error], [401, 'invalid_postback_secret']);
  assert.ok(!incoming[0].url.includes('wrong-0'), 'secret not stored');
  await server.stop(); // shutdown writes the pending count
  const events = (await readFile(join(dataDir, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'postback_in');
  assert.deepEqual(events.map((e) => e.error), ['invalid_postback_secret', 'invalid_postback_secret ×5 more']);
});

test('a flood of postbacks that change nothing (unknown click, malformed id, duplicates) is aggregated in the journal', { timeout: 30000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-security-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = await startTestServer(dataDir, { ADMIN_TOKEN: TOKEN });
  const pb = (id, extra = '') => fetch(`${server.url}/postback?click_id=${id}&secret=conversion-test-secret${extra}`);
  for (let i = 0; i < 10; i++) assert.equal((await pb(randomUUID())).status, 404);
  for (let i = 0; i < 10; i++) assert.equal((await pb(`bad-${i}`)).status, 400);
  const hit = await fetch(`${server.url}/r/demo/offer-1`, { redirect: 'manual' });
  const clickId = new URL(hit.headers.get('location')).searchParams.get('click_id');
  for (let i = 0; i < 10; i++) assert.equal((await (await pb(clickId, '&revenue=1')).json()).duplicate, i > 0 ? true : undefined);
  await server.stop();
  const events = (await readFile(join(dataDir, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'postback_in');
  assert.deepEqual(events.map((e) => [e.statusCode, e.error]).sort(), [
    [200, 'conversion_already_recorded'], [200, 'conversion_already_recorded ×8 more'], [200, null],
    [400, 'invalid_click_id'], [400, 'invalid_click_id ×9 more'],
    [404, 'click_not_found'], [404, 'click_not_found ×9 more']].sort());
});

// ---------- 4. File modes ----------

test('data files are written owner-only (0600) and older files are tightened at startup', { skip: process.platform === 'win32' && 'POSIX modes', timeout: 30000 }, async (t) => {
  const { server, dataDir, call, click } = await tracker(t, {}, async (dir) => {
    await writeFile(join(dir, 'offers.json'), '{}\n'); await chmod(join(dir, 'offers.json'), 0o644);
    await writeFile(join(dir, 'events.jsonl'), ''); await chmod(join(dir, 'events.jsonl'), 0o644);
  });
  const mode = async (name) => (await stat(join(dataDir, name))).mode & 0o777;
  assert.equal(await mode('offers.json'), 0o600, 'existing offers.json tightened');
  assert.equal(await mode('events.jsonl'), 0o600, 'existing journal tightened');
  await setupOffer(call);
  await click('sec-campaign');
  assert.equal((await call('/api/sources', { id: 'src-1', name: 'S' })).status, 201);
  assert.equal((await call('/api/networks', { id: 'net-1', name: 'N' })).status, 201);
  assert.equal((await call('/api/landings', { id: 'lp-1', url: 'https://lp.example.com/' })).status, 201);
  assert.equal((await call('/api/settings', { buyerSharePct: 10 }, 'PATCH')).status, 200);
  for (const name of ['offers.json', 'campaigns.json', 'events.jsonl', 'sources.json', 'networks.json', 'landings.json', 'settings.json'])
    assert.equal(await mode(name), 0o600, name);
  assert.ok(server.url);
});

// ---------- 5. CSV formula prefix ----------

test('CSV export prefixes text cells starting with = + - @ tab or CR', { timeout: 30000 }, async (t) => {
  const { server, call, click } = await tracker(t);
  await setupOffer(call);
  const values = ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tcalc', '\r=1', 'plain'];
  for (const v of values) await click('sec-campaign', `?sub_id_1=${encodeURIComponent(v)}`);
  const csv = await (await call('/stats/export?group=sub_id_1')).text();
  const keys = csv.replace(/^﻿/, '').trim().split('\n').slice(1).map((line) => line.startsWith('"') ? line.slice(1, line.indexOf('",')).replace(/""/g, '"') : line.split(',')[0]);
  for (const v of values.slice(0, -1)) assert.ok(keys.includes(`'${v}`), `${JSON.stringify(v)} prefixed in ${JSON.stringify(keys)}`);
  assert.ok(keys.includes('plain'));
  assert.match(csv, /,-?\d/, 'numbers are not prefixed');
  // Client-side exports in public/admin/admin.js use the same rule.
  const admin = await readFile(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
  assert.match(admin, /\/\^\[=\+\\-@\\t\\r\]\/\.test\(text\)/, 'table export prefixes formula cells');
  assert.ok(admin.includes("fc === '\\t' || fc === '\\r'"), 'report export covers tab and CR');
  assert.ok(server.url);
});

// ---------- 6. Macros in the host part ----------

test('a macro in the host cannot move a redirect to another domain', { timeout: 30000 }, async (t) => {
  const { server, call, click, journal } = await tracker(t);
  await setupOffer(call, { offer: 'host-any', campaign: 'cmp-any', url: 'https://{source}/landing' });
  await setupOffer(call, { offer: 'host-sub', campaign: 'cmp-sub', url: 'https://{source}.shop.example.com/landing?click_id={click_id}' });
  await setupOffer(call, { offer: 'host-glued', campaign: 'cmp-glued', url: 'https://{source}example.com/' });

  const any = await fetch(`${server.url}/r/cmp-any?source=evil.example.net`, { redirect: 'manual' });
  assert.equal(any.status, 404, 'host made only of a macro is refused');
  assert.equal((await any.json()).error, 'unsafe_destination');
  assert.equal((await fetch(`${server.url}/r/cmp-glued?source=evil`, { redirect: 'manual' })).status, 404, 'macro glued to the domain is refused');

  const ok = await fetch(`${server.url}/r/cmp-sub?source=fr`, { redirect: 'manual' });
  assert.equal(ok.status, 302);
  assert.equal(new URL(ok.headers.get('location')).hostname, 'fr.shop.example.com', 'subdomain macro still works');
  for (const evil of ['evil.com/', 'evil.com?', 'evil.com#', 'evil.com\\', 'evil.com:1@x']) {
    const r = await fetch(`${server.url}/r/cmp-sub?source=${encodeURIComponent(evil)}`, { redirect: 'manual' });
    if (r.status === 302) assert.ok(new URL(r.headers.get('location')).hostname.endsWith('.shop.example.com'), `${evil} stays under the domain`);
    else assert.equal(r.status, 404, evil);
  }
  // /lp/click: the click is recorded with a harmless source, so the check happens on the stored params.
  const clickId = await click('cmp-sub', '?source=de');
  const lp = await fetch(`${server.url}/lp/click?click_id=${clickId}`, { redirect: 'manual' });
  assert.equal(lp.status, 302, await lp.clone().text());
  assert.equal(new URL(lp.headers.get('location')).hostname, 'de.shop.example.com');
  const refused = (await journal()).filter((e) => e.type === 'click' && ['cmp-any', 'cmp-glued'].includes(e.campaign));
  assert.equal(refused.length, 0, 'refused destinations record no click');
});
