import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileLogger, installLogFile } from '../src/log-file.js';
import { startTestServer } from './test-server.mjs';

test('file logger: timestamp, level, size rotation keeps three old files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'logs', 'umbrella.log');
  let n = 0;
  const logger = createFileLogger({ path, maxBytes: 200, keep: 3, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)) });
  logger.write('info', ['first %s', 'line', { a: 1 }]);
  const first = await readFile(path, 'utf8');
  assert.equal(first, "2026-01-01T00:00:00.000Z INFO  first line { a: 1 }\n");
  for (let i = 0; i < 40; i++) logger.write(i % 2 ? 'warn' : 'error', [`message ${i} ${'x'.repeat(30)}`]);
  const files = (await readdir(join(dir, 'logs'))).sort();
  assert.deepEqual(files, ['umbrella.log', 'umbrella.log.1', 'umbrella.log.2', 'umbrella.log.3'], 'at most 3 rotated files');
  for (const f of files) {
    const text = await readFile(join(dir, 'logs', f), 'utf8');
    assert.ok(Buffer.byteLength(text) <= 200, `${f} stays under the limit`);
    assert.match(text, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z (WARN |ERROR) message \d+ x+$/m);
  }
  assert.match(await readFile(path, 'utf8'), /message 39 /, 'newest message in the current file');
  assert.match(await readFile(path + '.1', 'utf8'), /message 3[0-9] /, '.1 holds the previous chunk');
});

test('installLogFile: off without LOG_FILE, wraps console when set', async (t) => {
  assert.equal(installLogFile({}), null);
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [];
  const fake = { log: (...a) => seen.push(['log', ...a]), info: (...a) => seen.push(['info', ...a]), warn: (...a) => seen.push(['warn', ...a]), error: (...a) => seen.push(['error', ...a]) };
  const logger = installLogFile({ LOG_FILE: join(dir, 'app.log'), LOG_MAX_MB: '0.001' }, fake);
  fake.log('hello'); fake.warn('[db] fallback:', 'boom'); fake.error(new Error('bad'));
  assert.deepEqual(seen.slice(0, 2), [['log', 'hello'], ['warn', '[db] fallback:', 'boom']], 'still goes to the console');
  const text = await readFile(logger.path, 'utf8');
  assert.match(text, / INFO  hello\n/); assert.match(text, / WARN  \[db\] fallback: boom\n/); assert.match(text, / ERROR Error: bad/);
  for (let i = 0; i < 60; i++) fake.warn('filler line', i);
  assert.ok((await readdir(dir)).includes('app.log.1'), 'LOG_MAX_MB rotates (minimum 1 KB)');
});

test('server writes its startup log to LOG_FILE and still prints to stdout', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-log-'));
  const logFile = join(dir, 'server.log');
  const server = await startTestServer(join(dir, 'data'), { LOG_FILE: logFile });
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  let text = '';
  for (let i = 0; i < 50 && !/listening/.test(text); i++) { text = await readFile(logFile, 'utf8').catch(() => ''); if (!/listening/.test(text)) await new Promise((r) => setTimeout(r, 20)); }
  assert.match(text, /^\S+Z INFO  Product Umbrella listening on http:\/\/127\.0\.0\.1:\d+$/m);
  assert.doesNotMatch(text, /conversion-test-secret/, 'secrets are not logged');
});
