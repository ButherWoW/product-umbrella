// Journal robustness (JSONL mode): a torn line never breaks reports, the next append starts on a new line,
// and the revenue cap counts sales recorded today (UTC) whatever day their click was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { parseJournal } from '../src/journal.js';
import { revenueJournal, createCapCampaigns, assertCaps } from './revenue-fixture.mjs';

const TOKEN = 'journal-test-token';
const day = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const line = (event) => `${JSON.stringify({ id: randomUUID(), ...event })}\n`;

test('parseJournal skips and counts unparsable and non-object lines', () => {
  const { events, bad } = parseJournal('{"type":"click"}\n{"type":"cli\n\n42\nnull\n{"type":"bot"}\n');
  assert.deepEqual(events.map((e) => e.type), ['click', 'bot']);
  assert.equal(bad, 3);
});

test('a torn journal line: every report answers 200 and the next event is not glued to it', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-torn-'));
  let server;
  t.after(async () => { await server?.stop(); await rm(dir, { recursive: true, force: true }); });
  const clickId = randomUUID();
  await writeFile(join(dir, 'events.jsonl'), line({ type: 'click', at: iso(Date.now() - 1000), clickId, campaign: 'demo', offerId: 'offer-1', referrer: 'https://ref.example/', path: '/r/demo', uniqueCampaign: true })
    + line({ type: 'bot', at: iso(Date.now() - 900), campaign: 'demo', reason: 'ua' })
    + '{"id":"x","type":"click","at":"2026-10');
  server = await startTestServer(dir, { ADMIN_TOKEN: TOKEN });
  const get = (path) => fetch(server.url + path, { headers: { authorization: `Bearer ${TOKEN}` } });
  const paths = ['/stats', '/stats?campaign=demo', '/stats/timeseries', '/stats/timeseries?granularity=hour', '/stats/bots', '/stats/referrers', '/stats/paths',
    '/stats/params?field=sub_id_1', '/api/clicks', '/api/conversions', '/api/bots'];
  for (const path of paths) assert.equal((await get(path)).status, 200, path);
  assert.equal((await (await get('/stats')).json()).clicks, 1);
  assert.equal((await (await fetch(server.url + '/health')).json()).journalBadLines, 1);

  const hit = await fetch(`${server.url}/r/demo/offer-1`, { redirect: 'manual' });
  assert.equal(hit.status, 302);
  const text = await readFile(join(dir, 'events.jsonl'), 'utf8');
  const { events, bad } = parseJournal(text);
  assert.equal(bad, 1, 'only the torn line is unreadable');
  assert.equal(events.filter((e) => e.type === 'click').length, 2, 'the new click is its own line');
  assert.equal((await (await get('/stats')).json()).clicks, 2);
  for (const path of paths) assert.equal((await get(path)).status, 200, path);
});

test('revenue cap (JSONL): sales recorded today count, whatever day their click was', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-revcap-'));
  let server;
  t.after(async () => { await server?.stop(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'events.jsonl'), revenueJournal());
  server = await startTestServer(dir, { ADMIN_TOKEN: TOKEN });
  await createCapCampaigns(server.url);
  await assertCaps(server.url);
});
