import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTz, dayRange, localBucket } from '../src/report-tz.js';
import { startTestServer } from './test-server.mjs';

test('parseTz: default and UTC mean UTC days, bad zones are 400', () => {
  for (const raw of [undefined, null, '', 'UTC', 'utc', 'Etc/UTC']) assert.equal(parseTz(raw), null);
  assert.equal(parseTz('Europe/Paris'), 'Europe/Paris');
  for (const raw of ['Mars/Base', 'x; DROP TABLE', 'a'.repeat(80), '../etc']) assert.throws(() => parseTz(raw), { message: 'invalid_tz', statusCode: 400 });
});

test('dayRange: UTC by default, local midnights with tz (DST-safe)', () => {
  assert.deepEqual(dayRange('2026-11-05', '2026-11-05'), { fromMs: Date.UTC(2026, 10, 5), toMs: Date.UTC(2026, 10, 6),
    fromIso: '2026-11-05T00:00:00.000Z', toIso: '2026-11-06T00:00:00.000Z' });
  assert.deepEqual(dayRange('2026-11-05', '2026-11-05', 'Europe/Paris').fromIso, '2026-11-04T23:00:00.000Z');
  assert.equal(dayRange('2026-11-05', '2026-11-05', 'Europe/Paris').toIso, '2026-11-05T23:00:00.000Z');
  // 2026-10-25 is 25 hours long in Paris (clocks go back).
  const long = dayRange('2026-10-25', '2026-10-25', 'Europe/Paris');
  assert.equal((long.toMs - long.fromMs) / 3600000, 25);
  assert.deepEqual(dayRange(null, null, 'Europe/Paris'), { fromMs: null, toMs: null, fromIso: null, toIso: null });
});

test('dayRange: malformed dates are 400, not a crash', () => {
  assert.throws(() => dayRange('not-a-date', null), { message: 'invalid_from_date', statusCode: 400 });
  assert.throws(() => dayRange(null, '2026-13-45', 'Europe/Paris'), { message: 'invalid_to_date', statusCode: 400 });
});

test('localBucket', () => {
  assert.equal(localBucket('2026-11-05T23:30:00Z', 'Europe/Paris'), '2026-11-06');
  assert.equal(localBucket('2026-11-05T23:30:00Z', 'Europe/Paris', true), '2026-11-06T00');
  assert.equal(localBucket('2026-11-05T23:30:00Z', 'America/Los_Angeles', true), '2026-11-05T15');
});

test('/stats, /stats/timeseries, /stats/compare, /stats/params, /stats/bots take tz; without it UTC days as before', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-tz-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const click = (n, at) => JSON.stringify({ type: 'click', at, clickId: `00000000-0000-4000-8000-00000000000${n}`, campaign: 'tzc', offerId: 'o', ip: '10.0.0.1', params: { sub_id_1: 'a' } });
  await writeFile(join(dir, 'events.jsonl'), `${[
    click(1, '2026-11-05T22:30:00.000Z'), click(2, '2026-11-05T23:30:00.000Z'), click(3, '2026-11-06T00:30:00.000Z'),
    JSON.stringify({ type: 'bot', at: '2026-11-05T23:45:00.000Z', campaign: 'tzc', ip: '10.0.0.9' })].join('\n')}\n`);
  const server = await startTestServer(dir, { ADMIN_TOKEN: 'tz-token' });
  t.after(() => server.stop());
  const get = async (path) => { const r = await fetch(server.url + path, { headers: { authorization: 'Bearer tz-token' } }); return { status: r.status, body: await r.json() }; };

  const utc = await get('/stats?campaign=tzc&from=2026-11-06&to=2026-11-06');
  assert.equal(utc.body.clicks, 1, 'default = UTC day');
  assert.equal((await get('/stats?campaign=tzc&from=2026-11-06&to=2026-11-06&tz=UTC')).body.clicks, 1);
  assert.equal((await get('/stats?campaign=tzc&from=2026-11-06&to=2026-11-06&tz=Europe/Paris')).body.clicks, 2, 'Paris day starts at 23:00Z');
  assert.equal((await get('/stats?campaign=tzc&from=2026-11-05&to=2026-11-05&tz=Europe/Paris')).body.clicks, 1);
  assert.deepEqual([(await get('/stats?tz=Nope/Zone')).status, (await get('/stats?tz=Nope/Zone')).body.error], [400, 'invalid_tz']);

  const series = (await get('/stats/timeseries?campaign=tzc&tz=Europe/Paris')).body.series.map((r) => [r.date, r.clicks]);
  assert.deepEqual(series, [['2026-11-05', 1], ['2026-11-06', 2]]);
  const seriesUtc = (await get('/stats/timeseries?campaign=tzc')).body.series.map((r) => [r.date, r.clicks]);
  assert.deepEqual(seriesUtc, [['2026-11-05', 2], ['2026-11-06', 1]]);
  const hours = (await get('/stats/timeseries?campaign=tzc&granularity=hour&tz=Europe/Paris')).body.series.map((r) => r.date);
  assert.deepEqual(hours, ['2026-11-05T23', '2026-11-06T00', '2026-11-06T01']);

  const compare = (await get('/stats/compare?campaign=tzc&from=2026-11-06&to=2026-11-06&tz=Europe/Paris')).body;
  assert.deepEqual([compare.current.clicks, compare.previous.clicks], [2, 1]);
  const params = (await get('/stats/params?field=sub_id_1&campaign=tzc&from=2026-11-06&to=2026-11-06&tz=Europe/Paris')).body.rows;
  assert.equal(params[0].clicks, 2);
  assert.equal((await get('/stats/bots?campaign=tzc&from=2026-11-06&to=2026-11-06&tz=Europe/Paris')).body.total, 1);
  assert.equal((await get('/stats/bots?campaign=tzc&from=2026-11-06&to=2026-11-06')).body.total, 0);
});
