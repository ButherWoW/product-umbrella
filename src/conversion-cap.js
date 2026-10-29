import { readFile } from 'node:fs/promises';

// Offer conversion cap (Keitaro «Кап конверсий» + «Альтернативный оффер»).
// Counted: conversions whose latest status is lead or sale, by the time of the first postback of the click,
// for clicks recorded with this offer, since local midnight in the offer's time zone.

// UTC offset (ms) of a time zone at a given instant: wall clock read as UTC minus the instant.
export function zoneOffset(tz, ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(ms / 1000) * 1000;
}

// Instant (ms) of 00:00 local time on `date` (YYYY-MM-DD) in `tz`; a midnight skipped by DST → the first instant of that day.
export function zonedDayStart(date, tz) {
  const day = Date.parse(`${date}T00:00:00Z`);
  let guess = day - zoneOffset(tz, day);
  guess = day - zoneOffset(tz, guess);
  return guess;
}

// Instant of the last local midnight in `tz` at `now` (DST-safe: the offset is taken at midnight itself).
export function localMidnight(tz, now = new Date()) {
  const ms = now.getTime();
  const wall = ms + zoneOffset(tz, ms);
  const day = wall - (((wall % 86400000) + 86400000) % 86400000);
  let guess = day - zoneOffset(tz, day);
  guess = day - zoneOffset(tz, guess);
  // A midnight skipped by DST resolves to the first instant of the local day.
  return new Date(guess > ms ? guess - 3600000 : guess);
}

// Where traffic for `offerId` goes. `stateOf(id)` → null (usable) | 'missing' | 'archived' | 'click_cap' | 'conversion_cap'.
// Only a conversion-capped offer hands its traffic to `altOfferId`; the chain is followed up to `maxHops`,
// skipping unusable alternatives, and stops on a loop. Returns { offerId } (usable, maybe substituted) or { offerId: null, reason }.
export function resolveOffer(offerId, { stateOf, altOf, maxHops = 3 }) {
  const reason = stateOf(offerId);
  if (!reason) return { offerId, reason: null, path: [offerId] };
  if (reason !== 'conversion_cap') return { offerId: null, reason, path: [offerId] };
  const path = [offerId];
  let current = offerId;
  for (let hop = 0; hop < maxHops; hop++) {
    const next = altOf(current);
    if (!next || path.includes(next)) break;
    path.push(next);
    const state = stateOf(next);
    if (!state) return { offerId: next, reason, path };
    if (state === 'missing') break;
    current = next;
  }
  return { offerId: null, reason, path };
}

// Per-offer count of today's conversions, cached for `ttlMs` so /r does not query on every click.
// `countJournal(offerId, since)` (the in-memory journal index) replaces reading the journal file.
export function createConversionCapCounter({ db = null, eventsFile, countJournal = null, ttlMs = 30000, now = () => new Date(), onFallback = () => {} }) {
  const cache = new Map();

  async function countFromDb(offerId, since) {
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM conversions cv JOIN clicks c USING (click_id)
      WHERE c.offer_id = $1 AND cv.status IN ('lead', 'sale') AND cv.created_at >= $2`, [offerId, since]);
    return rows[0].n;
  }

  async function countFromJournal(offerId, since) {
    let text;
    try { text = await readFile(eventsFile, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    const sinceMs = since.getTime();
    const clicks = new Set();
    const conversions = new Map(); // clickId|tid → { clickId, firstAt, status } (upsells count like in PostgreSQL)
    for (const line of text.split('\n')) {
      if (!line.includes(offerId) && !line.includes('"conversion"')) continue;
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      if (item?.type === 'click' && item.offerId === offerId) clicks.add(item.clickId);
      else if (item?.type === 'conversion') {
        const key = `${item.clickId}|${item.tid || ''}`;
        const prev = conversions.get(key);
        conversions.set(key, { clickId: item.clickId, firstAt: prev?.firstAt ?? item.at, status: item.status || 'sale' });
      }
    }
    let n = 0;
    for (const cv of conversions.values()) if (clicks.has(cv.clickId) && ['lead', 'sale'].includes(cv.status) && Date.parse(cv.firstAt) >= sinceMs) n++;
    return n;
  }

  async function count(offerId, tz = 'UTC') {
    const at = now();
    const since = localMidnight(tz, at);
    const key = `${offerId}|${tz}`;
    const hit = cache.get(key);
    if (hit && hit.since === since.getTime() && at.getTime() - hit.at < ttlMs) return hit.n;
    let n = null;
    if (db) {
      try { n = await countFromDb(offerId, since); } catch (error) { onFallback(error); }
    }
    if (n === null) n = countJournal ? countJournal(offerId, since) : await countFromJournal(offerId, since);
    cache.set(key, { n, at: at.getTime(), since: since.getTime() });
    return n;
  }

  // Drop the cached count now and, when given, again once the PostgreSQL mirror has the conversion.
  function invalidate(offerId, settled = null) {
    const drop = () => { for (const key of cache.keys()) if (key.startsWith(`${offerId}|`)) cache.delete(key); };
    drop();
    settled?.then(drop, drop);
  }

  return { count, invalidate };
}
