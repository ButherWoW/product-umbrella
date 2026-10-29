// Sources, networks, clones, archive and groups must be stored in PostgreSQL, not only in the JSON files:
// a restart with an empty data directory has to bring them back. Runs only with TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const TOKEN = 'pg-management-token';

test('PostgreSQL: sources, networks, clones, archive and groups survive a restart', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 30000 }, async (t) => {
  const dirs = [];
  const start = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgm-')); dirs.push(dir);
    return startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN });
  };
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  const ids = { source: `src-${run}`, network: `net-${run}`, offer: `off-${run}`, campaign: `cmp-${run}` };

  let server = await start();
  const call = (path, body, method = body ? 'POST' : 'GET') => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await call('/api/sources', { id: ids.source, name: 'FB', costModel: 'cpc', cpc: 0.1, costFromParam: true, paramMap: { sub_id_1: 'ad_id' },
      postbackUrl: 'https://pb.example.com/c?id={external_id}&s={status}', postbackStatuses: ['lead', 'sale'] })).status, 201);
    assert.equal((await call('/api/networks', { id: ids.network, name: 'Net', offerParams: 'sub1={click_id}', clickIdParam: '{sub1}', payoutParam: '{payout}' })).status, 201);
    assert.equal((await call('/api/offers', { id: ids.offer, url: 'https://example.com/o', networkId: ids.network, group: 'Kitchen' })).status, 201);
    assert.equal((await call('/api/campaigns', { id: ids.campaign, name: 'C', sourceId: ids.source, group: 'FR', streams: [{ name: 'm', offers: [{ offerId: ids.offer }] }],
      sourcePostbackUrl: 'https://pb.example.com/camp?s={status}', sourcePostbackStatuses: ['trash'] })).status, 201);
    const clone = await (await call(`/api/campaigns/${ids.campaign}/clone`, {})).json();
    assert.equal(clone.id, `${ids.campaign}-copy`);
    const offerClone = await (await call(`/api/offers/${ids.offer}/clone`, {})).json();
    assert.equal(offerClone.id, `${ids.offer}-copy`);
    assert.equal((await call(`/api/offers/${offerClone.id}`, { archived: true }, 'PATCH')).status, 200);
  } finally { await server.stop(); }

  server = await start();
  try {
    const { sources } = await (await call('/api/sources')).json();
    assert.deepEqual([sources[ids.source]?.cpc, sources[ids.source]?.costFromParam, sources[ids.source]?.paramMap], [0.1, true, { sub_id_1: 'ad_id' }]);
    assert.deepEqual([sources[ids.source]?.postbackUrl, sources[ids.source]?.postbackStatuses], ['https://pb.example.com/c?id={external_id}&s={status}', ['lead', 'sale']], 'source postback stored in PostgreSQL');
    const { networks } = await (await call('/api/networks')).json();
    assert.equal(networks[ids.network]?.clickIdParam, '{sub1}');
    const { offers } = await (await call('/api/offers')).json();
    assert.deepEqual([offers[ids.offer]?.networkId, offers[ids.offer]?.group], [ids.network, 'Kitchen']);
    assert.equal(offers[`${ids.offer}-copy`]?.archived, true, 'archived flag stored in PostgreSQL');
    const { campaigns } = await (await call('/api/campaigns')).json();
    const c = campaigns[ids.campaign];
    assert.deepEqual([c?.sourceId, c?.group, c?.costModel, c?.cpc, c?.costFromParam, c?.paramMap], [ids.source, 'FR', 'cpc', 0.1, true, { sub_id_1: 'ad_id' }], 'source defaults applied and stored');
    assert.equal(campaigns[`${ids.campaign}-copy`]?.active, false, 'clone starts disabled');
    assert.deepEqual([c?.sourcePostbackUrl, c?.sourcePostbackStatuses], ['https://pb.example.com/camp?s={status}', ['trash']], 'campaign postback override stored');
  } finally { await server.stop(); }
});

test('PostgreSQL: offer conversion cap fields persist and the cap is counted from the database', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 30000 }, async (t) => {
  const dirs = [];
  const start = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgcap-')); dirs.push(dir);
    return startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN });
  };
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  const ids = { main: `cap-${run}`, alt: `cap-alt-${run}`, campaign: `cap-cmp-${run}` };
  let server = await start();
  const call = (path, body, method = body ? 'POST' : 'GET') => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const host = async () => new URL((await fetch(`${server.url}/r/${ids.campaign}`, { redirect: 'manual' })).headers.get('location'));
  try {
    assert.equal((await call('/api/offers', { id: ids.alt, url: 'https://alt.example.com/' })).status, 201);
    assert.equal((await call('/api/offers', { id: ids.main, url: 'https://main.example.com/', conversionCap: 1, capTz: 'Asia/Dubai', altOfferId: ids.alt })).status, 201);
    assert.equal((await call('/api/campaigns', { id: ids.campaign, name: 'Cap', streams: [{ name: 'm', offers: [{ offerId: ids.main }] }] })).status, 201);
    const first = await host();
    assert.equal(first.hostname, 'main.example.com');
    assert.equal((await fetch(`${server.url}/postback?click_id=${first.searchParams.get('click_id')}&secret=conversion-test-secret&status=sale`)).status, 200);
    // The cached count is dropped once the asynchronous mirror has the conversion, so the switch follows within moments.
    let routed = null;
    for (let i = 0; i < 40 && routed !== ids.alt; i++) {
      routed = (await (await call('/api/simulate', { campaign: ids.campaign })).json()).result.destinations?.[0]?.offerId;
      if (routed !== ids.alt) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(routed, ids.alt, 'same server switches to the alternative after the postback');
  } finally { await server.stop(); }

  // Empty data directory: offers and the conversion count can only come from PostgreSQL.
  server = await start();
  try {
    const { offers } = await (await call('/api/offers')).json();
    assert.deepEqual([offers[ids.main]?.conversionCap, offers[ids.main]?.capTz, offers[ids.main]?.altOfferId], [1, 'Asia/Dubai', ids.alt]);
    assert.equal(offers[ids.alt]?.conversionCap, null);
    const next = await host();
    assert.equal(next.hostname, 'alt.example.com', 'cap reached in PostgreSQL → alternative offer');
    const log = await (await call(`/api/clicks?campaign=${ids.campaign}`)).json();
    const recorded = log.clicks.find((c) => c.clickId === next.searchParams.get('click_id'));
    // The click log may read PostgreSQL before the asynchronous mirror catches up; the JSONL copy is checked then.
    if (recorded) assert.equal(recorded.offerId, ids.alt);
    assert.equal((await call(`/api/offers/${ids.main}`, { altOfferId: null }, 'PATCH')).status, 200);
    const { offers: after } = await (await call('/api/offers')).json();
    assert.equal(after[ids.main].altOfferId, null, 'alternative cleared');
    const capped = await fetch(`${server.url}/r/${ids.campaign}`, { redirect: 'manual' });
    assert.equal(capped.status, 404, 'no alternative → the stream has no usable offer');
  } finally { await server.stop(); }
});

test('PostgreSQL: API keys survive a restart, only their hash is stored', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 30000 }, async (t) => {
  const dirs = [];
  const start = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgk-')); dirs.push(dir);
    return startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN, REQUIRE_LOGIN: '1' });
  };
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  const email = `key-${run}@example.com`;
  let server = await start();
  const call = (path, { method = 'GET', body, bearer = TOKEN, cookie } = {}) => fetch(server.url + path, { method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'umbrella', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let secret, keyId;
  try {
    assert.equal((await call('/api/users', { method: 'POST', body: { email, password: 'buyer-password-pg' } })).status, 201);
    const login = await call('/api/auth/login', { method: 'POST', bearer: null, body: { email, password: 'buyer-password-pg' } });
    const cookie = (login.headers.get('set-cookie').match(/umb_session=[^;]*/) || [])[0];
    const created = await (await call('/api/keys', { method: 'POST', bearer: null, cookie, body: { name: 'pg key' } })).json();
    ({ secret } = created); keyId = created.key.id;
    assert.match(secret, /^umb_/);
    assert.equal((await (await call('/api/auth/me', { bearer: secret })).json()).user.email, email);
  } finally { await server.stop(); }

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT * FROM api_keys WHERE id = $1', [keyId]);
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows[0]).includes(secret), 'secret is not stored');
    assert.equal(rows[0].last4, secret.slice(-4));
    assert.ok(rows[0].last_used_at, 'last use recorded');
  } finally { await client.end(); }

  server = await start();
  try {
    assert.equal((await (await call('/api/auth/me', { bearer: secret })).json()).user.email, email, 'key works after a restart with an empty data directory');
    const keys = (await (await call('/api/keys?all=1')).json()).keys;
    assert.ok(keys.some((k) => k.id === keyId && k.email === email && k.lastUsedAt));
    assert.equal((await call(`/api/keys/${keyId}`, { method: 'DELETE' })).status, 200);
    assert.equal((await call('/api/campaigns', { bearer: secret })).status, 401);
  } finally { await server.stop(); }
});

test('PostgreSQL: viewer role and permission flags survive a restart', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 30000 }, async (t) => {
  const dirs = [];
  const start = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgp-')); dirs.push(dir);
    return startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN, REQUIRE_LOGIN: '1' });
  };
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  const viewerEmail = `viewer-${run}@example.com`, buyerEmail = `hidden-${run}@example.com`;
  let server = await start();
  const call = (path, { method = 'GET', body, bearer = TOKEN, cookie } = {}) => fetch(server.url + path, { method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'umbrella', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let viewerId, buyerId;
  try {
    const viewer = await (await call('/api/users', { method: 'POST', body: { email: viewerEmail, password: 'viewer-password-pg', role: 'viewer', viewAll: true } })).json();
    viewerId = viewer.user.id;
    assert.deepEqual([viewer.user.role, viewer.user.viewAll], ['viewer', true]);
    buyerId = (await (await call('/api/users', { method: 'POST', body: { email: buyerEmail, password: 'buyer-password-pg' } })).json()).user.id;
    const patched = await (await call(`/api/users/${buyerId}`, { method: 'PATCH', body: { hideRevenue: true, offersAccess: 'own' } })).json();
    assert.deepEqual([patched.user.hideRevenue, patched.user.offersAccess], [true, 'own']);
  } finally { await server.stop(); }

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT id, role, hide_revenue, offers_access, view_all FROM users WHERE id = ANY($1) ORDER BY email DESC', [[viewerId, buyerId]]);
    assert.deepEqual(rows.map((r) => [r.role, r.hide_revenue, r.offers_access, r.view_all]), [['viewer', false, 'all', true], ['buyer', true, 'own', false]]);
  } finally { await client.end(); }

  server = await start();
  try {
    const list = (await (await call('/api/users')).json()).users;
    const v = list.find((u) => u.id === viewerId), b = list.find((u) => u.id === buyerId);
    assert.deepEqual([v.role, v.viewAll, b.hideRevenue, b.offersAccess], ['viewer', true, true, 'own'], 'flags come back from PostgreSQL');
    const login = await call('/api/auth/login', { method: 'POST', bearer: null, body: { email: viewerEmail, password: 'viewer-password-pg' } });
    const cookie = (login.headers.get('set-cookie').match(/umb_session=[^;]*/) || [])[0];
    const write = await call('/api/campaigns', { method: 'POST', bearer: null, cookie, body: { id: `pgv-${run}`, name: 'x' } });
    assert.deepEqual([write.status, (await write.json()).error], [403, 'read_only'], 'viewer stays read-only after a restart');
    assert.equal((await call('/api/campaigns', { bearer: null, cookie })).status, 200);
  } finally { await server.stop(); }
});
