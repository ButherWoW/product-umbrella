import { createKeyedLock } from './conversion-recorder.js';

// JSONL remains primary. Mirror tasks for one click retain their journal order,
// while unrelated clicks can use different pool connections concurrently.
export function createEventMirror({ query, onError = () => {} }) {
  const lock = createKeyedLock();
  const pending = new Set();

  function enqueue({ type, at, ...payload }) {
    if (!['click', 'conversion', 'lp_click', 'bot', 'postback_in', 'postback_out', 'cost_update'].includes(type)) return null;
    if (type === 'postback_in' || type === 'postback_out') {
      const task = query(`INSERT INTO postbacks (direction, click_id, campaign, offer_id, tid, status, revenue, currency, url, status_code, error, attempt, ip, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [type === 'postback_in' ? 'in' : 'out', payload.clickId ?? null, payload.campaign ?? null,
        payload.offerId ?? null, payload.tid ?? null, payload.status ?? null, payload.revenue === null || payload.revenue === undefined ? null : String(payload.revenue),
        payload.currency ?? null, payload.url ?? null, payload.statusCode ?? null, payload.error ?? null, payload.attempt ?? null, payload.ip ?? null, at])
        .catch((error) => onError(type, error));
      pending.add(task); task.then(() => pending.delete(task)); return task;
    }
    if (type === 'cost_update') {
      // Manual cost update (G8): one cost for every listed click, the rounding remainder on the last one.
      // An import (importKey) also remembers its clicks, so re-importing the same key replaces instead of adding.
      const update = () => query(`UPDATE clicks SET cost = CASE WHEN click_id::text = $3 THEN $4::numeric ELSE $2::numeric END WHERE click_id = ANY($1::uuid[])`,
        [payload.clickIds || [], payload.cost ?? 0, payload.lastClickId ?? '', payload.lastCost ?? payload.cost ?? 0]);
      const task = (payload.importKey ? update().then(() => query(`INSERT INTO cost_imports (import_key, campaign, click_ids, cost, updated_at) VALUES ($1,$2,$3::text[],$4,$5)
        ON CONFLICT (import_key) DO UPDATE SET campaign = EXCLUDED.campaign, click_ids = EXCLUDED.click_ids, cost = EXCLUDED.cost, updated_at = EXCLUDED.updated_at`,
      [payload.importKey, payload.campaign ?? '', payload.clickIds || [], payload.importCost ?? 0, at])) : update()).catch((error) => onError(type, error));
      pending.add(task); task.then(() => pending.delete(task)); return task;
    }
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
        // One row per (click, tid): a new tid is an upsell, the same tid a status update (lead → sale → rejected)
        // that overwrites the row; the keyed lock keeps journal order. created_at stays the first postback's time,
        // updated_at is the journal time of the latest one (as /api/conversions reads them from the journal).
        await query(`INSERT INTO conversions (click_id, tid, revenue, currency, status, params, revenue_ignored, created_at)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (click_id, tid) DO UPDATE
          SET revenue = EXCLUDED.revenue, currency = EXCLUDED.currency, status = EXCLUDED.status,
            params = COALESCE(EXCLUDED.params, conversions.params), revenue_ignored = EXCLUDED.revenue_ignored, updated_at = EXCLUDED.created_at`,
        [payload.clickId, payload.tid ?? '', payload.revenue ?? null, payload.currency ?? null, payload.status || 'sale',
          payload.params ? JSON.stringify(payload.params) : null, payload.revenueIgnored === true, at]);
        // sub_id_N from the postback overwrite the click's parameters, so reports by sub_id show the network's values.
        if (payload.params && Object.keys(payload.params).length)
          await query(`UPDATE clicks SET params = COALESCE(params, '{}'::jsonb) || $2::jsonb WHERE click_id = $1`, [payload.clickId, JSON.stringify(payload.params)]);
      }
    }).catch((error) => { onError(type, error, payload); });
    // A logging callback must not cause an unhandled rejected mirror promise.
    const settled = task.catch(() => {});
    pending.add(settled);
    settled.then(() => pending.delete(settled));
    return settled;
  }

  async function drain() {
    while (pending.size) await Promise.all([...pending]);
  }
  // Waits only for the tasks queued so far (drain() could wait forever under steady traffic).
  async function flush() {
    await Promise.all([...pending]);
  }
  return { enqueue, drain, flush };
}
