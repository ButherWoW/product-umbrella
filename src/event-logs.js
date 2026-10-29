import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const invalid = (field) => Object.assign(new Error(`invalid_${field}`), { statusCode: 400 });

function integer(params, key, fallback, minimum, maximum) {
  const raw = params.get(key);
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw invalid(key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw invalid(key);
  return Math.min(value, maximum);
}

function date(params, key) {
  const value = params.get(key) || null;
  if (!value) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString().slice(0, 10) !== value) throw invalid(key);
  return timestamp;
}

export function parseLogQuery(params) {
  const from = date(params, 'from');
  const to = date(params, 'to');
  if (from !== null && to !== null && from > to) throw invalid('date_range');
  const text = (key) => {
    const value = params.get(key) || null;
    if (value && value.length > 120) throw invalid(key);
    return value;
  };
  return { campaign: text('campaign'), offer: text('offer'), stream: text('stream'), click: text('click'),
    from, until: to === null ? null : to + 86400000,
    limit: integer(params, 'limit', 50, 1, 100), offset: integer(params, 'offset', 0, 0, 1000000000) };
}

function iso(value) {
  if (!value) return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function normalizeClick(item) {
  const clickId = item.clickId ?? item.click_id;
  const offerId = item.offerId ?? item.offer_id ?? null;
  const at = iso(item.at ?? item.created_at);
  const userAgent = item.userAgent ?? item.user_agent ?? null;
  return { type: 'click', clickId, campaign: item.campaign ?? null, offerId,
    at, stream: item.stream || 'default', path: item.path ?? null,
    referrer: item.referrer ?? null, userAgent, subid: item.subid ?? null,
    country: item.country ?? null, ip: item.ip ?? null,
    params: item.params ?? null, cost: Number(item.cost) || 0,
    landingId: item.landingId ?? item.landing_id ?? null,
    device: item.device ?? null, os: item.os ?? null, browser: item.browser ?? null, language: item.language ?? null, isp: item.isp ?? null, connection: item.connection ?? null,
    uniqueCampaign: item.uniqueCampaign ?? item.is_unique_campaign ?? null, uniqueStream: item.uniqueStream ?? item.is_unique_stream ?? null,
    uniqueGlobal: item.uniqueGlobal ?? item.is_unique_global ?? null,
    // Compatibility aliases for clients of the original PostgreSQL API.
    click_id: clickId, offer_id: offerId, created_at: at, user_agent: userAgent };
}

function normalizeConversion(item, click = item) {
  const clickId = item.clickId ?? item.click_id;
  const offerId = click.offerId ?? click.offer_id ?? null;
  const at = iso(item.at ?? item.created_at);
  const revenue = item.revenue === null || item.revenue === undefined ? null : Number(item.revenue);
  return { type: 'conversion', clickId, campaign: click.campaign ?? null,
    offerId, at, stream: click.stream || 'default', revenue: Number.isFinite(revenue) ? revenue : null, status: item.status || 'sale',
    currency: item.currency ?? null, click_id: clickId, offer_id: offerId, created_at: at };
}

function matches(item, query) {
  if (query.campaign && item.campaign !== query.campaign) return false;
  if (query.allowed && !query.allowed.includes(item.campaign)) return false;
  if (query.offer && item.offerId !== query.offer) return false;
  if (query.stream && item.stream !== query.stream) return false;
  if (query.click && item.clickId !== query.click) return false;
  const at = item.at ? Date.parse(item.at) : NaN;
  if (query.from !== null && (!Number.isFinite(at) || at < query.from)) return false;
  if (query.until !== null && (!Number.isFinite(at) || at >= query.until)) return false;
  return true;
}

async function fromJsonl(kind, query, eventsFile) {
  const input = createReadStream(eventsFile, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const clicks = new Map();
  const events = [];
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      if (!item || typeof item !== 'object' || typeof item.clickId !== 'string') continue;
      if (item.type === 'click') {
        if (kind === 'clicks') events.push(normalizeClick(item));
        else clicks.set(item.clickId, item);
      } else if (kind === 'conversions' && item.type === 'conversion') events.push(item);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  const rows = (kind === 'clicks' ? events
    : events.map((item) => normalizeConversion(item, clicks.get(item.clickId) || {})))
    .filter((item) => matches(item, query))
    .sort((a, b) => (b.at || '').localeCompare(a.at || '') || String(b.clickId).localeCompare(String(a.clickId)));
  return rows.slice(query.offset, query.offset + query.limit + 1);
}

async function fromPostgres(kind, query, db) {
  const conditions = [], params = [];
  const add = (sql, value) => { params.push(value); conditions.push(`${sql} $${params.length}`); };
  if (query.campaign) add('c.campaign =', query.campaign);
  if (query.allowed) { params.push(query.allowed); conditions.push(`c.campaign = ANY($${params.length}::text[])`); }
  if (query.offer) add('c.offer_id =', query.offer);
  if (query.stream) add("COALESCE(NULLIF(c.stream, ''), 'default') =", query.stream);
  if (query.click) add('c.click_id =', query.click);
  const timestamp = kind === 'clicks' ? 'c.created_at' : 'cv.created_at';
  if (query.from !== null) add(`${timestamp} >=`, new Date(query.from).toISOString());
  if (query.until !== null) add(`${timestamp} <`, new Date(query.until).toISOString());
  params.push(query.limit + 1, query.offset);
  const fields = kind === 'clicks'
    ? 'c.click_id, c.campaign, c.offer_id, c.stream, c.path, c.referrer, c.user_agent, c.subid, c.country, c.ip, c.params, c.cost, c.landing_id, c.device, c.os, c.browser, c.language, c.isp, c.connection, c.is_unique_campaign, c.is_unique_stream, c.is_unique_global, c.created_at'
    : 'cv.click_id, c.campaign, c.offer_id, c.stream, cv.revenue, cv.currency, cv.status, cv.created_at';
  const source = kind === 'clicks' ? 'clicks c' : 'conversions cv JOIN clicks c USING (click_id)';
  const { rows } = await db.query(`SELECT ${fields} FROM ${source}
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY ${timestamp} DESC, c.click_id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return rows.map((row) => kind === 'clicks' ? normalizeClick(row) : normalizeConversion(row));
}

export async function readEventLog({ kind, params, eventsFile, db = null, onFallback = () => {}, allowedCampaigns = null }) {
  if (!['clicks', 'conversions'].includes(kind)) throw new Error('unsupported_log_kind');
  // allowedCampaigns: a buyer's own campaigns (null = no restriction).
  const query = { ...parseLogQuery(params), allowed: allowedCampaigns };
  let rows, storage = 'jsonl';
  if (db) {
    try { rows = await fromPostgres(kind, query, db); storage = 'postgres'; }
    catch (error) { onFallback(error); }
  }
  if (!rows) rows = await fromJsonl(kind, query, eventsFile);
  const hasMore = rows.length > query.limit;
  return { [kind]: rows.slice(0, query.limit), limit: query.limit, offset: query.offset,
    hasMore, nextOffset: hasMore ? query.offset + query.limit : null, storage };
}
