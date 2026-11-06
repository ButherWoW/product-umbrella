import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile, envLocalPath, loadEnvLocal } from '../src/env-local.js';

test('parseEnvFile: comments, quotes, export, inline comments, junk lines', () => {
  assert.deepEqual(parseEnvFile('# c\nRETENTION_DAYS=90\n\nexport A_B="x y" # note\nC=\'q\'\nD=v # tail\nbad line\n1X=no\nE=\n'),
    { RETENTION_DAYS: '90', A_B: 'x y', C: 'q', D: 'v', E: '' });
});

test('envLocalPath: explicit file, off, default next to DATA_DIR', () => {
  assert.equal(envLocalPath({ ENV_LOCAL_FILE: 'off' }), null);
  assert.equal(envLocalPath({}), null);
  assert.equal(envLocalPath({ DATA_DIR: '/opt/umbrella/data' }), '/opt/umbrella/.env.local');
  assert.equal(envLocalPath({ DATA_DIR: '/x/data', ENV_LOCAL_FILE: '/y/e' }), '/y/e');
});

test('loadEnvLocal overrides the environment, ignores a missing file, never sets ENV_LOCAL_FILE', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-envlocal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'data'));
  const env = { DATA_DIR: join(dir, 'data'), RETENTION_DAYS: '1', KEEP: 'a' };
  assert.deepEqual(loadEnvLocal(env), []);
  await writeFile(join(dir, '.env.local'), 'RETENTION_DAYS=90\nADMIN_ALLOWED_IPS=10.0.0.1\nENV_LOCAL_FILE=/etc/passwd\n');
  const names = loadEnvLocal(env);
  assert.deepEqual(names.sort(), ['ADMIN_ALLOWED_IPS', 'RETENTION_DAYS']);
  assert.equal(env.RETENTION_DAYS, '90');
  assert.equal(env.ADMIN_ALLOWED_IPS, '10.0.0.1');
  assert.equal(env.KEEP, 'a');
  assert.equal(env.ENV_LOCAL_FILE, undefined);
});
