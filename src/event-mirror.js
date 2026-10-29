import { createKeyedLock } from './conversion-recorder.js';

// JSONL remains primary. Mirror tasks for one click retain their journal order,
// while unrelated clicks can use different pool connections concurrently.
export function createEventMirror({ query, onError = () => {} }) {
  const lock = createKeyedLock();
  const pending = new Set();

  function enqueue({ type, at, ...payload }) {
    if (!['click', 'conversion'].includes(type)) return;
    const task = lock(payload.clickId, async () => {
      if (type === 'click') {
        await query(`INSERT INTO clicks
          (click_id, campaign, offer_id, path, referrer, user_agent, subid, country, ip, stream, params, cost, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13) ON CONFLICT DO NOTHING`,
        [payload.clickId, payload.campaign, payload.offerId, payload.path ?? null,
          payload.referrer ?? null, payload.userAgent ?? null, payload.subid ?? null,
          payload.country ?? null, payload.ip ?? null, payload.stream ?? null,
          payload.params ? JSON.stringify(payload.params) : null, payload.cost ?? 0, at]);
      } else {
        await query(`INSERT INTO conversions (click_id, revenue, currency, created_at)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [payload.clickId, payload.revenue ?? null, payload.currency ?? null, at]);
      }
    }).catch((error) => { onError(type, error); });
    // A logging callback must not cause an unhandled rejected mirror promise.
    const settled = task.catch(() => {});
    pending.add(settled);
    settled.then(() => pending.delete(settled));
  }

  async function drain() {
    while (pending.size) await Promise.all([...pending]);
  }
  return { enqueue, drain };
}
