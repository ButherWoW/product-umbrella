// JSONL ↔ PostgreSQL parity of every report. One scenario (campaigns, streams, landing, CPA/CPC offers, conversion cap,
// statuses, upsells by tid, currencies, cost from a parameter, manual cost updates, S2S postbacks, a buyer) runs three ways:
//   J  — JSONL only;
//   P  — PostgreSQL (own throwaway database);
//   P2 — JSONL only, replaying P's journal.
// J and P must give the same numbers (ids and times differ between runs); P and P2 must be identical.
// Then: the last second of a day is inside `to`, and «Очистка статистики» leaves the same data in both storages.
// Runs only with TEST_DATABASE_URL (a role that may create databases, as in CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { startTestServer } from './test-server.mjs';
import { readJournal } from '../src/journal.js';
import { reconcileEvents } from '../src/reconcile.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const TOKEN = 'parity-token';
const MOB = 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile';
const IPH = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1 Mobile';
const DESK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120';
const today = () => new Date().toISOString().slice(0, 10);

function client(base, auth = { authorization: `Bearer ${TOKEN}` }) {
  const call = async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + path, { method, headers: { ...auth, 'content-type': 'application/json', 'x-requested-with': 'umbrella' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json };
  };
  const must = async (path, body) => { const r = await call(path, body); assert.ok(r.status < 300, `${path} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  const hit = async (path, { ip, ua = MOB, lang = 'fr-FR' }) => {
    const r = await fetch(base + path, { redirect: 'manual', headers: { 'x-forwarded-for': ip, 'user-agent': ua, 'accept-language': lang } });
    await r.text();
    return r.headers.get('location')?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0] ?? null;
  };
  const pb = async (q) => (await fetch(`${base}/postback?${new URLSearchParams(q)}`)).status;
  return { call, must, hit, pb };
}

async function configure(base) {
  const { must } = client(base);
  await must('/api/networks', { id: 'netA', name: 'Net A' });
  await must('/api/networks', { id: 'netB', name: 'Net B' });
  await must('/api/sources', { id: 'srcA', name: 'Src A', costModel: 'cpc', cpc: 0.05 });
  await must('/api/sources', { id: 'srcB', name: 'Src B', costModel: 'cpc', cpc: 0.02, costFromParam: true });
  await must('/api/offers', { id: 'o-cpa1', url: 'https://offer1.example/?c={click_id}', payoutType: 'cpa', payout: 10, payoutCurrency: 'EUR', networkId: 'netA', postbackUrl: 'https://127.0.0.1:1/s2s?cid={click_id}' });
  await must('/api/offers', { id: 'o-alt', url: 'https://alt.example/', payoutType: 'cpa', networkId: 'netB' });
  await must('/api/offers', { id: 'o-cpa2', url: 'https://offer2.example/', payoutType: 'cpa', payout: 12, payoutCurrency: 'USD', networkId: 'netB', conversionCap: 2, altOfferId: 'o-alt' });
  await must('/api/offers', { id: 'o-cpc', url: 'https://cpc.example/', payoutType: 'cpc', payout: 0.3, payoutCurrency: 'USD', networkId: 'netA' });
  await must('/api/landings', { id: 'lp1', url: 'https://lp.example/one', name: 'LP1' });
  const { user: buyer } = await must('/api/users', { email: 'buyer@example.com', password: 'Buyer-pass-12345', role: 'buyer' });
  await must('/api/campaigns', { id: 'c1', name: 'C1', sourceId: 'srcA', botFilter: true, bindVisitors: 'stream_offer', streams: [
    { name: 's-a', conditions: { params: { sub_id_2: ['a'] } }, offers: [{ offerId: 'o-cpa1' }] },
    { name: 's-b', conditions: { params: { sub_id_2: ['b'] } }, offers: [{ offerId: 'o-cpc' }], landings: [{ landingId: 'lp1' }] },
    { name: 's-fb', type: 'fallback', offers: [{ offerId: 'o-cpa2' }] }] });
  await must('/api/campaigns', { id: 'c2', name: 'C2', sourceId: 'srcB', ownerId: buyer.id, streams: [{ name: 'main', offers: [{ offerId: 'o-cpa2' }] }] });
  await must('/api/campaigns', { id: 'c3', name: 'C3', streams: [{ name: 'x', offers: [{ offerId: 'o-cpa1' }] }] });
}

async function traffic(base) {
  const { call, hit, pb } = client(base);
  const ids = {};
  const H = async (key, path, opts) => { ids[key] = await hit(path, opts); };
  await H('a1', '/r/c1?sub_id_2=a&sub_id_1=k1&keyword=shoes', { ip: '90.1.1.1' });
  await H('a2', '/r/c1?sub_id_2=a&sub_id_1=k2', { ip: '90.1.1.1' }); // same visitor: not unique
  await H('a3', '/r/c1?sub_id_2=a&sub_id_1=k1', { ip: '90.1.1.1' });
  await H('b1', '/r/c1?sub_id_2=b&sub_id_1=k3', { ip: '172.58.0.1', ua: IPH, lang: 'en-US' });
  await H('b2', '/r/c1?sub_id_2=b', { ip: '172.58.0.2', ua: IPH, lang: 'en-US' });
  await H('z1', '/r/c1?sub_id_2=zz', { ip: '77.88.8.8', ua: DESK, lang: 'ru' });
  await H('z2', '/r/c1', { ip: '81.2.69.142', ua: DESK, lang: 'en' });
  await H('bot', '/r/c1?sub_id_2=a', { ip: '90.1.1.9', ua: 'curl/8.0' });
  for (const k of ['b1', 'b1', 'b2']) await (await fetch(`${base}/lp/click?click_id=${ids[k]}`, { redirect: 'manual' })).text();
  // Cost from a parameter with more than 6 decimals (clicks.cost is NUMERIC(12,6)).
  await H('m1', '/r/c2?cost=0.3333333&sub_id_1=m', { ip: '62.210.1.1', ua: DESK });
  await H('m2', '/r/c2?cost=0.1&sub_id_1=m', { ip: '90.1.1.2' });
  await H('x1', '/r/c3?sub_id_1=x', { ip: '90.1.1.3' });
  await H('x2', '/r/c3/o-cpa1?sub_id_1=x', { ip: '90.1.1.3' });
  const P = (q) => pb({ secret: 'conversion-test-secret', ...q });
  const codes = [
    await P({ click_id: ids.a1, status: 'lead' }),
    await P({ click_id: ids.a1, status: 'sale' }),
    await P({ click_id: ids.a1, status: 'sale' }), // duplicate
    await P({ click_id: ids.a2, revenue: '7.5', currency: 'USD' }),
    await P({ click_id: ids.a2, status: 'rejected' }),
    await P({ click_id: ids.a3, tid: 't1', revenue: '3', currency: 'GBP', status: 'sale', sub_id_3: 'net3' }),
    await P({ click_id: ids.a3, tid: 't2', revenue: '2', status: 'lead' }),
    await P({ click_id: ids.a3, tid: 't2', status: 'approved', sub_id_1: 'k1-over' }),
    await P({ click_id: ids.b1, revenue: '1.2345' }), // CPC offer: status counts, amount does not
    await P({ click_id: ids.z1, status: 'lead' }),
    await P({ click_id: ids.z2, revenue: '4', currency: 'RUB', status: 'sale' }),
    await P({ click_id: ids.m1, revenue: '5', status: 'sale' }),
    await P({ click_id: ids.x1, status: 'trash' }),
    await P({ click_id: '00000000-0000-4000-8000-000000000000' }),
    await pb({ secret: 'nope', click_id: ids.x2 }),
  ];
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 404, 401]);
  await H('m3', '/r/c2?sub_id_1=n', { ip: '90.1.1.4' }); // o-cpa2 capped → o-alt
  assert.equal(await P({ click_id: ids.m3, revenue: '2', status: 'sale' }), 200);
  const day = today();
  for (const body of [{ campaign: 'c1', amount: 10, currency: 'USD' }, { campaign: 'c1', amount: 1, filters: { offer: 'o-cpa1' }, uniqueOnly: true },
    { campaign: 'c3', amount: 0.01 }, { campaign: 'c2', amount: 1, filters: { sub_id_1: 'n' } }])
    assert.equal((await call('/api/costs', { from: day, to: day, ...body })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 500)); // S2S attempts (S2S_RETRY_MS=0) are journaled
  return ids;
}

async function buyerAuth(base) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'umbrella' },
    body: JSON.stringify({ email: 'buyer@example.com', password: 'Buyer-pass-12345' }) });
  return { cookie: r.headers.get('set-cookie').split(';')[0] };
}

async function reports(base) {
  const { call } = client(base);
  const day = today();
  const out = {};
  const paths = ['/stats', '/stats?currency=USD', '/stats?campaign=c1', `/stats?from=${day}&to=${day}`, '/stats?stream=s-a', '/stats?offer=o-cpa2&currency=RUB',
    ...['sub_id_1', 'sub_id_2', 'sub_id_3', 'keyword', 'device', 'os', 'browser', 'language'].map((f) => `/stats/params?field=${f}`), '/stats/params?field=sub_id_1&currency=USD',
    '/stats/timeseries', '/stats/timeseries?granularity=hour', '/stats/timeseries?currency=USD&campaign=c1', `/stats/compare?from=${day}&to=${day}`, '/stats/bots', '/api/bots',
    ...['campaign', 'offer', 'stream', 'landing', 'source', 'network', 'sub_id_1'].map((g) => `/stats/export?group=${g}`),
    '/stats/export?group=network&currency=USD', '/stats/export?group=source&currency=USD',
    '/api/clicks?limit=100', '/api/conversions?limit=100', `/api/conversions?from=${day}&to=${day}`, '/api/postbacks?direction=in', '/api/postbacks?direction=out'];
  for (const p of paths) out[p] = (await call(p)).json;
  const buyer = client(base, await buyerAuth(base));
  for (const p of ['/stats', '/stats/timeseries', '/stats/params?field=sub_id_1', '/api/clicks', '/api/conversions', '/api/postbacks?direction=in', '/stats/export?group=network'])
    out[`BUYER ${p}`] = (await buyer.call(p)).json;
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// `exact`: P vs P2 (same journal). Otherwise ids and times of the two runs are dropped and rows are compared as sets.
function differences(a, b, exact) {
  const drop = new Set(exact ? ['storage'] : ['storage', 'clickId', 'click_id', 'at', 'updatedAt', 'created_at', 'url']);
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).filter((k) => !drop.has(k)).sort().map((k) => [k, norm(v[k])]));
    if (typeof v === 'string' && v.includes('\n')) return v.split('\n').sort();
    if (typeof v === 'string' && !exact) return v.replace(UUID, '<id>');
    return v;
  };
  const out = [];
  const cmp = (x, y, path) => {
    if (typeof x === 'number' && typeof y === 'number') { if (Math.abs(x - y) > 1e-9 * Math.max(1, Math.abs(x))) out.push([path, x, y]); return; }
    if (x && y && typeof x === 'object' && typeof y === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) cmp(x[k], y[k], `${path}.${k}`); return; }
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push([path, x, y]);
  };
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) cmp(norm(a[k]), norm(b[k]), k);
  return out;
}

test('JSONL and PostgreSQL give the same reports', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 120000 }, async (t) => {
  const dbName = `parity_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const target = new URL(databaseUrl); target.pathname = `/${dbName}`;
  const ownUrl = target.toString();
  const dirs = [];
  const servers = [];
  t.after(async () => {
    for (const s of servers) await s.stop();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    for (const name of [dbName, `${dbName}_replay`]) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end();
  });
  await promisify(execFile)(process.execPath, ['src/migrate.js'], { env: { ...process.env, DATABASE_URL: ownUrl } });

  const start = async (env = {}, journal = null) => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-parity-')); dirs.push(dir);
    await writeFile(join(dir, 'fx-rates.json'), JSON.stringify({ base: 'EUR', rates: { EUR: 1, USD: 1.1, RUB: 100, GBP: 0.85 }, updatedAt: '2026-10-30T00:00:00Z', source: 'test' }));
    if (journal) await copyFile(journal, join(dir, 'events.jsonl'));
    const server = await startTestServer(dir, { ADMIN_TOKEN: TOKEN, TRUST_PROXY: '1', S2S_RETRY_MS: '0', DEFAULT_CURRENCY: 'EUR', ...env });
    servers.push(server);
    return { ...server, dir, journal: join(dir, 'events.jsonl') };
  };
  const pgEnv = { DATABASE_URL: ownUrl, REQUIRE_POSTGRES: '1' };

  const J = await start(); await configure(J.url); await traffic(J.url);
  const P = await start(pgEnv); await configure(P.url); await traffic(P.url);
  const P2 = await start({}, P.journal); await configure(P2.url);
  const [rJ, rP, rP2] = [await reports(J.url), await reports(P.url), await reports(P2.url)];
  for (const r of [rJ, rP, rP2]) assert.equal(r['/stats'].clicks, 12, 'scenario ran');
  assert.deepEqual([rJ, rP, rP2].map((r) => r['/api/clicks?limit=100'].storage), ['jsonl', 'postgres', 'jsonl']);
  assert.deepEqual(differences(rJ, rP, false), [], 'JSONL vs PostgreSQL');
  assert.deepEqual(differences(rP, rP2, true), [], 'PostgreSQL vs its journal replayed without a database');

  // The confirmed inconsistencies, spelled out.
  for (const r of [rJ, rP]) {
    // 1: bySource/byNetwork in the report currency (4 RUB = 0.04 EUR, 12 USD lead = 10.909 EUR pending).
    assert.ok(Math.abs(r['/stats'].byNetwork.netB.revenue - 7.04) < 1e-9, `netB revenue ${r['/stats'].byNetwork.netB.revenue}`);
    assert.ok(Math.abs(r['/stats'].byNetwork.netB.pendingRevenue - 12 / 1.1) < 1e-9);
    // 2: one conversion row per (click, tid), latest status; `at` = first postback.
    const rows = r['/api/conversions?limit=100'].conversions;
    assert.equal(rows.length, 10);
    const a1 = rows.filter((c) => c.offerId === 'o-cpa1' && c.campaign === 'c1' && c.status === 'sale' && c.tid === '');
    assert.equal(a1.length, 1); assert.ok(a1[0].updatedAt > a1[0].at, 'lead → sale: updatedAt is the later postback');
    // 4: cost from the parameter rounded to 6 decimals in the journal too.
    assert.ok(r['/api/clicks?limit=100'].clicks.some((c) => c.cost === 0.333333));
    // 5: no SQL alias in the parameter report.
    assert.ok(r['/stats/params?field=sub_id_1'].rows.every((row) => !('unique_clicks' in row)));
    // 8: CPC offer — revenue only from its 2 clicks (2 × 0.3 USD = 0.545454 EUR), the postback's 1.2345 is kept but ignored.
    assert.ok(Math.abs(r['/stats'].byOffer['o-cpc'].revenue - 0.545454) < 1e-9, `o-cpc revenue ${r['/stats'].byOffer['o-cpc'].revenue}`);
    assert.equal(r['/stats'].byOffer['o-cpc'].sales, 1);
    const cpc = rows.find((c) => c.offerId === 'o-cpc');
    assert.deepEqual([cpc.revenue, cpc.revenueIgnored], [1.2345, true]);
    assert.ok(rows.filter((c) => c.offerId !== 'o-cpc').every((c) => c.revenueIgnored === false));
  }

  // The reconciliation job replays the CPC flag too: P's journal into an empty database gives the same conversion rows.
  const replayDb = `${dbName}_replay`; // dropped with the main database in t.after
  await admin.query(`CREATE DATABASE ${replayDb}`);
  const replayUrl = new URL(databaseUrl); replayUrl.pathname = `/${replayDb}`;
  await promisify(execFile)(process.execPath, ['src/migrate.js'], { env: { ...process.env, DATABASE_URL: replayUrl.toString() } });
  const conversionRows = async (url) => {
    const c = new pg.Client({ connectionString: url }); await c.connect();
    try { return (await c.query(`SELECT click_id::text, tid, revenue::float, currency, status, revenue_ignored, created_at, COALESCE(updated_at, created_at) AS updated_at
      FROM conversions ORDER BY click_id, tid`)).rows; } finally { await c.end(); }
  };
  const replayPool = new pg.Pool({ connectionString: replayUrl.toString() });
  try { await reconcileEvents({ db: replayPool, events: await readJournal(P.journal) }); } finally { await replayPool.end(); }
  const replayed = await conversionRows(replayUrl.toString());
  assert.deepEqual(replayed, await conversionRows(ownUrl), 'reconciliation writes the same conversion rows as the live mirror');
  assert.equal(replayed.filter((r) => r.revenue_ignored).length, 1);

  // 7: `to` covers the whole last second of the day (a click at 23:59:59.5).
  const late = { type: 'click', clickId: '11111111-2222-4333-8444-555555555555', campaign: 'c3', offerId: 'o-cpa1', stream: 'x', at: '2020-01-01T23:59:59.500Z',
    uniqueCampaign: true, uniqueStream: true, uniqueGlobal: true, params: { sub_id_1: 'late' } };
  // JSONL servers read the journal per request; P's journal gets the line too, so its replay below still matches.
  for (const file of [J.journal, P.journal]) await appendFile(file, JSON.stringify({ id: 'late-click', ...late }) + '\n');
  const db = new pg.Client({ connectionString: ownUrl }); await db.connect();
  try {
    await db.query(`INSERT INTO clicks (click_id, campaign, offer_id, stream, params, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [late.clickId, late.campaign, late.offerId, late.stream, JSON.stringify(late.params), late.at]);
  } finally { await db.end(); }
  for (const base of [J.url, P.url]) {
    const { call } = client(base);
    const q = 'from=2020-01-01&to=2020-01-01';
    assert.equal((await call(`/stats?${q}`)).json.clicks, 1, `${base} /stats`);
    assert.equal((await call(`/stats/timeseries?${q}`)).json.series[0]?.clicks, 1, `${base} timeseries`);
    assert.equal((await call(`/stats/params?field=sub_id_1&${q}`)).json.rows[0]?.clicks, 1, `${base} params`);
    assert.equal((await call(`/api/clicks?${q}`)).json.clicks.length, 1, `${base} click log`);
    assert.equal((await call('/stats?from=2020-01-02&to=2020-01-02')).json.clicks, 0);
  }

  // 3: «Очистка статистики» of c1 removes its postback journal and its cost updates from the journal too:
  // the journal replayed without a database shows exactly what PostgreSQL shows.
  const cleared = await client(P.url).call('/api/campaigns/c1/clear-stats', { confirm: 'c1' });
  assert.equal(cleared.status, 200);
  assert.ok(cleared.json.removed.postbacks > 0 && cleared.json.removed.postbacks === cleared.json.removed.postgres.postbacks,
    `postbacks removed: ${JSON.stringify(cleared.json.removed)}`);
  const journal = (await readFile(P.journal, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(journal.filter((e) => ['postback_in', 'postback_out', 'cost_update', 'click', 'conversion', 'lp_click'].includes(e.type) && e.campaign === 'c1'), []);
  const P3 = await start({}, P.journal); await configure(P3.url);
  const [afterP, afterP3] = [await reports(P.url), await reports(P3.url)];
  assert.equal(afterP['/stats'].byCampaign.c1, undefined);
  assert.equal(afterP['/api/postbacks?direction=in'].postbacks.filter((p) => p.campaign === 'c1').length, 0);
  assert.deepEqual(differences(afterP, afterP3, true), [], 'after clearing: PostgreSQL vs its journal');
});
