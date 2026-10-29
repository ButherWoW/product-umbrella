// Every environment variable the app, deploy files and scripts read must be listed in .env.example
// (active or commented out), and .env.example must not list variables nobody reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['src', 'deploy', 'scripts'].flatMap((dir) => readdirSync(join(root, dir))
  .filter((f) => /\.(m?js|sh)$/.test(f)).map((f) => join(dir, f)));

// Variables only the test suite reads (documented in the "Только для тестов" section).
const TEST_ONLY = new Set(['TEST_DATABASE_URL', 'PLAYWRIGHT_MODULE']);

export function envNames(source, isShell) {
  const names = new Set();
  const patterns = isShell
    // ${NAME:-default}: read from the environment with a default (${NAME:?} is only an empty-variable guard).
    ? [/\$\{([A-Z][A-Z0-9_]*):[-=]/g]
    : [/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g, /\bprocess\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
      /\benv\.([A-Z][A-Z0-9_]*)/g, // helpers that take (env = process.env)
      // Helpers that read process.env[name] / env[name] for a literal first argument:
      // secret('KEITARO_API_KEY', file), envLimit('LP_CLICK_RATE_LIMIT', 300), num('LOGIN_WINDOW_MS', …).
      /\b(?:secret|envLimit|num)\(\s*'([A-Z][A-Z0-9_]*)'/g];
  for (const re of patterns) for (const m of source.matchAll(re)) names.add(m[1]);
  return names;
}

const used = new Map();
for (const f of files) {
  for (const name of envNames(readFileSync(join(root, f), 'utf8'), f.endsWith('.sh'))) {
    if (!used.has(name)) used.set(name, []);
    used.get(name).push(f);
  }
}
const example = readFileSync(join(root, '.env.example'), 'utf8');
const listed = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

test('the scan finds the variables (guards against a broken regex)', () => {
  for (const name of ['DATABASE_URL', 'ADMIN_TOKEN', 'LOG_FILE', 'SOURCE_POSTBACK_ALLOW_PRIVATE', 'KEITARO_API_KEY', 'KEEP_DAYS', 'LP_CLICK_RATE_LIMIT', 'LOGIN_WINDOW_MS']) {
    assert.ok(used.has(name), `${name} not found by the scan`);
  }
});

test('every variable read in src/, deploy/ and scripts/ is in .env.example', () => {
  const missing = [...used.keys()].filter((n) => !listed.has(n)).map((n) => `${n} (${used.get(n).join(', ')})`);
  assert.deepEqual(missing, [], `add to .env.example: ${missing.join('; ')}`);
});

test('.env.example lists no variable that nobody reads', () => {
  const stale = [...listed].filter((n) => !used.has(n) && !TEST_ONLY.has(n));
  assert.deepEqual(stale, [], `not read anywhere, remove from .env.example: ${stale.join(', ')}`);
});
