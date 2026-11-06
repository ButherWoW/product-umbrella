// The port is bound before the journal index is built: /health answers 503 «starting» (not a refused connection)
// and tracking answers 503 until the data is loaded. The slow journal is a named pipe that blocks the index build
// until the test closes the writing end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const canFifo = process.platform !== 'win32' && spawnSync('mkfifo', ['--help'], { stdio: 'ignore' }).error === undefined;

test('/health says «starting» and tracking is 503 while the journal index is being built', { skip: !canFifo && 'needs mkfifo', timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-startup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(spawnSync('mkfifo', [join(dir, 'events.jsonl')]).status, 0);
  const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, DATABASE_URL: '', ADMIN_TOKEN: '', GEOIP_DB: '', FX_REFRESH: '0', MONITOR: '0',
    PORT: '0', DATA_DIR: dir, RECONCILE_INTERVAL_MS: '0', RETENTION_DAYS: '', ENV_LOCAL_FILE: 'off' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  const seen = (re) => new Promise((resolve) => {
    const check = () => { const m = output.match(re); if (m) resolve(m); };
    child.stdout.on('data', (chunk) => { output += chunk; check(); });
    check();
  });
  const [, base] = await seen(/port bound on (http:\/\/127\.0\.0\.1:\d+)/);
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 503);
  assert.deepEqual({ ok: (await health.json()).ok }, { ok: false });
  const click = await fetch(`${base}/r/demo/offer-1`, { redirect: 'manual' });
  assert.equal(click.status, 503);
  assert.equal(click.headers.get('retry-after'), '2');
  assert.doesNotMatch(output, /listening on/);

  const writer = await open(join(dir, 'events.jsonl'), 'w'); // unblocks the index build: an empty journal
  await writer.close();
  await seen(/Product Umbrella listening on http/);
  const ready = await fetch(`${base}/health`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).ok, true);
  child.kill('SIGTERM');
  await once(child, 'exit');
});
