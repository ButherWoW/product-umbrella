// In-memory indexes over the JSONL journal, so the click path (/r, /lp/click, /postback) never reads the whole file.
// Built once at startup by streaming the journal and kept current by observe() on every append (src/server.js event()).
// Reports still scan the journal, but stream it line by line and one scan at a time (createScanQueue).
//
// Single process only: counters and indexes live in this process. Running several instances behind a balancer
// would need the cap reservation in the database (e.g. a counter row updated with UPDATE … RETURNING).
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export const utcDay = (at) => String(at || '').slice(0, 10);
const conversionTid = (raw) => (raw === null || raw === undefined ? '' : String(raw).trim().slice(0, 200));

// Calls onLine(line) for every non-empty journal line, streaming (memory stays at one chunk). Missing file = empty.
export async function scanJournalLines(eventsFile, onLine) {
  let input;
  try {
    input = createReadStream(eventsFile, { encoding: 'utf8', highWaterMark: 256 * 1024 });
    await new Promise((resolve, reject) => { input.once('open', resolve); input.once('error', reject); });
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for await (const line of createInterface({ input, crlfDelay: Infinity })) if (line) onLine(line);
}

// Parsed journal records (unreadable lines skipped). `types` keeps only those event types, which keeps big
// reports from holding bots, postbacks and audit events they do not use.
export async function readJournalRecords(eventsFile, types = null) {
  const wanted = types ? new Set(types) : null;
  // Cheap pre-filter before JSON.parse: the quoted type value must appear somewhere in the line.
  const needles = types ? types.map((type) => `"${type}"`) : null;
  const out = [];
  await scanJournalLines(eventsFile, (line) => {
    if (needles && !needles.some((needle) => line.includes(needle))) return;
    let item;
    try { item = JSON.parse(line); } catch { return; }
    if (item && typeof item === 'object' && (!wanted || wanted.has(item.type))) out.push(item);
  });
  return out;
}

// Runs report scans one at a time (FIFO), so parallel reports neither multiply memory nor starve /r.
export function createScanQueue() {
  let tail = Promise.resolve();
  return {
    run(task) {
      const result = tail.then(() => task());
      tail = result.catch(() => {});
      return result;
    },
  };
}

// Bounded map with least-recently-used eviction.
function lruSet(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) { map.delete(map.keys().next().value); return true; }
  return false;
}

// The fields of a click that /lp/click, postbacks and source postbacks use.
function clickSummary(item) {
  return { campaign: item.campaign, offerId: item.offerId, at: item.at, landingId: item.landingId ?? null, subid: item.subid ?? null,
    country: item.country ?? null, ...(item.params ? { params: item.params } : {}), cost: Number(item.cost) || 0 };
}

export function createJournalIndex({ clickLimit = 200000, visitorLimit = 200000 } = {}) {
  let counts, clicks, lastClick, conversions, offerConversions, sourcePostbacks, clicksEvicted;
  function reset() {
    counts = new Map(); // c|campaign|day, o|offer|day, t|campaign → clicks
    clicks = new Map(); // clickId → click summary (LRU)
    lastClick = new Map(); // campaign|ip → ms of the latest click (LRU)
    conversions = new Map(); // clickId|tid → { clickId, offerId, status, revenue, currency, firstAt }
    offerConversions = new Map(); // offerId → Set of conversion keys
    sourcePostbacks = new Set(); // clickId|status
    clicksEvicted = false;
  }
  reset();
  const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);

  function observe(item) {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'click' && item.clickId) {
      const day = utcDay(item.at);
      bump(`c|${item.campaign}|${day}`); bump(`o|${item.offerId}|${day}`); bump(`t|${item.campaign}`);
      if (item.ip) {
        const at = Date.parse(item.at);
        const key = `${item.campaign}|${item.ip}`;
        if (Number.isFinite(at) && !(lastClick.get(key) > at)) lruSet(lastClick, key, at, visitorLimit);
      }
      if (lruSet(clicks, item.clickId, clickSummary(item), clickLimit)) clicksEvicted = true;
    } else if (item.type === 'conversion' && item.clickId) {
      const key = `${item.clickId}|${conversionTid(item.tid)}`;
      const prev = conversions.get(key);
      const click = clicks.get(item.clickId);
      // sub_id_N from the postback overwrite the click's parameters (as the PostgreSQL mirror does).
      if (click && item.params && typeof item.params === 'object') click.params = { ...(click.params || {}), ...item.params };
      const offerId = prev?.offerId ?? click?.offerId ?? null;
      conversions.set(key, { clickId: item.clickId, offerId, status: item.status || 'sale', revenue: item.revenue ?? null,
        currency: item.currency ?? null, firstAt: prev?.firstAt ?? item.at });
      if (offerId !== null) {
        let set = offerConversions.get(offerId);
        if (!set) offerConversions.set(offerId, (set = new Set()));
        set.add(key);
      }
    } else if (item.type === 'cost_update' && Array.isArray(item.clickIds)) {
      for (const id of item.clickIds) { const click = clicks.get(id); if (click) click.cost = Number(item.cost) || 0; }
      if (item.lastClickId) { const click = clicks.get(item.lastClickId); if (click) click.cost = Number(item.lastCost) || 0; }
    } else if (item.type === 'source_postback' && item.clickId) {
      sourcePostbacks.add(`${item.clickId}|${item.status}`);
    }
  }

  // Rebuilds everything from the journal (startup, and after clearing statistics or retention rewrote it).
  async function build(eventsFile) {
    reset();
    let missingOffer = 0;
    await scanJournalLines(eventsFile, (line) => {
      let item;
      try { item = JSON.parse(line); } catch { return; }
      observe(item);
      if (item?.type === 'conversion' && !clicks.has(item.clickId)) missingOffer += 1;
    });
    // Conversions of clicks that had already left the LRU when the conversion was read: one more pass
    // finds their offers (needed for the offer conversion cap).
    if (missingOffer) {
      const unresolved = new Map();
      for (const [key, cv] of conversions) if (cv.offerId === null) unresolved.set(cv.clickId, [...(unresolved.get(cv.clickId) || []), key]);
      if (unresolved.size) {
        await scanJournalLines(eventsFile, (line) => {
          if (!line.includes('"click"')) return;
          let item;
          try { item = JSON.parse(line); } catch { return; }
          const keys = item?.type === 'click' && unresolved.get(item.clickId);
          if (!keys) return;
          for (const key of keys) {
            conversions.get(key).offerId = item.offerId;
            let set = offerConversions.get(item.offerId);
            if (!set) offerConversions.set(item.offerId, (set = new Set()));
            set.add(key);
          }
          unresolved.delete(item.clickId);
        });
      }
    }
  }

  return {
    observe,
    build,
    count: (key) => counts.get(key) || 0,
    // Click summary, `undefined` when unknown. `complete` says whether a miss is final (nothing was evicted).
    click: (clickId) => { const click = clicks.get(clickId); if (click) lruSet(clicks, clickId, click, clickLimit); return click; },
    get complete() { return !clicksEvicted; },
    remember: (clickId, item) => { if (item && lruSet(clicks, clickId, clickSummary(item), clickLimit)) clicksEvicted = true; },
    lastClickAt: (campaign, ip) => lastClick.get(`${campaign}|${ip}`) ?? null,
    markClick: (campaign, ip, at = Date.now()) => { if (ip) lruSet(lastClick, `${campaign}|${ip}`, at, visitorLimit); },
    // Latest conversion of a click and tid ({ status, revenue, currency }) or null; all conversions are indexed.
    conversion: (clickId, tid = '') => {
      const cv = conversions.get(`${clickId}|${conversionTid(tid)}`);
      return cv ? { status: cv.status, revenue: cv.revenue, currency: cv.currency } : null;
    },
    hasSourcePostback: (clickId, status) => sourcePostbacks.has(`${clickId}|${status}`),
    // Offer conversion cap: conversions whose latest status is lead or sale and whose first postback is at or after sinceMs.
    conversionCapCount: (offerId, sinceMs) => {
      let n = 0;
      for (const key of offerConversions.get(offerId) || []) {
        const cv = conversions.get(key);
        if (cv && (cv.status === 'lead' || cv.status === 'sale') && Date.parse(cv.firstAt) >= sinceMs) n += 1;
      }
      return n;
    },
    stats: () => ({ clicks: clicks.size, visitors: lastClick.size, conversions: conversions.size, counters: counts.size }),
  };
}

// Click counters for caps (campaign daily, offer daily, campaign total). Each key is seeded once from storage
// (PostgreSQL or the journal index) and refreshed in the background after `ttlMs`; clicks are reserved
// synchronously at decision time, so concurrent clicks see each other and a cap is never overrun.
// A reservation also counts as "not yet in storage" until settle(), so a refresh that races the
// PostgreSQL mirror adds it back instead of losing it (it may count it twice for a moment — the safe side).
export function createClickCounters({ seed, ttlMs = 60000, now = Date.now, maxIdleMs = 3600000 }) {
  const entries = new Map(); // key → { n, at, used, unsettled, during, loading }
  let lastPrune = now();

  function prune(t) {
    if (t - lastPrune < 60000) return;
    lastPrune = t;
    for (const [key, e] of entries) if (!e.loading && !e.unsettled && t - e.used > maxIdleMs) entries.delete(key);
  }

  function refresh(key, e) {
    const unsettled = e.unsettled;
    e.during = 0;
    e.loading = (async () => {
      try {
        const base = await seed(key);
        e.n = base + unsettled + e.during;
        e.at = now();
      } catch (error) {
        if (e.n === null) { entries.delete(key); throw error; }
        e.at = now(); // keep the previous value; the next refresh tries again
      } finally { e.loading = null; }
    })();
    return e.loading;
  }

  // Makes sure every key has a value; waits only for keys never seen before.
  async function ensure(keys) {
    const t = now();
    prune(t);
    const waits = [];
    for (const key of keys) {
      let e = entries.get(key);
      if (!e) { e = { n: null, at: 0, used: t, unsettled: 0, during: 0, loading: null }; entries.set(key, e); }
      e.used = t;
      if (e.loading) { if (e.n === null) waits.push(e.loading); continue; }
      if (e.n === null) waits.push(refresh(key, e));
      else if (t - e.at >= ttlMs) refresh(key, e).catch(() => {});
    }
    await Promise.all(waits);
  }

  const get = (key) => entries.get(key)?.n ?? 0;

  // Counts one click on every key that has a counter (keys without one are seeded later from storage, which has it).
  function reserve(keys) {
    const held = [];
    for (const key of keys) {
      const e = entries.get(key);
      if (!e || e.n === null) continue;
      e.n += 1; e.unsettled += 1;
      if (e.loading) e.during += 1;
      held.push(e);
    }
    let done = false;
    return {
      // The click is in storage now (journal written, or the PostgreSQL mirror has it).
      settle() { if (done) return; done = true; for (const e of held) e.unsettled = Math.max(0, e.unsettled - 1); },
      // The click was not recorded after all.
      release() { if (done) return; done = true; for (const e of held) { e.n = Math.max(0, e.n - 1); e.unsettled = Math.max(0, e.unsettled - 1); } },
    };
  }

  return { ensure, get, reserve, clear: () => entries.clear() };
}

// Finds clicks that are no longer in the index by streaming the journal. Lookups that arrive while a scan is
// queued join it, so any number of requests for old (or unknown) click ids costs at most one running and one
// queued pass over the file.
export function createOldClickLookup(eventsFile, queue) {
  let batch = null;
  return function lookup(clickId) {
    if (!batch) {
      const current = batch = { ids: new Set(), promise: null };
      current.promise = queue.run(async () => {
        batch = null; // later lookups start the next pass
        const found = new Map();
        await scanJournalLines(eventsFile, (line) => {
          const id = /"clickId"\s*:\s*"([^"]+)"/.exec(line)?.[1];
          if (!id || !current.ids.has(id)) return;
          try { const item = JSON.parse(line); if (item.type === 'click' && item.clickId === id) found.set(id, item); } catch { /* skip */ }
        });
        return found;
      });
    }
    batch.ids.add(clickId);
    return batch.promise.then((found) => found.get(clickId) || null);
  };
}
