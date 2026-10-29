// User permissions (Keitaro «Права пользователей»): read-only viewer, hideRevenue response filter, offersAccess 'own'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

async function boot(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-perms-'));
  const server = await startTestServer(dataDir);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, { method = 'GET', body, cookie } = {}) => {
    const headers = { 'x-requested-with': 'umbrella' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(server.url + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, cookie: (res.headers.get('set-cookie')?.match(/umb_session=([^;]*)/) || [])[0] || null, location: res.headers.get('location') };
  };
  const owner = (await call('/api/auth/setup', { method: 'POST', body: { email: 'owner@example.com', password: 'owner-password' } })).cookie;
  const addUser = async (email, extra = {}) => {
    const created = await call('/api/users', { method: 'POST', cookie: owner, body: { email, password: 'user-password-1', ...extra } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const cookie = (await call('/api/auth/login', { method: 'POST', body: { email, password: 'user-password-1' } })).cookie;
    return { id: created.json.user.id, user: created.json.user, cookie };
  };
  const addOffer = (id) => call('/api/offers', { method: 'POST', cookie: owner, body: { id, url: `https://${id}.example.com/?cid={click_id}`, postbackUrl: `https://net.example.com/pb?c={click_id}&p={revenue}` } });
  const addCampaign = (id, ownerId, offerId) => call('/api/campaigns', { method: 'POST', cookie: owner, body: { id, name: id, ownerId, streams: [{ name: 'Main', offers: [{ offerId, weight: 1 }] }] } });
  // One click with a paid conversion in the campaign.
  const convert = async (campaign, revenue) => {
    const location = (await fetch(`${server.url}/r/${campaign}`, { redirect: 'manual' })).headers.get('location');
    const clickId = new URL(location).searchParams.get('cid');
    assert.ok(clickId, `click id in ${location}`);
    const pb = await fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${clickId}&revenue=${revenue}&currency=EUR`);
    assert.equal(pb.status, 200);
  };
  return { call, owner, addUser, addOffer, addCampaign, convert };
}

test('viewer is read-only and scoped to its own campaigns unless viewAll', { timeout: 30000 }, async (t) => {
  const { call, owner, addUser, addOffer, addCampaign } = await boot(t);
  const viewer = await addUser('viewer@example.com', { role: 'viewer' });
  assert.equal(viewer.user.role, 'viewer');
  assert.deepEqual([viewer.user.hideRevenue, viewer.user.offersAccess, viewer.user.viewAll], [false, 'all', false], 'defaults');
  await addOffer('offer-v');
  assert.equal((await addCampaign('v-camp', viewer.id, 'offer-v')).status, 201);
  assert.equal((await addCampaign('team-camp', null, 'offer-v')).status, 201);

  assert.deepEqual(Object.keys((await call('/api/campaigns', { cookie: viewer.cookie })).json.campaigns), ['v-camp'], 'viewer sees own campaigns');
  assert.equal((await call('/stats', { cookie: viewer.cookie })).status, 200);
  assert.equal((await call('/stats?campaign=team-camp', { cookie: viewer.cookie })).json.error, 'campaign_not_yours');
  assert.equal((await call('/api/offers', { cookie: viewer.cookie })).status, 200, 'reads are allowed');

  const writes = [
    ['/api/campaigns', 'POST', { id: 'v-new', name: 'x' }],
    ['/api/campaigns/v-camp', 'PATCH', { name: 'renamed' }],
    ['/api/campaigns/v-camp/streams', 'PUT', { streams: [] }],
    ['/api/campaigns/v-camp/clone', 'POST', {}],
    ['/api/offers', 'POST', { id: 'offer-z', url: 'https://z.example.com/' }],
    ['/api/offers/offer-v', 'PATCH', { name: 'x' }],
    ['/api/landings', 'POST', { id: 'lp-1', url: 'https://lp.example.com/' }],
    ['/api/settings', 'PATCH', { buyerSharePct: 50 }],
    ['/api/keys', 'POST', { name: 'script' }],
    [`/api/users/${viewer.id}`, 'PATCH', { role: 'owner' }],
    [`/api/users/${viewer.id}`, 'DELETE', undefined],
    ['/api/simulate', 'POST', { campaign: 'v-camp' }],
  ];
  for (const [path, method, body] of writes) {
    const r = await call(path, { method, body, cookie: viewer.cookie });
    assert.deepEqual([r.status, r.json?.error], [403, 'read_only'], `${method} ${path}`);
  }
  assert.equal((await call('/api/campaigns', { cookie: owner })).json.campaigns['v-camp'].name, 'v-camp', 'nothing changed');

  // viewAll widens the read scope, writes stay closed.
  assert.equal((await call(`/api/users/${viewer.id}`, { method: 'PATCH', cookie: owner, body: { viewAll: true } })).json.user.viewAll, true);
  const all = Object.keys((await call('/api/campaigns', { cookie: owner })).json.campaigns).sort();
  assert.deepEqual(Object.keys((await call('/api/campaigns', { cookie: viewer.cookie })).json.campaigns).sort(), all);
  assert.ok(all.includes('team-camp'));
  assert.equal((await call('/stats?campaign=team-camp', { cookie: viewer.cookie })).status, 200);
  assert.equal((await call('/api/campaigns/team-camp', { method: 'PATCH', cookie: viewer.cookie, body: { name: 'x' } })).json.error, 'read_only');

  assert.equal((await call('/api/auth/logout', { method: 'POST', cookie: viewer.cookie })).status, 200, 'logout still works');
  assert.equal((await call('/api/auth/me', { cookie: viewer.cookie })).json.user, null);
});

test('hideRevenue strips revenue fields and offer URLs on the server', { timeout: 30000 }, async (t) => {
  const { call, owner, addUser, addOffer, addCampaign, convert } = await boot(t);
  const buyer = await addUser('buyer@example.com', { hideRevenue: true });
  assert.equal(buyer.user.hideRevenue, true, 'flag accepted on create');
  await addOffer('offer-b');
  await addCampaign('b-camp', buyer.id, 'offer-b');
  await convert('b-camp', 12.5);

  const ownerStats = (await call('/stats', { cookie: owner })).json;
  assert.equal(ownerStats.revenue, 12.5, 'owner is never filtered');
  const stats = await call('/stats', { cookie: buyer.cookie });
  assert.equal(stats.json.clicks, 1);
  assert.equal(stats.json.conversions, 1);
  assert.doesNotMatch(stats.text, /"(revenue|pendingRevenue|profit|roi|epc|rpm)"/i, 'no revenue fields at any depth (removed, not zeroed)');
  assert.equal(stats.json.byCampaign['b-camp'].clicks, 1, 'other metrics stay');
  assert.ok('cost' in stats.json.byCampaign['b-camp'], 'cost stays');
  const today = new Date().toISOString().slice(0, 10);
  const compare = await call(`/stats/compare?from=${today}&to=${today}`, { cookie: buyer.cookie });
  assert.equal(compare.status, 200);
  assert.doesNotMatch(compare.text, /revenue|profit/i);
  assert.doesNotMatch((await call('/stats/timeseries', { cookie: buyer.cookie })).text, /revenue/i);

  const offers = await call('/api/offers', { cookie: buyer.cookie });
  assert.ok(offers.json.offers['offer-b'], 'offer still listed');
  assert.ok(!('url' in offers.json.offers['offer-b']) && !('postbackUrl' in offers.json.offers['offer-b']), 'no offer/postback URL');
  assert.doesNotMatch(offers.text, /example\.com/);
  assert.match((await call('/api/offers', { cookie: owner })).text, /offer-b\.example\.com/, 'owner still sees URLs');

  const conversions = await call('/api/conversions', { cookie: buyer.cookie });
  assert.equal(conversions.json.conversions.length, 1);
  assert.ok(!('revenue' in conversions.json.conversions[0]), 'conversion amount removed');
  assert.equal((await call('/api/conversions', { cookie: owner })).json.conversions[0].revenue, 12.5);

  const csv = await call('/stats/export?group=campaign', { cookie: buyer.cookie });
  const header = csv.text.replace(/^﻿/, '').split('\n')[0].split(',');
  assert.deepEqual(header.filter((c) => /revenue|profit|roi|epc|rpm/i.test(c)), [], `CSV header: ${header}`);
  assert.ok(header.includes('clicks') && header.includes('cost'));
  assert.ok((await call('/stats/export?group=campaign', { cookie: owner })).text.includes('revenue'), 'owner CSV keeps revenue');
  assert.match((await call('/dashboard', { cookie: buyer.cookie })).location || '', /\/admin$/, 'legacy dashboard redirects');

  // Turning the flag off restores the data on the next request.
  await call(`/api/users/${buyer.id}`, { method: 'PATCH', cookie: owner, body: { hideRevenue: false } });
  assert.equal((await call('/stats', { cookie: buyer.cookie })).json.revenue, 12.5);
});

test("offersAccess 'own' limits the offer catalog to offers used in the user's campaigns", { timeout: 30000 }, async (t) => {
  const { call, owner, addUser, addOffer, addCampaign } = await boot(t);
  const buyer = await addUser('own@example.com');
  for (const id of ['offer-mine', 'offer-team', 'offer-free']) await addOffer(id);
  await addCampaign('mine', buyer.id, 'offer-mine');
  await addCampaign('team', null, 'offer-team');
  const total = Object.keys((await call('/api/offers', { cookie: owner })).json.offers).length;
  assert.ok(total >= 3);
  assert.equal(Object.keys((await call('/api/offers', { cookie: buyer.cookie })).json.offers).length, total, "default 'all'");

  const patched = await call(`/api/users/${buyer.id}`, { method: 'PATCH', cookie: owner, body: { offersAccess: 'own' } });
  assert.equal(patched.json.user.offersAccess, 'own');
  assert.deepEqual(Object.keys((await call('/api/offers', { cookie: buyer.cookie })).json.offers), ['offer-mine']);
  assert.equal((await call('/api/offers/offer-team', { method: 'PATCH', cookie: buyer.cookie, body: { name: 'x' } })).status, 404, 'foreign offer cannot be edited');
  assert.equal((await call('/api/offers/offer-team/clone', { method: 'POST', cookie: buyer.cookie })).status, 404);
  assert.equal((await call('/api/offers', { method: 'POST', cookie: buyer.cookie, body: { id: 'offer-free', url: 'https://evil.example.com/' } })).json.error, 'offer_id_taken', 'no overwrite of hidden offers');
  assert.equal((await call('/api/offers/offer-mine', { method: 'PATCH', cookie: buyer.cookie, body: { name: 'Mine' } })).status, 200, 'own offer editable');
  assert.equal(Object.keys((await call('/api/offers', { cookie: owner })).json.offers).length, total, 'owner unaffected');
  assert.equal((await call('/api/users', { cookie: owner })).json.users.find((u) => u.id === buyer.id).offersAccess, 'own', 'stored with the user');
});

test('PATCH /api/users validates roles and flags and protects owners', { timeout: 30000 }, async (t) => {
  const { call, owner, addUser } = await boot(t);
  const buyer = await addUser('b@example.com');
  const me = (await call('/api/auth/me', { cookie: owner })).json.user;
  assert.equal((await call(`/api/users/${buyer.id}`, { method: 'PATCH', cookie: owner, body: { role: 'admin' } })).json.error, 'invalid_role');
  assert.equal((await call(`/api/users/${buyer.id}`, { method: 'PATCH', cookie: owner, body: { hideRevenue: 'yes' } })).status, 400);
  assert.equal((await call(`/api/users/${buyer.id}`, { method: 'PATCH', cookie: owner, body: { offersAccess: 'some' } })).json.error, 'invalid_offers_access');
  assert.equal((await call(`/api/users/${me.id}`, { method: 'PATCH', cookie: owner, body: { role: 'buyer' } })).json.error, 'cannot_change_own_role');
  assert.equal((await call(`/api/users/${buyer.id}`, { method: 'PATCH', cookie: buyer.cookie, body: { hideRevenue: false } })).json.error, 'owner_only');
  assert.equal((await call('/api/users/00000000-0000-4000-8000-000000000000', { method: 'PATCH', cookie: owner, body: { role: 'viewer' } })).status, 404);
  const updated = (await call(`/api/users/${buyer.id}`, { method: 'PATCH', cookie: owner, body: { role: 'viewer', hideRevenue: true } })).json.user;
  assert.deepEqual([updated.role, updated.hideRevenue, updated.offersAccess], ['viewer', true, 'all']);
  assert.equal((await call('/api/auth/me', { cookie: buyer.cookie })).json.user.role, 'viewer', 'existing session picks up the new role');
  const entry = (await call(`/api/audit?entity=user&id=${buyer.id}`, { cookie: owner })).json.entries[0];
  assert.deepEqual(entry.changes.role, ['buyer', 'viewer'], 'change is audited');
});
