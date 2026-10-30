// Public demo (/demo, src/panel-routes.js): the panel shell marked as the demo and its static files, without a session
// and outside the IP allowlist; nothing else under /demo, and the real API stays closed. The demo's made-up answers
// (public/admin/demo.js) are checked here for the shape the panel reads and for refused writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startTestServer } from './test-server.mjs';
import { isDemoPanelPath, isDemoPath } from '../src/panel-routes.js';

async function tracker(t, environment = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-demo-'));
  const server = await startTestServer(dataDir, { ADMIN_TOKEN: 'demo-test-token', REQUIRE_LOGIN: '1', ...environment });
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  return server.url;
}

test('isDemoPanelPath: /demo plus the panel paths under it', () => {
  for (const p of ['/demo', '/demo/', '/demo/dashboard', '/demo/campaigns', '/demo/campaigns/demo-fr-audio', '/demo/reports', '/demo/login']) assert.ok(isDemoPanelPath(p), p);
  for (const p of ['/demox', '/demo/api/campaigns', '/demo/stats', '/demo/admin/admin.js', '/demo/campaigns/a/b', '/demo/nope', '/demo//campaigns', '/dashboard']) {
    assert.ok(!isDemoPanelPath(p), p);
  }
  assert.ok(isDemoPath('/demo/admin/admin.js'));
  assert.ok(!isDemoPath('/demox') && !isDemoPath('/r/demo'));
});

test('demo pages: the shell with the demo marker, no login needed, the API still closed', { timeout: 20000 }, async (t) => {
  const url = await tracker(t, { BASE_PATH: '/umbrella' });
  for (const p of ['/demo', '/demo/', '/demo/dashboard', '/demo/campaigns/demo-fr-audio', '/demo/reports?group=offer', '/demo/login']) {
    const res = await fetch(url + p, { redirect: 'manual' });
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-security-policy') || '', /script-src 'self'/, p);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', p);
    const html = await res.text();
    assert.match(html, /<meta name="umbrella-demo" content="1">/, p);
    assert.match(html, /<meta name="umbrella-base" content="\/umbrella">/, p);
    assert.match(html, /class="demo-banner"[^>]*>ДЕМО-РЕЖИМ — данные выдуманные, изменения не сохраняются</, p);
    // Assets and menu stay inside the demo; no inline script.
    assert.match(html, /<script type="module" src="\/umbrella\/demo\/admin\/admin\.js">/, p);
    assert.match(html, /href="\/umbrella\/demo\/campaigns" data-nav="campaigns"/, p);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, p);
  }
  for (const [p, type] of [['/demo/admin/admin.js', 'text/javascript'], ['/demo/admin/demo.js', 'text/javascript'], ['/demo/admin/stats-report.js', 'text/javascript'],
    ['/demo/admin/stream-policy.js', 'text/javascript'], ['/demo/admin/admin.css', 'text/css']]) {
    const res = await fetch(url + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), new RegExp(type), p);
  }
  // Only the shell and the static files live under /demo.
  for (const p of ['/demo/api/campaigns', '/demo/stats', '/demo/admin/index.html', '/demo/nope', '/demo/campaigns/a/b']) {
    assert.equal((await fetch(url + p)).status, 404, p);
  }
  assert.equal((await fetch(url + '/demo/campaigns', { method: 'POST', body: '{}' })).status, 405);
  // The real panel is unchanged: no demo marker, and the API wants a session.
  const real = await (await fetch(url + '/campaigns')).text();
  assert.doesNotMatch(real, /umbrella-demo|demo-banner/);
  assert.match(real, /src="\/umbrella\/admin\/admin\.js"/);
  for (const p of ['/api/campaigns', '/api/offers', '/stats', '/api/clicks']) {
    const res = await fetch(url + p);
    assert.equal(res.status, 401, p);
    assert.equal((await res.json()).error, 'login_required', p);
  }
  assert.equal((await (await fetch(url + '/api/auth/me')).json()).user, null);
});

test('demo pages open outside ADMIN_ALLOWED_IPS, the panel and API do not', { timeout: 20000 }, async (t) => {
  const url = await tracker(t, { ADMIN_ALLOWED_IPS: '203.0.113.7' });
  assert.equal((await fetch(url + '/demo/campaigns')).status, 200);
  assert.equal((await fetch(url + '/demo/admin/admin.js')).status, 200);
  assert.equal((await fetch(url + '/campaigns')).status, 403);
  assert.equal((await fetch(url + '/admin/admin.js')).status, 403);
  assert.equal((await fetch(url + '/api/campaigns')).status, 403);
});

test('demo data: reads in the shape of the real API, every write refused', async () => {
  // demo.js imports ./stats-report.js next to it (the server serves src/stats-report.js there); in Node the module is
  // loaded from a copy with the import pointed at src/.
  const { readFile, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-demo-js-'));
  try {
    const source = await readFile(new URL('../public/admin/demo.js', import.meta.url), 'utf8');
    const statsReport = new URL('../src/stats-report.js', import.meta.url).href;
    await writeFile(join(dir, 'demo.mjs'), source.replace("'./stats-report.js'", JSON.stringify(statsReport)));
    const demo = await import(pathToFileURL(join(dir, 'demo.mjs')).href);
    const get = async (p) => { const res = await demo.request(p); assert.equal(res.status, 200, p); return res.json(); };

    const me = await get('/api/auth/me');
    assert.equal(me.user.role, 'owner');
    const { campaigns } = await get('/api/campaigns');
    const { offers } = await get('/api/offers');
    assert.ok(Object.keys(campaigns).length >= 5 && Object.keys(offers).length >= 5);
    // Made up: example domains only, nothing from production.
    const everything = JSON.stringify([campaigns, offers, await get('/api/landings'), await get('/api/networks'), await get('/api/sources'), await get('/api/domains'), await get('/api/users')]);
    for (const host of everything.match(/https?:\/\/[^/"?]+/g) || []) assert.match(host, /\.example$/, host);
    for (const email of everything.match(/[\w.+-]+@[\w.-]+/g) || []) assert.match(email, /@demo\.example$/, email);
    for (const c of Object.values(campaigns)) assert.match(c.name, /^Demo Campaign /);

    const today = new Date().toISOString().slice(0, 10);
    const all = await get('/stats');
    assert.ok(all.clicks > 1000 && all.conversions > 50 && all.revenue > 0 && all.cost > 0);
    for (const key of ['byCampaign', 'byCountry', 'byOffer', 'byStream', 'byLanding', 'bySource', 'byNetwork']) assert.ok(Object.keys(all[key]).length > 0, key);
    const one = await get('/stats?campaign=demo-fr-audio&from=' + today + '&to=' + today);
    assert.deepEqual(Object.keys(one.byCampaign), ['demo-fr-audio']);
    assert.ok(one.clicks < all.clicks);
    const usd = await get('/stats?currency=USD');
    assert.equal(usd.currency, 'USD');
    assert.ok(Math.abs(usd.cost - all.cost * 1.08) < 0.01);
    const series = await get('/stats/timeseries?granularity=day');
    assert.equal(series.series.reduce((s, x) => s + x.clicks, 0), all.clicks);
    assert.ok((await get('/stats/params?field=sub_id_1')).rows.length > 3);
    assert.ok((await get('/stats/params?field=os')).rows.some((r) => r.value === 'ios'));
    const clicks = await get('/api/clicks?limit=10&offset=10');
    assert.equal(clicks.clicks.length, 10);
    assert.equal(clicks.hasMore, true);
    assert.equal(clicks.clicks[0].click_id, clicks.clicks[0].clickId);
    assert.ok((await get('/api/conversions?limit=5')).conversions.every((c) => ['lead', 'sale', 'rejected', 'trash'].includes(c.status)));
    assert.ok((await get('/api/bots?limit=5')).bots.length === 5);

    for (const [method, p] of [['POST', '/api/campaigns'], ['PATCH', '/api/offers/demo-offer-speaker'], ['PUT', '/api/campaigns/demo-fr-audio/streams'],
      ['DELETE', '/api/users/00000000-0000-4000-a000-000000000002'], ['POST', '/api/auth/login'], ['POST', '/api/auth/logout']]) {
      const res = await demo.request(p, { method, body: '{}' });
      assert.equal(res.status, 403, `${method} ${p}`);
      assert.deepEqual(await res.json(), { error: 'Хуй тебе' });
    }
    assert.equal((await demo.request('/api/nope')).status, 404);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
