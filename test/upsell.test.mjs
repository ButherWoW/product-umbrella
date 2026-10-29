// G6: postback tid (upsells) and sub_id_1..30 updating the click, over HTTP. Shared by the PostgreSQL test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

export async function checkUpsells(server, call, run = 'u') {
  const offer = `ups-off-${run}`, campaign = `ups-cmp-${run}`;
  assert.equal((await call('/api/offers', { id: offer, url: 'https://upsell.example.com/' })).status, 201);
  assert.equal((await call('/api/campaigns', { id: campaign, name: 'Upsell', streams: [{ name: 'm', offers: [{ offerId: offer }] }] })).status, 201);
  const hit = await fetch(`${server.url}/r/${campaign}?sub_id_3=from-click`, { redirect: 'manual' });
  const clickId = new URL(hit.headers.get('location')).searchParams.get('click_id');
  const postback = (query) => fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${clickId}&${query}`);

  assert.equal((await postback('revenue=10')).status, 200, 'main conversion (no tid)');
  assert.equal((await postback('revenue=4&tid=order-2')).status, 200, 'upsell with another tid');
  assert.equal((await postback('revenue=6&tid=order-3&sub_id_3=from-network&sub_id_7=net7')).status, 200);
  assert.equal((await postback('revenue=4&tid=order-2')).status, 409, 'same tid again = duplicate');
  assert.equal((await postback('revenue=10')).status, 409, 'no tid twice = duplicate, as before');
  const update = await postback('tid=order-3&status=rejected');
  assert.equal(update.status, 200);
  assert.deepEqual(await update.json(), { ok: true, status: 'rejected', updated: true, tid: 'order-3' });

  let stats;
  for (let i = 0; i < 40; i++) { // the PostgreSQL mirror is asynchronous
    stats = await (await call(`/stats?campaign=${campaign}`)).json();
    if (stats.rejected === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual([stats.clicks, stats.conversions, stats.sales, stats.rejected, stats.revenue], [1, 2, 2, 1, 14], 'one click, 10 + 4 revenue, the rejected upsell is not counted');
  assert.equal(stats.byOffer[offer].clicks, 1);

  const params = await (await call(`/stats/params?field=sub_id_3&campaign=${campaign}`)).json();
  assert.deepEqual(params.rows.map((r) => [r.value, r.clicks, r.conversions]), [['from-network', 1, 2]], 'postback sub_id_3 replaced the click value');
  const log = await (await call(`/api/clicks?campaign=${campaign}`)).json();
  assert.deepEqual(log.clicks[0].params, { sub_id_3: 'from-network', sub_id_7: 'net7' });
  const conversions = await (await call(`/api/conversions?campaign=${campaign}`)).json();
  assert.ok(conversions.conversions.some((c) => c.tid === 'order-2'));
}

test('postback tid: upsells are separate conversions, sub_id_N update the click (JSONL)', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-upsell-'));
  const server = await startTestServer(dir, { ADMIN_TOKEN: 'upsell-token' });
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const call = (path, body) => fetch(server.url + path, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: 'Bearer upsell-token' }, body: body ? JSON.stringify(body) : undefined });
  await checkUpsells(server, call);
});
