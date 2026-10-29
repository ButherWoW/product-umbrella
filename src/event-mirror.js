import { createKeyedLock } from './conversion-recorder.js';

// JSONL remains primary. Mirror tasks for one click retain their journal order,
// while unrelated clicks can use different pool connections concurrently.
export function createEventMirror({ query, onError = () => {} }) {
  const lock = createKeyedLock();
  const pending = new Set();

  function enqueue({ type, at, ...payload }) {
    if (!['click', 'conversion', 'lp_click', 'bot'].includes(type)) return null;
    if (type === 'bot') {
      const task = query('INSERT INTO bots (campaign, offer_id, stream, user_agent, ip, reason, isp, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [payload.campaign, payload.offerId ?? null, payload.stream ?? null, payload.userAgent ?? null, payload.ip ?? null, payload.reason ?? null, payload.isp ?? null, at]).catch((error) => onError(type, error));
      pending.add(task); task.then(() => pending.delete(task)); return task;
    }
    const task = lock(payload.clickId, async () => {
      if (type === 'click') {
        await query(`INSERT INTO clicks
          (click_id, campaign, offer_id, path, referrer, user_agent, subid, country, ip, stream, params, cost, landing_id, is_unique_campaign, is_unique_stream, is_unique_global, device, os, browser, language, asn, isp, datacenter, connection, revenue, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) ON CONFLICT DO NOTHING`,
        [payload.clickId, payload.campaign, payload.offerId, payload.path ?? null,
          payload.referrer ?? null, payload.userAgent ?? null, payload.subid ?? null,
          payload.country ?? null, payload.ip ?? null, payload.stream ?? null,
          payload.params ? JSON.stringify(payload.params) : null, payload.cost ?? 0, payload.landingId ?? null,
          payload.uniqueCampaign ?? true, payload.uniqueStream ?? true, payload.uniqueGlobal ?? true,
          payload.device ?? null, payload.os ?? null, payload.browser ?? null, payload.language ?? null,
          payload.asn ?? null, payload.isp ?? null, payload.datacenter ?? null, payload.connection ?? null, payload.revenue ?? 0, at]);
      } else if (type === 'lp_click') {
        // First landing click wins; repeats keep the original time.
        await query('UPDATE clicks SET lp_clicked_at = COALESCE(lp_clicked_at, $2) WHERE click_id = $1', [payload.clickId, at]);
      } else {
        // Status updates (lead → sale → rejected) overwrite the row; the keyed lock keeps journal order.
        await query(`INSERT INTO conversions (click_id, revenue, currency, status, created_at)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (click_id) DO UPDATE
          SET revenue = EXCLUDED.revenue, currency = EXCLUDED.currency, status = EXCLUDED.status, updated_at = now()`,
        [payload.clickId, payload.revenue ?? null, payload.currency ?? null, payload.status || 'sale', at]);
      }
    }).catch((error) => { onError(type, error); });
    // A logging callback must not cause an unhandled rejected mirror promise.
    const settled = task.catch(() => {});
    pending.add(settled);
    settled.then(() => pending.delete(settled));
    return settled;
  }

  async function drain() {
    while (pending.size) await Promise.all([...pending]);
  }
  return { enqueue, drain };
}
