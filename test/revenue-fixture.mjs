// Revenue-cap fixture shared by the JSONL and PostgreSQL tests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const TOKEN = 'journal-test-token';
const day = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const line = (event) => `${JSON.stringify({ id: randomUUID(), ...event })}\n`;

// Shared with the PostgreSQL test: rc-old has a sale today on a click from two days ago (capped at 10);
// rc-new has a click today whose sale was yesterday, a lead today and a sale today that was rejected (not capped).
export function revenueJournal(now = Date.now(), suffix = '') {
  const old = randomUUID(), fresh = randomUUID(), lead = randomUUID(), rejected = randomUUID();
  const today = Date.parse(`${iso(now).slice(0, 10)}T00:00:00Z`);
  const click = (clickId, campaign, at) => line({ type: 'click', at: iso(at), clickId, campaign, offerId: 'offer-1', uniqueCampaign: true });
  const [a, b] = [`rc-old${suffix}`, `rc-new${suffix}`];
  return click(old, a, now - 2 * day)
    + line({ type: 'conversion', at: iso(now - 2 * day + 1000), clickId: old, revenue: 100, currency: 'EUR', status: 'lead' })
    + line({ type: 'conversion', at: iso(Math.max(today + 1000, now - 5000)), clickId: old, revenue: 15, currency: 'EUR', status: 'sale', previousStatus: 'lead' })
    + click(fresh, b, today - 2000)
    + line({ type: 'conversion', at: iso(today - 1000), clickId: fresh, revenue: 50, currency: 'EUR' })
    + click(lead, b, now - 4000)
    + line({ type: 'conversion', at: iso(now - 3000), clickId: lead, revenue: 70, currency: 'EUR', status: 'lead' })
    + click(rejected, b, now - 4000)
    + line({ type: 'conversion', at: iso(now - 3000), clickId: rejected, revenue: 40, currency: 'EUR', status: 'sale' })
    + line({ type: 'conversion', at: iso(now - 2000), clickId: rejected, revenue: 40, currency: 'EUR', status: 'rejected', previousStatus: 'sale' });
}
export async function createCapCampaigns(url, suffix = '') {
  for (const id of [`rc-old${suffix}`, `rc-new${suffix}`]) {
    const response = await fetch(`${url}/api/campaigns`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: id, revenueCap: 10, streams: [{ name: 'main', offers: [{ offerId: 'offer-1' }] }] }) });
    assert.equal(response.status, 201, await response.text());
  }
}
export async function assertCaps(url, suffix = '') {
  const capped = await fetch(`${url}/r/rc-old${suffix}`, { redirect: 'manual' });
  assert.equal(capped.status, 429, 'sale today on a click from two days ago reaches the cap');
  assert.equal((await capped.json()).error, 'revenue_cap_reached');
  assert.equal((await fetch(`${url}/r/rc-new${suffix}`, { redirect: 'manual' })).status, 302, 'yesterday\'s sale, a lead and a rejected sale do not count');
}
