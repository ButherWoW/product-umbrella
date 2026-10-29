// /lp/click with PostgreSQL: an unknown click id is answered from the database alone, the JSONL journal is not
// scanned (it would let anyone load the server with random ids). Runs only with TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const TOKEN = 'pg-security-token';

test('PostgreSQL: /lp/click does not fall back to the JSONL journal for a click missing in the database', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgsec-'));
  const server = await startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN });
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const call = (path, body) => fetch(server.url + path, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const run = Date.now().toString(36);
  const offer = `sec-off-${run}`, campaign = `sec-cmp-${run}`;
  assert.equal((await call('/api/offers', { id: offer, url: 'https://offer.example.com/' })).status, 201);
  assert.equal((await call('/api/campaigns', { id: campaign, name: 'Sec', streams: [{ name: 'm', offers: [{ offerId: offer }] }] })).status, 201);

  // A fresh click works at once: a missing row first waits for the mirror's queued inserts.
  const hit = await fetch(`${server.url}/r/${campaign}`, { redirect: 'manual' });
  const clickId = new URL(hit.headers.get('location')).searchParams.get('click_id');
  const lp = await fetch(`${server.url}/lp/click?click_id=${clickId}`, { redirect: 'manual' });
  assert.equal(lp.status, 302);
  assert.equal(new URL(lp.headers.get('location')).hostname, 'offer.example.com');

  // A click that exists only in the journal (never reached PostgreSQL): the old code found it by scanning
  // events.jsonl and redirected; now the database answer is final.
  const journalOnly = randomUUID();
  await appendFile(join(dir, 'events.jsonl'), `${JSON.stringify({ id: randomUUID(), type: 'click', at: new Date().toISOString(), clickId: journalOnly, campaign, offerId: offer })}\n`);
  const unknown = await fetch(`${server.url}/lp/click?click_id=${journalOnly}`, { redirect: 'manual' });
  assert.equal(unknown.status, 404, 'no JSONL scan for a click missing in PostgreSQL');
  assert.equal((await unknown.json()).error, 'click_not_found');
});
