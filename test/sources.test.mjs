import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

async function withServer(t, fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-sources-'));
  const server = await startTestServer(dataDir);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const post = (path, body, method = 'POST') => fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await fn({ url: server.url, post });
}

test('sources CRUD', { timeout: 15000 }, async (t) => {
  await withServer(t, async ({ url, post }) => {
    // GET empty
    const empty = await (await fetch(url + '/api/sources')).json();
    assert.deepEqual(empty.sources, {});

    // POST - valid
    const created = await post('/api/sources', { id: 'fb-ads', name: 'Facebook Ads', paramMap: { sub_id_1: 'adset_id', creative_id: 'ad_id' }, costModel: 'cpc', cpc: 0.15 });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.id, 'fb-ads');
    assert.equal(body.name, 'Facebook Ads');
    assert.deepEqual(body.paramMap, { sub_id_1: 'adset_id', creative_id: 'ad_id' });
    assert.equal(body.costModel, 'cpc');
    assert.equal(body.cpc, 0.15);
    assert.equal(body.costFromParam, false);

    // GET after create
    const list = await (await fetch(url + '/api/sources')).json();
    assert.ok('fb-ads' in list.sources);
    assert.equal(list.sources['fb-ads'].name, 'Facebook Ads');

    // POST - invalid id
    const badId = await post('/api/sources', { id: '../bad', name: 'x' });
    assert.equal(badId.status, 400);
    assert.equal((await badId.json()).error, 'valid_id_required');

    // PATCH - update name and costModel
    const patched = await post('/api/sources/fb-ads', { name: 'FB Ads Updated', costModel: 'none', costFromParam: true }, 'PATCH');
    assert.equal(patched.status, 200);
    const patchedBody = await patched.json();
    assert.equal(patchedBody.name, 'FB Ads Updated');
    assert.equal(patchedBody.costModel, 'none');
    assert.equal(patchedBody.costFromParam, true);
    assert.deepEqual(patchedBody.paramMap, { sub_id_1: 'adset_id', creative_id: 'ad_id' }, 'unchanged field is preserved');

    // PATCH - non-existent source
    const miss = await post('/api/sources/no-such', { name: 'x' }, 'PATCH');
    assert.equal(miss.status, 404);
    assert.equal((await miss.json()).error, 'source_not_found');

    // paramMap - unknown fields are dropped, unsafe keys are dropped
    const s2 = await post('/api/sources', { id: 'src2', paramMap: { sub_id_1: 'ad_id', bogus_field: 'x', sub_id_2: 'bad key!' } });
    const s2body = await s2.json();
    assert.deepEqual(s2body.paramMap, { sub_id_1: 'ad_id' }, 'unknown and unsafe-keyed fields are dropped');
  });
});

test('sourceId on campaign', { timeout: 15000 }, async (t) => {
  await withServer(t, async ({ url, post }) => {
    // Create source
    await post('/api/sources', { id: 'ggl', name: 'Google', paramMap: { keyword: 'kw', sub_id_1: 'gclid' }, costModel: 'cpc', cpc: 0.5 });

    // Create campaign with sourceId
    const camp = await post('/api/campaigns', { id: 'camp-src', name: 'Camp', sourceId: 'ggl' });
    assert.equal(camp.status, 201);
    assert.equal((await camp.json()).sourceId, 'ggl');

    // GET campaigns - sourceId is present
    const camps = (await (await fetch(url + '/api/campaigns')).json()).campaigns;
    assert.equal(camps['camp-src'].sourceId, 'ggl');

    // PATCH campaign - change sourceId
    const patched = await post('/api/campaigns/camp-src', { sourceId: null }, 'PATCH');
    assert.equal((await patched.json()).sourceId, null, 'sourceId can be cleared');

    // PATCH campaign - invalid sourceId is rejected (set to null)
    const badSrc = await post('/api/campaigns/camp-src', { sourceId: '../evil' }, 'PATCH');
    assert.equal((await badSrc.json()).sourceId, null, 'invalid sourceId becomes null');

    // sourceId survives PATCH of other fields
    await post('/api/campaigns/camp-src', { sourceId: 'ggl' }, 'PATCH');
    const afterName = await post('/api/campaigns/camp-src', { name: 'Renamed' }, 'PATCH');
    assert.equal((await afterName.json()).sourceId, 'ggl', 'sourceId persists through unrelated PATCH');
  });
});
