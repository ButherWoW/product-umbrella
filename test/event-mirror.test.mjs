import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createEventMirror } from '../src/event-mirror.js';

const at = '2026-10-29T12:00:00.123Z';

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
  assert.ok(calls[2].sql.includes('INTO conversions'));
  assert.deepEqual(calls[2].values, ['first', 0, 'USD', 'sale', at], 'no status in the event = sale');
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

test('mirror writes the bot isp with created_at as the last parameter', async () => {
  const calls = [];
  const mirror = createEventMirror({ query: async (sql, values) => { calls.push({ sql, values }); } });
  mirror.enqueue({ type: 'bot', campaign: 'camp', offerId: 'o', stream: 's', userAgent: 'Googlebot', ip: '1.2.3.4', reason: 'datacenter', isp: 'OVH SAS', at });
  await mirror.drain();
  assert.ok(calls[0].sql.includes('reason, isp, created_at'));
  assert.deepEqual(calls[0].values, ['camp', 'o', 's', 'Googlebot', '1.2.3.4', 'datacenter', 'OVH SAS', at]);
});
