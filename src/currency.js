// Exchange rates for reporting in any currency. Amounts stay stored in the currency the network sent;
// reports convert them at the current rate. Rates come from open.er-api.com (daily, no key) and are
// cached on disk so a restart or an outage of the source keeps the last known rates.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CODE = /^[A-Z]{3}$/;
export const RATES_SOURCE = 'https://open.er-api.com/v6/latest/EUR';

export function normalizeCurrency(raw, fallback) {
  const code = String(raw || '').trim().toUpperCase();
  return CODE.test(code) ? code : fallback;
}

export function createRates({ dataDir, defaultCurrency = 'EUR', refreshMs = 12 * 3600 * 1000, sourceUrl = RATES_SOURCE, fetchImpl = fetch, log = console }) {
  const cacheFile = join(dataDir, 'fx-rates.json');
  // Units of each currency per 1 EUR.
  let table = { base: 'EUR', rates: { EUR: 1 }, updatedAt: null, source: null };
  let timer = null;

  const valid = (data) => data && typeof data.rates === 'object'
    && Object.entries(data.rates).every(([k, v]) => CODE.test(k) && Number.isFinite(v) && v > 0);

  async function loadCache() {
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
      if (valid(cached)) table = cached;
    } catch (error) { if (error.code !== 'ENOENT') log.warn('[fx] cache unreadable:', error.message); }
  }

  async function refresh() {
    try {
      const res = await fetchImpl(sourceUrl, { signal: AbortSignal.timeout(15000) });
      const data = await res.json();
      if (!res.ok || data.result !== 'success' || !valid(data)) throw new Error(`unexpected response ${res.status}`);
      const base = normalizeCurrency(data.base_code, 'EUR');
      const perEur = base === 'EUR' ? data.rates : Object.fromEntries(Object.entries(data.rates).map(([k, v]) => [k, v / data.rates.EUR]));
      table = { base: 'EUR', rates: { ...perEur, EUR: 1 }, updatedAt: new Date((data.time_last_update_unix || Date.now() / 1000) * 1000).toISOString(), source: 'exchangerate-api.com' };
      await mkdir(dataDir, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(table) + '\n', { mode: 0o600 });
    } catch (error) { log.warn('[fx] refresh failed, keeping last rates:', error.message); }
  }

  // Multiplier that turns an amount in `from` into `to`. Unknown currencies are not converted (factor 1).
  function factor(from, to) {
    const f = normalizeCurrency(from, defaultCurrency);
    const t = normalizeCurrency(to, defaultCurrency);
    if (f === t) return 1;
    const rf = table.rates[f]; const rt = table.rates[t];
    return rf && rt ? rt / rf : 1;
  }

  // { CUR: factor } for every known currency, for SQL (`amount * factors[currency]`).
  function factors(to) {
    return Object.fromEntries(Object.keys(table.rates).map((code) => [code, factor(code, to)]));
  }

  return {
    defaultCurrency,
    // blocking: false — do not wait for the first network refresh (the cached rates are enough to start serving).
    async start({ blocking = true } = {}) {
      await loadCache();
      if (refreshMs > 0) {
        const first = refresh(); // never rejects: failures keep the last rates
        if (blocking) await first;
        timer = setInterval(refresh, refreshMs);
        timer.unref?.();
      }
    },
    stop() { if (timer) clearInterval(timer); },
    refresh,
    factor,
    factors,
    has: (code) => Boolean(table.rates[normalizeCurrency(code, '')]),
    info: () => ({ base: table.base, updatedAt: table.updatedAt, source: table.source, currencies: Object.keys(table.rates).sort(), rates: table.rates }),
  };
}
