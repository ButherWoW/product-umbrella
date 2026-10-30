// dedupeWindow without PostgreSQL when the in-memory visitor index is smaller than the traffic (issue #74):
// a visitor pushed out of the index is still found in the journal, so a repeat click inside the window is not counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { createJournalIndex } from '../src/journal-index.js';

const TOKEN = 'dedupe-eviction-token';

test('journal index: visitorsCompleteSince says when a lastClickAt miss can be trusted', () => {
  const index = createJournalIndex({ visitorLimit: 1 });
  assert.equal(index.visitorsCompleteSince(0), true, 'nothing pushed out yet');
  index.markClick('camp', '10.0.0.1', 1000);
  index.markClick('camp', '10.0.0.2', 2000);
  assert.equal(index.lastClickAt('camp', '10.0.0.1'), null, 'the first visitor left the index');
  assert.equal(index.visitorsCompleteSince(1000), false, 'a miss inside a window that reaches back to it is not final');
  assert.equal(index.visitorsCompleteSince(1001), true, 'windows starting after it are complete');
});

test('JSONL: a repeat click inside dedupeWindow is not counted after its visitor left the index', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-dedupe-'));
  const server = await startTestServer(dir, { ADMIN_TOKEN: TOKEN, TRUST_PROXY: '1', CLICK_INDEX_LIMIT: '1' });
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const api = (path, body) => fetch(server.url + path, { method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await api('/api/offers', { id: 'dd-offer', url: 'https://example.com/dd' })).status, 201);
  assert.equal((await api('/api/campaigns', { id: 'dd', name: 'dd', dedupeWindow: 30, streams: [{ name: 'main', offers: [{ offerId: 'dd-offer' }] }] })).status, 201);
  const click = async (ip) => {
    const r = await fetch(`${server.url}/r/dd`, { redirect: 'manual', headers: { 'x-forwarded-for': ip } });
    return new URL(r.headers.get('location')).searchParams.has('click_id');
  };
  assert.equal(await click('192.0.2.10'), true);
  assert.equal(await click('192.0.2.11'), true, 'another visitor counts (and pushes the first one out of the index)');
  assert.equal(await click('192.0.2.10'), false, 'the first visitor is still a duplicate');
  assert.equal(await click('192.0.2.10'), false, 'and stays one');
  const stats = await (await fetch(`${server.url}/stats?campaign=dd`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(stats.clicks, 2);
});
