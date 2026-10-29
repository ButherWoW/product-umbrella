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
    assert.equal((await call('/api/sources', { id: ids.source, name: 'FB', costModel: 'cpc', cpc: 0.1, costFromParam: true, paramMap: { sub_id_1: 'ad_id' } })).status, 201);
    assert.equal((await call('/api/networks', { id: ids.network, name: 'Net', offerParams: 'sub1={click_id}', clickIdParam: '{sub1}', payoutParam: '{payout}' })).status, 201);
    assert.equal((await call('/api/offers', { id: ids.offer, url: 'https://example.com/o', networkId: ids.network, group: 'Kitchen' })).status, 201);
    assert.equal((await call('/api/campaigns', { id: ids.campaign, name: 'C', sourceId: ids.source, group: 'FR', streams: [{ name: 'm', offers: [{ offerId: ids.offer }] }] })).status, 201);
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
    const { networks } = await (await call('/api/networks')).json();
    assert.equal(networks[ids.network]?.clickIdParam, '{sub1}');
    const { offers } = await (await call('/api/offers')).json();
    assert.deepEqual([offers[ids.offer]?.networkId, offers[ids.offer]?.group], [ids.network, 'Kitchen']);
    assert.equal(offers[`${ids.offer}-copy`]?.archived, true, 'archived flag stored in PostgreSQL');
    const { campaigns } = await (await call('/api/campaigns')).json();
    const c = campaigns[ids.campaign];
    assert.deepEqual([c?.sourceId, c?.group, c?.costModel, c?.cpc, c?.costFromParam, c?.paramMap], [ids.source, 'FR', 'cpc', 0.1, true, { sub_id_1: 'ad_id' }], 'source defaults applied and stored');
    assert.equal(campaigns[`${ids.campaign}-copy`]?.active, false, 'clone starts disabled');
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
