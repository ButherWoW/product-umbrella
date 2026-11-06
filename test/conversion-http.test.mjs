import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

test('real concurrent HTTP postbacks remain unique after server restart', { timeout: 15000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-conversion-http-'));
  let server;
  t.after(async () => { await server?.stop(); await rm(dataDir, { recursive: true, force: true }); });
  server = await startTestServer(dataDir);
  const post = (clickId, revenue = '2.5', currency = 'USD') => fetch(`${server.url}/postback?${new URLSearchParams({
    click_id: clickId, secret: 'conversion-test-secret', revenue, currency })}`);
  const click = async () => {
    const result = await fetch(`${server.url}/r/demo/offer-1`, { redirect: 'manual' });
    assert.equal(result.status, 302);
    return new URL(result.headers.get('location')).searchParams.get('click_id');
  };
  const concurrentId = await click();
  const attempts = await Promise.all(Array.from({ length: 20 }, () => post(concurrentId)));
  const bodies = await Promise.all(attempts.map((response) => response.json()));
  assert.equal(attempts.every((response) => response.status === 200), true, 'a repeated postback is acknowledged, not 409');
  assert.equal(bodies.filter((body) => body.duplicate === true).length, 19);
  assert.equal(bodies.filter((body) => body.duplicate === undefined && body.ok === true).length, 1);
  const invalidId = await click();
  for (const revenue of ['NaN', 'Infinity', '-1', '1e3', '0x10', '100000000', '1.12345']) {
    const rejected = await post(invalidId, revenue);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, 'invalid_revenue');
  }
  const badCurrency = await post(invalidId, '1', 'US');
  assert.equal(badCurrency.status, 400);
  assert.equal((await badCurrency.json()).error, 'invalid_currency');
  assert.equal((await post('not-a-uuid')).status, 400);
  assert.equal((await post('00000000-0000-4000-8000-000000000099')).status, 404);
  assert.equal((await post(invalidId, '0', 'usd')).status, 200, 'invalid attempts must leave the click retryable');
  const journal = (await readFile(join(dataDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.filter((event) => event.type === 'conversion' && event.clickId === concurrentId).length, 1);
  assert.equal(journal.filter((event) => event.type === 'conversion' && event.clickId === invalidId)[0].revenue, 0);
  const before = await (await fetch(`${server.url}/stats?campaign=demo`)).json();
  assert.equal(before.clicks, 2);
  assert.equal(before.conversions, 2);
  assert.equal(before.revenue, 2.5);
  await server.stop();
  server = await startTestServer(dataDir);
  assert.deepEqual(await (await post(concurrentId)).json(), { ok: true, duplicate: true }, 'restart must not permit an already recorded conversion');
  assert.equal((await (await post(invalidId)).json()).duplicate, true);
  const after = await (await fetch(`${server.url}/stats?campaign=demo`)).json();
  assert.equal(after.conversions, 2);
  assert.equal(after.revenue, 2.5);
});
