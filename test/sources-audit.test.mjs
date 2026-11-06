import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

test('creating and changing a source is audited; the postback URL query (network token) never is', { timeout: 20000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-src-audit-'));
  const server = await startTestServer(dataDir, { ADMIN_TOKEN: 'src-audit-token', SOURCE_POSTBACK_ALLOW_PRIVATE: '1' });
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(server.url + path, { method, headers: { authorization: 'Bearer src-audit-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  assert.equal((await call('/api/sources', 'POST', { id: 'fb-audit', name: 'Facebook', postbackUrl: 'https://graph.example.com/cb?access_token=SECRETTOKEN&e={status}' })).status, 201);
  assert.equal((await call('/api/sources/fb-audit', 'PATCH', { name: 'Facebook 2', postbackUrl: 'https://graph.example.com/cb?access_token=OTHERTOKEN&e={status}' })).status, 200);
  const entries = (await call('/api/audit?entity=source&id=fb-audit')).json.entries;
  assert.deepEqual(entries.map((e) => e.action), ['update', 'create']);
  assert.deepEqual(entries[0].changes.name, ['Facebook', 'Facebook 2']);
  assert.ok(entries[0].changes.postbackQueryHash, 'the change of the URL is visible as a fingerprint');
  const text = JSON.stringify(entries);
  assert.ok(!text.includes('SECRETTOKEN') && !text.includes('OTHERTOKEN') && !text.includes('access_token'), 'no token in the history');
});
