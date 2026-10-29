import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

test('OpenAPI documents core tracking, stats and management routes', async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const spec = JSON.parse(await readFile(join(root, 'docs', 'openapi.json'), 'utf8'));
  assert.equal(spec.openapi, '3.1.0');
  for (const path of ['/health', '/r/{campaign}', '/postback', '/stats', '/stats/export', '/api/campaigns', '/api/offers', '/api/sources', '/api/networks']) assert.ok(spec.paths[path], `missing OpenAPI path: ${path}`);
});
