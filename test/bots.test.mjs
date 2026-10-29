import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

const BOT_UA = 'Googlebot/2.1 (+http://www.google.com/bot.html)';
const HUMAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

test('bot filter: bots recorded separately, clicks unaffected', { timeout: 15000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-bots-'));
  const server = await startTestServer(dataDir);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });

  const post = (path, body) => fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const hit = (path, ua) => fetch(server.url + path, { redirect: 'manual', headers: { 'user-agent': ua } });

  const created = await post('/api/campaigns', {
    id: 'bottest', name: 'Bot Test', botFilter: true,
    streams: [{ name: 'main', action: 'url', url: 'https://example.com/?click_id={click_id}' }],
  });
  assert.equal(created.status, 201);

  // 2 bot requests, 1 human request
  const r1 = await hit('/r/bottest', BOT_UA);
  assert.equal(r1.status, 302, 'bot should still be redirected');
  const r2 = await hit('/r/bottest', BOT_UA);
  assert.equal(r2.status, 302);
  const r3 = await hit('/r/bottest', HUMAN_UA);
  assert.equal(r3.status, 302, 'human click should be recorded');

  const bots = await (await fetch(server.url + '/stats/bots?campaign=bottest')).json();
  assert.equal(bots.total, 2, 'two bot events expected');
  assert.equal(bots.byCampaign['bottest'], 2);

  const stats = await (await fetch(server.url + '/stats?campaign=bottest')).json();
  assert.equal(stats.clicks, 1, 'only the human click is counted');
});
