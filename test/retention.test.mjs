// «Очистка статистики» (POST /api/campaigns/:id/clear-stats) and RETENTION_DAYS on the JSONL journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { createJournalGate } from '../src/retention.js';

const line = (type, at, payload) => JSON.stringify({ id: randomUUID(), type, at, ...payload });
const readJournal = async (dir) => (await readFile(join(dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return { unparsable: l }; } });

async function boot(t, journal, environment = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-retention-'));
  if (journal) await writeFile(join(dataDir, 'events.jsonl'), journal.join('\n') + '\n');
  const server = await startTestServer(dataDir, environment);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, { method = 'GET', body, cookie } = {}) => {
    const headers = { 'x-requested-with': 'umbrella' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(server.url + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, cookie: ((res.headers.get('set-cookie') || '').match(/umb_session=([^;]*)/) || [])[0] || null };
  };
  return { server, call, dataDir };
}

test('clear-stats removes only one campaign\'s events, respects `before`, keeps tracking alive', { timeout: 30000 }, async (t) => {
  const ids = { a1: randomUUID(), a2: randomUUID(), b1: randomUUID() };
  const old = '2026-01-10T10:00:00.000Z';
  const { server, call, dataDir } = await boot(t, [
    line('click', old, { clickId: ids.a1, campaign: 'camp-a', offerId: 'offer-1' }),
    line('lp_click', '2026-01-10T10:00:05.000Z', { clickId: ids.a1, campaign: 'camp-a' }),
    line('conversion', '2026-01-11T10:00:00.000Z', { clickId: ids.a1, revenue: 10, currency: 'EUR' }),
    line('click', old, { clickId: ids.a2, campaign: 'camp-a', offerId: 'offer-1' }),
    line('bot', old, { campaign: 'camp-a', offerId: 'offer-1', reason: 'ua' }),
    line('click', old, { clickId: ids.b1, campaign: 'camp-b', offerId: 'offer-1' }),
    line('bot', old, { campaign: 'camp-b', offerId: 'offer-1', reason: 'ua' }),
    // Postback journal and cost updates go with the campaign, as in PostgreSQL (clearCampaignRows).
    line('postback_in', '2026-01-11T10:00:00.000Z', { clickId: ids.a1, campaign: 'camp-a', statusCode: 200 }),
    line('postback_out', '2026-01-11T10:00:01.000Z', { clickId: ids.a1, campaign: 'camp-a', statusCode: 200, attempt: 1 }),
    line('postback_in', '2026-07-01T10:00:00.000Z', { clickId: ids.a1, campaign: 'camp-a', statusCode: 409 }),
    line('cost_update', '2026-01-12T10:00:00.000Z', { campaign: 'camp-a', clickIds: [ids.a1, ids.a2], cost: 0.1 }),
    line('cost_update', '2026-01-12T10:00:00.000Z', { campaign: 'camp-b', clickIds: [ids.b1], cost: 0.1 }),
  ]);
  const owner = (await call('/api/auth/setup', { method: 'POST', body: { email: 'o@example.com', password: 'owner-password' } })).cookie;
  for (const id of ['camp-a', 'camp-b']) assert.equal((await call('/api/campaigns', { method: 'POST', cookie: owner, body: { id, name: id, streams: [{ name: 'Main', offers: [{ offerId: 'offer-1' }] }] } })).status, 201);
  assert.equal((await call('/api/users', { method: 'POST', cookie: owner, body: { email: 'b@example.com', password: 'buyer-password' } })).status, 201);
  const buyer = (await call('/api/auth/login', { method: 'POST', body: { email: 'b@example.com', password: 'buyer-password' } })).cookie;

  const hit = async (campaign) => {
    const res = await fetch(`${server.url}/r/${campaign}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    return new URL(res.headers.get('location')).searchParams.get('click_id');
  };
  const fresh = await hit('camp-a');
  await hit('camp-a');
  await hit('camp-b');
  assert.equal((await fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${fresh}&revenue=5`)).status, 200);
  const stats = async (campaign) => { const r = await call(`/stats?campaign=${campaign}`, { cookie: owner }); if (r.status !== 200) throw new Error(JSON.stringify(r)); return r.json; };
  assert.deepEqual([(await stats('camp-a')).clicks, (await stats('camp-a')).conversions], [4, 2], 'retention is off by default: old events are still there');

  const clear = (body, cookie = owner) => call('/api/campaigns/camp-a/clear-stats', { method: 'POST', cookie, body });
  assert.equal((await clear({ confirm: 'camp-a' }, null)).status, 401, 'anonymous');
  assert.equal((await clear({ confirm: 'camp-a' }, buyer)).status, 403, 'buyer');
  assert.equal((await clear({ confirm: 'camp-b' })).json.error, 'confirm_mismatch');
  assert.equal((await clear({})).status, 400, 'confirm is required');
  assert.equal((await clear({ confirm: 'camp-a', before: '2026-13-45' })).status, 400);
  assert.equal((await call('/api/campaigns/nope-camp/clear-stats', { method: 'POST', cookie: owner, body: { confirm: 'nope-camp' } })).status, 404);

  const partial = await clear({ confirm: 'camp-a', before: '2026-06-01' });
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.json.removed, { clicks: 2, conversions: 1, lpClicks: 1, bots: 1, postbacks: 2, postgres: null });
  assert.deepEqual([(await stats('camp-a')).clicks, (await stats('camp-a')).conversions], [2, 1], 'clicks after `before` stay');
  let journal = await readJournal(dataDir);
  assert.ok(!journal.some((e) => !e.type.startsWith('postback_') && (e.clickId === ids.a1 || e.clickId === ids.a2)), 'old camp-a events are gone');
  assert.ok(journal.some((e) => e.clickId === ids.b1), 'other campaign intact');
  assert.deepEqual(journal.filter((e) => e.type === 'cost_update').map((e) => e.campaign), ['camp-b'], 'cost update of removed clicks is gone');
  assert.deepEqual(journal.filter((e) => e.type === 'postback_in' && e.clickId === ids.a1).map((e) => e.at), ['2026-07-01T10:00:00.000Z'], 'postbacks after `before` stay (PostgreSQL: by postback time)');

  // Clicks keep coming while the whole campaign is cleared.
  const during = Array.from({ length: 30 }, () => hit('camp-b'));
  const all = await clear({ confirm: 'camp-a' });
  await Promise.all(during);
  assert.equal(all.status, 200);
  assert.deepEqual([all.json.removed.clicks, all.json.removed.conversions, all.json.removed.postbacks], [2, 1, 2]);
  const a = await stats('camp-a');
  assert.deepEqual([a.clicks, a.conversions, a.revenue], [0, 0, 0], 'stats show 0 afterwards');
  assert.equal((await stats('camp-b')).clicks, 32, 'old + live + concurrent camp-b clicks all recorded');
  await hit('camp-a');
  assert.equal((await stats('camp-a')).clicks, 1, 'the campaign keeps tracking after a clear');
  journal = await readJournal(dataDir);
  assert.equal(journal.filter((e) => e.type === 'bot' && e.campaign === 'camp-b').length, 1, 'other campaign bots intact');
  assert.equal(journal.filter((e) => e.type.startsWith('postback_') && e.campaign === 'camp-a').length, 0, 'the campaign postback journal is gone');
  assert.equal(new Set(journal.filter((e) => e.type === 'click').map((e) => e.clickId)).size, journal.filter((e) => e.type === 'click').length, 'no duplicated lines');

  const audit = (await call('/api/audit?entity=campaign&id=camp-a', { cookie: owner })).json.entries.filter((e) => e.action === 'clear_stats');
  assert.equal(audit.length, 2);
  assert.deepEqual(audit[0].changes.clicks, [null, 2]);
  assert.deepEqual(audit[1].changes.before, [null, '2026-06-01']);
});

test('RETENTION_DAYS removes old unconverted clicks and bots, keeps converted clicks forever', { timeout: 30000 }, async (t) => {
  const ids = { paid: randomUUID(), unpaid: randomUUID(), recent: randomUUID() };
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const recent = new Date(Date.now() - 5 * 86400000).toISOString();
  const { dataDir } = await boot(t, [
    line('click', old, { clickId: ids.paid, campaign: 'ret', offerId: 'offer-1' }),
    line('conversion', recent, { clickId: ids.paid, revenue: 7 }),
    line('click', old, { clickId: ids.unpaid, campaign: 'ret', offerId: 'offer-1' }),
    line('lp_click', old, { clickId: ids.unpaid, campaign: 'ret' }),
    line('bot', old, { campaign: 'ret', reason: 'ua' }),
    line('bot', recent, { campaign: 'ret', reason: 'ua' }),
    line('click', recent, { clickId: ids.recent, campaign: 'ret', offerId: 'offer-1' }),
  ], { RETENTION_DAYS: '30', RETENTION_DELAY_MS: '0' });
  let journal = [];
  for (let i = 0; i < 100 && !journal.some((e) => e.action === 'retention'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    journal = await readJournal(dataDir);
  }
  const done = journal.find((e) => e.action === 'retention');
  assert.ok(done, 'retention ran and wrote an audit entry');
  assert.deepEqual([done.changes.clicks, done.changes.lpClicks, done.changes.bots], [[null, 1], [null, 1], [null, 1]]);
  assert.ok(journal.some((e) => e.type === 'click' && e.clickId === ids.paid), 'converted click kept');
  assert.ok(journal.some((e) => e.type === 'conversion' && e.clickId === ids.paid), 'conversion kept');
  assert.ok(!journal.some((e) => e.clickId === ids.unpaid), 'old unconverted click and its lp click removed');
  assert.ok(journal.some((e) => e.clickId === ids.recent), 'recent click kept');
  assert.equal(journal.filter((e) => e.type === 'bot').length, 1, 'only the recent bot event is left');
});

test('journal gate: a rewrite waits for in-flight appends and holds new ones until it finishes', async () => {
  const gate = createJournalGate();
  const order = [];
  let finishAppend;
  const first = gate.shared(() => new Promise((resolve) => { finishAppend = () => { order.push('append-1'); resolve(); }; }));
  const rewrite = gate.rewrite(async () => { order.push('rewrite'); await new Promise((r) => setTimeout(r, 20)); order.push('rewrite-done'); });
  const second = gate.shared(async () => { order.push('append-2'); });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, [], 'rewrite has not started while an append is in flight');
  finishAppend();
  await Promise.all([first, rewrite, second]);
  assert.deepEqual(order, ['append-1', 'rewrite', 'rewrite-done', 'append-2']);
});
