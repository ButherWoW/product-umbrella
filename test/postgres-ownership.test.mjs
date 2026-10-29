// Ownership in PostgreSQL: owner_id of offers, landings, sources and networks survives a restart with an empty data
// directory, and PATCH keeps it. Runs only with TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const TOKEN = 'pg-owner-token';

test('PostgreSQL: owner_id of offers, landings, sources and networks persists', { skip: !databaseUrl && 'set TEST_DATABASE_URL to run', timeout: 30000 }, async (t) => {
  const dirs = [];
  const start = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgown-')); dirs.push(dir);
    return startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN });
  };
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  const buyer = '3f1c2b9a-0000-4000-8000-' + String(Date.now()).slice(-12).padStart(12, '0');
  const kinds = [
    ['offers', { url: 'https://own.example.com/' }],
    ['landings', { url: 'https://own-lp.example.com/' }],
    ['sources', { name: 'Own source' }],
    ['networks', { name: 'Own network' }],
  ];
  let server = await start();
  const call = (path, body, method = body ? 'POST' : 'GET') => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    for (const [kind, body] of kinds) {
      const team = await call(`/api/${kind}`, { id: `${kind}-team-${run}`, ...body });
      assert.equal(team.status, 201, kind);
      assert.equal((await team.json()).ownerId, null);
      const owned = await call(`/api/${kind}`, { id: `${kind}-own-${run}`, ...body, ownerId: buyer });
      assert.equal((await owned.json()).ownerId, buyer, kind);
      assert.equal((await call(`/api/${kind}`, { id: `${kind}-own-${run}`, ...body })).status, 409, `${kind}: POST does not overwrite`);
      assert.equal((await call(`/api/${kind}/${kind}-own-${run}`, { name: 'Renamed' }, 'PATCH')).status, 200, kind);
    }
  } finally { await server.stop(); }

  server = await start();
  try {
    for (const [kind] of kinds) {
      const all = (await (await call(`/api/${kind}`)).json())[kind];
      assert.equal(all[`${kind}-team-${run}`]?.ownerId, null, kind);
      assert.equal(all[`${kind}-own-${run}`]?.ownerId, buyer, `${kind}: owner_id persisted and kept by PATCH`);
    }
  } finally { await server.stop(); }
});
