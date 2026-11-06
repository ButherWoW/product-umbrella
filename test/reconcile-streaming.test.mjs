import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileEvents, reconcileJournal } from '../src/reconcile.js';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString();

// A database that has nothing: every statement is recorded with its JSON payload.
function fakeDb() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      if (/^\s*SELECT/i.test(sql)) return { rows: [], rowCount: 0 };
      const payload = typeof params[0] === 'string' && params[0].startsWith('[') ? JSON.parse(params[0]) : params;
      calls.push({ op: sql.trim().split(/\s+/).slice(0, 3).join(' '), payload });
      return { rows: [], rowCount: Array.isArray(payload) ? payload.length : 1 };
    },
  };
}
// Statement payloads regardless of how the work was split in windows.
const flat = (db) => db.calls.flatMap((c) => (Array.isArray(c.payload) ? c.payload.map((row) => `${c.op}|${JSON.stringify(row)}`) : [`${c.op}|${JSON.stringify(c.payload)}`])).sort();

function journal() {
  const events = [];
  for (let n = 1; n <= 30; n += 1) {
    events.push({ type: 'click', id: uuid(1000 + n), at: at(n), clickId: uuid(n), campaign: 'c', offerId: 'o', ip: '1.1.1.1', params: { sub_id_1: `s${n}` } });
    if (n % 3 === 0) events.push({ type: 'lp_click', at: at(n + 1), clickId: uuid(n) });
    if (n % 5 === 0) events.push({ type: 'conversion', id: uuid(2000 + n), at: at(n + 2), clickId: uuid(n), status: 'lead', revenue: 1 });
    if (n % 10 === 0) events.push({ type: 'conversion', id: uuid(3000 + n), at: at(n + 3), clickId: uuid(n), status: 'sale', revenue: 5, params: { sub_id_2: 'x' } });
    if (n % 7 === 0) events.push({ type: 'bot', id: uuid(4000 + n), at: at(n), campaign: 'c', ip: '2.2.2.2' });
    if (n % 4 === 0) events.push({ type: 'postback_in', id: uuid(5000 + n), at: at(n), campaign: 'c', clickId: uuid(n), status: 'sale' });
  }
  events.push({ type: 'postback_in', id: uuid(5999), at: at(40), campaign: 'c', clickId: uuid(999) }); // click is gone: not replayed
  events.push({ type: 'cost_update', at: at(41), clickIds: [uuid(1), uuid(2)], cost: 0.25, importKey: 'k1', campaign: 'c', importCost: 0.5 });
  return events;
}

test('reconcileJournal over a file in small windows replays exactly what the whole-array version replays', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-reconcile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl');
  const events = journal();
  await writeFile(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const whole = fakeDb();
  const wholeCounts = await reconcileEvents({ db: whole, events });
  const streamed = fakeDb();
  const { counts, total } = await reconcileJournal({ db: streamed, eventsFile: file, windowSize: 7 });
  assert.equal(total, events.length);
  // A click touched by events of two windows has its state written twice (a no-op in PostgreSQL, so the real count stays equal).
  assert.deepEqual({ ...counts, clickState: 0 }, { ...wholeCounts, clickState: 0 });
  assert.ok(streamed.calls.length > whole.calls.length, 'several windows were used');
  assert.deepEqual([...new Set(flat(streamed))], [...new Set(flat(whole))]);
  assert.ok(!flat(streamed).some((row) => row.includes(uuid(5999))), 'a postback of a missing click is not replayed');
});

test('reconcileJournal tail: only events after the offset, with the state of the whole journal; torn line is ignored', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-reconcile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl');
  const events = journal();
  await writeFile(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n{"type":"click","clickId":"torn`);
  const first = await reconcileJournal({ db: fakeDb(), eventsFile: file });
  assert.equal(first.total, events.length, 'a torn last line is not counted');
  // A late conversion for an old click: the click state (its params) comes from the old part of the journal.
  const late = { type: 'conversion', id: uuid(7000), at: at(50), clickId: uuid(3), status: 'sale', revenue: 9 };
  await writeFile(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  await appendFile(file, `${JSON.stringify(late)}\n`);
  const db = fakeDb();
  const second = await reconcileJournal({ db, eventsFile: file, from: first.total });
  assert.equal(second.total, events.length + 1);
  const rows = flat(db);
  assert.equal(rows.filter((r) => r.startsWith('INSERT INTO conversions')).length, 1);
  assert.equal(rows.filter((r) => r.startsWith('INSERT INTO clicks')).length, 0, 'old clicks are not touched again');
  const state = db.calls.find((c) => c.op.startsWith('UPDATE clicks'));
  assert.deepEqual(state.payload[0].params, { sub_id_1: 's3' });
  assert.equal(state.payload[0].lp, at(4), 'first landing click from the old part of the journal');
});

test('reconcileJournal: an offset beyond the journal (rewritten file) starts over; missing file is empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-reconcile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl');
  assert.deepEqual(await reconcileJournal({ db: fakeDb(), eventsFile: file, from: 5 }), { counts: { clicks: 0, conversions: 0, clickState: 0, bots: 0, postbacks: 0, costImports: 0 }, total: 0 });
  const events = journal();
  await writeFile(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const db = fakeDb();
  const result = await reconcileJournal({ db, eventsFile: file, from: events.length + 100 });
  assert.equal(result.total, events.length);
  assert.equal(result.counts.clicks, 30);
});
