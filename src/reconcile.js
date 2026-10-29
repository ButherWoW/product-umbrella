// Reconciliation of the PostgreSQL mirror with the JSONL journal (the source of truth).
// The live mirror (src/event-mirror.js) can lose an event: a write that failed after its retries, a database that
// was attached to an existing journal, a table that was briefly unavailable. This job replays what PostgreSQL
// lacks, idempotently, so it can run any number of times (startup, every RECONCILE_INTERVAL_MS, scripts/reconcile-db.mjs):
//   clicks        inserted when their click_id is missing (ON CONFLICT DO NOTHING);
//   conversions   one row per (click, tid) holding the latest journal event (status history: lead → sale → rejected),
//                 created_at = first event, updated_at = latest event, event_id = latest event id; an older event never
//                 overwrites a newer one;
//   click state   lp_clicked_at (first landing click), params (click params + postback sub_id_N in journal order) and
//                 cost (manual cost updates in journal order) are set to what the journal says;
//   bots/postbacks inserted when no row has their event_id (rows written before event_id existed are matched by
//                 campaign/direction, time, ip/click/url);
//   cost imports  the latest import per key.
// `from` limits the work to the events at index >= from (the tail since the previous run); state is still
// computed from the whole journal. `shouldStop()` is checked between batches (a statistics cleanup waits for it).
import { CLICK_COLUMNS, clickValues, COST_IMPORT_UPSERT } from './event-mirror.js';
import { conversionTid } from './conversion-recorder.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 500;
const CLICK_TYPES = { click_id: 'uuid', params: 'jsonb', cost: 'numeric', is_unique_campaign: 'boolean', is_unique_stream: 'boolean',
  is_unique_global: 'boolean', asn: 'integer', datacenter: 'boolean', revenue: 'numeric', created_at: 'timestamptz' };
const recordset = (columns) => columns.map(([name, type]) => `"${name}" ${type}`).join(', ');
const timeKey = (at) => { const t = Date.parse(at); return Number.isFinite(t) ? t : null; };

function chunks(list, size = BATCH) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export class ReconcileStopped extends Error {}

export async function reconcileEvents({ db, events, from = 0, shouldStop = () => false }) {
  const counts = { clicks: 0, conversions: 0, clickState: 0, bots: 0, postbacks: 0, costImports: 0 };
  const checkpoint = () => { if (shouldStop()) throw new ReconcileStopped('reconcile stopped'); };
  const tail = from > 0 ? events.slice(from) : events;
  if (!tail.length) return counts;

  // Journal state (whole file).
  const clicks = new Map();
  const conversions = new Map(); // clickId|tid → { first, latest, params }
  const clickParams = new Map(); // clickId → params merged in journal order
  const clickCost = new Map();
  const lpFirst = new Map();
  for (const e of events) {
    if (e.type === 'click' && UUID.test(e.clickId || '')) {
      if (!clicks.has(e.clickId)) clicks.set(e.clickId, e);
      if (e.params) clickParams.set(e.clickId, { ...(clickParams.get(e.clickId) || {}), ...e.params });
      clickCost.set(e.clickId, e.cost ?? 0);
    } else if (e.type === 'conversion' && UUID.test(e.clickId || '')) {
      const key = `${e.clickId}|${conversionTid(e.tid)}`;
      const prev = conversions.get(key);
      conversions.set(key, { first: prev?.first ?? e, latest: e, params: e.params || prev?.params || null });
      if (e.params && Object.keys(e.params).length) clickParams.set(e.clickId, { ...(clickParams.get(e.clickId) || {}), ...e.params });
    } else if (e.type === 'lp_click' && e.clickId && !lpFirst.has(e.clickId)) lpFirst.set(e.clickId, e.at);
    else if (e.type === 'cost_update' && Array.isArray(e.clickIds)) {
      for (const id of e.clickIds) clickCost.set(id, e.cost ?? 0);
      if (e.lastClickId) clickCost.set(e.lastClickId, e.lastCost ?? e.cost ?? 0);
    }
  }

  // What the tail touches.
  const tailClicks = new Set(), touched = new Set(), tailConversions = new Set(), bots = [], postbacks = [], imports = new Map();
  for (const e of tail) {
    if (e.type === 'click' && clicks.has(e.clickId)) { tailClicks.add(e.clickId); touched.add(e.clickId); }
    else if (e.type === 'conversion' && UUID.test(e.clickId || '')) { tailConversions.add(`${e.clickId}|${conversionTid(e.tid)}`); touched.add(e.clickId); }
    else if (e.type === 'lp_click' && e.clickId) touched.add(e.clickId);
    else if (e.type === 'cost_update' && Array.isArray(e.clickIds)) {
      for (const id of e.clickIds) touched.add(id);
      if (e.importKey) imports.set(e.importKey, e);
    } else if (e.type === 'bot' && e.campaign && timeKey(e.at) !== null) bots.push(e);
    // «Очистка статистики» deletes a campaign's postback rows but keeps their journal lines (only the click lines go):
    // a postback of a campaign is replayed only while its click is still in the journal.
    else if ((e.type === 'postback_in' || e.type === 'postback_out') && timeKey(e.at) !== null && (!e.campaign || clicks.has(e.clickId))) postbacks.push(e);
  }

  // 1. Missing clicks.
  for (const ids of chunks([...tailClicks], 5000)) {
    checkpoint();
    const { rows } = await db.query('SELECT click_id::text AS id FROM clicks WHERE click_id = ANY($1::uuid[])', [ids]);
    const present = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !present.has(id));
    for (const part of chunks(missing)) {
      checkpoint();
      const data = part.map((id) => {
        const values = clickValues(clicks.get(id), clicks.get(id).at);
        values[10] = values[10] === null ? null : JSON.parse(values[10]);
        return Object.fromEntries(CLICK_COLUMNS.map((column, i) => [column, values[i]]));
      });
      const columns = CLICK_COLUMNS.map((c) => [c, CLICK_TYPES[c] || 'text']);
      const result = await db.query(`INSERT INTO clicks (${CLICK_COLUMNS.join(', ')})
        SELECT ${CLICK_COLUMNS.map((c) => `r."${c}"`).join(', ')} FROM jsonb_to_recordset($1::jsonb) AS r(${recordset(columns)})
        ON CONFLICT DO NOTHING`, [JSON.stringify(data)]);
      counts.clicks += result.rowCount;
    }
  }

  // 2. Conversions: the latest event of each (click, tid) the tail touched.
  for (const keys of chunks([...tailConversions])) {
    checkpoint();
    const data = keys.map((key) => {
      const { first, latest, params } = conversions.get(key);
      return { click_id: latest.clickId, tid: conversionTid(latest.tid), revenue: latest.revenue ?? null, currency: latest.currency ?? null,
        status: latest.status || 'sale', params: params || null, created_at: first.at, updated_at: first === latest ? null : latest.at,
        event_id: UUID.test(latest.id || '') ? latest.id : null, revenue_ignored: latest.revenueIgnored === true };
    });
    const result = await db.query(`INSERT INTO conversions (click_id, tid, revenue, currency, status, params, created_at, updated_at, event_id, revenue_ignored)
      SELECT r.click_id, r.tid, r.revenue, r.currency, r.status, r.params, r.created_at, r.updated_at, r.event_id, COALESCE(r.revenue_ignored, false)
      FROM jsonb_to_recordset($1::jsonb) AS r(click_id uuid, tid text, revenue numeric, currency text, status text, params jsonb,
        created_at timestamptz, updated_at timestamptz, event_id uuid, revenue_ignored boolean)
      WHERE EXISTS (SELECT 1 FROM clicks c WHERE c.click_id = r.click_id)
      ON CONFLICT (click_id, tid) DO UPDATE
      SET revenue = EXCLUDED.revenue, currency = EXCLUDED.currency, status = EXCLUDED.status, revenue_ignored = EXCLUDED.revenue_ignored,
        params = COALESCE(EXCLUDED.params, conversions.params), updated_at = COALESCE(EXCLUDED.updated_at, EXCLUDED.created_at), event_id = EXCLUDED.event_id
      WHERE (EXCLUDED.event_id IS NULL OR conversions.event_id IS DISTINCT FROM EXCLUDED.event_id)
        AND COALESCE(conversions.updated_at, conversions.created_at) <= COALESCE(EXCLUDED.updated_at, EXCLUDED.created_at)`, [JSON.stringify(data)]);
    counts.conversions += result.rowCount;
  }

  // 3. Click state: first landing click, params with postback sub_id_N, cost after manual updates.
  for (const ids of chunks([...touched].filter((id) => clicks.has(id)))) {
    checkpoint();
    const data = ids.map((id) => ({ click_id: id, params: clickParams.get(id) ?? null, cost: clickCost.get(id) ?? 0, lp: lpFirst.get(id) ?? null }));
    const result = await db.query(`UPDATE clicks c SET
        params = COALESCE(r.params, c.params),
        cost = round(r.cost, 6),
        lp_clicked_at = COALESCE(c.lp_clicked_at, r.lp)
      FROM jsonb_to_recordset($1::jsonb) AS r(click_id uuid, params jsonb, cost numeric, lp timestamptz)
      WHERE c.click_id = r.click_id AND (
        (r.params IS NOT NULL AND c.params IS DISTINCT FROM r.params)
        OR c.cost IS DISTINCT FROM round(r.cost, 6)
        OR (c.lp_clicked_at IS NULL AND r.lp IS NOT NULL))`, [JSON.stringify(data)]);
    counts.clickState += result.rowCount;
  }

  // 4. Bots and postbacks: insert the events no row stands for.
  async function missingRows(list, table, legacyKey, rowKey, legacyColumns) {
    const out = [];
    for (const part of chunks(list, 2000)) {
      checkpoint();
      const ids = part.map((e) => e.id).filter((id) => UUID.test(id || ''));
      const { rows: withId } = ids.length ? await db.query(`SELECT event_id::text AS id FROM ${table} WHERE event_id = ANY($1::uuid[])`, [ids]) : { rows: [] };
      const known = new Set(withId.map((r) => r.id));
      const times = [...new Set(part.map((e) => new Date(timeKey(e.at)).toISOString()))];
      const { rows: legacy } = await db.query(`SELECT ${legacyColumns}, created_at FROM ${table} WHERE event_id IS NULL AND created_at = ANY($1::timestamptz[])`, [times]);
      const legacyKeys = new Map();
      for (const r of legacy) { const k = rowKey(r); legacyKeys.set(k, (legacyKeys.get(k) || 0) + 1); }
      for (const e of part) {
        if (known.has(e.id)) continue;
        const k = legacyKey(e);
        if (legacyKeys.get(k)) { legacyKeys.set(k, legacyKeys.get(k) - 1); continue; }
        out.push(e);
      }
    }
    return out;
  }
  const botKey = (campaign, ms, ip) => `${campaign}|${ms}|${ip ?? ''}`;
  const missingBots = await missingRows(bots, 'bots', (e) => botKey(e.campaign, timeKey(e.at), e.ip), (r) => botKey(r.campaign, new Date(r.created_at).getTime(), r.ip), 'campaign, ip');
  for (const part of chunks(missingBots)) {
    checkpoint();
    const data = part.map((e) => ({ campaign: e.campaign, offer_id: e.offerId ?? null, stream: e.stream ?? null, user_agent: e.userAgent ?? null, ip: e.ip ?? null,
      reason: e.reason ?? null, isp: e.isp ?? null, created_at: e.at, event_id: UUID.test(e.id || '') ? e.id : null }));
    const result = await db.query(`INSERT INTO bots (campaign, offer_id, stream, user_agent, ip, reason, isp, created_at, event_id)
      SELECT r.campaign, r.offer_id, r.stream, r.user_agent, r.ip, r.reason, r.isp, r.created_at, r.event_id
      FROM jsonb_to_recordset($1::jsonb) AS r(campaign text, offer_id text, stream text, user_agent text, ip text, reason text, isp text, created_at timestamptz, event_id uuid)
      ON CONFLICT (event_id) DO NOTHING`, [JSON.stringify(data)]);
    counts.bots += result.rowCount;
  }
  const direction = (e) => (e.type === 'postback_in' ? 'in' : 'out');
  const pbKey = (dir, ms, clickId, url) => `${dir}|${ms}|${clickId ?? ''}|${url ?? ''}`;
  const missingPostbacks = await missingRows(postbacks, 'postbacks', (e) => pbKey(direction(e), timeKey(e.at), e.clickId, e.url),
    (r) => pbKey(r.direction, new Date(r.created_at).getTime(), r.click_id, r.url), 'direction, click_id, url');
  for (const part of chunks(missingPostbacks)) {
    checkpoint();
    const data = part.map((e) => ({ direction: direction(e), click_id: e.clickId ?? null, campaign: e.campaign ?? null, offer_id: e.offerId ?? null, tid: e.tid ?? null,
      status: e.status ?? null, revenue: e.revenue === null || e.revenue === undefined ? null : String(e.revenue), currency: e.currency ?? null, url: e.url ?? null,
      status_code: e.statusCode ?? null, error: e.error ?? null, attempt: e.attempt ?? null, ip: e.ip ?? null, created_at: e.at, event_id: UUID.test(e.id || '') ? e.id : null }));
    const result = await db.query(`INSERT INTO postbacks (direction, click_id, campaign, offer_id, tid, status, revenue, currency, url, status_code, error, attempt, ip, created_at, event_id)
      SELECT r.direction, r.click_id, r.campaign, r.offer_id, r.tid, r.status, r.revenue, r.currency, r.url, r.status_code, r.error, r.attempt, r.ip, r.created_at, r.event_id
      FROM jsonb_to_recordset($1::jsonb) AS r(direction text, click_id text, campaign text, offer_id text, tid text, status text, revenue text, currency text, url text,
        status_code integer, error text, attempt integer, ip text, created_at timestamptz, event_id uuid)
      ON CONFLICT (event_id) DO NOTHING`, [JSON.stringify(data)]);
    counts.postbacks += result.rowCount;
  }

  // 5. Cost imports: the latest import of each key.
  for (const e of imports.values()) {
    checkpoint();
    const result = await db.query(COST_IMPORT_UPSERT, [e.importKey, e.campaign ?? '', e.clickIds || [], e.importCost ?? 0, e.at]);
    counts.costImports += result.rowCount;
  }
  return counts;
}
