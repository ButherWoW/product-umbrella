import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createEventMirror } from '../src/event-mirror.js';

const at = '2026-10-29T12:00:00.123Z';

// Structured view of a mirror statement: verb, table, column list and ON CONFLICT target — so a test fails on a
// wrong table or column order, not only when a substring disappears.
function parseSql(sql) {
  const text = sql.replace(/\s+/g, ' ').trim();
  const insert = text.match(/^INSERT INTO (\w+)(?: \(([^)]*)\))? VALUES \(([^)]*)\)(?: ON CONFLICT(?: \(([^)]*)\))? DO (NOTHING|UPDATE))?/);
  if (insert) {
    return { verb: 'INSERT', table: insert[1], columns: insert[2] ? insert[2].split(',').map((c) => c.trim()) : null,
      placeholders: insert[3].split(',').length, conflict: insert[5] ? { target: insert[4] ? insert[4].split(',').map((c) => c.trim()) : null, action: insert[5] } : null };
  }
  const update = text.match(/^UPDATE (\w+) SET (\w+)/);
  if (update) return { verb: 'UPDATE', table: update[1], set: update[2] };
  return { verb: text.split(' ')[0] };
}

test('mirror keeps click before conversion while independent clicks run concurrently', { timeout: 2000 }, async () => {
  const calls = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const mirror = createEventMirror({ query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('INTO clicks') && values[0] === 'first') await blocked;
  } });
  mirror.enqueue({ type: 'click', clickId: 'first', campaign: 'camp', offerId: 'offer', at });
  mirror.enqueue({ type: 'conversion', clickId: 'first', revenue: 0, currency: 'USD', at });
  await nextTurn();
  assert.equal(calls.length, 1);
  mirror.enqueue({ type: 'click', clickId: 'second', campaign: 'camp', offerId: 'offer', at });
  await nextTurn();
  assert.equal(calls.length, 2);
  let drained = false;
  const draining = mirror.drain().then(() => { drained = true; });
  await nextTurn();
  assert.equal(drained, false);
  release(); await draining;
  assert.equal(calls.length, 3);
  assert.deepEqual([parseSql(calls[0].sql).verb, parseSql(calls[0].sql).table], ['INSERT', 'clicks']);
  assert.deepEqual([parseSql(calls[1].sql).table, calls[1].values[0]], ['clicks', 'second'], 'independent click did not wait');
  const conversion = parseSql(calls[2].sql);
  assert.deepEqual([conversion.verb, conversion.table, conversion.columns], ['INSERT', 'conversions', ['click_id', 'tid', 'revenue', 'currency', 'status', 'params', 'created_at']]);
  assert.equal(conversion.placeholders, calls[2].values.length);
  assert.deepEqual(calls[2].values, ['first', '', 0, 'USD', 'sale', null, at], 'no status in the event = sale, no tid = main conversion');
  assert.equal(calls[0].values.at(-1), at, 'mirror preserves source event timestamp');
});

test('mirror reports database failures and still drains every queued task', async () => {
  const errors = [], calls = [];
  const mirror = createEventMirror({ query: async (sql) => { calls.push(sql); throw new Error('test outage'); },
    onError: (type, error) => errors.push([type, error.message]) });
  mirror.enqueue({ type: 'click', clickId: 'first', campaign: 'camp', offerId: 'offer', at });
  mirror.enqueue({ type: 'conversion', clickId: 'first', revenue: 1, currency: 'USD', at });
  await mirror.drain();
  assert.equal(calls.length, 2);
  assert.deepEqual(errors, [['click', 'test outage'], ['conversion', 'test outage']]);
});

test('unmirrored journal events do not query PostgreSQL and logging errors cannot reject drain', async () => {
  let queries = 0;
  const mirror = createEventMirror({ query: async () => { queries += 1; throw new Error('test outage'); },
    onError: () => { throw new Error('logger failed'); } });
  mirror.enqueue({ type: 'campaign_paused', campaign: 'camp', at });
  await mirror.drain();
  assert.equal(queries, 0);
  mirror.enqueue({ type: 'click', clickId: 'first', campaign: 'camp', offerId: 'offer', at });
  await assert.doesNotReject(mirror.drain());
  assert.equal(queries, 1);
});

test('mirror writes upsells per (click, tid) and applies postback sub_id_N to the click', async () => {
  const calls = [];
  const mirror = createEventMirror({ query: async (sql, values) => { calls.push({ sql, values }); } });
  mirror.enqueue({ type: 'conversion', clickId: 'first', tid: 'upsell-1', revenue: 5, currency: 'EUR', status: 'sale', params: { sub_id_3: 'net' }, at });
  await mirror.drain();
  assert.equal(calls.length, 2);
  const upsell = parseSql(calls[0].sql);
  assert.deepEqual([upsell.table, upsell.conflict], ['conversions', { target: ['click_id', 'tid'], action: 'UPDATE' }], 'one row per (click, tid)');
  assert.equal(upsell.placeholders, calls[0].values.length);
  assert.deepEqual(calls[0].values, ['first', 'upsell-1', 5, 'EUR', 'sale', '{"sub_id_3":"net"}', at], 'created_at stays the last parameter');
  assert.deepEqual(parseSql(calls[1].sql), { verb: 'UPDATE', table: 'clicks', set: 'params' });
  assert.deepEqual(calls[1].values, ['first', '{"sub_id_3":"net"}']);
});

test('mirror writes the bot isp with created_at as the last parameter', async () => {
  const calls = [];
  const mirror = createEventMirror({ query: async (sql, values) => { calls.push({ sql, values }); } });
  mirror.enqueue({ type: 'bot', campaign: 'camp', offerId: 'o', stream: 's', userAgent: 'Googlebot', ip: '1.2.3.4', reason: 'datacenter', isp: 'OVH SAS', at });
  await mirror.drain();
  const bot = parseSql(calls[0].sql);
  assert.deepEqual([bot.verb, bot.table, bot.columns], ['INSERT', 'bots', ['campaign', 'offer_id', 'stream', 'user_agent', 'ip', 'reason', 'isp', 'created_at']]);
  assert.equal(bot.placeholders, calls[0].values.length);
  assert.deepEqual(calls[0].values, ['camp', 'o', 's', 'Googlebot', '1.2.3.4', 'datacenter', 'OVH SAS', at]);
});
