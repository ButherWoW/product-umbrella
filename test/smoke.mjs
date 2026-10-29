import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';

const dataDir = await mkdtemp(join(tmpdir(), 'product-umbrella-'));
const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: '4199', DATA_DIR: dataDir, POSTBACK_SECRET: 'test-secret', TRUST_PROXY: '1', FX_REFRESH: '0', MONITOR: '0', DATABASE_URL: '', ADMIN_TOKEN: '', GEOIP_DB: '', CLICK_RATE_LIMIT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server start timeout')), 5000);
  child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
  child.on('error', reject);
});

try {
  const health = await fetch('http://127.0.0.1:4199/health');
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.storage, 'jsonl');
  const dashboardHtml = await (await fetch('http://127.0.0.1:4199/dashboard')).text();
  for (const match of dashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
  const editorAsset = await fetch('http://127.0.0.1:4199/assets/stream-editor.js');
  assert.equal(editorAsset.status, 200);
  new Script(await editorAsset.text());
  const created = await fetch('http://127.0.0.1:4199/api/offers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'new-offer', url: 'https://example.org/product' }) });
  assert.equal(created.status, 201);
  assert.equal((await (await fetch('http://127.0.0.1:4199/api/offers')).json()).offers['new-offer'].url, 'https://example.org/product');
  const campaign = await fetch('http://127.0.0.1:4199/api/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'paid-test', name: 'Paid test' }) });
  assert.equal(campaign.status, 201);
  assert.equal((await (await fetch('http://127.0.0.1:4199/api/campaigns')).json()).campaigns['paid-test'].name, 'Paid test');
  const source = await fetch('http://127.0.0.1:4199/api/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'meta', name: 'Meta Ads', costModel: 'cpc', cpc: 0.12, paramMap: { sub_id_1: 'ad_id' } }) });
  assert.equal(source.status, 201);
  const network = await fetch('http://127.0.0.1:4199/api/networks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'acme', name: 'Acme Network', clickIdParam: 'sub1', payoutParam: 'payout' }) });
  assert.equal(network.status, 201);
  const linked = await fetch('http://127.0.0.1:4199/api/campaigns/paid-test', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'meta' }) });
  assert.equal((await linked.json()).sourceId, 'meta');
  const networkOffer = await fetch('http://127.0.0.1:4199/api/offers/new-offer', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ networkId: 'acme' }) });
  assert.equal((await networkOffer.json()).networkId, 'acme');
  const clonedCampaign = await fetch('http://127.0.0.1:4199/api/campaigns/paid-test/clone', { method: 'POST' });
  assert.equal(clonedCampaign.status, 201); assert.equal((await clonedCampaign.json()).active, false);
  const clonedOffer = await fetch('http://127.0.0.1:4199/api/offers/new-offer/clone', { method: 'POST' });
  assert.equal(clonedOffer.status, 201); assert.equal((await clonedOffer.json()).archived, false);
  const paused = await fetch('http://127.0.0.1:4199/api/campaigns/paid-test', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: false }) });
  assert.equal((await paused.json()).active, false);
  const resumed = await fetch('http://127.0.0.1:4199/api/campaigns/paid-test', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: true }) });
  assert.equal((await resumed.json()).active, true);
  const redirect = await fetch('http://127.0.0.1:4199/r/paid-test/offer-1?utm_source=test', { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  const location = redirect.headers.get('location');
  assert.match(location, /click_id=/);
  const clickId = new URL(location).searchParams.get('click_id');
  assert.equal((await fetch(`http://127.0.0.1:4199/postback?click_id=${clickId}`)).status, 401);
  const postback = await fetch(`http://127.0.0.1:4199/postback?click_id=${clickId}&secret=test-secret&revenue=1&currency=USD`);
  assert.deepEqual(await postback.json(), { ok: true });

  // Duplicate postback must be rejected with 409
  const duplicate = await fetch(`http://127.0.0.1:4199/postback?click_id=${clickId}&secret=test-secret&revenue=1&currency=USD`);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error, 'conversion_already_recorded');

  // Unknown click_id must return 404
  const unknown = await fetch(`http://127.0.0.1:4199/postback?click_id=00000000-0000-0000-0000-000000000000&secret=test-secret`);
  assert.equal(unknown.status, 404);

  // Campaign isolation: click on campaign A must not trigger postback for campaign B
  await fetch('http://127.0.0.1:4199/api/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'camp-b', name: 'Camp B' }) });
  const redirectB = await fetch('http://127.0.0.1:4199/r/camp-b/offer-1?utm_source=test', { redirect: 'manual' });
  assert.equal(redirectB.status, 302);
  const clickIdB = new URL(redirectB.headers.get('location')).searchParams.get('click_id');
  // Postback with clickIdB and secret of camp-a should succeed (secret is global) but only count for camp-b
  const postbackB = await fetch(`http://127.0.0.1:4199/postback?click_id=${clickIdB}&secret=test-secret&revenue=2&currency=EUR`);
  assert.deepEqual(await postbackB.json(), { ok: true });
  const report = await (await fetch('http://127.0.0.1:4199/stats')).json();
  assert.equal(report.clicks, 2);
  assert.equal(report.conversions, 2);
  assert.equal(report.byCampaign['paid-test'].clicks, 1);
  assert.equal(report.byCampaign['paid-test'].conversions, 1);
  assert.equal(report.byCampaign['camp-b'].clicks, 1);
  assert.equal(report.byCampaign['camp-b'].conversions, 1);
  assert.ok(report.bySource && report.byNetwork);
  const exportResponse = await fetch('http://127.0.0.1:4199/stats/export?group=country');
  assert.equal(exportResponse.status, 200);
  assert.match(await exportResponse.text(), /group,clicks,conversions,revenue/);
  const compareDate = new Date().toISOString().slice(0, 10);
  const compare = await (await fetch(`http://127.0.0.1:4199/stats/compare?from=${compareDate}&to=${compareDate}`)).json();
  assert.ok(compare.current && compare.previous && compare.deltaPct);
  const bots = await (await fetch(`http://127.0.0.1:4199/stats/bots?from=${compareDate}&to=${compareDate}`)).json();
  assert.deepEqual(bots, { total: 0, byCampaign: {} });
  const clickLog = await (await fetch('http://127.0.0.1:4199/api/clicks?campaign=paid-test&limit=10')).json();
  assert.ok(Array.isArray(clickLog.clicks));
  assert.ok(clickLog.clicks.length >= 1);
  const conversionLog = await (await fetch('http://127.0.0.1:4199/api/conversions?campaign=paid-test&limit=10')).json();
  assert.ok(Array.isArray(conversionLog.conversions));
  assert.ok(conversionLog.conversions.length >= 1);
  assert.equal(typeof clickLog.hasMore, 'boolean');
  assert.equal(clickLog.clicks[0].clickId, clickLog.clicks[0].click_id);
  assert.equal(clickLog.clicks[0].at, clickLog.clicks[0].created_at);
  assert.equal(conversionLog.conversions[0].campaign, 'paid-test');
  assert.equal(conversionLog.conversions[0].stream, 'default');
  assert.equal((await fetch('http://127.0.0.1:4199/api/clicks?limit=NaN')).status, 400);
  assert.equal((await fetch('http://127.0.0.1:4199/api/conversions?offset=-1')).status, 400);
  assert.equal((await fetch('http://127.0.0.1:4199/api/conversions?from=2026-02-30')).status, 400);

  // Stats filter: by campaign
  const statsA = await (await fetch('http://127.0.0.1:4199/stats?campaign=paid-test')).json();
  assert.equal(statsA.clicks, 1);
  assert.equal(statsA.conversions, 1);
  assert.equal(Object.keys(statsA.byCampaign).length, 1, 'campaign filter must return only that campaign');

  // Stats filter: by date (today should include all, yesterday should exclude all)
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const statsToday = await (await fetch(`http://127.0.0.1:4199/stats?from=${today}&to=${today}`)).json();
  assert.equal(statsToday.clicks, 2, 'today filter must include all clicks from today');
  const statsYesterday = await (await fetch(`http://127.0.0.1:4199/stats?from=${yesterday}&to=${yesterday}`)).json();
  assert.equal(statsYesterday.clicks, 0, 'yesterday filter must return 0 clicks');

  // Invalid date format must return 400
  const badDate = await fetch('http://127.0.0.1:4199/stats?from=not-a-date');
  assert.equal(badDate.status, 400);

  // Revenue is included in stats (paid-test had revenue=1 USD, camp-b had revenue=2 EUR)
  assert.equal(report.revenue, 3, 'total revenue must be sum of all conversion revenues');
  assert.equal(report.byCampaign['paid-test'].revenue, 1);
  assert.equal(report.byCampaign['camp-b'].revenue, 2);

  // Streams: create campaign with weighted offer rotation
  await fetch('http://127.0.0.1:4199/api/campaigns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'stream-camp', name: 'Stream test', streams: [{ offerId: 'offer-1', weight: 70 }, { offerId: 'new-offer', weight: 30 }] }),
  });
  const streamRedirect = await fetch('http://127.0.0.1:4199/r/stream-camp', { redirect: 'manual' });
  assert.equal(streamRedirect.status, 302, '/r/:campaign stream route must redirect');
  assert.match(streamRedirect.headers.get('location'), /click_id=/, 'stream redirect must carry click_id');

  // Campaign with no streams must return 404 on /r/:campaign
  await fetch('http://127.0.0.1:4199/api/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'no-stream', name: 'No streams' }) });
  const noStream = await fetch('http://127.0.0.1:4199/r/no-stream', { redirect: 'manual' });
  assert.equal(noStream.status, 404);
  assert.equal((await noStream.json()).error, 'no_streams_configured');

  // PUT /api/campaigns/:id/streams replaces streams
  const putStreams = await fetch('http://127.0.0.1:4199/api/campaigns/no-stream/streams', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ streams: [{ offerId: 'offer-1', weight: 100 }] }),
  });
  assert.equal(putStreams.status, 200);
  assert.equal((await putStreams.json()).streams.length, 1);
  const afterPut = await fetch('http://127.0.0.1:4199/r/no-stream', { redirect: 'manual' });
  assert.equal(afterPut.status, 302, 'after adding streams, /r/:campaign must redirect');

  // Sub-ID tracking: click with ?subid=sub123 should appear in ?subid= stats filter
  const subRedirect = await fetch('http://127.0.0.1:4199/r/paid-test/offer-1?subid=sub123', { redirect: 'manual' });
  assert.equal(subRedirect.status, 302);
  const subStats = await (await fetch('http://127.0.0.1:4199/stats?subid=sub123')).json();
  assert.equal(subStats.clicks, 1, 'subid filter must return only the click with that subid');
  const noSubStats = await (await fetch('http://127.0.0.1:4199/stats?subid=nonexistent')).json();
  assert.equal(noSubStats.clicks, 0, 'unknown subid must return 0 clicks');

  // S2S postback: offer with postbackUrl stores the field and returns it from GET
  await fetch('http://127.0.0.1:4199/api/offers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 's2s-offer', url: 'https://example.com/lp', postbackUrl: 'https://network.example.com/pb?cid={click_id}&rev={revenue}&cur={currency}' }),
  });
  const offersList = await (await fetch('http://127.0.0.1:4199/api/offers')).json();
  assert.equal(offersList.offers['s2s-offer'].url, 'https://example.com/lp');
  assert.equal(offersList.offers['s2s-offer'].postbackUrl, 'https://network.example.com/pb?cid={click_id}&rev={revenue}&cur={currency}');
  // Verify that conversion on s2s-offer does not error (fire-and-forget; network fails silently)
  await fetch('http://127.0.0.1:4199/api/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 's2s-camp', name: 'S2S' }) });
  const s2sClick = await fetch('http://127.0.0.1:4199/r/s2s-camp/s2s-offer', { redirect: 'manual' });
  assert.equal(s2sClick.status, 302);
  const s2sClickId = new URL(s2sClick.headers.get('location')).searchParams.get('click_id');
  const s2sPostback = await fetch(`http://127.0.0.1:4199/postback?click_id=${s2sClickId}&secret=test-secret&revenue=5.50&currency=USD`);
  assert.deepEqual(await s2sPostback.json(), { ok: true }, 'postback with S2S offer must succeed');

  // Geo-targeting: allowGeos with GEOIP_DB unset is fail-open (no blocking)
  await fetch('http://127.0.0.1:4199/api/campaigns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'geo-camp', name: 'Geo test', allowGeos: ['US', 'DE'], streams: [{ offerId: 'offer-1', weight: 1 }] }),
  });
  // Without GEOIP_DB, country = null → fail-open → pass through
  const geoPass = await fetch('http://127.0.0.1:4199/r/geo-camp', { redirect: 'manual' });
  assert.equal(geoPass.status, 302, 'allowGeos without GEOIP_DB must be fail-open (pass through)');
  // Verify allowGeos is stored on the campaign
  const geoCampData = (await (await fetch('http://127.0.0.1:4199/api/campaigns')).json()).campaigns['geo-camp'];
  assert.deepEqual(geoCampData.allowGeos, ['US', 'DE']);

  // Daily click cap: set dailyCap=2 on paid-test (already has 2 clicks from earlier tests)
  await fetch('http://127.0.0.1:4199/api/campaigns/paid-test', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dailyCap: 2 }),
  });
  const cappedNoUrl = await fetch('http://127.0.0.1:4199/r/paid-test/offer-1', { redirect: 'manual' });
  assert.equal(cappedNoUrl.status, 429, 'cap hit without capUrl must return 429');
  assert.equal((await cappedNoUrl.json()).error, 'daily_cap_reached');
  // With capUrl set: must redirect there instead
  await fetch('http://127.0.0.1:4199/api/campaigns/paid-test', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capUrl: 'https://example.com/cap' }),
  });
  const cappedWithUrl = await fetch('http://127.0.0.1:4199/r/paid-test/offer-1', { redirect: 'manual' });
  assert.equal(cappedWithUrl.status, 302);
  assert.equal(cappedWithUrl.headers.get('location'), 'https://example.com/cap', 'capped redirect must go to capUrl');

  // Device targeting: allowDevices=['mobile'] must block desktop UA
  await fetch('http://127.0.0.1:4199/api/campaigns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'mobile-only', name: 'Mobile only', allowDevices: ['mobile'], streams: [{ offerId: 'offer-1', weight: 1 }] }),
  });
  const desktopBlock = await fetch('http://127.0.0.1:4199/r/mobile-only', {
    redirect: 'manual',
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  assert.equal(desktopBlock.status, 403);
  assert.equal((await desktopBlock.json()).error, 'device_not_allowed');
  const mobilePass = await fetch('http://127.0.0.1:4199/r/mobile-only', {
    redirect: 'manual',
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' },
  });
  assert.equal(mobilePass.status, 302, 'mobile UA must pass mobile-only campaign');

  // URL macros: offer URL with {click_id} substitution
  await fetch('http://127.0.0.1:4199/api/offers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'macro-offer', url: 'https://example.com/lp?cid={click_id}&s1={subid}&src={campaign}' }),
  });
  const macroRedirect = await fetch('http://127.0.0.1:4199/r/camp-b/macro-offer?subid=mysub', { redirect: 'manual' });
  assert.equal(macroRedirect.status, 302);
  const macroLoc = new URL(macroRedirect.headers.get('location'));
  assert.match(macroLoc.searchParams.get('cid'), /^[0-9a-f-]{36}$/, 'cid must be a UUID from {click_id} macro');
  assert.equal(macroLoc.searchParams.get('s1'), 'mysub', '{subid} macro must be substituted');
  assert.equal(macroLoc.searchParams.get('src'), 'camp-b', '{campaign} macro must be substituted');
  // {click_id} already in template — must NOT be double-added as query param
  assert.ok(!macroLoc.searchParams.has('click_id'), '{click_id} in template must not be added again as query param');

  // PATCH /api/offers/:id — update url and postbackUrl
  const patchOffer = await fetch('http://127.0.0.1:4199/api/offers/new-offer', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://updated.example.org/product', postbackUrl: 'https://pb.example.com/cv?cid={click_id}' }),
  });
  assert.equal(patchOffer.status, 200);
  const patchedOffer = await patchOffer.json();
  assert.equal(patchedOffer.url, 'https://updated.example.org/product');
  assert.equal(patchedOffer.postbackUrl, 'https://pb.example.com/cv?cid={click_id}');
  // Patching a non-existent offer must return 404
  const patchMissing = await fetch('http://127.0.0.1:4199/api/offers/does-not-exist', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal(patchMissing.status, 404);

  // Stats country filter: create a click with geo, then filter by country
  // Without GEOIP_DB, country is null so country filter returns 0 clicks
  const statsCountryNull = await (await fetch('http://127.0.0.1:4199/stats?country=US')).json();
  assert.equal(statsCountryNull.clicks, 0, 'country filter US must return 0 when no geo db (all clicks have null country)');

  // Stats byCountry grouping: always present in response
  const statsAll = await (await fetch('http://127.0.0.1:4199/stats')).json();
  assert.ok('byCountry' in statsAll, 'stats must always include byCountry object');
  assert.ok(typeof statsAll.byCountry === 'object');

  // Stats offer filter: filter clicks by offer_id
  const statsOffer = await (await fetch('http://127.0.0.1:4199/stats?offer=offer-1')).json();
  assert.ok(statsOffer.clicks >= 1, 'offer filter must return clicks for offer-1');
  const statsNoOffer = await (await fetch('http://127.0.0.1:4199/stats?offer=nonexistent-offer')).json();
  assert.equal(statsNoOffer.clicks, 0, 'unknown offer filter must return 0 clicks');

  // byOffer grouping: always present in response
  const statsAllFull = await (await fetch('http://127.0.0.1:4199/stats')).json();
  assert.ok('byOffer' in statsAllFull, 'stats must include byOffer');
  assert.ok(typeof statsAllFull.byOffer === 'object');
  // offer-1 appears in byOffer (used in multiple clicks)
  assert.ok(statsAllFull.byOffer['offer-1']?.clicks >= 1, 'byOffer[offer-1] must have clicks');

  // Health endpoint: includes uptime field
  const healthFull = await (await fetch('http://127.0.0.1:4199/health')).json();
  assert.ok(typeof healthFull.uptime === 'number', 'health must include numeric uptime');
  assert.ok(healthFull.uptime >= 0);

  // Timeseries endpoint: basic smoke
  const ts = await (await fetch('http://127.0.0.1:4199/stats/timeseries')).json();
  assert.ok('series' in ts, 'timeseries must return series array');
  assert.ok(Array.isArray(ts.series));
  assert.equal(ts.granularity, 'day');
  // Timeseries with today must include at least one bucket (we generated clicks)
  const tsDate = new Date().toISOString().slice(0, 10);
  const tsToday = await (await fetch(`http://127.0.0.1:4199/stats/timeseries?from=${tsDate}&to=${tsDate}`)).json();
  assert.ok(tsToday.series.length >= 1, 'timeseries for today must have at least one bucket');
  assert.ok(tsToday.series[0].clicks >= 1, 'today bucket must have clicks');
  // Timeseries invalid date → 400
  const tsBad = await fetch('http://127.0.0.1:4199/stats/timeseries?from=bad-date');
  assert.equal(tsBad.status, 400);
  // Timeseries hour granularity
  const tsHour = await (await fetch('http://127.0.0.1:4199/stats/timeseries?granularity=hour')).json();
  assert.equal(tsHour.granularity, 'hour');
  assert.ok(Array.isArray(tsHour.series));

  // /stats/referrers: returns top referrers array
  const ref = await (await fetch('http://127.0.0.1:4199/stats/referrers')).json();
  assert.ok(Array.isArray(ref.referrers), 'referrers must be an array');
  // /stats/referrers with limit: respects limit param
  const refLim = await (await fetch('http://127.0.0.1:4199/stats/referrers?limit=3')).json();
  assert.ok(refLim.referrers.length <= 3, 'referrers limit=3 must return at most 3');
  // /stats/paths: returns top paths array
  const paths = await (await fetch('http://127.0.0.1:4199/stats/paths')).json();
  assert.ok(Array.isArray(paths.paths), 'paths must be an array');
  // /stats/paths with campaign filter: only paths for that campaign
  const pathsCamp = await (await fetch('http://127.0.0.1:4199/stats/paths?campaign=paid-test')).json();
  assert.ok(Array.isArray(pathsCamp.paths), 'paths with campaign filter must be an array');

  // Campaign daily cap must stop a second click.
  await fetch('http://127.0.0.1:4199/api/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'capped', name: 'Capped', dailyCap: 1 }) });
  assert.equal((await fetch('http://127.0.0.1:4199/r/capped/offer-1', { redirect: 'manual' })).status, 302);
  assert.equal((await fetch('http://127.0.0.1:4199/r/capped/offer-1', { redirect: 'manual' })).status, 429);

  // Multi-stream with conditions: forced → regular (weighted, matching) → fallback
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';
  const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
  const msCreate = await fetch('http://127.0.0.1:4199/api/campaigns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'ms-camp', name: 'Multi-stream', streams: [
      { name: 'ios-forced', type: 'forced', conditions: { os: ['ios'] }, offers: [{ offerId: 'macro-offer' }] },
      { name: 'android-ru', conditions: { devices: ['mobile'], languages: ['ru'] }, offers: [{ offerId: 'new-offer', weight: 1 }] },
      { name: 'geo-us', type: 'bogus', conditions: { countries: ['us'] }, offers: [{ offerId: 's2s-offer' }] },
      { name: 'fallback', type: 'fallback', offers: [{ offerId: 'offer-1' }] },
    ] }),
  });
  assert.equal(msCreate.status, 201);
  const msStored = (await (await fetch('http://127.0.0.1:4199/api/campaigns')).json()).campaigns['ms-camp'].streams;
  assert.equal(msStored.length, 4);
  assert.deepEqual(msStored[0].conditions.os, ['ios']);
  assert.equal(msStored[2].type, 'regular', 'unknown stream type must normalize to regular');
  assert.deepEqual(msStored[2].conditions.countries, ['US'], 'country codes must be uppercased');
  const msHit = async (ua, lang) => fetch('http://127.0.0.1:4199/r/ms-camp', { redirect: 'manual', headers: { 'user-agent': ua, ...(lang ? { 'accept-language': lang } : {}) } });
  const iosLoc = new URL((await msHit(IPHONE, 'ru-RU')).headers.get('location'));
  assert.equal(iosLoc.pathname, '/lp', 'iOS must hit forced stream (macro-offer) even when android-ru-like conditions also match');
  const androidLoc = new URL((await msHit(ANDROID, 'ru-RU,ru;q=0.9')).headers.get('location'));
  assert.equal(androidLoc.host, 'updated.example.org', 'Android+ru must hit android-ru regular stream');
  const desktopLoc = new URL((await msHit(DESKTOP, 'en-US')).headers.get('location'));
  assert.equal(desktopLoc.host, 'example.com');
  assert.equal(desktopLoc.pathname, '/', 'desktop without geo db must fall through to fallback stream (offer-1)');
  const streamClickId = iosLoc.searchParams.get('cid');
  assert.equal((await fetch(`http://127.0.0.1:4199/postback?click_id=${streamClickId}&secret=test-secret&revenue=7&currency=USD`)).status, 200);
  const streamReport = await (await fetch('http://127.0.0.1:4199/stats?campaign=ms-camp&stream=ios-forced')).json();
  assert.equal(streamReport.clicks, 1);
  assert.equal(streamReport.conversions, 1);
  assert.equal(streamReport.byStream['ios-forced'].revenue, 7);
  assert.equal(streamReport.byOffer['macro-offer'].conversions, 1);
  assert.equal(streamReport.byCountry.unknown.revenue, 7);
  assert.equal(streamReport.epc, 7);
  const missingStream = await (await fetch('http://127.0.0.1:4199/stats?stream=does-not-exist')).json();
  assert.equal(missingStream.clicks, 0);
  assert.deepEqual(missingStream.byStream, {});
  const explicitReport = await (await fetch('http://127.0.0.1:4199/stats?campaign=capped&stream=default')).json();
  assert.equal(explicitReport.clicks, 1);
  assert.equal(explicitReport.byStream.default.clicks, 1);

  // Campaign targeting applies to explicit and stream routes and survives PATCH.
  const targeted = await fetch('http://127.0.0.1:4199/api/campaigns', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'os-browser',
      allowOS: ['IOS'], allowBrowsers: ['SAFARI'], streams: [{ offerId: 'offer-1', weight: 1 }] }) });
  assert.equal(targeted.status, 201);
  const targetData = await targeted.json();
  assert.deepEqual(targetData.allowOS, ['ios']);
  assert.deepEqual(targetData.allowBrowsers, ['safari']);
  const hitTarget = (ua, explicit = false) => fetch(`http://127.0.0.1:4199/r/os-browser${explicit ? '/offer-1' : ''}`,
    { redirect: 'manual', headers: { 'user-agent': ua } });
  assert.equal((await hitTarget(IPHONE)).status, 302);
  const osBlocked = await hitTarget(DESKTOP, true);
  assert.equal(osBlocked.status, 403);
  assert.equal((await osBlocked.json()).error, 'os_not_allowed');
  const patchTarget = await fetch('http://127.0.0.1:4199/api/campaigns/os-browser', { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }) });
  assert.deepEqual((await patchTarget.json()).allowBrowsers, ['safari']);
  const browserBlocked = await hitTarget(IPHONE.replace('Safari/604.1', 'CriOS/126.0 Safari/604.1'));
  assert.equal(browserBlocked.status, 403);
  assert.equal((await browserBlocked.json()).error, 'browser_not_allowed');
  await fetch('http://127.0.0.1:4199/api/campaigns/os-browser', { method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allowOS: [], allowBrowsers: [] }) });
  assert.equal((await hitTarget(DESKTOP)).status, 302);
  // No stream matches → 404 no_matching_stream
  await fetch('http://127.0.0.1:4199/api/campaigns/ms-camp/streams', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ streams: [{ name: 'only-us', conditions: { countries: ['US'] }, offers: [{ offerId: 'offer-1' }] }] }) });
  const noMatch = await msHit(DESKTOP, 'en-US');
  assert.equal(noMatch.status, 404);
  assert.equal((await noMatch.json()).error, 'no_matching_stream');
  // Stream with zero valid offers is rejected
  const badStreams = await fetch('http://127.0.0.1:4199/api/campaigns/ms-camp/streams', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ streams: [{ name: 'empty', offers: [{ offerId: '!' }] }] }) });
  assert.equal(badStreams.status, 400);

  // Bot filter: opt-in per campaign; bot UA is redirected to the offer but not counted
  const botCreate = await fetch('http://127.0.0.1:4199/api/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'bot-camp', name: 'Bots', botFilter: true }) });
  assert.equal(botCreate.status, 201);
  assert.equal((await (await fetch('http://127.0.0.1:4199/api/campaigns')).json()).campaigns['bot-camp'].botFilter, true);
  const botHit = await fetch('http://127.0.0.1:4199/r/bot-camp/offer-1', { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } });
  assert.equal(botHit.status, 302, 'bot must still be redirected');
  assert.ok(!new URL(botHit.headers.get('location')).searchParams.has('click_id'), 'bot redirect must not carry a click_id');
  const curlHit = await fetch('http://127.0.0.1:4199/r/bot-camp/offer-1', { redirect: 'manual', headers: { 'user-agent': 'curl/8.4.0' } });
  assert.equal(curlHit.status, 302);
  assert.equal((await (await fetch('http://127.0.0.1:4199/stats?campaign=bot-camp')).json()).clicks, 0, 'bot hits must not be counted as clicks');
  const humanHit = await fetch('http://127.0.0.1:4199/r/bot-camp/offer-1', { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' } });
  assert.ok(new URL(humanHit.headers.get('location')).searchParams.has('click_id'), 'human click must get click_id');
  assert.equal((await (await fetch('http://127.0.0.1:4199/stats?campaign=bot-camp')).json()).clicks, 1, 'human click must be counted');
  const events = (await readFile(join(dataDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(events.filter((e) => e.type === 'bot' && e.campaign === 'bot-camp').length, 2, 'bot hits must be logged as bot events');
  // Without botFilter the same bot UA is counted (feature is opt-in)
  const noFilter = await fetch('http://127.0.0.1:4199/r/camp-b/offer-1', { redirect: 'manual', headers: { 'user-agent': 'curl/8.4.0' } });
  assert.ok(new URL(noFilter.headers.get('location')).searchParams.has('click_id'));

  // Conversion window: postback for a click older than conversionWindowDays is rejected
  await fetch('http://127.0.0.1:4199/api/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'win-camp', name: 'Window', conversionWindowDays: 7 }) });
  const oldClickId = '00000000-0000-4000-8000-000000000001';
  await appendFile(join(dataDir, 'events.jsonl'), JSON.stringify({ id: 'old', type: 'click', at: new Date(Date.now() - 10 * 86400000).toISOString(), clickId: oldClickId, campaign: 'win-camp', offerId: 'offer-1' }) + '\n');
  const expired = await fetch(`http://127.0.0.1:4199/postback?click_id=${oldClickId}&secret=test-secret&revenue=1`);
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).error, 'conversion_window_expired');
  const freshWin = await fetch('http://127.0.0.1:4199/r/win-camp/offer-1', { redirect: 'manual' });
  const freshWinId = new URL(freshWin.headers.get('location')).searchParams.get('click_id');
  assert.equal((await fetch(`http://127.0.0.1:4199/postback?click_id=${freshWinId}&secret=test-secret&revenue=1`)).status, 200, 'fresh click inside window must convert');
  // Invalid window value is ignored (null = unlimited)
  await fetch('http://127.0.0.1:4199/api/campaigns/win-camp', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversionWindowDays: 9999 }) });
  assert.equal((await (await fetch('http://127.0.0.1:4199/api/campaigns')).json()).campaigns['win-camp'].conversionWindowDays, null);

  const BASE = 'http://127.0.0.1:4199';
  const postJson = (path, body, method = 'POST') => fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const hitFrom = (path, ip) => fetch(BASE + path, { redirect: 'manual', headers: { 'x-forwarded-for': ip } });

  // IP blacklist: exact IP and IPv4 CIDR; invalid rules are dropped
  assert.equal((await postJson('/api/campaigns', { id: 'ip-camp', name: 'IP', blockedIps: ['203.0.113.7', '198.51.100.0/24', 'not-an-ip', '10.0.0.0/99'] })).status, 201);
  assert.deepEqual((await (await fetch(BASE + '/api/campaigns')).json()).campaigns['ip-camp'].blockedIps, ['203.0.113.7', '198.51.100.0/24']);
  const blockedExact = await hitFrom('/r/ip-camp/offer-1', '203.0.113.7');
  assert.equal(blockedExact.status, 403);
  assert.equal((await blockedExact.json()).error, 'ip_blocked');
  assert.equal((await hitFrom('/r/ip-camp/offer-1', '198.51.100.200')).status, 403, 'CIDR /24 must block the range');
  assert.equal((await hitFrom('/r/ip-camp/offer-1', '198.51.101.1')).status, 302, 'IP outside CIDR must pass');
  // IP whitelist
  await postJson('/api/campaigns/ip-camp', { blockedIps: [], allowedIps: ['192.0.2.0/28'] }, 'PATCH');
  assert.equal((await hitFrom('/r/ip-camp/offer-1', '192.0.2.5')).status, 302);
  const notAllowed = await hitFrom('/r/ip-camp/offer-1', '192.0.2.16');
  assert.equal(notAllowed.status, 403);
  assert.equal((await notAllowed.json()).error, 'ip_not_allowed');

  // Offer-level daily cap: shared across campaigns; stream routing skips the capped offer
  assert.equal((await postJson('/api/offers', { id: 'cap-offer', url: 'https://capped.example.net/', dailyCap: 2 })).status, 201);
  await postJson('/api/campaigns', { id: 'ocap-a', name: 'A' });
  await postJson('/api/campaigns', { id: 'ocap-b', name: 'B', streams: [{ offers: [{ offerId: 'cap-offer', weight: 1000 }, { offerId: 'offer-1', weight: 1 }] }] });
  assert.equal((await hitFrom('/r/ocap-a/cap-offer', '192.0.2.50')).status, 302);
  assert.equal((await hitFrom('/r/ocap-a/cap-offer', '192.0.2.51')).status, 302);
  const offerCapped = await hitFrom('/r/ocap-a/cap-offer', '192.0.2.52');
  assert.equal(offerCapped.status, 429);
  assert.equal((await offerCapped.json()).error, 'offer_cap_reached');
  for (let i = 0; i < 3; i++) {
    const loc = new URL((await hitFrom('/r/ocap-b', `192.0.2.${60 + i}`)).headers.get('location'));
    assert.equal(loc.host, 'example.com', 'capped offer must be skipped in stream rotation');
  }
  // dailyCap persists through PATCH and can be cleared
  const offerPatched = await (await postJson('/api/offers/cap-offer', { dailyCap: null }, 'PATCH')).json();
  assert.equal(offerPatched.dailyCap, null);

  // Total cap: campaign auto-pauses after totalCap clicks
  await postJson('/api/campaigns', { id: 'total-camp', name: 'Total', totalCap: 2 });
  assert.equal((await hitFrom('/r/total-camp/offer-1', '192.0.2.70')).status, 302);
  assert.equal((await (await fetch(BASE + '/api/campaigns')).json()).campaigns['total-camp'].active, true);
  assert.equal((await hitFrom('/r/total-camp/offer-1', '192.0.2.71')).status, 302);
  assert.equal((await (await fetch(BASE + '/api/campaigns')).json()).campaigns['total-camp'].active, false, 'campaign must auto-pause when totalCap is reached');
  assert.equal((await hitFrom('/r/total-camp/offer-1', '192.0.2.72')).status, 404, 'paused campaign must stop redirecting');
  const pausedEvents = (await readFile(join(dataDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.type === 'campaign_paused' && e.campaign === 'total-camp');
  assert.equal(pausedEvents.length, 1);
  assert.equal(pausedEvents[0].reason, 'total_cap_reached');

  // Admin UI (/admin): shell and both assets are served; unknown asset paths are not
  const adminPage = await fetch('http://127.0.0.1:4199/admin');
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.headers.get('content-type'), /text\/html/);
  assert.match(await adminPage.text(), /\/admin\/admin\.js/);
  const adminJs = await fetch('http://127.0.0.1:4199/admin/admin.js');
  assert.equal(adminJs.status, 200);
  assert.match(adminJs.headers.get('content-type'), /javascript/);
  assert.equal((await fetch('http://127.0.0.1:4199/admin/admin.css')).status, 200);
  assert.equal((await fetch('http://127.0.0.1:4199/admin/../src/server.js')).status, 404, 'admin route must not serve arbitrary files');

  console.log('Product Umbrella smoke test passed');
} finally {
  child.kill('SIGTERM');
}
