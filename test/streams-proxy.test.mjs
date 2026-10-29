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

test('landing flow: stream → landing → /lp/click → offer, with landing stats', { timeout: 15000 }, async (t) => {
  await withServer(t, {}, async ({ url, post, hit }) => {
    assert.equal((await post('/api/landings', { id: 'lp-a', name: 'Cdiscount LP', url: 'http://insecure.example/' })).status, 400, 'https only');
    assert.equal((await post('/api/landings', { id: 'lp-a', name: 'Cdiscount LP', url: 'https://lp.example.net/a?go={lp_click_url}' })).status, 201);
    await post('/api/offers', { id: 'lp-offer', url: 'https://net.example.com/o?sub1={click_id}&s2={sub_id_2}' });
    await post('/api/campaigns', { id: 'lp-camp', name: 'LP', streams: [{ name: 'main', offers: [{ offerId: 'lp-offer' }], landings: [{ landingId: 'lp-a', weight: 1 }] }] });

    const first = await hit('/r/lp-camp?sub_id_2=x');
    const landingUrl = new URL(first.headers.get('location'));
    assert.equal(landingUrl.host, 'lp.example.net', 'visitor lands on the landing first');
    const clickId = landingUrl.searchParams.get('click_id');
    assert.match(clickId, /^[0-9a-f-]{36}$/);
    const go = new URL(landingUrl.searchParams.get('go'));
    assert.equal(go.pathname, '/lp/click');
    assert.equal(go.searchParams.get('click_id'), clickId, 'landing button URL carries the same click id');

    const before = await (await fetch(url + '/stats?campaign=lp-camp')).json();
    assert.equal(before.byLanding['lp-a'].clicks, 1);
    assert.equal(before.lpClicks, 0);

    const toOffer = await hit(`/lp/click?click_id=${clickId}`);
    const offerUrl = new URL(toOffer.headers.get('location'));
    assert.equal(offerUrl.host, 'net.example.com');
    assert.equal(offerUrl.searchParams.get('sub1'), clickId, 'offer gets the original click id');
    assert.equal(offerUrl.searchParams.get('s2'), 'x', 'source params from the original click are reused');
    await hit(`/lp/click?click_id=${clickId}`);
    assert.equal((await fetch(`${url}/postback?click_id=${clickId}&secret=conversion-test-secret&revenue=10`)).status, 200);

    const after = await (await fetch(url + '/stats?campaign=lp-camp')).json();
    assert.equal(after.lpClicks, 1, 'repeated landing clicks count once');
    assert.equal(after.byLanding['lp-a'].lpCtr, 1);
    assert.equal(after.byLanding['lp-a'].conversions, 1);
    assert.equal((await hit('/lp/click?click_id=00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await hit('/lp/click?click_id=../../etc')).status, 400);

    const patched = await (await post('/api/landings/lp-a', { name: 'Renamed' }, 'PATCH')).json();
    assert.equal(patched.name, 'Renamed');
    assert.equal(patched.url, 'https://lp.example.net/a?go={lp_click_url}');
    const log = (await (await fetch(url + '/api/clicks?campaign=lp-camp')).json()).clicks;
    assert.equal(log[0].landingId, 'lp-a');
  });
});

// Runs only with a real country database: GEOIP_TEST_DB=/path/to/dbip-country-lite.mmdb npm test
test('GeoIP: country streams, campaign geo filter and country stats', { timeout: 15000, skip: !process.env.GEOIP_TEST_DB && 'set GEOIP_TEST_DB to run' }, async (t) => {
  await withServer(t, { GEOIP_DB: process.env.GEOIP_TEST_DB, TRUST_PROXY: '1' }, async ({ url, post, hit }) => {
    assert.equal((await (await fetch(url + '/health')).json()).geo, true);
    const FR = { 'x-forwarded-for': '90.84.10.1' }; const US = { 'x-forwarded-for': '8.8.8.8' };
    await post('/api/offers', { id: 'fr-offer', url: 'https://fr.example.net/' });
    await post('/api/campaigns', { id: 'geo-flow', name: 'Geo', streams: [
      { name: 'fr', conditions: { countries: ['FR'] }, offers: [{ offerId: 'fr-offer' }] },
      { name: 'rest', type: 'fallback', offers: [{ offerId: 'offer-1' }] },
    ] });
    assert.equal(new URL((await hit('/r/geo-flow', FR)).headers.get('location')).host, 'fr.example.net');
    assert.equal(new URL((await hit('/r/geo-flow', US)).headers.get('location')).host, 'example.com');
    await post('/api/campaigns', { id: 'fr-only', name: 'FR only', allowGeos: ['FR'] });
    assert.equal((await hit('/r/fr-only/offer-1', FR)).status, 302);
    assert.equal((await hit('/r/fr-only/offer-1', US)).status, 403);
    const s = await (await fetch(url + '/stats?campaign=geo-flow')).json();
    assert.equal(s.byCountry.FR.clicks, 1);
    assert.equal(s.byCountry.US.clicks, 1);
  });
});

// Runs only with a real ASN database: GEOIP_TEST_ASN_DB=/path/to/dbip-asn-lite.mmdb npm test
test('ISP: provider stored on click, data-center traffic counted as bots when enabled', { timeout: 15000, skip: !process.env.GEOIP_TEST_ASN_DB && 'set GEOIP_TEST_ASN_DB to run' }, async (t) => {
  await withServer(t, { GEOIP_ASN_DB: process.env.GEOIP_TEST_ASN_DB, TRUST_PROXY: '1' }, async ({ url, post, hit }) => {
    assert.equal((await (await fetch(url + '/health')).json()).isp, true);
    const AWS = { 'x-forwarded-for': '52.95.110.1' }; const HOME = { 'x-forwarded-for': '90.84.10.1' };
    await post('/api/campaigns', { id: 'dc', name: 'DC', datacenterAsBot: true });
    const dc = await hit('/r/dc/offer-1', AWS);
    assert.equal(dc.status, 302, 'data-center visitor still reaches the offer');
    assert.equal(new URL(dc.headers.get('location')).searchParams.get('click_id'), null, 'but gets no click id');
    assert.equal((await hit('/r/dc/offer-1', HOME)).status, 302);
    const s = await (await fetch(url + '/stats?campaign=dc')).json();
    assert.equal(s.clicks, 1, 'only the residential click counts');
    await hit('/r/demo/offer-1', AWS);
    const isp = await (await fetch(url + '/stats/params?field=isp&campaign=demo')).json();
    assert.match(isp.rows[0].value, /amazon/i, 'ISP recorded when the option is off');
    await post('/api/offers', { id: 'aws-offer', url: 'https://aws.example.net/' });
    await post('/api/campaigns', { id: 'isp-flow', name: 'ISP', streams: [
      { name: 'aws', conditions: { isps: ['AMAZON'] }, offers: [{ offerId: 'aws-offer' }] },
      { name: 'rest', type: 'fallback', offers: [{ offerId: 'offer-1' }] },
    ] });
    assert.equal(new URL((await hit('/r/isp-flow', AWS)).headers.get('location')).host, 'aws.example.net', 'ISP condition, case-insensitive');
    assert.equal(new URL((await hit('/r/isp-flow', HOME)).headers.get('location')).host, 'example.com');
  });
});

test('postback statuses: lead → sale → rejected, duplicates, aliases, amounts carried over', { timeout: 15000 }, async (t) => {
  await withServer(t, {}, async ({ url, hit }) => {
    const pb = (q) => fetch(`${url}/postback?secret=conversion-test-secret&${q}`);
    const cid = new URL((await hit('/r/demo/offer-1')).headers.get('location')).searchParams.get('click_id');
    const stats = async () => (await fetch(url + '/stats?campaign=demo')).json();

    const lead = await pb(`click_id=${cid}&status=pending&revenue=20&currency=EUR`);
    assert.deepEqual(await lead.json(), { ok: true, status: 'lead' }, 'alias pending → lead');
    let s = await stats();
    assert.deepEqual([s.conversions, s.leads, s.sales, s.revenue, s.pendingRevenue], [1, 1, 0, 0, 20], 'lead is pending revenue, not revenue');
    assert.equal((await pb(`click_id=${cid}&status=lead`)).status, 409, 'same status again is a duplicate');

    const sale = await pb(`click_id=${cid}&status=approved`);
    assert.deepEqual(await sale.json(), { ok: true, status: 'sale', updated: true });
    s = await stats();
    assert.deepEqual([s.conversions, s.leads, s.sales, s.revenue, s.pendingRevenue], [1, 0, 1, 20, 0], 'amount carried over from the lead');

    assert.equal((await pb(`click_id=${cid}&status=chargeback`)).status, 200);
    s = await stats();
    assert.deepEqual([s.conversions, s.rejected, s.revenue], [0, 1, 0], 'rejected is neither a conversion nor revenue');
    assert.equal((await pb(`click_id=${cid}&status=maybe`)).status, 400);

    const cid2 = new URL((await hit('/r/demo/offer-1')).headers.get('location')).searchParams.get('click_id');
    assert.deepEqual(await (await pb(`click_id=${cid2}&revenue=7`)).json(), { ok: true }, 'no status = sale, response unchanged');
    assert.equal((await stats()).revenue, 7);
    const log = (await (await fetch(url + '/api/conversions?campaign=demo&limit=10')).json()).conversions;
    assert.ok(log.some((c) => c.clickId === cid && c.status === 'rejected'));
  });
});

test('multi-currency: amounts kept in their currency, reports converted at current rates', { timeout: 15000 }, async (t) => {
  const { writeFile, mkdtemp: mk } = await import('node:fs/promises');
  const dataDir = await mk(join(tmpdir(), 'umbrella-fx-'));
  // Fixed rates per 1 EUR so the test does not depend on the network.
  await writeFile(join(dataDir, 'fx-rates.json'), JSON.stringify({ base: 'EUR', rates: { EUR: 1, USD: 1.25, RUB: 100 }, updatedAt: '2026-10-30T00:00:00.000Z', source: 'test' }));
  const server = await startTestServer(dataDir, {});
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const click = async () => new URL((await fetch(server.url + '/r/demo/offer-1', { redirect: 'manual' })).headers.get('location')).searchParams.get('click_id');
  const pb = (cid, q) => fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${cid}&${q}`);
  assert.equal((await pb(await click(), 'revenue=10&currency=EUR')).status, 200);
  assert.equal((await pb(await click(), 'revenue=25&currency=USD')).status, 200);
  assert.equal((await pb(await click(), 'revenue=5')).status, 200, 'no currency = DEFAULT_CURRENCY (EUR)');

  const eur = await (await fetch(server.url + '/stats?campaign=demo')).json();
  assert.equal(eur.currency, 'EUR');
  assert.equal(eur.revenue, 10 + 25 / 1.25 + 5, '10 EUR + 25 USD (=20 EUR) + 5 EUR');
  const rub = await (await fetch(server.url + '/stats?campaign=demo&currency=rub')).json();
  assert.equal(rub.currency, 'RUB');
  assert.equal(rub.revenue, 3500);
  assert.equal(rub.byCampaign.demo.revenue, 3500, 'groups are converted too');
  const usd = await (await fetch(server.url + '/stats/timeseries?campaign=demo&currency=USD')).json();
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.series.reduce((sum, p) => sum + p.revenue, 0), 43.75);
  assert.equal((await (await fetch(server.url + '/stats?currency=12x')).json()).currency, 'EUR', 'bad code falls back to default');
  const info = await (await fetch(server.url + '/api/rates')).json();
  assert.equal(info.defaultCurrency, 'EUR');
  assert.deepEqual(info.currencies, ['EUR', 'RUB', 'USD']);
  const log = (await (await fetch(server.url + '/api/conversions?campaign=demo&limit=10')).json()).conversions;
  assert.ok(log.some((c) => c.revenue === 25 && c.currency === 'USD'), 'the log keeps the original amount and currency');
});

test('unique clicks: repeat visitor within the window is not unique', { timeout: 15000 }, async (t) => {
  await withServer(t, { TRUST_PROXY: '1' }, async ({ url, post, hit }) => {
    await post('/api/campaigns', { id: 'uniq', name: 'Uniq', uniquenessHours: 24 });
    const A = { 'x-forwarded-for': '198.51.100.1', 'user-agent': 'UA-1' };
    const B = { 'x-forwarded-for': '198.51.100.2', 'user-agent': 'UA-1' };
    await hit('/r/uniq/offer-1', A); await hit('/r/uniq/offer-1', A); await hit('/r/uniq/offer-1', B);
    await hit('/r/demo/offer-1', A);
    const s = await (await fetch(url + '/stats?campaign=uniq')).json();
    assert.equal(s.clicks, 3);
    assert.equal(s.uniqueClicks, 2, 'A twice + B once = 2 unique');
    const demo = await (await fetch(url + '/stats?campaign=demo')).json();
    assert.equal(demo.uniqueClicks, 1, 'uniqueness is per campaign');
    assert.equal((await (await fetch(url + '/api/campaigns')).json()).campaigns.uniq.uniquenessHours, 24);
  });
});

test('stream rotation by position: first matching regular stream wins', { timeout: 15000 }, async (t) => {
  await withServer(t, {}, async ({ url, post, hit }) => {
    await post('/api/offers', { id: 'pos-a', url: 'https://a.example.net/' });
    await post('/api/offers', { id: 'pos-b', url: 'https://b.example.net/' });
    await post('/api/campaigns', { id: 'pos', name: 'Pos', streamRotation: 'position', streams: [
      { name: 'first', offers: [{ offerId: 'pos-a' }], weight: 1 },
      { name: 'second', offers: [{ offerId: 'pos-b' }], weight: 1000 },
    ] });
    for (let i = 0; i < 10; i++) assert.equal(new URL((await hit('/r/pos')).headers.get('location')).host, 'a.example.net', 'weight is ignored by position');
    await post('/api/campaigns/pos', { streamRotation: 'weight' }, 'PATCH');
    const hosts = new Set();
    for (let i = 0; i < 30; i++) hosts.add(new URL((await hit('/r/pos')).headers.get('location')).host);
    assert.ok(hosts.has('b.example.net'), 'by weight the heavy stream gets traffic');
    assert.equal((await (await fetch(url + '/api/campaigns')).json()).campaigns.pos.streamRotation, 'weight');
  });
});

test('device/os/browser/language reports and day-parting streams', { timeout: 15000 }, async (t) => {
  await withServer(t, {}, async ({ url, post, hit }) => {
    const IPHONE = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1', 'accept-language': 'fr-FR' };
    const WIN = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36', 'accept-language': 'de-DE' };
    await post('/api/campaigns', { id: 'dims', name: 'Dims' });
    await hit('/r/dims/offer-1', IPHONE); await hit('/r/dims/offer-1', IPHONE); await hit('/r/dims/offer-1', WIN);
    const os = await (await fetch(url + '/stats/params?field=os&campaign=dims')).json();
    assert.deepEqual(os.rows.map((r) => [r.value, r.clicks]), [['ios', 2], ['windows', 1]]);
    const lang = await (await fetch(url + '/stats/params?field=language&campaign=dims')).json();
    assert.equal(lang.rows.find((r) => r.value === 'fr').clicks, 2);
    assert.equal((await (await fetch(url + '/stats/params?field=device&campaign=dims')).json()).rows.find((r) => r.value === 'mobile').clicks, 2);

    // Schedule: the current UTC hour matches, every other hour does not.
    const nowHour = new Date().getUTCHours();
    const otherHours = Array.from({ length: 24 }, (_, h) => h).filter((h) => h !== nowHour);
    await post('/api/offers', { id: 'night', url: 'https://night.example.net/' });
    await post('/api/campaigns', { id: 'sched', name: 'Sched', streams: [
      { name: 'not-now', conditions: { hours: otherHours, tz: 'UTC' }, offers: [{ offerId: 'night' }] },
      { name: 'now', conditions: { hours: [nowHour], days: [1, 2, 3, 4, 5, 6, 7], tz: 'Mars/Olympus' }, offers: [{ offerId: 'offer-1' }] },
    ] });
    const stored = (await (await fetch(url + '/api/campaigns')).json()).campaigns.sched.streams;
    assert.equal(stored[1].conditions.tz, 'UTC', 'unknown time zone falls back to UTC');
    for (let i = 0; i < 5; i++) assert.equal(new URL((await hit('/r/sched')).headers.get('location')).host, 'example.com');
  });
});

test('CSV export: groups, currency, formula-injection safe', { timeout: 15000 }, async (t) => {
  await withServer(t, {}, async ({ url, post, hit }) => {
    await post('/api/campaigns', { id: 'exp', name: 'Export' });
    await hit('/r/exp/offer-1?sub_id_1=%3DHYPERLINK(%22x%22)');
    const res = await fetch(url + '/stats/export?group=campaign');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const text = (await res.text()).replace(/^﻿/, '');
    const [header, ...lines] = text.trim().split('\n');
    assert.ok(header.startsWith('group,clicks,conversions,revenue,cost,cr,epc,rpm,uniqueClicks'));
    assert.ok(lines.some((l) => l.startsWith('exp,1,0,0,0')));
    const byParam = (await (await fetch(url + '/stats/export?group=sub_id_1')).text()).replace(/^﻿/, '');
    assert.ok(byParam.includes(`"'=HYPERLINK(""x"")"`), 'a value starting with = is neutralised for spreadsheets');
    assert.equal((await fetch(url + '/stats/export?group=nope')).status, 400);
  });
});
