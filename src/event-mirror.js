import { createKeyedLock } from './conversion-recorder.js';

// PostgreSQL errors worth retrying: the connection dropped or the server is restarting / overloaded.
// Anything else (missing table, constraint) fails at once; the reconciliation job (src/reconcile.js)
// replays the event from the journal later.
const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  '57P01', '57P02', '57P03', '53300', '40001', '40P01']);
export function isTransientDbError(error) {
  if (!error) return false;
  if (TRANSIENT_CODES.has(error.code) || /^08/.test(String(error.code || ''))) return true;
  return /Connection terminated|connection timeout|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(error.message || '');
}

// Statements shared by the live mirror and the reconciliation job, so both write the same rows.
// A conversion row holds the latest event of its (click, tid): event_id is that event, updated_at its time.
// The WHERE guard never lets an older event overwrite a newer one (mirror and reconciliation may race).
export const CONVERSION_UPSERT = `INSERT INTO conversions (click_id, tid, revenue, currency, status, params, created_at, updated_at, event_id)
  VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) ON CONFLICT (click_id, tid) DO UPDATE
  SET revenue = EXCLUDED.revenue, currency = EXCLUDED.currency, status = EXCLUDED.status,
    params = COALESCE(EXCLUDED.params, conversions.params), updated_at = COALESCE(EXCLUDED.updated_at, EXCLUDED.created_at), event_id = EXCLUDED.event_id
  WHERE (EXCLUDED.event_id IS NULL OR conversions.event_id IS DISTINCT FROM EXCLUDED.event_id)
    AND COALESCE(conversions.updated_at, conversions.created_at) <= COALESCE(EXCLUDED.updated_at, EXCLUDED.created_at)`;
export const CLICK_COLUMNS = ['click_id', 'campaign', 'offer_id', 'path', 'referrer', 'user_agent', 'subid', 'country', 'ip', 'stream', 'params', 'cost', 'landing_id',
  'is_unique_campaign', 'is_unique_stream', 'is_unique_global', 'device', 'os', 'browser', 'language', 'asn', 'isp', 'datacenter', 'connection', 'revenue', 'created_at'];
export function clickValues(payload, at) {
  return [payload.clickId, payload.campaign, payload.offerId, payload.path ?? null,
    payload.referrer ?? null, payload.userAgent ?? null, payload.subid ?? null,
    payload.country ?? null, payload.ip ?? null, payload.stream ?? null,
    payload.params ? JSON.stringify(payload.params) : null, payload.cost ?? 0, payload.landingId ?? null,
    payload.uniqueCampaign ?? true, payload.uniqueStream ?? true, payload.uniqueGlobal ?? true,
    payload.device ?? null, payload.os ?? null, payload.browser ?? null, payload.language ?? null,
    payload.asn ?? null, payload.isp ?? null, payload.datacenter ?? null, payload.connection ?? null, payload.revenue ?? 0, at];
}
export const CLICK_INSERT = `INSERT INTO clicks (${CLICK_COLUMNS.join(', ')})
  VALUES (${CLICK_COLUMNS.map((c, i) => `$${i + 1}${c === 'params' ? '::jsonb' : ''}`).join(',')}) ON CONFLICT DO NOTHING`;
export const BOT_INSERT = `INSERT INTO bots (campaign, offer_id, stream, user_agent, ip, reason, isp, created_at, event_id)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (event_id) DO NOTHING`;
export const botValues = (e) => [e.campaign, e.offerId ?? null, e.stream ?? null, e.userAgent ?? null, e.ip ?? null, e.reason ?? null, e.isp ?? null, e.at, e.id ?? null];
export const POSTBACK_INSERT = `INSERT INTO postbacks (direction, click_id, campaign, offer_id, tid, status, revenue, currency, url, status_code, error, attempt, ip, created_at, event_id)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (event_id) DO NOTHING`;
export const postbackValues = (e) => [e.type === 'postback_in' ? 'in' : 'out', e.clickId ?? null, e.campaign ?? null,
  e.offerId ?? null, e.tid ?? null, e.status ?? null, e.revenue === null || e.revenue === undefined ? null : String(e.revenue),
  e.currency ?? null, e.url ?? null, e.statusCode ?? null, e.error ?? null, e.attempt ?? null, e.ip ?? null, e.at, e.id ?? null];
export const COST_IMPORT_UPSERT = `INSERT INTO cost_imports (import_key, campaign, click_ids, cost, updated_at) VALUES ($1,$2,$3::text[],$4,$5)
  ON CONFLICT (import_key) DO UPDATE SET campaign = EXCLUDED.campaign, click_ids = EXCLUDED.click_ids, cost = EXCLUDED.cost, updated_at = EXCLUDED.updated_at
  WHERE cost_imports.updated_at <= EXCLUDED.updated_at
    AND (cost_imports.campaign, cost_imports.click_ids, cost_imports.cost, cost_imports.updated_at) IS DISTINCT FROM (EXCLUDED.campaign, EXCLUDED.click_ids, EXCLUDED.cost, EXCLUDED.updated_at)`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// JSONL remains primary. Mirror tasks for one click retain their journal order,
// while unrelated clicks can use different pool connections concurrently.
// Transient errors (PostgreSQL restart, dropped connection) are retried with backoff inside the click's lock,
// so the order is kept; an event that still fails is counted (stats().errors) and left to the reconciliation job.
export function createEventMirror({ query, onError = () => {}, retryDelays = [200, 1000, 3000] }) {
  const lock = createKeyedLock();
  const pending = new Set();
  const lastByKey = new Map();
  const counters = { errors: 0, retries: 0 };

  async function withRetry(statement) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await statement(); } catch (error) {
        if (attempt >= retryDelays.length || !isTransientDbError(error)) throw error;
        counters.retries += 1;
        await sleep(retryDelays[attempt]);
      }
    }
  }
  const q = (sql, params) => withRetry(() => query(sql, params));

  async function apply({ type, at, id, ...payload }) {
    const record = { type, at, id, ...payload };
    if (type === 'postback_in' || type === 'postback_out') return q(POSTBACK_INSERT, postbackValues(record));
    if (type === 'bot') return q(BOT_INSERT, botValues(record));
    if (type === 'cost_update') {
      // Manual cost update (G8): one cost for every listed click, the rounding remainder on the last one.
      // An import (importKey) also remembers its clicks, so re-importing the same key replaces instead of adding.
      await q(`UPDATE clicks SET cost = CASE WHEN click_id::text = $3 THEN $4::numeric ELSE $2::numeric END WHERE click_id = ANY($1::uuid[])`,
        [payload.clickIds || [], payload.cost ?? 0, payload.lastClickId ?? '', payload.lastCost ?? payload.cost ?? 0]);
      if (payload.importKey) await q(COST_IMPORT_UPSERT, [payload.importKey, payload.campaign ?? '', payload.clickIds || [], payload.importCost ?? 0, at]);
      return;
    }
    if (type === 'click') return q(CLICK_INSERT, clickValues(payload, at));
    // First landing click wins; repeats keep the original time.
    if (type === 'lp_click') return q('UPDATE clicks SET lp_clicked_at = COALESCE(lp_clicked_at, $2) WHERE click_id = $1', [payload.clickId, at]);
    // One row per (click, tid): a new tid is an upsell, the same tid a status update (lead → sale → rejected)
    // that overwrites the row; the keyed lock keeps journal order.
    await q(CONVERSION_UPSERT, [payload.clickId, payload.tid ?? '', payload.revenue ?? null, payload.currency ?? null, payload.status || 'sale',
      payload.params ? JSON.stringify(payload.params) : null, at, null, id ?? null]);
    // sub_id_N from the postback overwrite the click's parameters, so reports by sub_id show the network's values.
    if (payload.params && Object.keys(payload.params).length)
      await q(`UPDATE clicks SET params = COALESCE(params, '{}'::jsonb) || $2::jsonb WHERE click_id = $1`, [payload.clickId, JSON.stringify(payload.params)]);
  }

  function enqueue(record) {
    const { type } = record;
    if (!['click', 'conversion', 'lp_click', 'bot', 'postback_in', 'postback_out', 'cost_update'].includes(type)) return null;
    // Click events keep their order per click; cost updates keep their order among themselves.
    const key = ['click', 'conversion', 'lp_click'].includes(type) ? record.clickId : type === 'cost_update' ? '\u0000cost' : null;
    const run = () => apply(record);
    const task = (key === null ? run() : lock(key, run)).catch((error) => { counters.errors += 1; onError(type, error, record); });
    // A logging callback must not cause an unhandled rejected mirror promise.
    const settled = task.catch(() => {});
    pending.add(settled);
    if (key !== null) lastByKey.set(key, settled);
    settled.then(() => { pending.delete(settled); if (key !== null && lastByKey.get(key) === settled) lastByKey.delete(key); });
    return settled;
  }

  async function drain() {
    while (pending.size) await Promise.all([...pending]);
  }
  // Waits only for the tasks queued so far (drain() could wait forever under steady traffic).
  async function flush() {
    await Promise.all([...pending]);
  }
  // Waits until every event of this click queued so far is in PostgreSQL (or has failed).
  async function settledFor(clickId) {
    await lastByKey.get(clickId);
  }
  const stats = () => ({ errors: counters.errors, retries: counters.retries, pending: pending.size });
  return { enqueue, drain, flush, settledFor, stats };
}
