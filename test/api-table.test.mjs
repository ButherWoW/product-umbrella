// The API table in README.md is generated from docs/openapi.json; this is the CI check
// (same as `node scripts/gen-api-table.mjs --check`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTable, updateReadme } from '../scripts/gen-api-table.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('README.md API table matches docs/openapi.json', () => {
  const spec = JSON.parse(readFileSync(resolve(root, 'docs/openapi.json'), 'utf8'));
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  assert.ok(updateReadme(readme, renderTable(spec)) === readme,
    'README.md API table is out of date: run `node scripts/gen-api-table.mjs` and commit README.md');
});

test('every operation has a Russian summary for the table', () => {
  const spec = JSON.parse(readFileSync(resolve(root, 'docs/openapi.json'), 'utf8'));
  assert.doesNotThrow(() => renderTable(spec));
});
