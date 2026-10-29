import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversionRecorder, conversionValues, hasRecordedConversion } from '../src/conversion-recorder.js';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SECOND = 'bbbbbbbb-0000-4000-8000-000000000002';
const NOW = Date.parse('2026-10-29T12:00:00Z');
const click = { campaign: 'test', offerId: 'offer', at: new Date(NOW).toISOString() };

test('20 concurrent same-click requests record and schedule delivery exactly once', async () => {
  const recorded = new Set(), deliveries = [];
  const recorder = createConversionRecorder({
    findClick: async () => { await nextTurn(); return click; },
    hasConversion: async (id) => { await nextTurn(); return recorded.has(id); },
    record: async (payload) => { await nextTurn(); recorded.add(payload.clickId); },
    onRecorded: async (payload) => deliveries.push(payload),
  });
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => recorder({
    clickId: i % 2 ? ID.toUpperCase() : ID, revenue: '2.5000', currency: 'usd' })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.statusCode === 409).length, 19);
  assert.equal(recorded.size, 1);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].revenue, 2.5);
  assert.equal(deliveries[0].currency, 'USD');
});

test('independent clicks can finish while another click waits for storage', { timeout: 2000 }, async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const recorded = new Set();
  const recorder = createConversionRecorder({ findClick: async () => click,
    hasConversion: async (id) => recorded.has(id), record: async ({ clickId }) => {
      if (clickId === ID) await wait;
      recorded.add(clickId);
    } });
  const first = recorder({ clickId: ID });
  try {
    assert.deepEqual(await recorder({ clickId: SECOND }), { ok: true });
    assert.equal(recorded.has(ID), false);
  } finally { release(); await first; }
});

test('failed storage releases lock, remains retryable and sends no delivery', async () => {
  let fail = true, delivered = 0, recorded = false;
  const recorder = createConversionRecorder({ findClick: async () => click,
    hasConversion: async () => recorded, record: async () => {
      if (fail) throw new Error('disk failure');
      recorded = true;
    }, onRecorded: () => { delivered += 1; } });
  await assert.rejects(recorder({ clickId: ID }), /disk failure/);
  assert.equal(delivered, 0);
  fail = false;
  assert.deepEqual(await recorder({ clickId: ID }), { ok: true });
  assert.equal(delivered, 1);
});

test('delivery scheduling failure never turns an already recorded conversion into an HTTP failure', async () => {
  let recorded = false, errors = 0;
  const recorder = createConversionRecorder({ findClick: async () => click,
    hasConversion: async () => recorded, record: async () => { recorded = true; },
    onRecorded: () => { throw new Error('delivery failure'); }, onDeliveryError: () => { errors += 1; } });
  assert.deepEqual(await recorder({ clickId: ID }), { ok: true });
  assert.equal(errors, 1);
  await assert.rejects(recorder({ clickId: ID }), (error) => error.statusCode === 409);
});

test('conversion window accepts boundary and rejects older or unparseable timestamps', async () => {
  let at = new Date(NOW - 7 * 86400000).toISOString();
  let written = 0;
  const recorder = createConversionRecorder({ findClick: async () => ({ ...click, at }),
    hasConversion: async () => false, record: async () => { written += 1; },
    windowDaysForClick: () => 7, now: () => NOW });
  assert.deepEqual(await recorder({ clickId: ID }), { ok: true });
  at = new Date(NOW - 7 * 86400000 - 1).toISOString();
  await assert.rejects(recorder({ clickId: ID }), (error) => error.message === 'conversion_window_expired' && error.conversionWindowDays === 7);
  at = 'invalid date';
  await assert.rejects(recorder({ clickId: ID }), (error) => error.message === 'click_timestamp_invalid');
  assert.equal(written, 1);
});

test('amounts fit NUMERIC(12,4), zero remains zero, and invalid amounts cannot become conversions', () => {
  assert.deepEqual(conversionValues('0', 'usd'), { revenue: 0, currency: 'USD' });
  assert.deepEqual(conversionValues('99999999.9999', null), { revenue: 99999999.9999, currency: null });
  assert.deepEqual(conversionValues(null, null), { revenue: null, currency: null });
  for (const value of ['NaN', 'Infinity', '-1', '1e3', '0x10', '100000000', '1.12345', ' '])
    assert.throws(() => conversionValues(value, 'USD'), (error) => error.statusCode === 400 && error.message === 'invalid_revenue');
  assert.throws(() => conversionValues('1', 'US'), (error) => error.statusCode === 400 && error.message === 'invalid_currency');
});

test('malformed and unknown click IDs never write events', async () => {
  let writes = 0;
  const recorder = createConversionRecorder({ findClick: async () => null, hasConversion: async () => false,
    record: async () => { writes += 1; } });
  await assert.rejects(recorder({ clickId: '' }), (error) => error.message === 'click_id_required');
  await assert.rejects(recorder({ clickId: 'invalid' }), (error) => error.message === 'invalid_click_id');
  await assert.rejects(recorder({ clickId: ID }), (error) => error.message === 'click_not_found');
  assert.equal(writes, 0);
});

test('an empty PostgreSQL mirror result cannot hide a conversion already in JSONL', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'umbrella-conversion-lag-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventsFile = join(directory, 'events.jsonl');
  await writeFile(eventsFile, JSON.stringify({ type: 'conversion', clickId: ID, revenue: 1 }) + '\n');
  const db = { query: async (sql, params) => {
    assert.equal(params[0], ID);
    return { rows: [] };
  } };
  assert.equal(await hasRecordedConversion({ clickId: ID, eventsFile, db }), true);
  assert.equal(await hasRecordedConversion({ clickId: SECOND, eventsFile }), false);
  assert.equal(await hasRecordedConversion({ clickId: ID, eventsFile: `${eventsFile}.missing`,
    db: { query: async () => ({ rows: [{}] }) } }), true);
});

test('tid: a new tid of the same click is another conversion, the same tid is a duplicate or a status update', async () => {
  const rows = new Map();
  const recorder = createConversionRecorder({ findClick: async () => click, hasConversion: async () => false,
    currentConversion: async (id, tid) => rows.get(`${id}|${tid}`) || null,
    record: async (payload) => { rows.set(`${payload.clickId}|${payload.tid || ''}`, { status: payload.status || 'sale', revenue: payload.revenue, currency: payload.currency }); return payload; } });
  assert.deepEqual(await recorder({ clickId: ID, revenue: '10' }), { ok: true });
  assert.deepEqual(await recorder({ clickId: ID, tid: 'up-1', revenue: '5' }), { ok: true, tid: 'up-1' });
  await assert.rejects(recorder({ clickId: ID, tid: 'up-1', revenue: '5' }), { statusCode: 409 });
  await assert.rejects(recorder({ clickId: ID, revenue: '10' }), { statusCode: 409 }, 'no tid = the main conversion, as before');
  assert.deepEqual(await recorder({ clickId: ID, tid: 'up-1', status: 'rejected' }), { ok: true, status: 'rejected', updated: true, tid: 'up-1' });
  assert.equal(rows.size, 2);
  assert.equal(rows.get(`${ID}|up-1`).revenue, 5, 'status update keeps the amount of that tid');
  assert.equal(rows.get(`${ID}|`).status, 'sale');
});
