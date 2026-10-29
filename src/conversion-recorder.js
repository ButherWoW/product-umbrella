import { readFile } from 'node:fs/promises';

const CLICK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(statusCode, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

export async function hasRecordedConversion({ clickId, eventsFile, db = null, onFallback = () => {} }) {
  if (db) {
    try {
      const { rows } = await db.query('SELECT 1 FROM conversions WHERE click_id = $1', [clickId]);
      if (rows.length) return true;
      // PostgreSQL is an asynchronous mirror: a successful empty result does not
      // prove that the source JSONL journal has no conversion yet.
    } catch (error) { onFallback(error); }
  }
  try {
    const lines = (await readFile(eventsFile, 'utf8')).split('\n');
    return lines.some((line) => {
      try { const item = JSON.parse(line); return item?.type === 'conversion' && item.clickId === clickId; }
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

export function createConversionRecorder({ findClick, hasConversion, record, windowDaysForClick = () => null,
  onRecorded = () => {}, onDeliveryError = () => {}, now = Date.now }) {
  const lock = createKeyedLock();
  return async ({ clickId, revenue: rawRevenue, currency: rawCurrency }) => {
    if (!clickId) throw failure(400, 'click_id_required');
    if (typeof clickId !== 'string' || !CLICK_ID.test(clickId)) throw failure(400, 'invalid_click_id');
    const id = clickId.toLowerCase();
    return lock(id, async () => {
      const click = await findClick(id);
      if (!click) throw failure(404, 'click_not_found');
      if (await hasConversion(id)) throw failure(409, 'conversion_already_recorded');
      const windowDays = windowDaysForClick(click);
      if (windowDays) {
        const clickedAt = Date.parse(click.at);
        if (!Number.isFinite(clickedAt)) throw failure(409, 'click_timestamp_invalid');
        if (now() - clickedAt > windowDays * 86400000)
          throw failure(409, 'conversion_window_expired', { conversionWindowDays: windowDays });
      }
      const values = conversionValues(rawRevenue, rawCurrency);
      const payload = { clickId: id, ...values };
      // Duplicate check and successful JSONL append are inside the same lock.
      // Record failures release the lock and leave the click retryable.
      await record(payload);
      try { await onRecorded({ ...payload, click }); }
      catch (error) { onDeliveryError(error); }
      return { ok: true };
    });
  };
}
