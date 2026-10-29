import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

async function withServer(t, environment, fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-streams-'));
  const server = await startTestServer(dataDir, environment);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const post = (path, body, method = 'POST') => fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const hit = (path, headers = {}) => fetch(server.url + path, { redirect: 'manual', headers });
  await fn({ url: server.url, post, hit });
}

test('X-Forwarded-For is ignored unless TRUST_PROXY is set', { timeout: 15000 }, async (t) => {
  await withServer(t, {}, async ({ post, hit }) => {
    await post('/api/campaigns', { id: 'spoof', name: 'Spoof', blockedIps: ['203.0.113.7'] });
    assert.equal((await hit('/r/spoof/offer-1', { 'x-forwarded-for': '203.0.113.7' })).status, 302, 'spoofed header must not decide the client IP');
    await post('/api/campaigns', { id: 'local', name: 'Local', blockedIps: ['127.0.0.1'] });
    assert.equal((await hit('/r/local/offer-1', { 'x-forwarded-for': '8.8.8.8' })).status, 403, 'socket address must be used');
  });
});

test('TRUST_PROXY=1 takes the address appended by our proxy, not the client-supplied one', { timeout: 15000 }, async (t) => {
  await withServer(t, { TRUST_PROXY: '1' }, async ({ post, hit }) => {
    await post('/api/campaigns', { id: 'proxied', name: 'Proxied', blockedIps: ['203.0.113.7'] });
    assert.equal((await hit('/r/proxied/offer-1', { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })).status, 403);
    assert.equal((await hit('/r/proxied/offer-1', { 'x-forwarded-for': '203.0.113.7, 9.9.9.9' })).status, 302, 'forged leftmost entry must be ignored');
  });
});

test('stream state, click counting and actions', { timeout: 15000 }, async (t) => {
  await withServer(t, {}, async ({ post, hit }) => {
    const created = await post('/api/campaigns', { id: 'flows', name: 'Flows', streams: [
      { name: 'off', type: 'forced', enabled: false, offers: [{ offerId: 'offer-1' }] },
      { name: 'direct', action: 'url', url: 'https://landing.example.net/p?c={campaign}' },
    ] });
    assert.equal(created.status, 201);
    const stored = (await created.json()).streams;
    assert.equal(stored[0].enabled, false);
    assert.equal(stored[1].action, 'url');
    assert.ok(!('offers' in stored[1]), 'url stream must not carry offers');
    assert.ok(!('enabled' in stored[1]) && !('countClicks' in stored[1]), 'defaults are not stored');

    const direct = await hit('/r/flows');
    assert.equal(direct.status, 302, 'disabled forced stream must be skipped');
    const loc = new URL(direct.headers.get('location'));
    assert.equal(loc.host, 'landing.example.net');
    assert.equal(loc.searchParams.get('c'), 'flows', 'macros apply to the direct URL');
    assert.match(loc.searchParams.get('click_id'), /^[0-9a-f-]{36}$/);
    const report = await (await fetch(direct.url.replace(/\/r\/flows$/, '/stats?campaign=flows'))).json();
    assert.equal(report.clicks, 1);
    assert.equal(report.byStream.direct.clicks, 1);

    await post('/api/campaigns/flows/streams', { streams: [{ name: 'quiet', countClicks: false, offers: [{ offerId: 'offer-1' }] }] }, 'PUT');
    assert.equal((await hit('/r/flows')).status, 302);
    const after = await (await fetch(direct.url.replace(/\/r\/flows$/, '/stats?campaign=flows'))).json();
    assert.equal(after.clicks, 1, 'countClicks=false must not add to reports');

    await post('/api/campaigns/flows/streams', { streams: [{ name: 'gone', action: 'not_found' }] }, 'PUT');
    const gone = await hit('/r/flows');
    assert.equal(gone.status, 404);
    assert.equal(await gone.text(), 'Not Found');

    const bad = await post('/api/campaigns/flows/streams', { streams: [{ name: 'bad', action: 'url', url: 'http://insecure.example' }] }, 'PUT');
    assert.equal(bad.status, 400, 'url action requires https');
  });
});

test('source parameters, macros, cost and ROI', { timeout: 15000 }, async (t) => {
  await withServer(t, {}, async ({ url, post, hit }) => {
    await post('/api/offers', { id: 'p-offer', url: 'https://shop.example.net/?a={sub_id_1}&cr={creative_id}&k={keyword}' });
    await post('/api/campaigns', { id: 'paid', name: 'Paid', costModel: 'cpc', cpc: 0.2, costFromParam: true, paramMap: { sub_id_1: 'ad_id', cost: 'bid', bogus: 'x', sub_id_2: 'bad key!' } });
    const stored = (await (await fetch(url + '/api/campaigns')).json()).campaigns.paid;
    assert.deepEqual(stored.paramMap, { sub_id_1: 'ad_id', cost: 'bid' }, 'unknown fields and unsafe keys are dropped');
    const r1 = await hit('/r/paid/p-offer?ad_id=123&creative_id=cr9&keyword=a%26b%3Dc&bid=0.5');
    const loc = new URL(r1.headers.get('location'));
    assert.equal(loc.searchParams.get('a'), '123', 'mapped param reaches the offer');
    assert.equal(loc.searchParams.get('cr'), 'cr9');
    assert.equal(loc.searchParams.get('k'), 'a&b=c', 'macro values are URL-encoded and cannot inject parameters');
    assert.ok(!loc.searchParams.has('b'));
    await hit('/r/paid/p-offer?ad_id=123');
    await hit('/r/paid/p-offer?ad_id=456&bid=nonsense');
    const cid = new URL((await hit('/r/paid/p-offer?ad_id=456')).headers.get('location')).searchParams.get('click_id');
    assert.equal((await fetch(`${url}/postback?click_id=${cid}&secret=conversion-test-secret&revenue=2`)).status, 200);

    const s = await (await fetch(url + '/stats?campaign=paid')).json();
    assert.equal(s.clicks, 4);
    assert.ok(Math.abs(s.cost - (0.5 + 0.2 + 0.2 + 0.2)) < 1e-9, 'cost from param, fallback to fixed CPC on missing/invalid value');
    assert.ok(Math.abs(s.profit - (2 - 1.1)) < 1e-9);
    assert.ok(Math.abs(s.roi - (0.9 / 1.1)) < 1e-9);

    const byAd = await (await fetch(url + '/stats/params?field=sub_id_1&campaign=paid')).json();
    const ad456 = byAd.rows.find((r) => r.value === '456');
    assert.equal(byAd.rows.find((r) => r.value === '123').clicks, 2);
    assert.equal(ad456.conversions, 1);
    assert.equal(ad456.revenue, 2);
    assert.equal((await fetch(url + '/stats/params?field=nope')).status, 400);

    const log = await (await fetch(url + '/api/clicks?campaign=paid&limit=10')).json();
    assert.ok(log.clicks.some((c) => c.params?.sub_id_1 === '123' && c.params?.creative_id === 'cr9' && c.cost === 0.5));
  });
});

test('send to campaign, OR filters and redirect methods', { timeout: 15000 }, async (t) => {
  await withServer(t, {}, async ({ url, post, hit }) => {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1';
    await post('/api/campaigns', { id: 'target', name: 'Target', streams: [{ name: 'main', offers: [{ offerId: 'offer-1' }] }] });
    await post('/api/campaigns', { id: 'entry', name: 'Entry', streams: [{ name: 'to-target', action: 'campaign', campaignId: 'target' }] });
    const handed = await hit('/r/entry');
    assert.equal(handed.status, 302);
    assert.equal(new URL(handed.headers.get('location')).host, 'example.com');
    const clicks = (await (await fetch(url + '/api/clicks?campaign=target')).json()).clicks;
    assert.equal(clicks.length, 1, 'click is recorded in the final campaign');
    assert.equal((await (await fetch(url + '/stats?campaign=entry')).json()).clicks, 0, 'not double-counted in the entry campaign');

    await post('/api/campaigns', { id: 'loop-a', name: 'A', streams: [{ name: 'a', action: 'campaign', campaignId: 'loop-b' }] });
    await post('/api/campaigns', { id: 'loop-b', name: 'B', streams: [{ name: 'b', action: 'campaign', campaignId: 'loop-a' }] });
    const loop = await hit('/r/loop-a');
    assert.equal(loop.status, 508);
    assert.equal((await loop.json()).error, 'campaign_loop');
    await post('/api/campaigns/target', { active: false }, 'PATCH');
    assert.equal((await hit('/r/entry')).status, 404, 'inactive target stops the hand-off');
    const badHop = await (await post('/api/campaigns', { id: 'bad-hop', name: 'x', streams: [{ name: 'x', action: 'campaign', campaignId: '../evil' }] })).json();
    assert.equal(badHop.streams.length, 0, 'invalid target campaign id is rejected');

    await post('/api/campaigns', { id: 'or-camp', name: 'OR', streams: [
      { name: 'ios-or-fr', conditions: { mode: 'or', os: ['ios'], languages: ['fr'] }, offers: [{ offerId: 'offer-1' }] },
      { name: 'rest', type: 'fallback', action: 'not_found' },
    ] });
    assert.equal((await hit('/r/or-camp', { 'user-agent': IPHONE, 'accept-language': 'en' })).status, 302, 'OR: iOS alone is enough');
    assert.equal((await hit('/r/or-camp', { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0', 'accept-language': 'fr-FR' })).status, 302, 'OR: French alone is enough');
    assert.equal((await hit('/r/or-camp', { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0', 'accept-language': 'de' })).status, 404, 'OR: neither → fallback');

    await post('/api/offers', { id: 'xss-offer', url: 'https://shop.example.net/?q="><script>alert(1)</script>&s={subid}' });
    await post('/api/campaigns', { id: 'meta-camp', name: 'Meta', redirectMethod: 'meta' });
    const meta = await hit('/r/meta-camp/xss-offer?subid=a"b');
    assert.equal(meta.status, 200);
    const metaHtml = await meta.text();
    assert.match(metaHtml, /http-equiv="refresh"/);
    assert.ok(!metaHtml.includes('<script>alert'), 'offer URL is escaped in HTML');
    await post('/api/campaigns', { id: 'js-camp', name: 'JS', redirectMethod: 'js' });
    const js = await (await hit('/r/js-camp/xss-offer')).text();
    assert.match(js, /location\.replace\(/);
    assert.ok(!js.includes('</script><script>alert'), 'URL cannot break out of the script tag');
    await post('/api/campaigns', { id: 'weird', name: 'W', redirectMethod: 'iframe' });
    assert.equal((await (await fetch(url + '/api/campaigns')).json()).campaigns.weird.redirectMethod, 'http', 'unknown method falls back to http');
  });
});
