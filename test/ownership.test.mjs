// Ownership of offers, landings, sources and networks: a buyer changes only what they created; POST never overwrites;
// streams may use only team offers/landings and the user's own; /r/:campaign/:offer only reaches the campaign's offers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

async function boot(t, environment = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-owner-'));
  let server = await startTestServer(dataDir, environment);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, { method = 'GET', body, cookie, token } = {}) => {
    const headers = { 'x-requested-with': 'umbrella' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(server.url + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, cookie: (res.headers.get('set-cookie')?.match(/umb_session=([^;]*)/) || [])[0] || null, location: res.headers.get('location') };
  };
  const login = async (email, password) => (await call('/api/auth/login', { method: 'POST', body: { email, password } })).cookie;
  const owner = (await call('/api/auth/setup', { method: 'POST', body: { email: 'owner@example.com', password: 'owner-password' } })).cookie;
  const addUser = async (email, extra = {}) => {
    const created = await call('/api/users', { method: 'POST', cookie: owner, body: { email, password: 'user-password-1', ...extra } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    return { id: created.json.user.id, cookie: await login(email, 'user-password-1') };
  };
  const restart = async () => { await server.stop(); server = await startTestServer(dataDir, environment); };
  return { call, owner, addUser, login, restart };
}

const offerBody = (id, extra = {}) => ({ id, url: `https://${id}.example.com/?cid={click_id}`, ...extra });
const stream = (offerId, landingId) => [{ name: 'Main', offers: [{ offerId, weight: 1 }], ...(landingId ? { landings: [{ landingId, weight: 1 }] } : {}) }];

test('offers: a buyer edits, archives and clones only their own; POST never overwrites', { timeout: 30000 }, async (t) => {
  const { call, owner, addUser, login, restart } = await boot(t);
  const ann = await addUser('ann@example.com'), bob = await addUser('bob@example.com');
  assert.equal((await call('/api/offers', { method: 'POST', cookie: owner, body: offerBody('team-offer') })).json.ownerId, null, 'owner creates team offers');
  const created = await call('/api/offers', { method: 'POST', cookie: ann.cookie, body: offerBody('ann-offer', { ownerId: bob.id }) });
  assert.equal(created.status, 201);
  assert.equal(created.json.ownerId, ann.id, 'a buyer cannot create offers in someone else\'s name');

  // Finding 1: another buyer rewrites url / postbackUrl / payout of a foreign offer.
  const hijack = await call('/api/offers/ann-offer', { method: 'PATCH', cookie: bob.cookie, body: { url: 'https://evil.example.com/', postbackUrl: 'https://evil.example.com/pb', payout: 0 } });
  assert.equal(hijack.status, 403);
  assert.equal(hijack.json.error, 'offer_not_yours');
  assert.equal((await call('/api/offers/team-offer', { method: 'PATCH', cookie: bob.cookie, body: { url: 'https://evil.example.com/' } })).status, 403, 'team offers are read-only for buyers');
  assert.equal((await call('/api/offers/ann-offer', { method: 'PATCH', cookie: bob.cookie, body: { archived: true } })).status, 403, 'no archiving of foreign offers');
  assert.equal((await call('/api/offers/ann-offer/clone', { method: 'POST', cookie: bob.cookie })).status, 403, 'no cloning of foreign offers');
  for (const cookie of [bob.cookie, ann.cookie, owner]) {
    const overwrite = await call('/api/offers', { method: 'POST', cookie, body: offerBody('ann-offer', { url: 'https://evil.example.com/' }) });
    assert.equal(overwrite.status, 409);
    assert.equal(overwrite.json.error, 'id_taken');
  }
  const offers = (await call('/api/offers', { cookie: owner })).json.offers;
  assert.equal(offers['ann-offer'].url, 'https://ann-offer.example.com/?cid={click_id}', 'foreign offer untouched');
  assert.equal(offers['team-offer'].url, 'https://team-offer.example.com/?cid={click_id}');

  // The creator manages their offer; ownerId in a buyer's PATCH is ignored.
  const edited = await call('/api/offers/ann-offer', { method: 'PATCH', cookie: ann.cookie, body: { payout: 5, ownerId: bob.id } });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.payout, 5);
  assert.equal(edited.json.ownerId, ann.id);
  const copy = await call('/api/offers/ann-offer/clone', { method: 'POST', cookie: ann.cookie });
  assert.equal(copy.status, 201);
  assert.equal(copy.json.ownerId, ann.id, 'a buyer\'s copy is theirs');
  // The owner edits anything and may reassign it.
  assert.equal((await call('/api/offers/ann-offer', { method: 'PATCH', cookie: owner, body: { name: 'Ann' } })).status, 200);
  assert.equal((await call('/api/offers/team-offer', { method: 'PATCH', cookie: owner, body: { ownerId: bob.id } })).json.ownerId, bob.id);
  assert.equal((await call('/api/offers/team-offer', { method: 'PATCH', cookie: bob.cookie, body: { name: 'Bob now' } })).status, 200, 'reassigned offer is editable by its new owner');

  // ownerId survives a restart (JSON storage).
  await restart();
  const after = (await call('/api/offers', { cookie: await login('owner@example.com', 'owner-password') })).json.offers;
  assert.equal(after['ann-offer'].ownerId, ann.id);
  assert.equal(after['team-offer'].ownerId, bob.id);
  assert.equal(after['ann-offer-copy'].ownerId, ann.id);
});

test('landings: no overwrite through POST, no PATCH of foreign landings', { timeout: 30000 }, async (t) => {
  const { call, owner, addUser } = await boot(t);
  const ann = await addUser('ann@example.com'), bob = await addUser('bob@example.com');
  assert.equal((await call('/api/landings', { method: 'POST', cookie: owner, body: { id: 'team-lp', url: 'https://lp.example.com/' } })).json.ownerId, null);
  assert.equal((await call('/api/landings', { method: 'POST', cookie: ann.cookie, body: { id: 'ann-lp', url: 'https://ann-lp.example.com/' } })).json.ownerId, ann.id);
  // Finding 2: a buyer redirects someone else's campaign by rewriting its landing.
  for (const cookie of [bob.cookie, owner]) {
    const overwrite = await call('/api/landings', { method: 'POST', cookie, body: { id: 'ann-lp', url: 'https://evil.example.com/' } });
    assert.equal(overwrite.status, 409);
    assert.equal(overwrite.json.error, 'id_taken');
  }
  for (const id of ['ann-lp', 'team-lp']) {
    const patch = await call(`/api/landings/${id}`, { method: 'PATCH', cookie: bob.cookie, body: { url: 'https://evil.example.com/' } });
    assert.equal(patch.status, 403, id);
    assert.equal(patch.json.error, 'landing_not_yours');
  }
  const landings = (await call('/api/landings', { cookie: owner })).json.landings;
  assert.equal(landings['ann-lp'].url, 'https://ann-lp.example.com/');
  assert.equal(landings['team-lp'].url, 'https://lp.example.com/');
  assert.equal((await call('/api/landings/ann-lp', { method: 'PATCH', cookie: ann.cookie, body: { name: 'Mine' } })).status, 200);
  assert.equal((await call('/api/landings/team-lp', { method: 'PATCH', cookie: owner, body: { url: 'https://lp2.example.com/' } })).status, 200);
});

test('streams accept only team and own offers and landings', { timeout: 30000 }, async (t) => {
  const { call, owner, addUser } = await boot(t);
  const ann = await addUser('ann@example.com'), bob = await addUser('bob@example.com');
  await call('/api/offers', { method: 'POST', cookie: owner, body: offerBody('team-offer') });
  await call('/api/offers', { method: 'POST', cookie: ann.cookie, body: offerBody('ann-offer') });
  await call('/api/offers', { method: 'POST', cookie: bob.cookie, body: offerBody('bob-offer') });
  await call('/api/landings', { method: 'POST', cookie: ann.cookie, body: { id: 'ann-lp', url: 'https://ann-lp.example.com/' } });

  // Finding 3: putting a foreign offer into one's own stream used to expose it (offersAccess 'own') and route traffic to it.
  const trick = await call('/api/campaigns', { method: 'POST', cookie: bob.cookie, body: { id: 'bob-camp', name: 'Bob', streams: stream('ann-offer') } });
  assert.equal(trick.status, 403);
  assert.deepEqual(trick.json, { error: 'offer_not_usable', offerId: 'ann-offer' });
  assert.equal((await call('/api/campaigns', { method: 'POST', cookie: bob.cookie, body: { id: 'bob-camp', name: 'Bob', streams: stream('missing-offer') } })).status, 403, 'unknown offers are refused too');
  assert.equal((await call('/api/campaigns', { method: 'POST', cookie: bob.cookie, body: { id: 'bob-camp', name: 'Bob', streams: stream('team-offer') } })).status, 201, 'team offers are usable');
  assert.equal((await call('/api/campaigns/bob-camp', { method: 'PATCH', cookie: bob.cookie, body: { streams: stream('ann-offer') } })).status, 403);
  assert.equal((await call('/api/campaigns/bob-camp/streams', { method: 'PUT', cookie: bob.cookie, body: { streams: stream('ann-offer') } })).status, 403);
  const lp = await call('/api/campaigns/bob-camp/streams', { method: 'PUT', cookie: bob.cookie, body: { streams: stream('bob-offer', 'ann-lp') } });
  assert.deepEqual(lp.json, { error: 'landing_not_usable', landingId: 'ann-lp' });
  assert.equal((await call('/api/campaigns/bob-camp/streams', { method: 'PUT', cookie: bob.cookie, body: { streams: stream('bob-offer') } })).status, 200, 'own offers are usable');
  assert.equal((await call('/api/campaigns/bob-camp', { method: 'PATCH', cookie: bob.cookie, body: { name: 'Renamed' } })).status, 200, 'saving without streams is unaffected');
  assert.equal((await call('/api/offers', { method: 'POST', cookie: bob.cookie, body: offerBody('bob-alt', { altOfferId: 'ann-offer' }) })).json.error, 'offer_not_usable', 'no foreign alternative offer');

  // The owner may put any offer into a buyer's campaign; the buyer can keep saving it.
  assert.equal((await call('/api/campaigns', { method: 'POST', cookie: owner, body: { id: 'assigned', name: 'A', ownerId: bob.id, streams: stream('ann-offer') } })).status, 201);
  assert.equal((await call('/api/campaigns/assigned/streams', { method: 'PUT', cookie: bob.cookie, body: { streams: [...stream('ann-offer'), ...stream('bob-offer')] } })).status, 200);
  assert.equal((await call('/api/offers/ann-offer', { method: 'PATCH', cookie: bob.cookie, body: { url: 'https://evil.example.com/' } })).status, 403, 'still read-only');

  // offersAccess 'own': own offers + offers of own campaigns; team offers outside them are neither listed nor usable.
  await call(`/api/users/${bob.id}`, { method: 'PATCH', cookie: owner, body: { offersAccess: 'own' } });
  await call('/api/offers', { method: 'POST', cookie: owner, body: offerBody('team-hidden') });
  assert.deepEqual(Object.keys((await call('/api/offers', { cookie: bob.cookie })).json.offers).sort(), ['ann-offer', 'bob-offer'],
    'own + offers of own campaigns');
  assert.equal((await call('/api/campaigns/bob-camp/streams', { method: 'PUT', cookie: bob.cookie, body: { streams: stream('team-hidden') } })).status, 403);
  assert.equal((await call('/api/offers/ann-offer', { method: 'PATCH', cookie: bob.cookie, body: { name: 'x' } })).status, 403, 'visible but not editable');
});

test('sources and networks: buyers change only their own', { timeout: 30000 }, async (t) => {
  const { call, owner, addUser } = await boot(t);
  const ann = await addUser('ann@example.com'), bob = await addUser('bob@example.com');
  const viewer = await addUser('view@example.com', { role: 'viewer' });
  assert.equal((await call('/api/sources', { method: 'POST', cookie: owner, body: { id: 'fb', name: 'FB', costModel: 'cpc', cpc: 0.1 } })).json.ownerId, null);
  assert.equal((await call('/api/sources', { method: 'POST', cookie: ann.cookie, body: { id: 'ann-src', name: 'Ann' } })).json.ownerId, ann.id);
  assert.equal((await call('/api/networks', { method: 'POST', cookie: owner, body: { id: 'net', name: 'Net' } })).json.ownerId, null);
  assert.equal((await call('/api/networks', { method: 'POST', cookie: ann.cookie, body: { id: 'ann-net', name: 'Ann net' } })).json.ownerId, ann.id);

  // Finding 4: paramMap / cpc / costModel of any source and any network were editable by every buyer.
  for (const [path, error] of [['/api/sources/fb', 'source_not_yours'], ['/api/sources/ann-src', 'source_not_yours'], ['/api/networks/net', 'network_not_yours'], ['/api/networks/ann-net', 'network_not_yours']]) {
    const patch = await call(path, { method: 'PATCH', cookie: bob.cookie, body: { name: 'evil', cpc: 99, costModel: 'cpc', paramMap: { sub_id_1: 'x' }, clickIdParam: 'evil' } });
    assert.equal(patch.status, 403, path);
    assert.equal(patch.json.error, error);
  }
  assert.equal((await call('/api/sources/fb', { method: 'PATCH', cookie: viewer.cookie, body: { cpc: 9 } })).status, 403, 'viewer stays read-only');
  assert.equal((await call('/api/sources', { cookie: owner })).json.sources.fb.cpc, 0.1);
  assert.equal((await call('/api/networks', { cookie: owner })).json.networks.net.clickIdParam, 'sub1');
  for (const [path, body] of [['/api/sources', { id: 'fb', name: 'evil' }], ['/api/networks', { id: 'net', name: 'evil' }]]) {
    const overwrite = await call(path, { method: 'POST', cookie: bob.cookie, body });
    assert.equal(overwrite.status, 409, path);
    assert.equal(overwrite.json.error, 'id_taken');
  }
  assert.equal((await call('/api/sources/ann-src', { method: 'PATCH', cookie: ann.cookie, body: { cpc: 0.2 } })).status, 200);
  const net = await call('/api/networks/ann-net', { method: 'PATCH', cookie: ann.cookie, body: { notes: 'mine', ownerId: bob.id } });
  assert.equal(net.status, 200);
  assert.equal(net.json.ownerId, ann.id);
  assert.equal((await call('/api/sources/fb', { method: 'PATCH', cookie: owner, body: { cpc: 0.3 } })).status, 200);
  assert.equal((await call('/api/networks/net', { method: 'PATCH', cookie: owner, body: { notes: 'team' } })).status, 200);
});

test('/r/:campaign/:offer only reaches offers of the campaign', { timeout: 30000 }, async (t) => {
  const { call, owner, addUser } = await boot(t);
  const ann = await addUser('ann@example.com'), bob = await addUser('bob@example.com');
  await call('/api/offers', { method: 'POST', cookie: owner, body: offerBody('team-offer') });
  await call('/api/offers', { method: 'POST', cookie: ann.cookie, body: offerBody('ann-offer') });
  await call('/api/offers', { method: 'POST', cookie: bob.cookie, body: offerBody('bob-offer') });
  await call('/api/campaigns', { method: 'POST', cookie: bob.cookie, body: { id: 'with-streams', name: 'S', streams: stream('bob-offer') } });
  await call('/api/campaigns', { method: 'POST', cookie: bob.cookie, body: { id: 'legacy', name: 'L' } });
  const go = async (path) => { const res = await call(path); return { status: res.status, location: res.location }; };
  // Finding 5: any offer id in the URL bypassed the campaign's streams.
  assert.match((await go('/r/with-streams/bob-offer')).location || '', /bob-offer\.example\.com/);
  assert.equal((await go('/r/with-streams/ann-offer')).status, 404);
  assert.equal((await go('/r/with-streams/team-offer')).status, 404, 'not in the streams');
  // A campaign without offer streams accepts team offers and the campaign owner's.
  assert.equal((await go('/r/legacy/team-offer')).status, 302);
  assert.equal((await go('/r/legacy/bob-offer')).status, 302);
  assert.equal((await go('/r/legacy/ann-offer')).status, 404);
});

test('ADMIN_TOKEN creates team entities unless it names an owner', { timeout: 30000 }, async (t) => {
  const { call, login } = await boot(t, { ADMIN_TOKEN: 'owner-admin-token' });
  const token = 'owner-admin-token';
  const created = await call('/api/users', { method: 'POST', token, body: { email: 'ann@example.com', password: 'user-password-1', role: 'buyer' } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const ann = { id: created.json.user.id, cookie: await login('ann@example.com', 'user-password-1') };
  assert.equal((await call('/api/offers', { method: 'POST', token, body: offerBody('tok-offer') })).json.ownerId, null);
  assert.equal((await call('/api/offers', { method: 'POST', token, body: offerBody('for-ann', { ownerId: ann.id }) })).json.ownerId, ann.id);
  assert.equal((await call('/api/offers', { method: 'POST', token, body: offerBody('tok-offer') })).status, 409);
  assert.equal((await call('/api/offers/for-ann', { method: 'PATCH', cookie: ann.cookie, body: { name: 'Mine' } })).status, 200);
  assert.equal((await call('/api/offers/tok-offer', { method: 'PATCH', cookie: ann.cookie, body: { name: 'x' } })).status, 403);
  assert.equal((await call('/api/offers/for-ann', { method: 'PATCH', token, body: { name: 'Team edit' } })).status, 200);
});
