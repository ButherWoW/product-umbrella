// Spend import (FB Ads Manager CSV → POST /api/costs/import): costs land on the clicks of the right ad set and day,
// a re-import replaces instead of adding, rows without clicks are reported. The check is shared with
// test/postgres-cost-import.test.mjs, which seeds the clicks into PostgreSQL instead of the JSONL journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

export const TOKEN = 'cost-import-token';
// (Not imported from postbacks-costs.test.mjs: importing a test file would run its tests again.)
export async function buyerSession(server, call, email) {
  assert.equal((await call('/api/users', { email, password: 'buyer-password-1' })).status, 201);
  const login = await fetch(`${server.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'umbrella' },
    body: JSON.stringify({ email, password: 'buyer-password-1' }) });
  const cookie = (login.headers.get('set-cookie').match(/umb_session=[^;]*/) || [])[0];
  return (path, body) => fetch(server.url + path, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'umbrella', cookie }, body: body ? JSON.stringify(body) : undefined });
}
const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// Clicks two days ago (d1) and yesterday (d2) at 12:00 UTC: ad set A ×2 / B ×1 on d1, A ×1 / B ×3 on d2;
// plus decoys: the same ad set in another campaign, and in this campaign but today.
export function importClicks(campaign, other) {
  const d1 = dayAgo(2), d2 = dayAgo(1), today = dayAgo(0);
  const click = (camp, day, adset, hour = 12) => ({ clickId: randomUUID(), campaign: camp, offerId: 'imp-offer', stream: 'main',
    at: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`, params: { sub_id_2: adset }, adset, day });
  const clicks = [click(campaign, d1, 'A'), click(campaign, d1, 'A'), click(campaign, d1, 'B'),
    click(campaign, d2, 'A'), click(campaign, d2, 'B'), click(campaign, d2, 'B'), click(campaign, d2, 'B'),
    click(other, d1, 'A'), click(campaign, today, 'A', 0)];
  return { d1, d2, clicks };
}

export async function checkCostImport({ call, buyer, campaign, other, d1, d2, clicks }) {
  const costsOf = async (camp) => {
    const log = await (await call(`/api/clicks?campaign=${camp}&limit=100`)).json();
    return Object.fromEntries(log.clicks.map((c) => [c.clickId, Math.round(c.cost * 1e6) / 1e6]));
  };
  const total = async (camp) => Math.round(Object.values(await costsOf(camp)).reduce((t, c) => t + c, 0) * 1e6) / 1e6;
  const rows = [
    { date: d1, id: 'A', amount: 4, currency: 'EUR' },
    { date: d1, id: 'B', amount: '1.5', currency: 'EUR' },
    { date: d2, id: 'A', amount: 2, currency: 'EUR' },
    { date: d2, id: 'B', amount: 3, currency: 'EUR' },
    { date: d2, id: 'no-such-adset', amount: 5, currency: 'EUR' },
    { date: '31.12.2025', id: 'A', amount: 1, currency: 'EUR' },
  ];
  const importRows = (body) => call('/api/costs/import', { campaign, param: 'sub_id_2', tz: 'UTC', rows, ...body });

  const first = await importRows();
  assert.equal(first.status, 200);
  const r1 = await first.json();
  assert.deepEqual(r1.results.map((r) => [r.clicks, r.error ?? null]), [[2, null], [1, null], [1, null], [3, null], [0, 'no_matching_clicks'], [0, 'invalid_date']]);
  assert.deepEqual([r1.applied, r1.failed, r1.clicks, r1.cost], [4, 2, 7, 10.5]);
  assert.ok(r1.results.every((r) => !r.replaced), 'first import replaces nothing');

  const expected = (d1A) => {
    const cost = {};
    for (const c of clicks.filter((x) => x.campaign === campaign)) {
      cost[c.clickId] = c.day === d1 ? (c.adset === 'A' ? d1A / 2 : 1.5) : c.day === d2 ? (c.adset === 'A' ? 2 : 1) : 0;
    }
    return cost;
  };
  assert.deepEqual(await costsOf(campaign), expected(4), 'each click got its ad set and day share');
  assert.equal(await total(other), 0, 'another campaign with the same ad set id is untouched');
  assert.equal((await (await call(`/stats?campaign=${campaign}`)).json()).cost, 10.5);

  // Re-import: same keys → replaced, not added.
  const r2 = await (await importRows()).json();
  assert.equal(r2.results.filter((r) => r.replaced).length, 4);
  assert.equal(await total(campaign), 10.5, 'no double counting');
  // A corrected amount replaces the previous one.
  rows[0].amount = 6;
  await importRows();
  assert.deepEqual(await costsOf(campaign), expected(6));
  // The same key in another time zone matches other clicks: the ones of the previous import are reset to 0.
  const shifted = await (await call('/api/costs/import', { campaign, param: 'sub_id_2', tz: 'Pacific/Kiritimati', rows: [rows[0]] })).json();
  assert.deepEqual([shifted.results[0].clicks, shifted.results[0].error, shifted.results[0].replaced], [0, 'no_matching_clicks', true]);
  assert.equal(await total(campaign), 12.5 - 6);
  await importRows();
  assert.equal(await total(campaign), 12.5);
  // Two rows with the same key in one file are summed.
  const merged = await (await call('/api/costs/import', { campaign, param: 'sub_id_2', tz: 'UTC',
    rows: [{ date: d2, id: 'B', amount: 1, currency: 'EUR' }, { date: d2, id: 'B', amount: 2, currency: 'EUR' }] })).json();
  assert.deepEqual(merged.results.map((r) => r.merged), [2, 2]);
  assert.equal(await total(campaign), 12.5, 'd2/B is still 3 in total');

  // Validation and permissions.
  assert.equal((await importRows({ param: 'country' })).status, 400);
  assert.equal((await importRows({ rows: [] })).status, 400);
  assert.equal((await importRows({ tz: 'Mars/Base' })).status, 400);
  assert.equal((await importRows({ campaign: 'missing-campaign' })).status, 404);
  assert.equal((await buyer('/api/costs/import', { campaign, param: 'sub_id_2', rows })).status, 403, 'buyer on a foreign campaign');
  assert.equal((await buyer('/api/costs/import', { campaign: [other, campaign], param: 'sub_id_2', rows })).status, 403);
  const audit = await (await call(`/api/audit?entity=costs&id=${campaign}`)).json();
  assert.ok(audit.entries.some((e) => e.action === 'import'), 'imports are in the audit log');
}

export async function createImportCampaigns(call, run) {
  const campaign = `imp-cmp-${run}`, other = `imp-oth-${run}`;
  if (!(await call('/api/offers')).ok) throw new Error('server not ready');
  await call('/api/offers', { id: 'imp-offer', url: 'https://import.example.com/' });
  for (const id of [campaign, other]) assert.equal((await call('/api/campaigns', { id, name: id, streams: [{ name: 'main', offers: [{ offerId: 'imp-offer' }] }] })).status, 201);
  return { campaign, other };
}

test('FB spend import: per ad set and day, idempotent re-import (JSONL)', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-costimp-'));
  const server = await startTestServer(dir, { ADMIN_TOKEN: TOKEN });
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const call = (path, body) => fetch(server.url + path, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const run = Date.now().toString(36);
  const buyer = await buyerSession(server, call, `buyer-imp-${run}@example.com`);
  const { campaign, other } = await createImportCampaigns(call, run);
  const seed = importClicks(campaign, other);
  await appendFile(join(dir, 'events.jsonl'), seed.clicks.map(({ adset, day, ...c }) =>
    JSON.stringify({ id: randomUUID(), type: 'click', ...c, uniqueCampaign: true, uniqueStream: true, uniqueGlobal: true })).join('\n') + '\n');
  await checkCostImport({ call, buyer, campaign, other, ...seed });
});
