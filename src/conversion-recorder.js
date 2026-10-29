import { readFile } from 'node:fs/promises';

const CLICK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(statusCode, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

// Keitaro-style conversion statuses. Networks use many words; unknown ones are rejected rather than guessed.
const STATUS_ALIASES = {
  lead: 'lead', pending: 'lead', hold: 'lead', new: 'lead', processing: 'lead', waiting: 'lead',
  sale: 'sale', approved: 'sale', approve: 'sale', confirmed: 'sale', paid: 'sale', success: 'sale', accepted: 'sale',
  rejected: 'rejected', reject: 'rejected', declined: 'rejected', decline: 'rejected', cancel: 'rejected', canceled: 'rejected', cancelled: 'rejected', refund: 'rejected', chargeback: 'rejected',
  trash: 'trash', fraud: 'trash', invalid: 'trash', duplicate: 'trash', spam: 'trash',
};
export const CONVERSION_STATUSES = ['lead', 'sale', 'rejected', 'trash'];

export function normalizeStatus(raw) {
  if (raw === null || raw === undefined || raw === '') return 'sale';
  const status = STATUS_ALIASES[String(raw).trim().toLowerCase()];
  if (!status) throw failure(400, 'invalid_status');
  return status;
}

// Latest conversion of a click ({ status, revenue, currency }) or null. Rows written before statuses existed are sales.
export async function findRecordedConversion({ clickId, tid = null, eventsFile, db = null, onFallback = () => {} }) {
  if (db) {
    try {
      const { rows } = await db.query('SELECT status, revenue, currency FROM conversions WHERE click_id = $1 AND tid IS NOT DISTINCT FROM $2 ORDER BY created_at DESC LIMIT 1', [clickId, tid]);
      if (rows.length) return { status: rows[0].status || 'sale', revenue: rows[0].revenue === null ? null : Number(rows[0].revenue), currency: rows[0].currency };
    } catch (error) { onFallback(error); }
  }
  let latest = null;
  try {
    for (const line of (await readFile(eventsFile, 'utf8')).split('\n')) {
      if (!line.includes(clickId)) continue;
      try { const item = JSON.parse(line); if (item?.type === 'conversion' && item.clickId === clickId && (item.tid ?? null) === (tid ?? null)) latest = item; } catch { /* skip */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return latest ? { status: latest.status || 'sale', revenue: latest.revenue ?? null, currency: latest.currency ?? null } : null;
}

export async function hasRecordedConversion({ clickId, tid = null, eventsFile, db = null, onFallback = () => {} }) {
  if (db) {
    try {
      const { rows } = await db.query('SELECT 1 FROM conversions WHERE click_id = $1 AND tid IS NOT DISTINCT FROM $2', [clickId, tid]);
      if (rows.length) return true;
      // PostgreSQL is an asynchronous mirror: a successful empty result does not
      // prove that the source JSONL journal has no conversion yet.
    } catch (error) { onFallback(error); }
  }
  try {
    const lines = (await readFile(eventsFile, 'utf8')).split('\n');
    return lines.some((line) => {
      try { const item = JSON.parse(line); return item?.type === 'conversion' && item.clickId === clickId && (item.tid ?? null) === (tid ?? null); }
      catch { return false; }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// One queue per click; unrelated clicks continue concurrently. Entries are removed
// after completion. This is a single-process lock, not a distributed database lock.
export function createKeyedLock() {
  const pending = new Map();
  return async (key, action) => {
    const previous = pending.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    pending.set(key, tail);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (pending.get(key) === tail) pending.delete(key);
    }
  };
}

export function conversionValues(rawRevenue, rawCurrency) {
  const amount = rawRevenue === null || rawRevenue === undefined || rawRevenue === '' ? null : String(rawRevenue);
  // Matches PostgreSQL NUMERIC(12,4): at most eight integer and four fractional digits.
  if (amount !== null && !/^\d{1,8}(?:\.\d{1,4})?$/.test(amount)) throw failure(400, 'invalid_revenue');
  const revenue = amount === null ? null : Number(amount);
  const currency = rawCurrency === null || rawCurrency === undefined || rawCurrency === '' ? null : String(rawCurrency).toUpperCase();
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw failure(400, 'invalid_currency');
  return { revenue, currency };
}

export function createConversionRecorder({ findClick, hasConversion, currentConversion = null, record, windowDaysForClick = () => null,
  onRecorded = () => {}, onDeliveryError = () => {}, now = Date.now }) {
  const lock = createKeyedLock();
  return async ({ clickId, tid: rawTid = null, revenue: rawRevenue, currency: rawCurrency, status: rawStatus, params = null }) => {
    if (!clickId) throw failure(400, 'click_id_required');
    if (typeof clickId !== 'string' || !CLICK_ID.test(clickId)) throw failure(400, 'invalid_click_id');
    const id = clickId.toLowerCase();
    const tid = rawTid === null || rawTid === '' ? null : String(rawTid).slice(0, 200);
    return lock(`${id}:${tid || ''}`, async () => {
      const click = await findClick(id);
      if (!click) throw failure(404, 'click_not_found');
      const status = normalizeStatus(rawStatus);
      const existing = currentConversion ? await currentConversion(id, tid) : ((await hasConversion(id, tid)) ? { status: 'sale' } : null);
      // Same status again is a duplicate; a different status is an update (lead → sale, sale → rejected, …).
      if (existing && (existing.status || 'sale') === status) throw failure(409, 'conversion_already_recorded');
      const windowDays = existing ? null : windowDaysForClick(click);
      if (windowDays) {
        const clickedAt = Date.parse(click.at);
        if (!Number.isFinite(clickedAt)) throw failure(409, 'click_timestamp_invalid');
        if (now() - clickedAt > windowDays * 86400000)
          throw failure(409, 'conversion_window_expired', { conversionWindowDays: windowDays });
      }
      const values = conversionValues(rawRevenue, rawCurrency);
      // A status-only update (no amount) keeps the amount reported earlier.
      if (values.revenue === null && existing?.revenue !== null && existing?.revenue !== undefined) {
        values.revenue = existing.revenue;
        values.currency = values.currency ?? existing.currency ?? null;
      }
      // Without an explicit status a first conversion is written exactly as before statuses existed (implicitly a sale).
      const explicit = rawStatus !== null && rawStatus !== undefined && rawStatus !== '';
      const payload = { clickId: id, tid, params, ...values, ...(explicit || existing ? { status } : {}), ...(existing ? { previousStatus: existing.status || 'sale' } : {}) };
      // Duplicate check and successful JSONL append are inside the same lock.
      // Record failures release the lock and leave the click retryable.
      const recorded = await record(payload);
      try { await onRecorded({ ...payload, click, recorded }); }
      catch (error) { onDeliveryError(error); }
      if (existing) return { ok: true, status, updated: true };
      return explicit ? { ok: true, status } : { ok: true };
    });
  };
}
