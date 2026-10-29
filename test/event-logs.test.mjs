import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLogQuery, readEventLog } from '../src/event-logs.js';

const firstId = '00000000-0000-0000-0000-000000000001';
const secondId = '00000000-0000-0000-0000-000000000002';
const thirdId = '00000000-0000-0000-0000-000000000003';
const clicks = [
  { type: 'click', clickId: firstId, campaign: 'alpha', offerId: 'offer-a', stream: 'ios', at: '2026-10-28T23:59:59.999Z', ip: '127.0.0.1' },
  { type: 'click', clickId: secondId, campaign: 'alpha', offerId: 'offer-a', stream: 'ios', at: '2026-10-29T23:59:59.999Z', userAgent: 'Browser <literal>', secret: 'must-not-leak' },
  { type: 'click', clickId: thirdId, campaign: 'beta', offerId: 'offer-b', at: '2026-10-29T23:59:59.999Z' },
];
const conversions = [
  { type: 'conversion', clickId: firstId, revenue: 4, currency: 'USD', at: '2026-10-30T00:00:00.000Z' },
  { type: 'conversion', clickId: secondId, revenue: '5.25', currency: 'EUR', at: '2026-10-30T01:00:00.000Z' },
];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'umbrella-log-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventsFile = join(directory, 'events.jsonl');
  await writeFile(eventsFile, [...clicks, ...conversions].map((item) => JSON.stringify(item)).join('\n') + '\nnull\n{broken\n');
  return eventsFile;
}

test('log queries validate calendar dates, bounds and pagination before storage access', () => {
  for (const value of ['limit=NaN', 'limit=0', 'limit=-1', 'offset=1.5', 'offset=-1',
    'from=2026-02-30', 'to=not-a-date', 'from=2026-10-30&to=2026-10-29'])
    assert.throws(() => parseLogQuery(new URLSearchParams(value)), (error) => error.statusCode === 400);
  assert.equal(parseLogQuery(new URLSearchParams('limit=1000')).limit, 100);
  const range = parseLogQuery(new URLSearchParams('from=2026-10-29&to=2026-10-29'));
  assert.equal(range.until - range.from, 86400000);
});

test('click logs filter whole UTC days and use stable pagination when timestamps tie', async (t) => {
  const eventsFile = await fixture(t);
  const page = await readEventLog({ kind: 'clicks', params: new URLSearchParams('from=2026-10-29&to=2026-10-29&limit=1'), eventsFile });
  assert.equal(page.clicks[0].clickId, thirdId);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 1);
  const next = await readEventLog({ kind: 'clicks', params: new URLSearchParams('from=2026-10-29&to=2026-10-29&limit=1&offset=1'), eventsFile });
  assert.equal(next.clicks[0].clickId, secondId);
  assert.equal(next.hasMore, false);
  assert.equal(next.nextOffset, null);
  assert.equal(next.clicks[0].secret, undefined);
  assert.equal(next.clicks[0].userAgent, 'Browser <literal>');
  assert.equal(next.clicks[0].click_id, secondId);
});

test('conversion filters join originating click but use conversion date', async (t) => {
  const eventsFile = await fixture(t);
  const report = await readEventLog({ kind: 'conversions', params: new URLSearchParams('campaign=alpha&offer=offer-a&stream=ios&from=2026-10-30&to=2026-10-30'), eventsFile });
  assert.equal(report.conversions.length, 2);
  assert.equal(report.conversions[0].revenue, 5.25);
  assert.equal(report.conversions[0].campaign, 'alpha');
  const onClickDay = await readEventLog({ kind: 'conversions', params: new URLSearchParams('to=2026-10-29'), eventsFile });
  assert.equal(onClickDay.conversions.length, 0);
  const defaultStream = await readEventLog({ kind: 'clicks', params: new URLSearchParams('stream=default'), eventsFile });
  assert.equal(defaultStream.clicks.length, 1);
  assert.equal(defaultStream.clicks[0].clickId, thirdId);
});

test('missing JSONL returns an empty page; PostgreSQL failure explicitly falls back', async (t) => {
  const eventsFile = await fixture(t);
  const empty = await readEventLog({ kind: 'clicks', params: new URLSearchParams(), eventsFile: `${eventsFile}.missing` });
  assert.deepEqual(empty.clicks, []);
  assert.equal(empty.hasMore, false);
  let fallbackCalled = false;
  const result = await readEventLog({ kind: 'clicks', params: new URLSearchParams(), eventsFile,
    db: { query: async () => { throw new Error('test connection lost'); } }, onFallback: () => { fallbackCalled = true; } });
  assert.equal(result.storage, 'jsonl');
  assert.equal(result.clicks.length, 3);
  assert.equal(fallbackCalled, true);
});

test('PostgreSQL adapter parameterizes filters and normalizes the same API fields', async (t) => {
  const eventsFile = await fixture(t);
  const params = new URLSearchParams('campaign=alpha&offer=offer-a&stream=ios&from=2026-10-29&to=2026-10-29');
  const jsonl = await readEventLog({ kind: 'clicks', params, eventsFile });
  const db = { query: async (sql, values) => {
    assert.match(sql, /ORDER BY c.created_at DESC, c.click_id DESC/);
    assert.ok(!sql.includes('alpha'));
    assert.deepEqual(values, ['alpha', 'offer-a', 'ios', '2026-10-29T00:00:00.000Z', '2026-10-30T00:00:00.000Z', 51, 0]);
    return { rows: [{ click_id: secondId, campaign: 'alpha', offer_id: 'offer-a', stream: 'ios',
      created_at: new Date(clicks[1].at), user_agent: 'Browser <literal>' }] };
  } };
  const postgres = await readEventLog({ kind: 'clicks', params, eventsFile, db });
  assert.deepEqual(postgres.clicks, jsonl.clicks);
  assert.equal(postgres.storage, 'postgres');
});

test('PostgreSQL conversion log filters conversion time and normalizes numeric revenue', async (t) => {
  const eventsFile = await fixture(t);
  const params = new URLSearchParams('campaign=alpha&from=2026-10-30&to=2026-10-30');
  const jsonl = await readEventLog({ kind: 'conversions', params, eventsFile });
  const db = { query: async (sql, values) => {
    assert.match(sql, /cv.created_at >= \$2/);
    assert.match(sql, /cv.created_at < \$3/);
    assert.match(sql, /ORDER BY cv.created_at DESC, c.click_id DESC/);
    assert.deepEqual(values, ['alpha', '2026-10-30T00:00:00.000Z', '2026-10-31T00:00:00.000Z', 51, 0]);
    return { rows: [conversions[1], conversions[0]].map((item) => ({ click_id: item.clickId,
      campaign: 'alpha', offer_id: 'offer-a', stream: 'ios', revenue: String(item.revenue),
      currency: item.currency, created_at: new Date(item.at) })) };
  } };
  const postgres = await readEventLog({ kind: 'conversions', params, eventsFile, db });
  assert.deepEqual(postgres.conversions, jsonl.conversions);
});
