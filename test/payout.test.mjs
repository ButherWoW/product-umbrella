import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

const dir = await mkdtemp(join(tmpdir(), 'umbrella-payout-'));
const server = await startTestServer(dir, { POSTBACK_SECRET: 'payout-secret' });
const call = (path, body) => fetch(server.url + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer admin-ui-token' }, body: body ? JSON.stringify(body) : undefined });
try {
  assert.equal((await call('/api/offers', { id: 'payout-offer', url: 'https://example.test/o', payoutType: 'cpa', payout: 7.5, payoutCurrency: 'EUR' })).status, 201);
  assert.equal((await call('/api/campaigns', { id: 'payout-campaign', name: 'Payout', streams: [{ offers: [{ offerId: 'payout-offer', weight: 1 }] }] })).status, 201);
  const hit = await fetch(server.url + '/r/payout-campaign', { redirect: 'manual' });
  const clickId = new URL(hit.headers.get('location')).searchParams.get('click_id');
  const post = await fetch(`${server.url}/postback?secret=payout-secret&click_id=${clickId}&currency=EUR`);
  assert.equal(post.status, 200);
  const stats = await (await call('/stats')).json();
  assert.equal(stats.revenue, 7.5);
} finally { await server.stop(); }
