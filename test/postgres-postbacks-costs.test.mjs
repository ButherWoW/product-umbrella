// G7 + G8 in PostgreSQL: postback journals come from the postbacks table, cost updates reach clicks.cost,
// both survive a restart with an empty data directory. Runs only with TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';
import { TOKEN, startNetworkMock, hasOpenssl, buyerSession, checkPostbackLogs, checkCosts } from './postbacks-costs.test.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL: postback journals, S2S retries and manual cost updates', { skip: (!databaseUrl && 'set TEST_DATABASE_URL to run') || (!hasOpenssl() && 'openssl not available'), timeout: 40000 }, async (t) => {
  const dirs = [];
  const mockDir = await mkdtemp(join(tmpdir(), 'umbrella-pgpbm-')); dirs.push(mockDir);
  const mock = await startNetworkMock(mockDir);
  const start = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbrella-pgpb-')); dirs.push(dir);
    return startTestServer(dir, { DATABASE_URL: databaseUrl, REQUIRE_POSTGRES: '1', ADMIN_TOKEN: TOKEN, S2S_RETRY_MS: '20', NODE_EXTRA_CA_CERTS: mock.cert });
  };
  t.after(async () => { await mock.stop(); for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = Date.now().toString(36);
  let server = await start();
  const call = (path, body) => fetch(server.url + path, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let campaign;
  try {
    const buyer = await buyerSession(server, call, `buyer-pb-${run}@example.com`);
    await checkPostbackLogs({ server, call, buyer, mock, run });
    ({ campaign } = await checkCosts({ server, call, buyer, run }));
  } finally { await server.stop(); }

  server = await start();
  try {
    const out = await (await call(`/api/postbacks?direction=out&campaign=pb-cmp-${run}`)).json();
    assert.equal(out.storage, 'postgres');
    assert.deepEqual(out.postbacks.map((p) => [p.attempt, p.statusCode]), [[3, 200], [2, 500], [1, 500]]);
    assert.ok(out.postbacks.every((p) => !p.url.includes('network-key-1')));
    const incoming = await (await call(`/api/postbacks?direction=in&campaign=pb-cmp-${run}`)).json();
    assert.ok(incoming.postbacks.some((p) => p.statusCode === 200) && incoming.postbacks.every((p) => !p.url.includes('conversion-test-secret')));
    const stats = await (await call(`/stats?campaign=${campaign}`)).json();
    assert.ok(Math.abs(stats.cost - 1.8) < 1e-9, `cost from clicks.cost: ${stats.cost}`);
  } finally { await server.stop(); }

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT url FROM postbacks WHERE url LIKE '%secret%' OR url LIKE '%network-key-1%' OR url LIKE '%network-token-1%'");
    assert.ok(rows.every((r) => !/conversion-test-secret|wrong-secret|network-key-1|network-token-1/.test(r.url)), 'no credentials in the postbacks table');
  } finally { await client.end(); }
});
