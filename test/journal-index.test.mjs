import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournalIndex, createClickCounters, createScanQueue, createOldClickLookup } from '../src/journal-index.js';
import { readJournal } from '../src/journal.js';

const today = new Date().toISOString().slice(0, 10);
const click = (n, extra = {}) => ({ type: 'click', at: `${today}T10:00:${String(n % 60).padStart(2, '0')}Z`, clickId: `c${n}`, campaign: 'camp', offerId: n % 2 ? 'odd' : 'even', ip: `10.0.0.${n}`, ...extra });

test('journal index: counts, last click per IP, conversions and source postbacks from a streamed journal', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl');
  const lines = [click(1), click(2, { params: { sub_id_1: 'a' } }), 'not json', click(3),
    { type: 'conversion', at: `${today}T11:00:00Z`, clickId: 'c1', status: 'lead', revenue: 5 },
    { type: 'conversion', at: `${today}T12:00:00Z`, clickId: 'c1', status: 'sale', revenue: 7, currency: 'USD' },
    { type: 'conversion', at: `${today}T12:00:00Z`, clickId: 'c2', params: { sub_id_1: 'b' } },
    { type: 'cost_update', clickIds: ['c3'], cost: 0.5 },
    { type: 'source_postback', clickId: 'c1', status: 'sale' }];
  await writeFile(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const index = createJournalIndex({ clickLimit: 2 });
  await index.build(file);
  assert.equal(index.count(`c|camp|${today}`), 3);
  assert.equal(index.count(`o|odd|${today}`), 2);
  assert.equal(index.count('t|camp'), 3);
  assert.equal(index.lastClickAt('camp', '10.0.0.2'), Date.parse(`${today}T10:00:02Z`));
  assert.deepEqual(index.conversion('c1'), { status: 'sale', revenue: 7, currency: 'USD' }, 'latest status wins');
  assert.equal(index.conversion('c1', 'upsell'), null);
  assert.equal(index.hasSourcePostback('c1', 'sale'), true);
  assert.equal(index.hasSourcePostback('c1', 'lead'), false);
  // c1 left the LRU (limit 2) before its conversions were read: the second pass still finds its offer.
  assert.equal(index.conversionCapCount('odd', Date.parse(`${today}T00:00:00Z`)), 1);
  assert.equal(index.conversionCapCount('odd', Date.parse(`${today}T11:30:00Z`)), 0, 'counted by the first postback');
  assert.equal(index.complete, false);
  assert.equal(index.click('c1'), undefined);
  assert.deepEqual(index.click('c2').params, { sub_id_1: 'b' }, 'postback sub_id_N update the click');
  assert.equal(index.click('c3').cost, 0.5, 'cost updates apply');
  index.observe(click(4));
  assert.equal(index.count('t|camp'), 4);
  assert.equal(index.click('c4').offerId, 'even');
  // The streamed reader keeps only the asked types and skips unreadable lines.
  assert.deepEqual((await readJournal(file, ['source_postback'])).map((r) => r.clickId), ['c1']);
  assert.equal((await readJournal(file)).length, lines.length - 1);
  assert.deepEqual(await readJournal(join(dir, 'missing.jsonl')), []);
});

test('click counters: seeded once, reservations are synchronous, a refresh keeps unsettled clicks', async () => {
  let stored = 5, seeds = 0, clock = 0;
  let releaseSeed;
  const counters = createClickCounters({ ttlMs: 1000, now: () => clock, seed: async () => { seeds += 1; await new Promise((r) => { releaseSeed = r; }); return stored; } });
  const first = counters.ensure(['k']); const second = counters.ensure(['k']);
  releaseSeed(); await Promise.all([first, second]);
  assert.equal(seeds, 1, 'concurrent first uses share one seed');
  assert.equal(counters.get('k'), 5);
  const a = counters.reserve(['k', 'unknown']); const b = counters.reserve(['k']);
  assert.equal(counters.get('k'), 7);
  assert.equal(counters.get('unknown'), 0, 'keys without a counter are not created by reserve');
  b.release();
  assert.equal(counters.get('k'), 6);
  // a is not in storage yet when the refresh reads it, and a third click arrives during the refresh.
  clock = 2000; stored = 5;
  await counters.ensure(['k']); // expired: refresh starts in the background, the old value is used meanwhile
  const c = counters.reserve(['k']);
  assert.equal(counters.get('k'), 7);
  stored = 6; releaseSeed(); await new Promise((r) => setImmediate(r));
  assert.equal(counters.get('k'), 6 + 1 + 1, 'storage 6 (a is half-way in) + unsettled a + c reserved during the refresh — never below the truth');
  a.settle(); c.settle();
});

test('scan queue runs one scan at a time, in order', async () => {
  const queue = createScanQueue(); const log = [];
  const job = (name, ms) => queue.run(async () => { log.push(`start ${name}`); await new Promise((r) => setTimeout(r, ms)); log.push(`end ${name}`); return name; });
  const failing = queue.run(async () => { throw new Error('boom'); });
  assert.deepEqual(await Promise.all([job('a', 20), job('b', 1), failing.catch((e) => e.message)]), ['a', 'b', 'boom']);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b']);
});

test('old click lookup: requests that arrive together share one pass over the journal', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-oldclick-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl');
  await writeFile(file, [click(1), click(2), { type: 'conversion', clickId: 'c1' }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  let runs = 0;
  const queue = createScanQueue();
  const counted = { run: (task) => queue.run(() => { runs += 1; return task(); }) };
  const lookup = createOldClickLookup(file, counted);
  const [a, b, none] = await Promise.all([lookup('c1'), lookup('c2'), lookup('nope')]);
  assert.equal(a.campaign, 'camp'); assert.equal(b.clickId, 'c2'); assert.equal(none, null);
  assert.equal(runs, 1);
  assert.equal((await lookup('c2')).clickId, 'c2');
  assert.equal(runs, 2);
});
