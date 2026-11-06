// PostgreSQL resilience: connection loss, lost mirror writes and their reconciliation, the revenue cap and
// UTC day buckets, migrations of an old schema. Each test uses its own throwaway database (created from
// TEST_DATABASE_URL), because tables are renamed and connections terminated.
// Runs only with TEST_DATABASE_URL (CI starts a throwaway PostgreSQL; locally: docker run postgres:16).
// PG_RESTART_CMD (e.g. "docker restart my-pg") additionally runs a real server restart under load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exec, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { revenueJournal, createCapCampaigns, assertCaps, TOKEN } from './revenue-fixture.mjs';
import { parseJournal } from '../src/journal.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = !databaseUrl && 'set TEST_DATABASE_URL to run';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pool(url = databaseUrl) {
  const { default: pg } = await import('pg');
  const p = new pg.Pool({ connectionString: url, max: 2 });
  p.on('error', () => {});
  return p;
}
// A fresh database (optionally migrated); dropped after the test.
async function scratchDatabase(t, { migrate = true } = {}) {
  const name = `umb_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const admin = await pool();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl); url.pathname = `/${name}`;
  t.after(async () => {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end();
  });
  if (migrate) runMigrate(url.href);
  return { name, url: url.href, admin };
}
function runMigrate(url) {
  const result = spawnSync(process.execPath, ['src/migrate.js'], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout + result.stderr;
}
async function waitFor(check, { timeout = 15000, step = 100 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) return value;
    await sleep(step);
  }
}
const api = (server) => (path, body, method = body ? 'POST' : 'GET') => fetch(server.url + path, {
  method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const clickOf = async (response) => new URL(response.headers.get('location')).searchParams.get('click_id');

test('migrate upgrades an old schema idempotently; CHECK constraints are added (NOT VALID when old rows fail)', { skip, timeout: 60000 }, async (t) => {
  const { url } = await scratchDatabase(t, { migrate: false });
  const db = await pool(url);
  t.after(() => db.end());
  // The shape of an early install: no event ids, no CHECK constraints, conversion keyed by click only.
  await db.query(`CREATE TABLE offers (id TEXT PRIMARY KEY, url TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE landings (id TEXT PRIMARY KEY, url TEXT NOT NULL, name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE clicks (click_id UUID PRIMARY KEY, campaign TEXT NOT NULL, offer_id TEXT NOT NULL, path TEXT, referrer TEXT, user_agent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE conversions (click_id UUID PRIMARY KEY REFERENCES clicks(click_id), revenue NUMERIC(12,4), currency TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE bots (id BIGSERIAL PRIMARY KEY, campaign TEXT NOT NULL, offer_id TEXT, stream TEXT, user_agent TEXT, ip TEXT, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  const clickId = randomUUID();
  await db.query(`INSERT INTO offers (id, url) VALUES ('good', 'https://example.com/'), ('HTTPS-upper', 'HTTPS://example.com/')`);
  await db.query(`INSERT INTO landings (id, url) VALUES ('legacy', 'http://old.example/')`);
  await db.query('INSERT INTO clicks (click_id, campaign, offer_id) VALUES ($1, $2, $3)', [clickId, 'c', 'good']);
  await db.query('INSERT INTO conversions (click_id, revenue) VALUES ($1, 5)', [clickId]);
  await db.query(`INSERT INTO bots (campaign, reason) VALUES ('c', 'ua')`);

  const output = runMigrate(url);
  assert.match(output, /landings_url_check stays NOT VALID/);
  runMigrate(url);
  const constraints = Object.fromEntries((await db.query(`SELECT conname, convalidated FROM pg_constraint
    WHERE conname IN ('conversions_status_check', 'offers_url_check', 'landings_url_check')`)).rows.map((r) => [r.conname, r.convalidated]));
  assert.deepEqual(constraints, { conversions_status_check: true, offers_url_check: true, landings_url_check: false });
  for (const table of ['conversions', 'bots', 'postbacks']) {
    const { rowCount } = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'event_id'`, [table]);
    assert.equal(rowCount, 1, `${table}.event_id`);
  }
  await assert.rejects(db.query(`INSERT INTO conversions (click_id, tid, status) VALUES ($1, 'x', 'bogus')`, [clickId]), /conversions_status_check/);
  await assert.rejects(db.query(`INSERT INTO landings (id, url) VALUES ('new', 'http://x/')`), /landings_url_check/, 'new rows are checked even while NOT VALID');
  assert.equal((await db.query('SELECT status FROM conversions WHERE click_id = $1', [clickId])).rows[0].status, 'sale', 'old rows kept');
});

test('lost mirror writes are replayed by the reconciliation job; /health counts the failures', { skip, timeout: 60000 }, async (t) => {
  const { url } = await scratchDatabase(t);
  const db = await pool(url);
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgrec-'));
  let server;
  t.after(async () => { await server?.stop(); await db.end(); await rm(dir, { recursive: true, force: true }); });
  server = await startTestServer(dir, { DATABASE_URL: url, ADMIN_TOKEN: TOKEN, RECONCILE_INTERVAL_MS: '1000', RECONCILE_DELAY_MS: '0' });
  const call = api(server);
  assert.equal((await call('/api/campaigns', { id: 'lost', name: 'lost', botFilter: true, streams: [{ name: 'main', offers: [{ offerId: 'offer-1' }] }] })).status, 201);
  const kept = await clickOf(await fetch(`${server.url}/r/lost`, { redirect: 'manual' }));
  assert.equal((await fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${kept}&revenue=3&status=lead`)).status, 200);
  await waitFor(async () => (await db.query('SELECT 1 FROM conversions WHERE click_id = $1', [kept])).rowCount);

  // Tables unavailable for a moment (as in the audit): every write of this window fails in PostgreSQL.
  for (const table of ['clicks', 'conversions', 'bots', 'postbacks']) await db.query(`ALTER TABLE ${table} RENAME TO ${table}_off`);
  const lost = await clickOf(await fetch(`${server.url}/r/lost`, { redirect: 'manual' }));
  assert.equal((await fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${lost}&revenue=7&status=lead`)).status, 200);
  assert.equal((await fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${lost}&status=sale`)).status, 200, 'status update');
  assert.equal((await fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${kept}&status=sale`)).status, 200, 'update of a mirrored conversion');
  assert.equal((await fetch(`${server.url}/r/lost`, { redirect: 'manual', headers: { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' } })).status >= 200, true);
  await sleep(300);
  for (const table of ['clicks', 'conversions', 'bots', 'postbacks']) await db.query(`ALTER TABLE ${table}_off RENAME TO ${table}`);
  const health = await (await fetch(`${server.url}/health`)).json();
  assert.ok(health.mirrorErrors >= 4, `mirror errors counted: ${JSON.stringify(health)}`);
  assert.equal(health.db, 'up');

  const journal = parseJournal(await readFile(join(dir, 'events.jsonl'), 'utf8')).events;
  const expect = { bots: journal.filter((e) => e.type === 'bot').length, postbacks: journal.filter((e) => e.type.startsWith('postback_')).length };
  const state = async () => {
    const conv = (await db.query('SELECT click_id::text AS id, status, revenue::float AS revenue, event_id::text AS event_id FROM conversions ORDER BY click_id')).rows;
    const clicks = (await db.query('SELECT COUNT(*)::int AS n FROM clicks')).rows[0].n;
    const bots = (await db.query('SELECT COUNT(*)::int AS n FROM bots')).rows[0].n;
    const postbacks = (await db.query('SELECT COUNT(*)::int AS n FROM postbacks')).rows[0].n;
    return { conv, clicks, bots, postbacks };
  };
  const done = await waitFor(async () => { const s = await state(); return s.clicks === 2 && s.conv.length === 2 && s.conv.every((c) => c.status === 'sale') && s.bots === expect.bots && s.postbacks === expect.postbacks && s; });
  assert.ok(done, `reconciled: ${JSON.stringify(await state())}`);
  const latest = (clickId) => journal.filter((e) => e.type === 'conversion' && e.clickId === clickId).at(-1);
  for (const id of [kept, lost]) {
    const row = done.conv.find((c) => c.id === id);
    assert.equal(row.event_id, latest(id).id, 'row holds the latest journal event');
  }
  assert.equal(done.conv.find((c) => c.id === lost).revenue, 7, 'status-only update keeps the amount');
  const stats = await (await call('/stats?campaign=lost')).json();
  assert.deepEqual([stats.clicks, stats.sales, stats.revenue], [2, 2, 10]);

  // Idempotent: running the script again changes nothing.
  const again = spawnSync(process.execPath, ['scripts/reconcile-db.mjs', '--data-dir', dir], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout.trim().split('\n').at(-1)).replayed, { clicks: 0, conversions: 0, clickState: 0, bots: 0, postbacks: 0, costImports: 0 });
  assert.deepEqual(await state(), done);
});

test('reconciliation copies an existing journal into an empty database (clicks, conversions, lp clicks, costs, bots)', { skip, timeout: 60000 }, async (t) => {
  const { url } = await scratchDatabase(t);
  const db = await pool(url);
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgattach-'));
  let server;
  t.after(async () => { await server?.stop(); await db.end(); await rm(dir, { recursive: true, force: true }); });
  const at = (s) => new Date(Date.parse('2026-05-01T10:00:00Z') + s * 1000).toISOString();
  const [a, b] = [randomUUID(), randomUUID()];
  const ev = (e) => JSON.stringify({ id: randomUUID(), ...e });
  await writeFile(join(dir, 'events.jsonl'), [
    ev({ type: 'click', at: at(0), clickId: a, campaign: 'att', offerId: 'offer-1', params: { sub_id_1: 'x' }, cost: 0.1 }),
    ev({ type: 'click', at: at(1), clickId: b, campaign: 'att', offerId: 'offer-1' }),
    ev({ type: 'lp_click', at: at(2), clickId: a, campaign: 'att' }),
    ev({ type: 'lp_click', at: at(3), clickId: a, campaign: 'att' }),
    ev({ type: 'conversion', at: at(4), clickId: a, revenue: 9, currency: 'EUR', status: 'lead', params: { sub_id_2: 'net' } }),
    ev({ type: 'conversion', at: at(5), clickId: a, revenue: 9, currency: 'EUR', status: 'sale', previousStatus: 'lead' }),
    ev({ type: 'conversion', at: at(6), clickId: a, tid: 'up1', revenue: 2, currency: 'EUR' }),
    ev({ type: 'cost_update', at: at(7), campaign: 'att', clickIds: [a, b], cost: 0.25, lastClickId: b, lastCost: 0.35, importKey: 'att|k', importCost: 0.6 }),
    ev({ type: 'bot', at: at(8), campaign: 'att', reason: 'ua', ip: '10.0.0.1' }),
    ev({ type: 'postback_in', at: at(9), clickId: a, campaign: 'att', status: 'sale', statusCode: 200 }),
  ].join('\n') + '\n');
  // A bot row written before event ids existed (old backfill) must not be duplicated.
  await db.query(`INSERT INTO bots (campaign, reason, ip, created_at) VALUES ('att', 'ua', '10.0.0.1', $1)`, [at(8)]);
  server = await startTestServer(dir, { DATABASE_URL: url, ADMIN_TOKEN: TOKEN, RECONCILE_INTERVAL_MS: '3600000', RECONCILE_DELAY_MS: '0' });
  // Reconciliation writes table by table: wait for the postback row and the cost import, not just one of them.
  const ok = await waitFor(async () => (await db.query('SELECT 1 FROM postbacks')).rowCount === 1
    && (await db.query(`SELECT 1 FROM cost_imports WHERE import_key = 'att|k'`)).rowCount === 1);
  assert.ok(ok, 'startup reconciliation ran');
  const clicks = Object.fromEntries((await db.query('SELECT click_id::text AS id, cost::float AS cost, params, lp_clicked_at FROM clicks')).rows.map((r) => [r.id, r]));
  assert.deepEqual(clicks[a].params, { sub_id_1: 'x', sub_id_2: 'net' });
  assert.equal(clicks[a].cost, 0.25);
  assert.equal(clicks[b].cost, 0.35);
  assert.equal(clicks[a].lp_clicked_at.toISOString(), at(2), 'first landing click');
  const conv = (await db.query('SELECT tid, status, revenue::float AS revenue, created_at, updated_at FROM conversions ORDER BY tid')).rows;
  assert.deepEqual(conv.map((r) => [r.tid, r.status, r.revenue]), [['', 'sale', 9], ['up1', 'sale', 2]]);
  assert.equal(conv[0].created_at.toISOString(), at(4), 'created_at = first event');
  assert.equal(conv[0].updated_at.toISOString(), at(5), 'updated_at = latest event');
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM bots')).rows[0].n, 1, 'legacy bot row matched');
  assert.equal(Number((await db.query(`SELECT cost FROM cost_imports WHERE import_key = 'att|k'`)).rows[0].cost), 0.6);
  const stats = await (await api(server)('/stats?campaign=att')).json();
  assert.deepEqual([stats.clicks, stats.lpClicks, stats.sales, stats.revenue], [2, 1, 2, 11]);
});

test('revenue cap reads PostgreSQL and gives the same answer as the journal', { skip, timeout: 60000 }, async (t) => {
  const { url } = await scratchDatabase(t);
  const db = await pool(url);
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgcap-'));
  let server;
  t.after(async () => { await server?.stop(); await db.end(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'events.jsonl'), revenueJournal(Date.now(), '-pg'));
  server = await startTestServer(dir, { DATABASE_URL: url, ADMIN_TOKEN: TOKEN, RECONCILE_INTERVAL_MS: '3600000', RECONCILE_DELAY_MS: '0' });
  assert.ok(await waitFor(async () => (await db.query('SELECT COUNT(*)::int AS n FROM conversions')).rows[0].n === 4), 'journal reconciled into PostgreSQL');
  await createCapCampaigns(server.url, '-pg');
  await assertCaps(server.url, '-pg');
  assert.doesNotMatch(server.logs(), /todayRevenue fallback/, 'the PostgreSQL query itself works');
  // The JSONL answer for the same journal.
  await server.stop();
  server = await startTestServer(dir, { ADMIN_TOKEN: TOKEN });
  await createCapCampaigns(server.url, '-pg'); // campaigns were stored in PostgreSQL
  await assertCaps(server.url, '-pg');
});

test('daily buckets are UTC days even when the database time zone is not UTC', { skip, timeout: 60000 }, async (t) => {
  const { url, name, admin } = await scratchDatabase(t);
  await admin.query(`ALTER DATABASE ${name} SET timezone TO 'America/Los_Angeles'`);
  const db = await pool(url);
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgtz-'));
  let server;
  t.after(async () => { await server?.stop(); await db.end(); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await db.query('SHOW timezone')).rows[0].TimeZone, 'America/Los_Angeles');
  await db.query(`INSERT INTO clicks (click_id, campaign, offer_id, created_at) VALUES ($1, 'tz', 'offer-1', '2026-02-10T03:00:00Z'), ($2, 'tz', 'offer-1', '2026-02-10T23:30:00Z')`, [randomUUID(), randomUUID()]);
  server = await startTestServer(dir, { DATABASE_URL: url, ADMIN_TOKEN: TOKEN });
  const day = await (await api(server)('/stats/timeseries?campaign=tz&from=2026-02-09&to=2026-02-11')).json();
  assert.deepEqual(day.series.map((s) => [s.date, s.clicks]), [['2026-02-10', 2]]);
  const hour = await (await api(server)('/stats/timeseries?campaign=tz&granularity=hour&from=2026-02-09&to=2026-02-11')).json();
  assert.deepEqual(hour.series.map((s) => s.date), ['2026-02-10T03', '2026-02-10T23']);
});

test('the tracker survives PostgreSQL dropping every connection under load; nothing is lost', { skip, timeout: 90000 }, async (t) => {
  const { url, name, admin } = await scratchDatabase(t);
  const db = await pool(url);
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgdrop-'));
  let server;
  t.after(async () => { await server?.stop(); await db.end(); await rm(dir, { recursive: true, force: true }); });
  server = await startTestServer(dir, { DATABASE_URL: url, ADMIN_TOKEN: TOKEN, RECONCILE_INTERVAL_MS: '1000', RECONCILE_DELAY_MS: '0' });
  assert.equal((await api(server)('/api/campaigns', { id: 'drop', name: 'drop', streams: [{ name: 'main', offers: [{ offerId: 'offer-1' }] }] })).status, 201);
  const kill = () => admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
  const restart = process.env.PG_RESTART_CMD;
  const total = restart ? 200 : 60; // with a real restart the load runs through it
  let hits = 0;
  const load = (async () => {
    for (let i = 0; i < total; i++) {
      const r = await fetch(`${server.url}/r/drop`, { redirect: 'manual' }).catch(() => null);
      if (r?.status === 302) hits += 1;
      await sleep(25);
    }
  })();
  for (let i = 0; i < 4; i++) { await sleep(250); await kill(); }
  if (restart) await new Promise((resolve, reject) => exec(restart, (error) => (error ? reject(error) : resolve())));
  await load;
  assert.equal(hits, total, 'every click answered while connections were dropped');
  const health = await fetch(`${server.url}/health`);
  assert.equal(health.status, 200, 'server still up');
  const journalClicks = parseJournal(await readFile(join(dir, 'events.jsonl'), 'utf8')).events.filter((e) => e.type === 'click').length;
  assert.equal(journalClicks, total);
  const pgClicks = await waitFor(async () => {
    const n = (await db.query(`SELECT COUNT(*)::int AS n FROM clicks WHERE campaign = 'drop'`).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
    return n === total && n;
  }, { timeout: 20000 });
  assert.equal(pgClicks, total, 'PostgreSQL has every click (retried or reconciled)');
  assert.equal((await (await fetch(`${server.url}/health`)).json()).db, 'up');
});

test('a repeated sale is a duplicate even while the PostgreSQL row still holds the older status', { skip, timeout: 60000 }, async (t) => {
  const { url } = await scratchDatabase(t);
  const db = await pool(url);
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgdup-'));
  let server;
  t.after(async () => { await server?.stop(); await db.end(); await rm(dir, { recursive: true, force: true }); });
  server = await startTestServer(dir, { DATABASE_URL: url, ADMIN_TOKEN: TOKEN });
  const clickId = await clickOf(await fetch(`${server.url}/r/demo/offer-1`, { redirect: 'manual' }));
  const post = (status) => fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${clickId}&revenue=5&status=${status}`);
  assert.equal((await post('lead')).status, 200);
  await waitFor(async () => (await db.query('SELECT 1 FROM conversions WHERE click_id = $1', [clickId])).rowCount);
  // The sale cannot reach PostgreSQL: the row stays 'lead' there while the journal says 'sale'.
  await db.query(`ALTER TABLE conversions ADD CONSTRAINT block_sale CHECK (status <> 'sale') NOT VALID`);
  assert.equal((await post('sale')).status, 200);
  await sleep(200);
  assert.equal((await db.query('SELECT status FROM conversions WHERE click_id = $1', [clickId])).rows[0].status, 'lead');
  const repeat = await post('sale');
  assert.equal((await repeat.json()).duplicate, true, 'not taken for a lead → sale update (that would re-send S2S postbacks)');
  await db.query('ALTER TABLE conversions DROP CONSTRAINT block_sale');
  const fix = spawnSync(process.execPath, ['scripts/reconcile-db.mjs', '--data-dir', dir], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  assert.equal(fix.status, 0, fix.stderr);
  assert.equal(JSON.parse(fix.stdout.trim().split('\n').at(-1)).replayed.conversions, 1);
  assert.equal((await db.query('SELECT status FROM conversions WHERE click_id = $1', [clickId])).rows[0].status, 'sale');
});
