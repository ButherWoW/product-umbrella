import './log-setup.js';
import http from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, query, closeDb } from './db.js';
import { reportFromRows, reportFromEvents, metrics } from './stats-report.js';
import { createUserStore, readCookie, SESSION_TTL_MS, API_KEY_PREFIX } from './auth.js';
import { createRates, normalizeCurrency } from './currency.js';
import { readEventLog } from './event-logs.js';
import { createConversionRecorder, hasRecordedConversion, findRecordedConversion } from './conversion-recorder.js';
import { createEventMirror } from './event-mirror.js';
import { createConversionCapCounter, resolveOffer } from './conversion-cap.js';
import { createJournalGate, filterJournal, campaignPlan, retentionPlan, clearCampaignRows, retentionRows } from './retention.js';
import { createSourcePostbacks, resolveSourcePostback, parsePostbackUrl, parsePostbackStatuses, journalHasSourcePostback, sendPostback, fillPostbackMacros, stripQuery, allowPrivateFromEnv, SAMPLE_MACROS } from './source-postback.js';
import { connectionType, CONNECTION_TYPES } from './connection-type.js';
import { createBindingStore, bindingKey, boundChoice, streamRef, parseBindMode, parseBindTtl } from './visitor-binding.js';
import { createMonitor, MONITOR_MODES } from './monitor.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DATA_DIR || join(root, 'data');
const eventsFile = join(dataDir, 'events.jsonl');
const offersFile = join(dataDir, 'offers.json');
const landingsFile = join(dataDir, 'landings.json');
const settingsFile = join(dataDir, 'settings.json');
const campaignsFile = join(dataDir, 'campaigns.json');
const sourcesFile = join(dataDir, 'sources.json');
const networksFile = join(dataDir, 'networks.json');
const port = Number(process.env.PORT || 4100);
// Public path prefix when served behind a proxy under a subpath (nginx strips it before proxying).
const basePath = /^\/[A-Za-z0-9_-]{1,40}$/.test(process.env.BASE_PATH || '') ? process.env.BASE_PATH : '';
// Umbrella's own accounts (see src/auth.js). REQUIRE_LOGIN=1 closes reports and APIs to anonymous visitors.
const users = createUserStore({ db, dataDir });
const requireLogin = /^(1|true|yes)$/i.test(process.env.REQUIRE_LOGIN || '');
// Source postbacks to loopback (and plain http) only in tests: SOURCE_POSTBACK_ALLOW_PRIVATE=1.
const sourcePostbackAllowPrivate = allowPrivateFromEnv();
// Amounts without a currency (and all click costs) are in DEFAULT_CURRENCY; reports convert to any currency at current rates.
const rates = createRates({ dataDir, defaultCurrency: normalizeCurrency(process.env.DEFAULT_CURRENCY, 'EUR'),
  refreshMs: process.env.FX_REFRESH === '0' ? 0 : 12 * 3600 * 1000 });
const reportCurrency = (raw) => normalizeCurrency(raw, rates.defaultCurrency);
// Adds the conversion factors to a SQL parameter list; returns the SQL fragments that use them.
function sqlFx(params, currency) {
  params.push(JSON.stringify(rates.factors(currency)), rates.defaultCurrency, rates.factor(rates.defaultCurrency, currency));
  const n = params.length;
  const amount = `cv.revenue * COALESCE(($${n - 2}::jsonb ->> COALESCE(cv.currency, $${n - 1}))::float, 1)`;
  return {
    revenue: `COALESCE(SUM(${amount}) FILTER (WHERE cv.status = 'sale'), 0)`,
    pending: `COALESCE(SUM(${amount}) FILTER (WHERE cv.status = 'lead'), 0)`,
    cost: `COALESCE(SUM(c.cost), 0) * $${n}::float`,
    // CPC offer payout booked on the click itself (stored in DEFAULT_CURRENCY, like cost).
    clickRevenue: `COALESCE(SUM(c.revenue), 0) * $${n}::float`,
  };
}
// JSONL equivalents.
const convertConversion = (cv, currency) => (cv.revenue === null || cv.revenue === undefined ? cv : { ...cv, revenue: Number(cv.revenue) * rates.factor(cv.currency, currency) });
const convertClickCost = (click, currency) => (click.cost || click.revenue ? { ...click, cost: Number(click.cost || 0) * rates.factor(rates.defaultCurrency, currency),
  revenue: Number(click.revenue || 0) * rates.factor(rates.defaultCurrency, currency) } : click);
const SESSION_COOKIE = 'umb_session';
const loginFailures = new Map();
const postbackSecret = process.env.POSTBACK_SECRET || '';
const adminToken = process.env.ADMIN_TOKEN || '';
const requirePostgres = /^(1|true|yes)$/i.test(process.env.REQUIRE_POSTGRES || '');
const clickRateLimit = Math.max(0, Number(process.env.CLICK_RATE_LIMIT || 120));
const clickRateWindowMs = Math.max(1000, Number(process.env.CLICK_RATE_WINDOW_MS || 60000));
const rateBuckets = new Map();
const adminAllowedIps = parseAdminAllowedIps(process.env.ADMIN_ALLOWED_IPS);
const adminIpAllowed = (req) => !adminAllowedIps.length || adminAllowedIps.some((rule) => ipMatches(normalizeIp(clientIp(req)), rule));
// Offers store { url, postbackUrl } objects. Old saves with bare strings are migrated on load.
const offers = new Map([
  ['offer-1', { url: process.env.OFFER_1_URL || 'https://example.com/', postbackUrl: null }],
]);

// Optional geo-lookup. Requires GEOIP_DB env var + @maxmind/geoip2-node installed.
let geoReader = null;
if (process.env.GEOIP_DB) {
  try {
    const { Reader } = await import('@maxmind/geoip2-node');
    geoReader = await Reader.open(process.env.GEOIP_DB);
    console.log('[geo] GeoIP2 database loaded');
  } catch (e) { console.warn('[geo] GeoIP2 unavailable, geo checks disabled:', e.message); }
}
// Optional ISP lookup (DB-IP ASN Lite, CC BY 4.0) via GEOIP_ASN_DB.
let asnReader = null;
if (process.env.GEOIP_ASN_DB) {
  try {
    const { Reader } = await import('@maxmind/geoip2-node');
    asnReader = await Reader.open(process.env.GEOIP_ASN_DB);
    console.log('[geo] ASN database loaded');
  } catch (e) { console.warn('[geo] ASN database unavailable, ISP lookup disabled:', e.message); }
}
// Hosting / cloud networks: real visitors do not browse from these; crawlers, scanners and review bots do.
const DATACENTER_RE = /\b(amazon|google llc|google cloud|microsoft|azure|digitalocean|ovh|hetzner|linode|akamai|vultr|oracle|alibaba|tencent|cloudflare|leaseweb|contabo|scaleway|choopa|m247|datacamp|facebook|hostinger|ionos|hosting|servers?|data ?cent(er|re)s?|colocation)\b/i;
function lookupAsn(ip) {
  if (!asnReader || !ip) return null;
  try {
    const r = asnReader.asn(ip);
    const isp = r.autonomousSystemOrganization || null;
    const asn = r.autonomousSystemNumber ?? null;
    const datacenter = Boolean(isp && DATACENTER_RE.test(isp));
    return { asn, isp, datacenter, connection: connectionType({ asn, isp, datacenter }) };
  } catch { return null; }
}

function lookupCountry(ip) {
  if (!geoReader || !ip) return null;
  try { return geoReader.country(ip)?.country?.isoCode || null; }
  catch { return null; }
}
// TRUST_PROXY=N (or true = 1): number of our own proxies in front. Without it X-Forwarded-For is ignored,
// because any client can send that header. With N proxies the client is the N-th entry from the right.
const trustProxyHops = /^(true|yes)$/i.test(process.env.TRUST_PROXY || '') ? 1 : Math.max(0, Number.parseInt(process.env.TRUST_PROXY || '0', 10) || 0);
function clientIp(req) {
  const socketIp = req.socket?.remoteAddress || null;
  if (!trustProxyHops) return socketIp;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!chain.length) return socketIp;
  return chain[Math.max(0, chain.length - trustProxyHops)];
}

function rateLimited(ip) {
  if (!clickRateLimit || !ip) return false;
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) || []).filter((at) => now - at < clickRateWindowMs);
  if (bucket.length >= clickRateLimit) { rateBuckets.set(ip, bucket); return true; }
  bucket.push(now); rateBuckets.set(ip, bucket);
  if (rateBuckets.size > 10000) for (const [key, values] of rateBuckets) if (!values.length || now - values.at(-1) >= clickRateWindowMs) rateBuckets.delete(key);
  return false;
}
const campaigns = new Map([['demo', { name: 'Demo campaign', active: true, streams: [], dailyCap: null, capUrl: null, allowDevices: [], allowGeos: [], geoCapUrl: null }]]);
const eventMirror = db ? createEventMirror({ query,
  onError: (type, error) => console.warn(`[db] ${type} insert:`, error.message) }) : null;

// Offer / landing monitoring: MONITOR=0 turns the timer off (POST /api/monitor/check still works).
// MONITOR_ALLOW_PRIVATE lists private IPs that may be fetched anyway — only for tests against 127.0.0.1.
const monitorEnabled = process.env.MONITOR !== '0';
const monitorIntervalMs = Math.max(1000, Number(process.env.MONITOR_INTERVAL_MS) || 600000);
const monitor = createMonitor({ campaigns, offers, landings: { get: (id) => landings.get(id) },
  persistCampaign: (id, value) => persistCampaign(id, value), event: (type, payload) => event(type, payload),
  intervalMs: monitorIntervalMs, allowPrivate: String(process.env.MONITOR_ALLOW_PRIVATE || '').split(',').map((s) => s.trim()).filter(Boolean) });

const OFFER_ID_RE = /^[a-z0-9_-]{2,80}$/i;
const STREAM_TYPES = ['forced', 'regular', 'fallback'];
const STREAM_ACTIONS = ['offers', 'url', 'not_found', 'campaign'];
const REDIRECT_METHODS = ['http', 'meta', 'js'];
// Hops allowed through "send to campaign" streams before giving up (protects against A → B → A loops).
const MAX_CAMPAIGN_HOPS = 3;
// Alternative offers followed when an offer's conversion cap is reached (A → B → C → D at most).
const MAX_ALT_HOPS = 3;

function parseList(raw, normalize, valid) {
  return Array.isArray(raw) ? raw.map(normalize).filter(valid).slice(0, 50) : [];
}

function parseConditions(raw = {}) {
  const lower = (v) => String(v).toLowerCase().slice(0, 20);
  const text = (v) => String(v).trim().toLowerCase().slice(0, 200);
  const out = {
    countries: parseList(raw.countries, (g) => String(g).toUpperCase().slice(0, 2), (g) => /^[A-Z]{2}$/.test(g)),
    devices: parseList(raw.devices, lower, (d) => ['mobile', 'tablet', 'desktop'].includes(d)),
    os: parseList(raw.os, lower, (o) => ['android', 'ios', 'windows', 'macos', 'linux', 'other'].includes(o)),
    browsers: parseList(raw.browsers, lower, (b) => ['chrome', 'safari', 'firefox', 'edge', 'opera', 'samsung', 'other'].includes(b)),
    languages: parseList(raw.languages, (l) => String(l).toLowerCase().slice(0, 2), (l) => /^[a-z]{2}$/.test(l)),
    // Provider name fragments, e.g. "orange", "free mobile"; matched case-insensitively against the visitor's ISP.
    isps: parseList(raw.isps, (i) => String(i).trim().toLowerCase().slice(0, 40), (i) => i.length >= 2).slice(0, 50),
    ...(raw.mode === 'or' ? { mode: 'or' } : {}),
    ...scheduleConditions(raw),
  };
  // Newer conditions are stored only when set, so existing streams keep their exact shape.
  for (const key of ['referrers', 'keywords', 'userAgents']) { const list = parseList(raw[key], text, (v) => v.length > 0); if (list.length) out[key] = list; }
  if (typeof raw.emptyReferrer === 'boolean') out.emptyReferrer = raw.emptyReferrer;
  const connections = [...new Set(parseList(raw.connections, lower, (x) => CONNECTION_TYPES.includes(x)))];
  if (connections.length) out.connections = connections;
  const ips = parseIpRules(raw.ips).slice(0, 50);
  if (ips.length) out.ips = ips;
  if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
    const params = {};
    for (const [f, values] of Object.entries(raw.params)) {
      const list = TRACK_FIELDS.includes(f) ? parseList(values, (v) => String(v).trim().slice(0, 200), (v) => v.length > 0) : [];
      if (list.length) params[f] = list;
    }
    if (Object.keys(params).length) out.params = params;
  }
  const not = [...new Set(parseList(raw.not, String, (k) => CONDITION_KEYS.includes(k) && conditionSet(out, k)))];
  if (not.length) out.not = not;
  return out;
}

// Day parting (Keitaro «Расписание»): ISO weekdays 1 (Mon) … 7 (Sun), hours 0–23 and an inclusive date range, in an IANA time zone.
// Only stored when set, so streams without a schedule keep their original shape.
function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v) ? v : null);
function scheduleConditions(raw) {
  const days = [...new Set(parseList(raw.days, Number, (d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
  const hours = [...new Set(parseList(raw.hours, Number, (h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
  const dateFrom = isoDate(raw.dateFrom); const dateTo = isoDate(raw.dateTo);
  if (!days.length && !hours.length && !dateFrom && !dateTo) return {};
  const tz = typeof raw.tz === 'string' && validTimeZone(raw.tz) ? raw.tz : 'UTC';
  return { ...(days.length ? { days } : {}), ...(hours.length ? { hours } : {}), ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}), tz };
}
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function localDayHour(tz, date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).map((p) => [p.type, p.value]));
  return { day: WEEKDAY[parts.weekday], hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
}

function parseOfferWeights(raw) {
  return parseList(raw, (o) => ({ offerId: String(o?.offerId || ''), weight: Number(o?.weight ?? 1) }), (o) => OFFER_ID_RE.test(o.offerId) && o.weight > 0).slice(0, 20);
}

// A stream is either legacy flat { offerId, weight } or conditional { name, type, conditions, offers, weight }.
function parseStreams(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out = [];
  for (const s of raw.slice(0, 20)) {
    if (!s || typeof s !== 'object') continue;
    const name = s.name ? { name: String(s.name).slice(0, 60) } : {};
    if (Array.isArray(s.offers) || STREAM_ACTIONS.includes(s.action)) {
      const action = STREAM_ACTIONS.includes(s.action) ? s.action : 'offers';
      const weight = s.weight === undefined ? 1 : Number(s.weight);
      if (!(weight > 0)) continue;
      const stream = { ...name, type: STREAM_TYPES.includes(s.type) ? s.type : 'regular', conditions: parseConditions(s.conditions), weight };
      if (action === 'offers') {
        stream.offers = parseOfferWeights(s.offers);
        const landingList = parseList(s.landings, (l) => ({ landingId: String(l?.landingId || ''), weight: Number(l?.weight ?? 1) }), (l) => OFFER_ID_RE.test(l.landingId) && l.weight > 0).slice(0, 20);
        if (landingList.length) stream.landings = landingList;
        if (!stream.offers.length) continue;
      } else {
        stream.action = action;
        if (action === 'url') {
          if (!/^https:\/\//i.test(String(s.url || ''))) continue;
          stream.url = String(s.url).slice(0, 2048);
        }
        if (action === 'campaign') {
          if (!OFFER_ID_RE.test(String(s.campaignId || ''))) continue;
          stream.campaignId = String(s.campaignId);
        }
      }
      // Defaults are omitted so existing stored streams keep their exact shape.
      if (s.enabled === false) stream.enabled = false;
      // Remembers that the offer monitor (src/monitor.js) switched the stream off, so it may switch it back on.
      if (s.enabled === false && s.disabledBy === 'monitor') stream.disabledBy = 'monitor';
      if (s.countClicks === false) stream.countClicks = false;
      out.push(stream);
    } else if (OFFER_ID_RE.test(String(s.offerId || '')) && Number(s.weight) > 0) {
      out.push({ offerId: String(s.offerId), weight: Number(s.weight), ...name });
    }
  }
  return out;
}

function weightedPick(items) {
  if (!items.length) return null;
  const total = items.reduce((sum, s) => sum + s.weight, 0);
  let r = Math.random() * total;
  for (const s of items) { r -= s.weight; if (r <= 0) return s; }
  return items[items.length - 1];
}

// Stream conditions: [label, (conditions, visitor, local time) → [actual, matched]]. Lists match any value; `not` inverts a condition.
const includesAny = (hay, needles) => Boolean(hay) && needles.some((n) => String(hay).toLowerCase().includes(n));
function referrerText(ref) {
  if (!ref) return '';
  try { const u = new URL(ref); return (u.host + u.pathname).toLowerCase(); } catch { return String(ref).toLowerCase().slice(0, 500); }
}
const CONDITIONS = {
  // Unknown country (no GEOIP_DB) / ISP (no GEOIP_ASN_DB) never matches, so geo streams fall through to others.
  countries: ['страна', (c, v) => [v.country, c.countries.includes(v.country)]],
  devices: ['устройство', (c, v) => [v.device, c.devices.includes(v.device)]],
  os: ['ОС', (c, v) => [v.os, c.os.includes(v.os)]],
  browsers: ['браузер', (c, v) => [v.browser, c.browsers.includes(v.browser)]],
  languages: ['язык', (c, v) => [v.language, c.languages.includes(v.language)]],
  isps: ['провайдер', (c, v) => [v.isp, includesAny(v.isp, c.isps)]],
  // Unknown connection type (no GEOIP_ASN_DB) never matches either; with «НЕ» it does.
  connections: ['тип соединения', (c, v) => [v.connection, c.connections.includes(v.connection)]],
  days: ['день недели', (c, v, t) => [t.day, c.days.includes(t.day)]],
  hours: ['час', (c, v, t) => [t.hour, c.hours.includes(t.hour)]],
  dateFrom: ['дата с', (c, v, t) => [t.date, t.date >= c.dateFrom], '≥'],
  dateTo: ['дата по', (c, v, t) => [t.date, t.date <= c.dateTo], '≤'],
  referrers: ['реферер', (c, v) => { const r = referrerText(v.referrer); return [r || null, includesAny(r, c.referrers)]; }],
  emptyReferrer: ['пустой реферер', (c, v) => [v.referrer ? 'нет' : 'да', !v.referrer === c.emptyReferrer], '='],
  keywords: ['ключевое слово', (c, v) => [v.params?.keyword, includesAny(v.params?.keyword, c.keywords)]],
  ips: ['IP', (c, v) => [v.ip, Boolean(v.ip) && c.ips.some((r) => ipMatches(v.ip, r))]],
  userAgents: ['User-Agent', (c, v) => [v.userAgent, includesAny(v.userAgent, c.userAgents)]],
};
const CONDITION_KEYS = [...Object.keys(CONDITIONS), 'params'];
const conditionSet = (c, k) => (k === 'emptyReferrer' ? typeof c[k] === 'boolean' : k === 'params' ? Object.keys(c.params || {}).length > 0 : Boolean(c[k]?.length));
function conditionChecks(c, visitor) {
  const local = c.days?.length || c.hours?.length || c.dateFrom || c.dateTo ? localDayHour(c.tz || 'UTC', visitor.now || new Date()) : {};
  const not = new Set(c.not || []);
  const out = Object.entries(CONDITIONS).filter(([k]) => conditionSet(c, k)).map(([k, [label, test, op]]) => {
    const [actual, ok] = test(c, visitor, local);
    return { key: k, condition: label, expected: [].concat(c[k] === true ? 'да' : c[k] === false ? 'нет' : c[k]), actual: actual ?? null, ok: ok !== not.has(k), ...(op ? { op } : {}) };
  });
  // Each tracked parameter (after paramMap) is its own check: exact match against the listed values.
  for (const [f, values] of Object.entries(c.params || {})) {
    const actual = visitor.params?.[f] ?? null;
    out.push({ key: 'params', condition: `параметр ${f}`, expected: values, actual, ok: values.includes(actual) !== not.has('params') });
  }
  return out;
}

function streamMatches(stream, visitor) {
  const c = stream.conditions;
  if (!c) return true;
  const checks = conditionChecks(c, visitor);
  if (!checks.length) return true;
  return c.mode === 'or' ? checks.some((x) => x.ok) : checks.every((x) => x.ok);
}

// Keitaro order: first matching forced stream → weighted among matching regular → first matching fallback.
// Offers in `excluded` (capped) are skipped; a stream with no remaining offers does not match.
// Disabled streams are skipped; action streams (url / not_found) need no offers.
function pickStream(streams, visitor = {}, excluded = new Set(), rotation = 'weight') {
  if (!streams || !streams.length) return null;
  const available = (s) => (s.action ? [s] : s.offers ? s.offers.filter((o) => !excluded.has(o.offerId)) : (excluded.has(s.offerId) ? [] : [s]));
  const matching = streams.filter((s) => s.enabled !== false && streamMatches(s, visitor) && available(s).length);
  const typeOf = (s) => s.type || 'regular';
  const stream = matching.find((s) => typeOf(s) === 'forced')
    // Keitaro «Ротация потоков»: by weight (default) or by position — the first matching regular stream wins.
    || (rotation === 'position' ? matching.find((s) => typeOf(s) === 'regular') : weightedPick(matching.filter((s) => typeOf(s) === 'regular')))
    || matching.find((s) => typeOf(s) === 'fallback');
  if (!stream) return null;
  if (stream.action) return { stream, offerId: null };
  const offerId = stream.offers ? weightedPick(available(stream)).offerId : stream.offerId;
  const landingId = stream.landings?.length ? weightedPick(stream.landings).landingId : null;
  return { stream, offerId, landingId };
}

// Traffic simulation (Keitaro «Симуляция трафика»): where would this visitor go and why. Records nothing.
function explainStream(stream, visitor) {
  const c = stream.conditions || {};
  const checks = conditionChecks(c, visitor).map(({ key, ...check }) => ({ ...check, ...(c.not?.includes(key) ? { not: true } : {}) }));
  return { checks, matches: streamMatches(stream, visitor), mode: c.mode === 'or' ? 'or' : 'and' };
}

async function simulateClick(input, canSee) {
  const ip = normalizeIp(String(input.ip || '').trim()) || null;
  const ua = String(input.userAgent || '');
  const network = ip ? lookupAsn(ip) : null;
  const lang = String(input.language || '').trim().slice(0, 2).toLowerCase();
  const at = input.at ? new Date(input.at) : new Date();
  if (Number.isNaN(at.getTime())) return { error: 'invalid_at' };
  const visitor = { device: detectDevice(ua), os: detectOS(ua), browser: detectBrowser(ua), language: /^[a-z]{2}$/.test(lang) ? lang : null,
    country: /^[A-Za-z]{2}$/.test(input.country || '') ? input.country.toUpperCase() : (ip ? lookupCountry(ip) : null),
    isp: input.isp ? String(input.isp).slice(0, 120) : network?.isp || null, now: at,
    // Explicit connection type, or derived from an explicit ISP name, or from the IP's ASN.
    connection: CONNECTION_TYPES.includes(input.connection) ? input.connection
      : input.isp ? connectionType({ isp: String(input.isp), datacenter: DATACENTER_RE.test(String(input.isp)) }) : network?.connection ?? null,
    referrer: input.referrer ? String(input.referrer).trim().slice(0, 2048) : null, userAgent: ua, ip };
  const query = new URLSearchParams(String(input.query || '').replace(/^\?/, ''));
  const steps = [];
  const finish = (result) => ({ visitor: { ...visitor, now: at.toISOString(), datacenter: network?.datacenter ?? null }, steps, result });
  let campaignId = String(input.campaign || '');
  const visited = [];
  for (;;) {
    const c = campaigns.get(campaignId);
    if (!c || !canSee(c)) return finish({ outcome: 'error', status: 404, reason: `кампания ${campaignId} не найдена` });
    const step = { campaign: campaignId, name: c.name, checks: [] };
    steps.push(step);
    visitor.params = trackedParams(query, c.paramMap);
    if (!c.active) step.checks.push({ check: 'кампания включена', ok: false, note: 'на живом трафике будет 404' });
    if (ip && c.blockedIps?.some((r) => ipMatches(ip, r))) return finish({ outcome: 'blocked', status: 403, reason: 'IP в чёрном списке кампании' });
    if (ip && c.allowedIps?.length && !c.allowedIps.some((r) => ipMatches(ip, r))) return finish({ outcome: 'blocked', status: 403, reason: 'IP не в белом списке кампании' });
    if (c.allowDevices?.length && !c.allowDevices.includes(visitor.device)) return finish({ outcome: 'blocked', status: 403, reason: `устройство ${visitor.device} не разрешено кампанией` });
    if (c.allowOS?.length && !c.allowOS.includes(visitor.os)) return finish({ outcome: 'blocked', status: 403, reason: `ОС ${visitor.os} не разрешена кампанией` });
    if (c.allowBrowsers?.length && !c.allowBrowsers.includes(visitor.browser)) return finish({ outcome: 'blocked', status: 403, reason: `браузер ${visitor.browser} не разрешён кампанией` });
    if (c.allowGeos?.length && visitor.country && !c.allowGeos.includes(visitor.country)) {
      return finish(c.geoCapUrl ? { outcome: 'redirect', status: 302, url: c.geoCapUrl, reason: `страна ${visitor.country} не разрешена → URL для чужого гео` }
        : { outcome: 'blocked', status: 403, reason: `страна ${visitor.country} не разрешена кампанией` });
    }
    const routing = await offerRouting(c.streams || []);
    const capped = routing.excluded;
    // Every offer that cannot take traffic itself: why, and which alternative takes it (conversion cap) if any.
    step.streams = (c.streams || []).map((st) => ({ name: st.name, type: st.type || 'regular', enabled: st.enabled !== false, ...explainStream(st, visitor),
      cappedOffers: (st.offers || (st.offerId ? [st] : [])).filter((o) => routing.reasons.has(o.offerId))
        .map((o) => ({ offerId: o.offerId, reason: routing.reasons.get(o.offerId), altOfferId: routing.substitutes.get(o.offerId) || null })) }));
    const matching = (c.streams || []).filter((st) => st.enabled !== false && streamMatches(st, visitor)
      && (st.action || (st.offers ? st.offers.some((o) => !capped.has(o.offerId)) : !capped.has(st.offerId))));
    const typeOf = (st) => st.type || 'regular';
    const forced = matching.find((st) => typeOf(st) === 'forced');
    const regular = matching.filter((st) => typeOf(st) === 'regular');
    // Visitor binding is only known for a concrete visitor: IP + User-Agent, as on a live click.
    let bound = null;
    if (c.bindVisitors !== 'off' && ip && input.userAgent) {
      const binding = visitorBindings.get(bindingKey(campaignId, ip, ua), c.bindTtlHours * 3600 * 1000, at.getTime());
      bound = boundChoice({ mode: c.bindVisitors, binding, streams: c.streams || [], matches: (st) => streamMatches(st, visitor), excluded: capped,
        pickOffer: (list) => list[0], pickLanding: (list) => list[0] });
      step.binding = bound ? { applies: true, mode: c.bindVisitors, stream: bound.stream.name ?? null, ...(c.bindVisitors === 'stream_offer' ? { offerId: bound.offerId, landingId: bound.landingId } : {}), boundAt: new Date(binding.at).toISOString() }
        : { applies: false, mode: c.bindVisitors, reason: binding ? 'привязанный поток или оффер больше не подходит — будет обычный выбор и новая привязка' : 'привязки нет или срок истёк' };
    }
    let candidates;
    if (bound) candidates = [{ stream: bound.stream, share: 1 }];
    else if (forced) candidates = [{ stream: forced, share: 1 }];
    else if (regular.length) {
      if (c.streamRotation === 'position') candidates = [{ stream: regular[0], share: 1 }];
      else { const total = regular.reduce((t, st) => t + (st.weight || 1), 0); candidates = regular.map((st) => ({ stream: st, share: (st.weight || 1) / total })); }
    } else { const fb = matching.find((st) => typeOf(st) === 'fallback'); candidates = fb ? [{ stream: fb, share: 1 }] : []; }
    if (!candidates.length) return finish({ outcome: 'no_stream', status: 404, reason: 'ни один поток не подошёл (no_matching_stream)' });
    step.chosen = candidates.map(({ stream: st, share }) => ({ stream: st.name, share: Math.round(share * 1000) / 10 }));
    const top = candidates.sort((a, b) => b.share - a.share)[0].stream;
    if (top.action === 'campaign') {
      visited.push(campaignId);
      if (visited.length > MAX_CAMPAIGN_HOPS || visited.includes(top.campaignId)) return finish({ outcome: 'error', status: 508, reason: 'зацикливание кампаний' });
      campaignId = top.campaignId;
      continue;
    }
    if (top.action === 'not_found') return finish({ outcome: 'not_found', status: 404, reason: `поток «${top.name}» отвечает 404` });
    const bot = (c.botFilter && isBot(ua)) || (c.datacenterAsBot && network?.datacenter);
    const params = visitor.params;
    const destinations = top.action === 'url' ? [{ url: top.url, share: 100 }]
      : (() => { const live = (top.offers || [{ offerId: top.offerId, weight: 1 }]).filter((o) => !capped.has(o.offerId) && (!bound || c.bindVisitors !== 'stream_offer' || o.offerId === bound.offerId)); const total = live.reduce((t, o) => t + (o.weight || 1), 0);
        return live.map((o) => { const used = routing.substitutes.get(o.offerId) || o.offerId;
          return { offerId: used, ...(used !== o.offerId ? { insteadOf: o.offerId } : {}), share: Math.round((o.weight || 1) / total * 1000) / 10, url: offers.get(used)?.url || null }; }); })();
    const landing = bound?.landingId && c.bindVisitors === 'stream_offer' ? landings.get(bound.landingId)?.url || null
      : top.landings?.length ? top.landings.map((l) => landings.get(l.landingId)?.url).filter(Boolean)[0] : null;
    const vars = { ...params, click_id: 'SIMULATION', subid: query.get('subid') || '', campaign: campaignId, device: visitor.device, country: visitor.country || '', cost: '' };
    return finish({ outcome: bot ? 'bot' : 'click', status: 302, stream: top.name,
      ...(bot ? { reason: 'User-Agent бота или дата-центр при включённом фильтре' } : {}),
      ...(landing ? { landing: applyMacros(landing, vars) } : {}),
      destinations: destinations.map((d) => ({ ...d, url: d.url ? applyMacros(d.url, { ...vars, offer_id: d.offerId || '' }) : null })) });
  }
}

const BOT_UA_RE = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|headless|phantomjs|selenium|puppeteer|playwright|lighthouse|pingdom|uptimerobot|scrapy|curl\/|wget\/|python-requests|python-urllib|aiohttp|go-http-client|java\/|okhttp|apache-httpclient|libwww-perl/i;

function isBot(ua) {
  return !ua || BOT_UA_RE.test(ua);
}

function detectOS(ua) {
  if (!ua) return 'other';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

function detectBrowser(ua) {
  if (!ua) return 'other';
  if (/SamsungBrowser/i.test(ua)) return 'samsung';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/OPR\/|Opera/i.test(ua)) return 'opera';
  if (/Firefox\/|FxiOS/i.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS/i.test(ua)) return 'chrome';
  if (/Safari\//i.test(ua)) return 'safari';
  return 'other';
}

// Tracked parameters come from the query via the campaign's paramMap, so /r/:campaign sets `params` per campaign hop.
function visitorProfile(req) {
  const ua = req.headers['user-agent'] || '';
  const lang = String(req.headers['accept-language'] || '').trim().slice(0, 2).toLowerCase();
  const ip = normalizeIp(clientIp(req));
  const network = lookupAsn(ip);
  return { device: detectDevice(ua), os: detectOS(ua), browser: detectBrowser(ua), language: /^[a-z]{2}$/.test(lang) ? lang : null, country: lookupCountry(clientIp(req)),
    isp: network?.isp || null, connection: network?.connection ?? null, referrer: req.headers.referer || null, userAgent: ua, ip: ip || null, params: {} };
}

// Replace known macros in URL templates (offer URLs and S2S postback URLs).
// Traffic-source parameters recorded per click (Keitaro "Параметры" tab). paramMap renames the query key per campaign.
const TRACK_FIELDS = ['keyword', 'source', 'external_id', 'creative_id', 'ad_campaign_id', ...Array.from({ length: 30 }, (_, i) => `sub_id_${i + 1}`)];
const MAPPABLE_FIELDS = [...TRACK_FIELDS, 'cost'];
function trackedParams(query, paramMap) {
  const params = {};
  for (const field of TRACK_FIELDS) { const v = query.get(paramMap?.[field] || field); if (v) params[field] = v.slice(0, 255); }
  return params;
}
function parseParamMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const field of MAPPABLE_FIELDS) {
    const key = typeof raw[field] === 'string' ? raw[field].trim() : '';
    if (key && key !== field && /^[A-Za-z0-9_.\-[\]]{1,64}$/.test(key)) out[field] = key;
  }
  return out;
}

const MACRO_RE = new RegExp(`\\{(click_id|subid|campaign|offer_id|device|country|revenue|currency|status|cost|lp_click_url|${TRACK_FIELDS.join('|')})\\}`, 'g');
// Values are URL-encoded: they come from visitors' query strings and must not inject extra parameters.
function applyMacros(template, vars) {
  return template.replace(MACRO_RE, (_, k) => encodeURIComponent(vars[k] ?? ''));
}

// Classify visitor device from User-Agent header.
function detectDevice(ua) {
  if (!ua) return 'desktop';
  if (/\b(iPad|Tablet|PlayBook|Kindle(?!.*phone))\b/i.test(ua)) return 'tablet';
  if (/\b(Mobile|Android(?!.*Tablet)|iPhone|iPod)\b/i.test(ua)) return 'mobile';
  return 'desktop';
}

// Count clicks recorded today (UTC) for a campaign. Non-fatal — returns 0 on error.
// Unique visitors (Keitaro «Уник.»): same IP + User-Agent within the campaign's uniqueness window is not unique.
// In-memory and bounded; after a restart the first repeat visit of a returning visitor counts as unique again.
const seenVisitors = new Map();
const SEEN_LIMIT = 300000;
const visitorBindings = createBindingStore({ limit: SEEN_LIMIT });
function firstVisit(key, windowMs, now = Date.now()) {
  const hash = createHash('sha1').update(key).digest('base64');
  const last = seenVisitors.get(hash);
  seenVisitors.delete(hash);
  seenVisitors.set(hash, now);
  if (seenVisitors.size > SEEN_LIMIT) seenVisitors.delete(seenVisitors.keys().next().value);
  return !(last && now - last < windowMs);
}

// Count clicks by campaign and/or offer, optionally since a UTC ISO timestamp. Non-fatal — returns 0 on error.
async function countClicks({ campaign = null, offerId = null, since = null } = {}) {
  if (db) {
    try {
      const where = []; const params = [];
      if (campaign) { params.push(campaign); where.push(`campaign = $${params.length}`); }
      if (offerId) { params.push(offerId); where.push(`offer_id = $${params.length}`); }
      if (since) { params.push(since); where.push(`created_at >= $${params.length}`); }
      const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM clicks${where.length ? ' WHERE ' + where.join(' AND ') : ''}`, params);
      return rows[0].n;
    } catch (e) { console.warn('[db] countClicks fallback:', e.message); }
  }
  const sinceMs = since ? Date.parse(since) : null;
  try {
    const lines = (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean);
    return lines.filter((line) => {
      try {
        const item = JSON.parse(line);
        return item.type === 'click'
          && (!campaign || item.campaign === campaign)
          && (!offerId || item.offerId === offerId)
          && (sinceMs === null || Date.parse(item.at) >= sinceMs);
      } catch { return false; }
    }).length;
  } catch { return 0; }
}

const todayStart = () => `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;

async function countTodayClicks(campaign) {
  return countClicks({ campaign, since: todayStart() });
}

const conversionCaps = createConversionCapCounter({ db, eventsFile,
  onFallback: (error) => console.warn('[db] conversion cap fallback:', error.message) });

// null when the offer can take traffic, otherwise why not: missing, archived, click_cap (dailyCap) or conversion_cap.
async function offerState(id) {
  const offer = offers.get(id);
  if (!offer) return 'missing';
  if (offer.archived) return 'archived';
  if (offer.dailyCap && await countClicks({ offerId: id, since: todayStart() }) >= offer.dailyCap) return 'click_cap';
  if (offer.conversionCap && await conversionCaps.count(id, offer.capTz) >= offer.conversionCap) return 'conversion_cap';
  return null;
}

// For the campaign's stream offers: `excluded` (capped, archived, no usable alternative) are skipped in rotation,
// `substitutes` maps a conversion-capped offer to the alternative that takes its traffic, `reasons` says why.
async function offerRouting(streams) {
  const ids = new Set(streams.flatMap((s) => (s.offers ? s.offers.map((o) => o.offerId) : s.offerId ? [s.offerId] : [])));
  const states = new Map();
  const stateOf = async (id) => { if (!states.has(id)) states.set(id, await offerState(id)); return states.get(id); };
  const excluded = new Set(); const substitutes = new Map(); const reasons = new Map();
  for (const id of ids) {
    const state = await stateOf(id);
    // Unknown offers are left alone (the click answers 404 offer_not_found, as before).
    if (!state || state === 'missing') continue;
    reasons.set(id, state);
    // Pre-compute states along the alternative chain, then resolve it synchronously.
    for (let alt = offers.get(id)?.altOfferId, seen = new Set([id]); state === 'conversion_cap' && alt && seen.size <= MAX_ALT_HOPS && !seen.has(alt); seen.add(alt), alt = offers.get(alt)?.altOfferId) await stateOf(alt);
    const route = resolveOffer(id, { stateOf: (x) => (states.has(x) ? states.get(x) : 'missing'), altOf: (x) => offers.get(x)?.altOfferId || null, maxHops: MAX_ALT_HOPS });
    if (route.offerId) substitutes.set(id, route.offerId);
    else excluded.add(id);
  }
  return { excluded, substitutes, reasons };
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((acc, p) => (acc * 256) + Number(p), 0);
}

function normalizeIp(ip) {
  return String(ip || '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
}

// Rule is an exact IPv4/IPv6 address or an IPv4 CIDR range (e.g. 10.0.0.0/8).
function ipMatches(ip, rule) {
  if (!ip) return false;
  if (!rule.includes('/')) return ip === rule;
  const [base, bitsRaw] = rule.split('/');
  const bits = Number(bitsRaw);
  const ipInt = ipv4ToInt(ip); const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  if (bits === 0) return true;
  const block = 2 ** (32 - bits);
  return Math.floor(ipInt / block) === Math.floor(baseInt / block);
}

// ADMIN_ALLOWED_IPS: comma-separated IPs / IPv4 CIDRs allowed to reach the panel, /api and /stats.
// Env only, so nobody can lock the team out from the UI. A typo must not silently open the panel,
// so any invalid rule stops the server instead of being dropped.
function parseAdminAllowedIps(raw) {
  const items = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  const rules = parseIpRules(items);
  if (rules.length !== items.length) {
    const bad = items.filter((item) => !rules.includes(normalizeIp(item)));
    throw new Error(`ADMIN_ALLOWED_IPS: неверные правила: ${bad.join(', ')}`);
  }
  return rules;
}

function parseIpRules(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeIp).filter((r) => {
    if (r.includes('/')) { const [b, n] = r.split('/'); return ipv4ToInt(b) !== null && /^\d{1,2}$/.test(n) && Number(n) <= 32; }
    return ipv4ToInt(r) !== null || (/^[0-9a-f:]+$/.test(r) && r.includes(':'));
  }).slice(0, 1000);
}

// Check if IP already clicked this campaign within the dedup window (minutes). Returns true if duplicate.
async function isDuplicateClick(campaign, ip, windowMinutes) {
  if (!windowMinutes || !ip) return false;
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  if (db) {
    try {
      const { rows } = await db.query(
        'SELECT 1 FROM clicks WHERE campaign = $1 AND ip = $2 AND created_at >= $3 LIMIT 1',
        [campaign, ip, since],
      );
      return rows.length > 0;
    } catch (e) { console.warn('[db] dedupe fallback:', e.message); }
  }
  try {
    const lines = (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean);
    return lines.some((line) => {
      try {
        const item = JSON.parse(line);
        return item.type === 'click' && item.campaign === campaign && item.ip === ip && Date.parse(item.at) >= Date.parse(since);
      } catch { return false; }
    });
  } catch { return false; }
}

// Sum revenue from conversions today for a campaign. Non-fatal — returns 0 on error.
// Conversions with statuses: a click's latest conversion event wins. Events written before statuses existed are sales.
// "Conversions" = lead + sale; revenue counts only sales (lead amounts are pending revenue).
function latestConversions(lines) {
  const latest = new Map();
  for (const item of lines) if (item?.type === 'conversion') latest.set(item.clickId, item);
  return latest;
}
const conversionCounts = (cv) => ['lead', 'sale'].includes(cv?.status || 'sale');
const saleRevenue = (cv) => ((cv?.status || 'sale') === 'sale' ? Number(cv.revenue) || 0 : 0);
const SQL_CONVERSIONS = "COUNT(cv.click_id) FILTER (WHERE cv.status IN ('lead', 'sale'))";
const SQL_REVENUE = "COALESCE(SUM(cv.revenue) FILTER (WHERE cv.status = 'sale'), 0)";

async function todayRevenue(campaign) {
  const today = new Date().toISOString().slice(0, 10);
  if (db) {
    try {
      // Revenue cap is set in DEFAULT_CURRENCY; conversions in other currencies are converted.
      const capParams = [campaign, `${today}T00:00:00Z`];
      const capFx = sqlFx(capParams, rates.defaultCurrency);
      const { rows } = await db.query(
        `SELECT ${capFx.revenue}::float AS rev
         FROM conversions cv
         JOIN clicks c USING (click_id)
         WHERE c.campaign = $1 AND cv.created_at >= $2`,
        capParams,
      );
      return rows[0].rev;
    } catch (e) { console.warn('[db] todayRevenue fallback:', e.message); }
  }
  try {
    const lines = (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    const clickIds = new Set(
      lines.filter((item) => item.type === 'click' && item.campaign === campaign && Date.parse(item.at) >= todayMs)
           .map((item) => item.clickId),
    );
    return [...latestConversions(lines).values()]
      .filter((item) => clickIds.has(item.clickId))
      .reduce((sum, item) => sum + saleRevenue(item) * rates.factor(item.currency, rates.defaultCurrency), 0);
  } catch { return 0; }
}

function parseOffer(raw) {
  // Accept bare string (legacy) or object { url, postbackUrl? }.
  const urlStr = typeof raw === 'string' ? raw : String(raw?.url || '');
  if (!/^https:\/\//i.test(urlStr)) return null;
  const postbackUrl = raw?.postbackUrl && /^https:\/\//i.test(String(raw.postbackUrl)) ? String(raw.postbackUrl).slice(0, 2048) : null;
  const payoutType = raw?.payoutType === 'cpc' ? 'cpc' : 'cpa';
  const payout = raw?.payout === null || raw?.payout === undefined || raw?.payout === '' ? null : (Number.isFinite(Number(raw.payout)) && Number(raw.payout) >= 0 ? Number(raw.payout) : null);
  const payoutCurrency = /^[A-Z]{3}$/i.test(String(raw?.payoutCurrency || '')) ? String(raw.payoutCurrency).toUpperCase() : null;
  const dailyCap = Number.isInteger(raw?.dailyCap) && raw.dailyCap > 0 ? raw.dailyCap : null;
  const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : null;
  const networkId = OFFER_ID_RE.test(String(raw?.networkId || '')) ? String(raw.networkId) : null;
  // Conversion cap: lead + sale conversions per local day in capTz; when reached, traffic goes to altOfferId.
  const conversionCap = Number.isInteger(raw?.conversionCap) && raw.conversionCap > 0 ? raw.conversionCap : null;
  const capTz = typeof raw?.capTz === 'string' && validTimeZone(raw.capTz) ? raw.capTz : 'UTC';
  const altOfferId = OFFER_ID_RE.test(String(raw?.altOfferId || '')) ? String(raw.altOfferId) : null;
  return { url: urlStr, postbackUrl, payoutType, payout, payoutCurrency, dailyCap, name, networkId, archived: raw?.archived === true, group: typeof raw?.group === 'string' ? raw.group.trim().slice(0, 60) : '',
    conversionCap, capTz, altOfferId };
}

// Validation of the payout fields in POST/PATCH /api/offers (absent fields are not checked).
function payoutError(body) {
  if (body.payoutType !== undefined && body.payoutType !== null && !['cpa', 'cpc'].includes(body.payoutType)) return 'invalid_payout_type';
  if (body.payout !== undefined && body.payout !== null && body.payout !== '' && !/^\d{1,8}(?:\.\d{1,4})?$/.test(String(body.payout))) return 'invalid_payout';
  if (body.payoutCurrency !== undefined && body.payoutCurrency !== null && body.payoutCurrency !== '' && !/^[A-Z]{3}$/i.test(String(body.payoutCurrency))) return 'invalid_payout_currency';
  return null;
}

// Validation of the conversion-cap fields in POST/PATCH /api/offers (absent fields are not checked).
function conversionCapError(id, body) {
  if (body.conversionCap !== undefined && body.conversionCap !== null && !(Number.isInteger(body.conversionCap) && body.conversionCap > 0)) return 'invalid_conversion_cap';
  if (body.capTz !== undefined && body.capTz !== null && !(typeof body.capTz === 'string' && validTimeZone(body.capTz))) return 'invalid_cap_tz';
  if (body.altOfferId !== undefined && body.altOfferId !== null && body.altOfferId !== '') {
    if (String(body.altOfferId) === id) return 'alt_offer_is_self';
    if (!offers.has(String(body.altOfferId))) return 'alt_offer_not_found';
  }
  return null;
}

async function loadOffers() {
  if (db) {
    try {
      const { rows } = await db.query('SELECT id, url, postback_url, payout_type, payout, payout_currency, daily_cap, name, network_id, "group", archived, conversion_cap, cap_tz, alt_offer_id FROM offers');
      for (const row of rows) if (/^[a-z0-9_-]{2,80}$/i.test(row.id) && /^https:\/\//i.test(row.url)) offers.set(row.id, parseOffer({ url: row.url, postbackUrl: row.postback_url, payoutType: row.payout_type, payout: row.payout, payoutCurrency: row.payout_currency, dailyCap: row.daily_cap, name: row.name, networkId: row.network_id, group: row.group, archived: row.archived === true,
        conversionCap: row.conversion_cap, capTz: row.cap_tz, altOfferId: row.alt_offer_id }));
      return;
    } catch (error) { console.warn('[db] offers load fallback:', error.message); }
  }
  try {
    const saved = JSON.parse(await readFile(offersFile, 'utf8'));
    for (const [id, raw] of Object.entries(saved)) {
      if (!/^[a-z0-9_-]{2,80}$/i.test(id)) continue;
      const offer = parseOffer(raw);
      if (offer) offers.set(id, offer);
    }
  } catch (error) { if (error.code !== 'ENOENT') console.warn('[offers] invalid config ignored'); }
}

async function saveOffers() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(offersFile, JSON.stringify(Object.fromEntries(offers), null, 2) + '\n');
}

async function persistOffer(id, value) {
  const offer = typeof value === 'string' ? { url: value, postbackUrl: null } : value;
  if (db) await db.query('INSERT INTO offers (id, url, postback_url, daily_cap, name, network_id, "group", archived, conversion_cap, cap_tz, alt_offer_id, payout_type, payout, payout_currency) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, postback_url = EXCLUDED.postback_url, payout_type = EXCLUDED.payout_type, payout = EXCLUDED.payout, payout_currency = EXCLUDED.payout_currency, daily_cap = EXCLUDED.daily_cap, name = EXCLUDED.name, network_id = EXCLUDED.network_id, "group" = EXCLUDED."group", archived = EXCLUDED.archived, conversion_cap = EXCLUDED.conversion_cap, cap_tz = EXCLUDED.cap_tz, alt_offer_id = EXCLUDED.alt_offer_id', [id, offer.url, offer.postbackUrl, offer.dailyCap ?? null, offer.name ?? null, offer.networkId ?? null, offer.group ?? '', offer.archived === true, offer.conversionCap ?? null, offer.capTz || 'UTC', offer.altOfferId ?? null, offer.payoutType || 'cpa', offer.payout ?? null, offer.payoutCurrency ?? null]);
  else await saveOffers();
}

const sources = new Map();
const networks = new Map();

function parseSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : null,
    paramMap: parseParamMap(raw.paramMap),
    costModel: raw.costModel === 'cpc' ? 'cpc' : 'none',
    cpc: Number.isFinite(Number(raw.cpc)) && Number(raw.cpc) >= 0 && Number(raw.cpc) < 1000 ? Number(raw.cpc) : 0,
    costFromParam: raw.costFromParam === true,
    // Postback to the traffic source: URL with macros and the conversion statuses that trigger it.
    postbackUrl: parsePostbackUrl(raw.postbackUrl, { allowHttp: sourcePostbackAllowPrivate }),
    postbackStatuses: parsePostbackStatuses(raw.postbackStatuses),
  };
}

async function loadSources() {
  if (db) {
    try {
      const { rows } = await db.query('SELECT id, name, param_map, cost_model, cpc, cost_from_param, postback_url, postback_statuses FROM sources');
      for (const row of rows) if (OFFER_ID_RE.test(row.id)) {
        const s = parseSource({ name: row.name, paramMap: row.param_map, costModel: row.cost_model, cpc: row.cpc, costFromParam: row.cost_from_param,
          postbackUrl: row.postback_url, postbackStatuses: row.postback_statuses });
        if (s) sources.set(row.id, s);
      }
      return;
    } catch (error) { console.warn('[db] sources load fallback:', error.message); }
  }
  try {
    const saved = JSON.parse(await readFile(sourcesFile, 'utf8'));
    for (const [id, raw] of Object.entries(saved)) {
      if (!OFFER_ID_RE.test(id)) continue;
      const s = parseSource(raw);
      if (s) sources.set(id, s);
    }
  } catch (error) { if (error.code !== 'ENOENT') console.warn('[sources] invalid config ignored'); }
}

async function saveSources() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(sourcesFile, JSON.stringify(Object.fromEntries(sources), null, 2) + '\n');
}

async function persistSource(id, value) {
  if (db) await db.query('INSERT INTO sources (id, name, param_map, cost_model, cpc, cost_from_param, postback_url, postback_statuses) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, param_map = EXCLUDED.param_map, cost_model = EXCLUDED.cost_model, cpc = EXCLUDED.cpc, cost_from_param = EXCLUDED.cost_from_param, postback_url = EXCLUDED.postback_url, postback_statuses = EXCLUDED.postback_statuses',
    [id, value.name ?? null, JSON.stringify(value.paramMap || {}), value.costModel, value.cpc, value.costFromParam, value.postbackUrl ?? null, JSON.stringify(value.postbackStatuses || ['sale'])]);
  else await saveSources();
}

function parseNetwork(raw) {
  const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 120) : '';
  if (!name) return null;
  return { name, offerParams: typeof raw?.offerParams === 'string' ? raw.offerParams.trim().slice(0, 1000) : '', clickIdParam: typeof raw?.clickIdParam === 'string' ? raw.clickIdParam.trim().slice(0, 80) : 'sub1', payoutParam: typeof raw?.payoutParam === 'string' ? raw.payoutParam.trim().slice(0, 80) : 'payout', notes: typeof raw?.notes === 'string' ? raw.notes.slice(0, 2000) : '' };
}
async function loadNetworks() {
  if (db) { try { const { rows } = await db.query('SELECT id,name,offer_params,click_id_param,payout_param,notes FROM networks'); for (const r of rows) { const n=parseNetwork({name:r.name,offerParams:r.offer_params,clickIdParam:r.click_id_param,payoutParam:r.payout_param,notes:r.notes}); if(n) networks.set(r.id,n); } return; } catch (e) { console.warn('[db] networks load fallback:', e.message); } }
  try { const saved=JSON.parse(await readFile(networksFile,'utf8')); for (const [id,raw] of Object.entries(saved||{})) if (OFFER_ID_RE.test(id) && parseNetwork(raw)) networks.set(id,parseNetwork(raw)); } catch (e) { if(e.code!=='ENOENT') console.warn('[networks] invalid config ignored'); }
}
async function saveNetworks() { await mkdir(dataDir,{recursive:true}); await writeFile(networksFile,JSON.stringify(Object.fromEntries(networks),null,2)+'\n'); }
async function persistNetwork(id,v) { if(db) await db.query('INSERT INTO networks (id,name,offer_params,click_id_param,payout_param,notes) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,offer_params=EXCLUDED.offer_params,click_id_param=EXCLUDED.click_id_param,payout_param=EXCLUDED.payout_param,notes=EXCLUDED.notes',[id,v.name,v.offerParams,v.clickIdParam,v.payoutParam,v.notes]); else await saveNetworks(); }

function parseCampaign(id, value) {
  return {
    name: String(value.name || id).slice(0, 120),
    group: typeof value.group === 'string' ? value.group.trim().slice(0, 60) : '',
    active: value.archived === true ? false : value.active !== false,
    archived: value.archived === true,
    streams: parseStreams(value.streams),
    dailyCap: Number.isInteger(value.dailyCap) && value.dailyCap > 0 ? value.dailyCap : null,
    capUrl: value.capUrl && /^https:\/\//i.test(String(value.capUrl)) ? String(value.capUrl).slice(0, 2048) : null,
    allowDevices: Array.isArray(value.allowDevices)
      ? value.allowDevices.filter((d) => ['mobile', 'tablet', 'desktop'].includes(d))
      : [],
    allowOS: parseConditions({ os: value.allowOS }).os,
    allowBrowsers: parseConditions({ browsers: value.allowBrowsers }).browsers,
    allowGeos: Array.isArray(value.allowGeos)
      ? value.allowGeos.map((g) => String(g).toUpperCase().slice(0, 2)).filter((g) => /^[A-Z]{2}$/.test(g))
      : [],
    geoCapUrl: value.geoCapUrl && /^https:\/\//i.test(String(value.geoCapUrl)) ? String(value.geoCapUrl).slice(0, 2048) : null,
    // Unique clicks: deduplicate by IP within dedupeWindow minutes (0 = no dedup)
    dedupeWindow: Number.isInteger(value.dedupeWindow) && value.dedupeWindow >= 0 ? value.dedupeWindow : 0,
    // Revenue cap: stop after earning revenueCap per day
    revenueCap: typeof value.revenueCap === 'number' && value.revenueCap > 0 ? value.revenueCap : null,
    botFilter: value.botFilter === true,
    datacenterAsBot: value.datacenterAsBot === true,
    domain: DOMAIN_RE.test(String(value.domain || '').toLowerCase()) ? String(value.domain).toLowerCase() : null,
    streamRotation: value.streamRotation === 'position' ? 'position' : 'weight',
    uniquenessHours: Number.isInteger(value.uniquenessHours) && value.uniquenessHours >= 1 && value.uniquenessHours <= 720 ? value.uniquenessHours : 24,
    bindVisitors: parseBindMode(value.bindVisitors),
    bindTtlHours: parseBindTtl(value.bindTtlHours),
    ownerId: /^[0-9a-f-]{36}$/i.test(String(value.ownerId || '')) ? String(value.ownerId).toLowerCase() : null,
    redirectMethod: REDIRECT_METHODS.includes(value.redirectMethod) ? value.redirectMethod : 'http',
    blockedIps: parseIpRules(value.blockedIps),
    allowedIps: parseIpRules(value.allowedIps),
    totalCap: Number.isInteger(value.totalCap) && value.totalCap > 0 ? value.totalCap : null,
    paramMap: parseParamMap(value.paramMap),
    costModel: value.costModel === 'cpc' ? 'cpc' : 'none',
    cpc: Number.isFinite(Number(value.cpc)) && Number(value.cpc) >= 0 && Number(value.cpc) < 1000 ? Number(value.cpc) : 0,
    costFromParam: value.costFromParam === true,
    conversionWindowDays: Number.isInteger(value.conversionWindowDays) && value.conversionWindowDays > 0 && value.conversionWindowDays <= 365 ? value.conversionWindowDays : null,
    sourceId: OFFER_ID_RE.test(String(value.sourceId || '')) ? String(value.sourceId) : null,
    // Campaign override of the source postback; null / [] = use the source's.
    sourcePostbackUrl: parsePostbackUrl(value.sourcePostbackUrl, { allowHttp: sourcePostbackAllowPrivate }),
    sourcePostbackStatuses: parsePostbackStatuses(value.sourcePostbackStatuses, []),
    monitoring: MONITOR_MODES.includes(value.monitoring) ? value.monitoring : 'notify',
  };
}

async function loadCampaigns() {
  if (db) {
    try {
      const { rows } = await db.query('SELECT id, name, active, streams, config FROM campaigns');
      for (const row of rows) if (/^[a-z0-9_-]{2,80}$/i.test(row.id)) campaigns.set(row.id, parseCampaign(row.id, { ...(row.config || {}), name: row.name, active: row.active, streams: row.streams }));
      return;
    } catch (error) { console.warn('[db] campaigns load fallback:', error.message); }
  }
  try {
    const saved = JSON.parse(await readFile(campaignsFile, 'utf8'));
    for (const [id, value] of Object.entries(saved)) {
      if (/^[a-z0-9_-]{2,80}$/i.test(id)) campaigns.set(id, parseCampaign(id, value));
    }
  } catch (error) { if (error.code !== 'ENOENT') console.warn('[campaigns] invalid config ignored'); }
}

async function saveCampaigns() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(campaignsFile, JSON.stringify(Object.fromEntries(campaigns), null, 2) + '\n');
}

async function persistCampaign(id, value) {
  if (db) await db.query('INSERT INTO campaigns (id, name, active, streams, config) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, streams = EXCLUDED.streams, config = EXCLUDED.config', [id, value.name, value.active, JSON.stringify(value.streams || []), JSON.stringify(value)]);
  else await saveCampaigns();
}

async function pauseCampaign(id, reason) {
  const cur = campaigns.get(id);
  if (!cur || !cur.active) return;
  const updated = { ...cur, active: false };
  campaigns.set(id, updated);
  await persistCampaign(id, updated);
  await event('campaign_paused', { campaign: id, reason });
  await event('audit', { actor: 'system', action: 'pause', entity: 'campaign', entityId: id, changes: { active: [true, false], reason: [null, reason] } });
}

// Appends hold the journal gate shared; clearing statistics and retention rewrite it exclusively (src/retention.js).
const journalGate = createJournalGate();
async function event(type, payload) {
  await mkdir(dataDir, { recursive: true });
  return journalGate.shared(async () => {
    const record = { id: randomUUID(), type, at: new Date().toISOString(), ...payload };
    await appendFile(eventsFile, `${JSON.stringify(record)}\n`);
    // `mirrored` settles once PostgreSQL has the event (null without a database).
    return { mirrored: eventMirror?.enqueue(record) ?? null };
  });
}

// Removes events from the journal and the matching rows from PostgreSQL. New events wait meanwhile;
// the mirror is drained first so a queued insert cannot bring a deleted row back.
async function removeStats(plan, deleteRows) {
  const result = await journalGate.rewrite(async () => {
    await eventMirror?.drain();
    let postgres = null;
    const counts = await filterJournal(eventsFile, plan, async () => { if (db) postgres = await deleteRows(db); });
    return { ...counts, postgres };
  });
  for (const offerId of offers.keys()) conversionCaps.invalidate(offerId);
  return result;
}

// RETENTION_DAYS=N: daily removal of unconverted clicks, their landing clicks and bot events older than N days.
const retentionDays = Number.parseInt(process.env.RETENTION_DAYS || '', 10);
async function runRetention() {
  const cutoff = new Date(Date.now() - retentionDays * 86400000);
  const removed = await removeStats(retentionPlan(cutoff.getTime()), (pool) => retentionRows(pool, cutoff.toISOString()));
  console.log(`[retention] older than ${cutoff.toISOString()}: removed ${removed.clicks} clicks, ${removed.lpClicks} lp clicks, ${removed.bots} bots from the journal`
    + (removed.postgres ? `; PostgreSQL: ${removed.postgres.clicks} clicks, ${removed.postgres.bots} bots` : ''));
  await event('audit', { actor: 'system', action: 'retention', entity: 'stats', entityId: 'retention',
    changes: { days: [null, retentionDays], clicks: [null, removed.clicks], lpClicks: [null, removed.lpClicks], bots: [null, removed.bots] } });
  return removed;
}

async function stats({ campaign = null, allowed = null, from = null, to = null, subid = null, country = null, offer = null, stream = null, currency = rates.defaultCurrency } = {}) {
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw Object.assign(new Error('invalid_from_date'), { statusCode: 400 });
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw Object.assign(new Error('invalid_to_date'), { statusCode: 400 });

  // PG path — groups by campaign+country+offer_id in one query to produce byCampaign, byCountry, byOffer
  if (db) {
    try {
      const conditions = [];
      const params = [];
      if (campaign) { params.push(campaign); conditions.push(`c.campaign = $${params.length}`); }
      if (allowed) { params.push(allowed); conditions.push(`c.campaign = ANY($${params.length}::text[])`); }
      if (from) { params.push(`${from}T00:00:00Z`); conditions.push(`c.created_at >= $${params.length}`); }
      if (to) { params.push(`${to}T23:59:59Z`); conditions.push(`c.created_at <= $${params.length}`); }
      if (subid) { params.push(subid); conditions.push(`c.subid = $${params.length}`); }
      if (country) { params.push(country.toUpperCase()); conditions.push(`c.country = $${params.length}`); }
      if (offer) { params.push(offer); conditions.push(`c.offer_id = $${params.length}`); }
      if (stream) { params.push(stream); conditions.push(`COALESCE(NULLIF(c.stream, ''), 'default') = $${params.length}`); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const fx = sqlFx(params, currency);
      const { rows } = await db.query(`
        SELECT
          c.campaign,
          c.country,
          c.offer_id,
          c.stream,
          c.landing_id,
          COUNT(c.lp_clicked_at)::int             AS lp_clicks,
          COUNT(c.click_id)::int                  AS clicks,
          COUNT(c.click_id) FILTER (WHERE c.is_unique_campaign)::int AS unique_clicks,
          ${SQL_CONVERSIONS}::int                 AS conversions,
          (${fx.revenue} + ${fx.clickRevenue})::float AS revenue,
          COUNT(cv.click_id) FILTER (WHERE cv.status = 'lead')::int     AS leads,
          COUNT(cv.click_id) FILTER (WHERE cv.status = 'sale')::int     AS sales,
          COUNT(cv.click_id) FILTER (WHERE cv.status = 'rejected')::int AS rejected,
          COUNT(cv.click_id) FILTER (WHERE cv.status = 'trash')::int    AS trash,
          ${fx.pending}::float AS pending_revenue,
          ${fx.cost}::float                       AS cost
        FROM clicks c
        LEFT JOIN conversions cv USING (click_id)
        ${where}
        GROUP BY c.campaign, c.country, c.offer_id, c.stream, c.landing_id
      `, params);
      const report = { ...reportFromRows(rows), currency };
      report.bySource = Object.create(null); report.byNetwork = Object.create(null);
      for (const row of rows) {
        const source = campaigns.get(row.campaign)?.sourceId; const network = offers.get(row.offer_id)?.networkId;
        for (const [key, id] of [['bySource', source || 'none'], ['byNetwork', network || 'none']]) {
          report[key][id] ||= { clicks: 0, conversions: 0, revenue: 0, cost: 0, uniqueClicks: 0 };
          const target = report[key][id]; for (const f of ['clicks','conversions','revenue','cost','uniqueClicks','leads','sales','rejected','trash','pendingRevenue']) target[f] = (target[f] || 0) + (Number(row[f] ?? row[f.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())]) || 0);
        }
      }
      report.bySource = Object.fromEntries(Object.entries(report.bySource).map(([k,v]) => [k, metrics(v)])); report.byNetwork = Object.fromEntries(Object.entries(report.byNetwork).map(([k,v]) => [k, metrics(v)]));
      return report;
    } catch (e) {
      if (e.statusCode) throw e;
      console.warn('[db] stats fallback to JSONL:', e.message);
    }
  }
  // JSONL fallback
  try {
    const lines = (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const fromMs = from ? Date.parse(`${from}T00:00:00Z`) : null;
    const toMs = to ? Date.parse(`${to}T23:59:59Z`) : null;
    const allClicks = lines.filter((item) => item.type === 'click');
    const clicks = allClicks.filter((item) => {
      if (campaign && item.campaign !== campaign) return false;
      if (allowed && !allowed.includes(item.campaign)) return false;
      if (subid && item.subid !== subid) return false;
      if (country && (item.country || '').toUpperCase() !== country.toUpperCase()) return false;
      if (offer && item.offerId !== offer) return false;
      if (stream && (item.stream || 'default') !== stream) return false;
      const t = item.at ? Date.parse(item.at) : null;
      if (fromMs !== null && (t === null || t < fromMs)) return false;
      if (toMs !== null && (t === null || t > toMs)) return false;
      return true;
    });
    const visibleClickIds = new Set(clicks.map((c) => c.clickId));
    const conversions = [...latestConversions(lines).values()].filter((item) => visibleClickIds.has(item.clickId));
    const conversionByClick = new Map(conversions.map((item) => [item.clickId, item]));
    const lpClicked = new Set(lines.filter((item) => item.type === 'lp_click').map((item) => item.clickId));
    const report = { ...reportFromEvents(clicks.map((c) => convertClickCost(lpClicked.has(c.clickId) ? { ...c, lpClicked: true } : c, currency)), conversions.map((cv) => convertConversion(cv, currency))), currency };
    report.bySource = Object.create(null); report.byNetwork = Object.create(null);
    for (const click of clicks) { const source = campaigns.get(click.campaign)?.sourceId || 'none'; const network = offers.get(click.offerId)?.networkId || 'none'; const cv = conversionByClick.get(click.clickId); const one = reportFromEvents([click], cv ? [cv] : []); for (const [key,id] of [['bySource',source],['byNetwork',network]]) { report[key][id] ||= { clicks:0, conversions:0, revenue:0, cost:0, uniqueClicks:0 }; for (const f of ['clicks','conversions','revenue','cost','uniqueClicks','leads','sales','rejected','trash','pendingRevenue']) report[key][id][f] = (report[key][id][f] || 0) + (one[f] || 0); } }
    report.bySource = Object.fromEntries(Object.entries(report.bySource).map(([k,v]) => [k, metrics(v)])); report.byNetwork = Object.fromEntries(Object.entries(report.byNetwork).map(([k,v]) => [k, metrics(v)]));
    return report;
  } catch (error) {
    if (error.code === 'ENOENT') return { ...reportFromEvents([], []), currency };
    throw error;
  }
}

// Clicks/conversions/revenue/cost grouped by one tracked parameter value ('' = not passed).
// Click attributes stored as columns (not in params) that reports can group by.
const DIMENSION_FIELDS = ['device', 'os', 'browser', 'language', 'isp', 'connection'];
async function paramReport({ field, campaign, allowed = null, from, to, currency = rates.defaultCurrency }) {
  const isColumn = DIMENSION_FIELDS.includes(field);
  if (db) {
    try {
      const conditions = []; const values = isColumn ? [] : [field];
      if (campaign) { values.push(campaign); conditions.push(`c.campaign = $${values.length}`); }
      if (allowed) { values.push(allowed); conditions.push(`c.campaign = ANY($${values.length}::text[])`); }
      if (from) { values.push(`${from}T00:00:00Z`); conditions.push(`c.created_at >= $${values.length}`); }
      if (to) { values.push(`${to}T23:59:59Z`); conditions.push(`c.created_at <= $${values.length}`); }
      const fx = sqlFx(values, currency);
      const { rows } = await db.query(`
        SELECT ${isColumn ? `COALESCE(c.${field}, '')` : "COALESCE(c.params->>$1, '')"} AS value, COUNT(c.click_id)::int AS clicks, COUNT(c.click_id) FILTER (WHERE c.is_unique_campaign IS DISTINCT FROM false)::int AS unique_clicks, ${SQL_CONVERSIONS}::int AS conversions,
          (${fx.revenue} + ${fx.clickRevenue})::float AS revenue, ${fx.cost}::float AS cost
        FROM clicks c LEFT JOIN conversions cv USING (click_id)
        ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
        GROUP BY 1 ORDER BY clicks DESC LIMIT 500`, values);
      return rows.map(metrics);
    } catch (e) { console.warn('[db] paramReport fallback:', e.message); }
  }
  let lines = [];
  try { lines = (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fromMs = from ? Date.parse(`${from}T00:00:00Z`) : null;
  const toMs = to ? Date.parse(`${to}T23:59:59Z`) : null;
  const conv = latestConversions(lines);
  const groups = new Map();
  for (const click of lines) {
    if (click.type !== 'click' || (campaign && click.campaign !== campaign) || (allowed && !allowed.includes(click.campaign))) continue;
    const t = Date.parse(click.at);
    if ((fromMs !== null && t < fromMs) || (toMs !== null && t > toMs)) continue;
    const key = (isColumn ? click[field] : click.params?.[field]) ?? '';
    const g = groups.get(key) || { value: key, clicks: 0, uniqueClicks: 0, conversions: 0, revenue: 0, cost: 0 };
    const cv = conv.get(click.clickId);
    g.clicks += 1; if (click.uniqueCampaign !== false) g.uniqueClicks += 1; g.cost += (Number(click.cost) || 0) * rates.factor(rates.defaultCurrency, currency);
    g.revenue += (Number(click.revenue) || 0) * rates.factor(rates.defaultCurrency, currency);
    if (cv && conversionCounts(cv)) { g.conversions += 1; g.revenue += saleRevenue(cv) * rates.factor(cv.currency, currency); }
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.clicks - a.clicks).slice(0, 500).map(metrics);
}

// Returns { offerId, campaign } for a click, or null if not found.
const landings = new Map();

function parseLanding(raw) {
  const url = String(raw?.url || '').trim();
  if (!/^https:\/\//i.test(url)) return null;
  const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : null;
  return { url: url.slice(0, 2048), name };
}

async function loadLandings() {
  if (db) {
    try {
      const { rows } = await db.query('SELECT id, url, name FROM landings');
      for (const row of rows) { const l = OFFER_ID_RE.test(row.id) && parseLanding(row); if (l) landings.set(row.id, l); }
      return;
    } catch (error) { console.warn('[db] landings load fallback:', error.message); }
  }
  try {
    for (const [id, raw] of Object.entries(JSON.parse(await readFile(landingsFile, 'utf8')))) { const l = OFFER_ID_RE.test(id) && parseLanding(raw); if (l) landings.set(id, l); }
  } catch (error) { if (error.code !== 'ENOENT') console.warn('[landings] invalid config ignored'); }
}

async function persistLanding(id, landing) {
  if (db) await db.query('INSERT INTO landings (id, url, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, name = EXCLUDED.name', [id, landing.url, landing.name]);
  else { await mkdir(dataDir, { recursive: true }); await writeFile(landingsFile, JSON.stringify(Object.fromEntries(landings), null, 2) + '\n'); }
}

// Public URL of this tracker as the visitor sees it (behind a proxy: scheme from X-Forwarded-Proto, plus BASE_PATH).
// Tracking domains (Keitaro «Домены»): any host other than PRIMARY_HOST serves only tracking routes at the root,
// without BASE_PATH. The panel and APIs stay on the primary host.
const primaryHost = String(process.env.PRIMARY_HOST || '').toLowerCase();
const requestHost = (req) => String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
// Local calls (deploy checks, seeding) count as the primary host.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const onTrackingDomain = (req) => Boolean(primaryHost) && requestHost(req) !== primaryHost && !LOCAL_HOSTS.has(requestHost(req));
const isTrackingPath = (p) => p.startsWith('/r/') || p === '/lp/click' || p === '/postback' || p === '/health';
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
async function trackingDomains() {
  try {
    return (await readFile(join(root, 'deploy', 'domains.txt'), 'utf8')).split('\n').map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith('#') && DOMAIN_RE.test(l));
  } catch { return []; }
}

function publicBase(req) {
  const proto = trustProxyHops > 0 && req.headers['x-forwarded-proto'] === 'https' ? 'https' : (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host || 'localhost'}${onTrackingDomain(req) ? '' : basePath}`;
}

// Full click record for /lp/click. PostgreSQL first; JSONL when the mirror has not caught up yet.
async function getClickRecord(clickId) {
  if (db) {
    try {
      const { rows } = await db.query('SELECT campaign, offer_id, landing_id, subid, country, params, cost FROM clicks WHERE click_id = $1', [clickId]);
      if (rows.length) { const r = rows[0]; return { campaign: r.campaign, offerId: r.offer_id, landingId: r.landing_id, subid: r.subid, country: r.country, params: r.params, cost: Number(r.cost) || 0 }; }
    } catch (e) { console.warn('[db] getClickRecord fallback:', e.message); }
  }
  try {
    const lines = (await readFile(eventsFile, 'utf8')).split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes(clickId)) continue;
      try { const item = JSON.parse(lines[i]); if (item.type === 'click' && item.clickId === clickId) return item; } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }
  return null;
}

async function getClickData(clickId) {
  if (db) {
    try {
      const { rows } = await db.query('SELECT offer_id, campaign, created_at FROM clicks WHERE click_id = $1', [clickId]);
      if (rows.length) return { offerId: rows[0].offer_id, campaign: rows[0].campaign, at: new Date(rows[0].created_at).toISOString() };
    } catch (e) { console.warn('[db] getClickData fallback:', e.message); }
  }
  try {
    const lines = (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.type === 'click' && item.clickId === clickId) return { offerId: item.offerId, campaign: item.campaign, at: item.at };
      } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }
  return null;
}

// Constant-time comparison so response timing does not leak how much of a secret matched.
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a ?? '')).digest();
  const hb = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(ha, hb) && String(a ?? '') === String(b ?? '');
}

// Browser hardening for the panel and APIs. Tracking redirects keep the browser's default referrer
// behaviour, because networks rely on it.
const ADMIN_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
function securityHeaders(res, path) {
  res.setHeader('x-content-type-options', 'nosniff');
  if (path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/') || path === '/stats' || path.startsWith('/stats/') || path === '/dashboard' || path.startsWith('/assets/')) {
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
  }
  if (path === '/admin' || path.startsWith('/admin/')) res.setHeader('content-security-policy', ADMIN_CSP);
}

function json(res, status, body) {
  if (res.revenueFilter) body = stripRevenue(body, res.revenueFilter.urls);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const sourcePostbacks = createSourcePostbacks({
  targetFor: (click) => { const c = campaigns.get(click.campaign); return resolveSourcePostback(c, c?.sourceId ? sources.get(c.sourceId) : null); },
  loadClick: getClickRecord,
  alreadySent: (clickId, status) => journalHasSourcePostback(eventsFile, clickId, status),
  record: (payload) => event('source_postback', payload),
  allowPrivate: sourcePostbackAllowPrivate,
  onError: (error) => console.warn('[source-postback] failed:', error.message),
});

const recordPostback = createConversionRecorder({
  findClick: getClickData,
  hasConversion: (clickId) => hasRecordedConversion({ clickId, eventsFile, db,
    onFallback: (error) => console.warn('[db] hasConversion fallback:', error.message) }),
  currentConversion: (clickId) => findRecordedConversion({ clickId, eventsFile, db,
    onFallback: (error) => console.warn('[db] currentConversion fallback:', error.message) }),
  windowDaysForClick: (click) => campaigns.get(click.campaign)?.conversionWindowDays,
  // A postback without revenue earns the CPA offer's payout (CPC offers are paid per click, not here).
  defaultRevenue: (click) => {
    const offer = offers.get(click.offerId);
    return offer?.payoutType === 'cpa' && offer.payout !== null && offer.payout !== undefined
      ? { revenue: String(offer.payout), currency: offer.payoutCurrency } : null;
  },
  record: (payload) => event('conversion', payload),
  onRecorded: ({ click, clickId, revenue, currency, status, previousStatus, recorded }) => {
    // Recount the offer's conversion cap now and again once PostgreSQL has the conversion.
    if (click.offerId) conversionCaps.invalidate(click.offerId, recorded?.mirrored);
    // Postback to the traffic source: fire-and-forget, never delays the /postback response.
    sourcePostbacks.dispatch({ clickId, status: status || 'sale', revenue, currency, previousStatus, click });
    const offer = offers.get(click.offerId);
    if (!offer?.postbackUrl) return;
    const s2sUrl = applyMacros(offer.postbackUrl, { click_id: clickId, revenue: revenue ?? '', currency: currency ?? '', status: status || 'sale' });
    fetch(s2sUrl, { signal: AbortSignal.timeout(10000) })
      .then(async (response) => {
        await response.body?.cancel();
        if (!response.ok) console.warn('[s2s] postback HTTP:', response.status);
      }).catch((error) => console.warn('[s2s] postback failed:', error.message));
  },
  onDeliveryError: (error) => console.warn('[s2s] postback scheduling failed:', error.message),
});

function bearerAuthorized(req) {
  return Boolean(adminToken) && safeEqual(req.headers.authorization, `Bearer ${adminToken}`);
}

async function sessionUser(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  try { return await users.userForToken(token); }
  catch (error) { console.warn('[auth] session lookup failed:', error.message); return null; }
}

// Writes: admin Bearer token, or a logged-in user. Cookie-authenticated writes must carry
// X-Requested-With: umbrella — a cross-site form cannot set it, which blocks CSRF.
async function adminAuthorized(req) {
  if (bearerAuthorized(req)) return true;
  // A personal API key arrives in the Authorization header, which a cross-site form cannot set.
  if (req.apiKey) return true;
  if (req.user) return req.method === 'GET' || req.headers['x-requested-with'] === 'umbrella';
  return !adminToken && !requireLogin && (await users.count()) === 0;
}

function sessionCookie(req, token, maxAgeSeconds) {
  const secure = process.env.COOKIE_SECURE === '1' || (trustProxyHops > 0 && req.headers['x-forwarded-proto'] === 'https');
  return `${SESSION_COOKIE}=${token}; Path=${basePath || '/'}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

const isPrivatePath = (p) => (p.startsWith('/api/') && !p.startsWith('/api/auth/')) || p === '/stats' || p.startsWith('/stats/') || p === '/dashboard' || p.startsWith('/assets/');

function loginBlocked(ip) {
  const now = Date.now();
  const recent = (loginFailures.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  loginFailures.set(ip, recent);
  return recent.length >= 10;
}

async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('request_too_large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid_json'), { statusCode: 400 }); }
}

function dashboard(res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Product Umbrella</title><link rel="stylesheet" href="/assets/event-logs.css">
  <style>:root{--tiffany:#0abab5;--deep:#123b40;--ink:#173b40;--line:#d6eeeb;--paper:#fff}*{box-sizing:border-box}body{font:16px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:1040px;margin:0 auto;padding:48px 24px;background:linear-gradient(145deg,#f1fffd,#fff 55%,#e9fbf8);color:var(--ink)}h1{font-size:36px;letter-spacing:-.04em;margin:0 0 2px;color:var(--deep)}h2{margin:34px 0 14px;color:var(--deep)}small,.muted{color:#648287}.cards{display:flex;gap:16px;flex-wrap:wrap;margin:30px 0}.card{background:rgba(255,255,255,.85);border:1px solid var(--line);box-shadow:0 12px 30px rgba(18,59,64,.08);border-radius:18px;padding:20px;min-width:180px;flex:1}.value{font-size:34px;font-weight:750;color:var(--deep)}form{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}input,button{font:inherit;border-radius:10px;padding:11px 13px;border:1px solid #b8ded9}input{background:#fff;min-width:190px;color:var(--ink)}button{background:var(--tiffany);border-color:var(--tiffany);color:#fff;font-weight:700;cursor:pointer;box-shadow:0 5px 12px rgba(10,186,181,.25)}button:hover{background:#079b98}ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}li{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 14px}table{width:100%;border-collapse:separate;border-spacing:0;background:rgba(255,255,255,.9);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 10px 25px rgba(18,59,64,.06)}td,th{text-align:left;padding:14px 16px;border-bottom:1px solid var(--line)}th{color:#5c7d81;background:#f3fffd;font-size:13px;text-transform:uppercase;letter-spacing:.08em}tr:last-child td{border-bottom:0}</style>
  <style>#stream-editor{margin-top:40px;padding:24px;background:white;border:1px solid var(--line);border-radius:18px}#stream-editor fieldset{border:1px solid var(--line);border-radius:12px;margin:18px 0;padding:18px}#stream-editor label{display:grid;gap:5px;min-width:0}#stream-editor label span{font-size:12px;color:#648287}#stream-editor input,#stream-editor select{width:100%;min-width:0;font:inherit;padding:10px;border:1px solid #b8ded9;border-radius:10px;background:white}#stream-editor .editor-row{display:flex;flex-wrap:wrap;align-items:end;gap:10px;margin:12px 0}#stream-editor .editor-row label{flex:1;min-width:140px}#stream-editor .editor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:12px 0}#stream-editor summary{cursor:pointer;color:var(--deep)}#stream-editor [role=status]{color:#17685f}#stream-editor a{color:#17685f;overflow-wrap:anywhere}#stream-editor button:disabled{opacity:.5;cursor:wait}</style>
  <h1>Product Umbrella</h1><small>Локальный трекер кампаний</small><div id="app">Загрузка…</div><section id="stream-editor" aria-label="Редактор потоков"></section><section id="event-logs" aria-label="Журнал событий"></section>
  <script>
  function fmt(n){return n==null?'—':Number(n).toFixed(2);}
  function esc(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');}
  function tbl(rows,hdrs){return '<table><thead><tr>'+hdrs.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+(rows||'<tr><td colspan="'+hdrs.length+'">Нет данных</td></tr>')+'</tbody></table>';}
  function csvDownload(data,filename){const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(data);a.download=filename;a.click();}
  function sparkline(series){const BARS='▁▂▃▄▅▆▇█';const vals=series.map(v=>v.clicks);const mx=Math.max(...vals,1);return vals.map(v=>BARS[Math.round((v/mx)*(BARS.length-1))]).join('');}
  let lastStats={};
  async function render(q={}){
    const p=new URLSearchParams(q);
    const compareUrl=q.from&&q.to?('/stats/compare?from='+encodeURIComponent(q.from)+'&to='+encodeURIComponent(q.to)):null;
    const paramField=q.param||'sub_id_1';
    const [s,o,c,ts,src,net,cmp,pr,bots]=await Promise.all([fetch('/stats?'+p).then(r=>r.json()),fetch('/api/offers').then(r=>r.json()),fetch('/api/campaigns').then(r=>r.json()),fetch('/stats/timeseries?from='+new Date(Date.now()-6*86400000).toISOString().slice(0,10)).then(r=>r.json()),fetch('/api/sources').then(r=>r.json()),fetch('/api/networks').then(r=>r.json()),compareUrl?fetch(compareUrl).then(r=>r.json()):Promise.resolve(null),fetch('/stats/params?field='+encodeURIComponent(paramField)+(q.from?'&from='+q.from:'')+(q.to?'&to='+q.to:'')).then(r=>r.json()),fetch('/stats/bots'+(q.from?'?from='+q.from+(q.to?'&to='+q.to:''):'')).then(r=>r.json())]);
    lastStats=s;
    const campRows=Object.entries(s.byCampaign).map(([name,v])=>'<tr><td><a href="?campaign='+encodeURIComponent(name)+'" style="color:#087f7b;text-decoration:none;font-weight:650">'+esc(name)+'</a></td><td>'+v.clicks+'</td><td>'+v.conversions+'</td><td>'+((v.conversions/Math.max(v.clicks,1))*100).toFixed(2)+'%</td><td>'+fmt(v.revenue)+'</td></tr>').join('');
    const ctryRows=Object.entries(s.byCountry||{}).sort((a,b)=>b[1].clicks-a[1].clicks).slice(0,15).map(([ctry,v])=>'<tr><td>'+ctry+'</td><td>'+v.clicks+'</td><td>'+v.conversions+'</td><td>'+fmt(v.revenue)+'</td></tr>').join('');
    const offerRows=Object.entries(s.byOffer||{}).sort((a,b)=>b[1].clicks-a[1].clicks).map(([id,v])=>'<tr><td>'+id+'</td><td>'+v.clicks+'</td><td>'+v.conversions+'</td><td>'+((v.conversions/Math.max(v.clicks,1))*100).toFixed(2)+'%</td><td>'+fmt(v.revenue)+'</td></tr>').join('');
    const streamRows=Object.entries(s.byStream||{}).sort((a,b)=>b[1].clicks-a[1].clicks).map(([name,v])=>'<tr><td>'+esc(name)+'</td><td>'+v.clicks+'</td><td>'+v.conversions+'</td><td>'+((v.cr||0)*100).toFixed(2)+'%</td><td>'+fmt(v.revenue)+'</td><td>'+fmt(v.epc)+'</td></tr>').join('');
    const paramRows=(pr.rows||[]).map(v=>'<tr><td>'+esc(v.value||'(не передан)')+'</td><td>'+v.clicks+'</td><td>'+v.conversions+'</td><td>'+fmt(v.revenue)+'</td></tr>').join('');
    const offerList=Object.entries(o.offers).map(([id,v])=>'<li><input type="checkbox" data-offer-select="'+esc(id)+'"> <b>'+esc(id)+'</b> — '+esc(typeof v==='string'?v:v.url)+(v.group?' <small>['+esc(v.group)+']</small>':'')+(v.postbackUrl?' <small>[S2S]</small>':'')+(v.networkId&&net.networks?.[v.networkId]?' <small>['+esc(net.networks[v.networkId].name)+']</small>':'')+' <button data-offer-action="clone" data-offer="'+esc(id)+'">Копировать</button> <button data-offer-action="archive" data-offer="'+esc(id)+'">'+(v.archived?'Восстановить':'В архив')+'</button></li>').join('');
    const campList=Object.entries(c.campaigns).map(([id,v])=>'<li><b>'+esc(id)+'</b> — '+esc(v.name)+(v.group?' <small>['+esc(v.group)+']</small>':'')+' <button data-campaign="'+esc(id)+'" data-active="'+(!v.active)+'">'+(v.active?'Выключить':'Включить')+'</button> <button data-campaign-action="clone" data-campaign-id="'+esc(id)+'">Копировать</button> <button data-campaign-action="archive" data-campaign-id="'+esc(id)+'">'+(v.archived?'Восстановить':'В архив')+'</button></li>').join('');
    const campOpts='<option value="">Все кампании</option>'+Object.keys(c.campaigns).map(id=>'<option>'+id+'</option>').join('');
    const sourceOpts='<option value="">Без источника</option>'+Object.entries(src.sources||{}).map(([id,v])=>'<option value="'+esc(id)+'">'+esc(v.name)+' ('+esc(id)+')</option>').join('');
    const networkOpts='<option value="">Без сети</option>'+Object.entries(net.networks||{}).map(([id,v])=>'<option value="'+esc(id)+'">'+esc(v.name)+' ('+esc(id)+')</option>').join('');
    const inp=k=>'<input id="f-'+k+'" '+(k==='from'||k==='to'?'type="date"':'placeholder="'+(k==='country'?'Страна (US)':'Оффер')+'"')+' style="font:inherit;border-radius:10px;padding:10px;border:1px solid #b8ded9;background:#fff;width:130px">';
    const spark=ts&&ts.series&&ts.series.length?'<div style="font-family:monospace;font-size:18px;letter-spacing:2px;color:#1a7f6e;margin:-6px 0 6px;line-height:1" title="Клики за 7 дней">'+sparkline(ts.series)+'</div><div style="font-size:11px;color:#999;margin-bottom:8px">7 дней</div>':'';
    document.querySelector('#app').innerHTML=
      '<div class="cards"><div class="card"><div class="muted">Клики</div><div class="value">'+s.clicks+'</div>'+spark+(cmp?.deltaPct?.clicks!=null?'<small>Δ '+cmp.deltaPct.clicks+'%</small>':'')+'</div>'
      +'<div class="card"><div class="muted">Конверсии</div><div class="value">'+s.conversions+'</div>'+(cmp?.deltaPct?.conversions!=null?'<small>Δ '+cmp.deltaPct.conversions+'%</small>':'')+'</div>'
      +'<div class="card"><div class="muted">CR</div><div class="value">'+((s.conversions/Math.max(s.clicks,1))*100).toFixed(2)+'%</div></div>'
      +'<div class="card"><div class="muted">Revenue</div><div class="value">'+fmt(s.revenue)+'</div>'+(cmp?.deltaPct?.revenue!=null?'<small>Δ '+cmp.deltaPct.revenue+'%</small>':'')+'</div></div>'
      +(bots.total>0?'<div class="card" style="margin-bottom:20px"><div class="muted">Боты</div><div class="value">'+bots.total+'</div><small>Доля: '+((bots.total/Math.max(s.clicks+bots.total,1))*100).toFixed(2)+'%</small></div>':'')
      +'<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px;align-items:center">'
      +'<select id="f-campaign" style="font:inherit;border-radius:10px;padding:10px 13px;border:1px solid #b8ded9;background:#fff">'+campOpts+'</select>'
      +inp('from')+inp('to')+inp('country')+inp('offer')
      +'<input id="f-stream" placeholder="Поток (или default)" aria-label="Фильтр по потоку">'
      +'<button id="f-apply">Применить</button>'
      +'<button id="f-csv" style="background:#1a7f6e">CSV</button></div>'
      +'<h2>По кампаниям</h2>'+tbl(campRows,['Кампания','Клики','Конв.','CR','Revenue'])
      +(offerRows?'<h2>По офферам</h2>'+tbl(offerRows,['Оффер','Клики','Конв.','CR','Revenue']):'')
      +(streamRows?'<h2>По потокам</h2>'+tbl(streamRows,['Поток','Клики','Конв.','CR','Revenue','EPC']):'')
      +'<h2>По параметру</h2><div style="margin-bottom:8px"><select id="f-param" style="font:inherit;border-radius:10px;padding:10px;border:1px solid #b8ded9;background:#fff"><option value="sub_id_1">sub_id_1</option><option value="source">source</option><option value="keyword">keyword</option><option value="creative_id">creative_id</option></select><button id="f-param-apply">Показать</button></div>'+tbl(paramRows,['Значение','Клики','Конв.','Revenue'])
      +(ctryRows?'<h2>По странам (топ-15)</h2>'+tbl(ctryRows,['Страна','Клики','Конв.','Revenue']):'')
      +'<h2>Добавить оффер</h2><form id="offer-form"><input name="id" placeholder="offer-id" required pattern="[A-Za-z0-9_-]{2,80}"><input name="url" type="url" placeholder="https://..." required><input name="group" placeholder="Группа (необязательно)" maxlength="60"><input name="postbackUrl" type="url" placeholder="S2S URL (необязательно)"><select name="networkId" style="font:inherit;border-radius:10px;padding:10px 13px;border:1px solid #b8ded9;background:#fff">'+networkOpts+'</select><button>Сохранить</button></form>'
      +'<h2>Офферы</h2><button id="bulk-offer-archive" style="background:#1a7f6e">Архивировать выбранные</button><ul>'+(offerList||'<li>Пока нет офферов</li>')+'</ul>'
      +'<h2>Кампании</h2><form id="campaign-form"><input name="id" placeholder="campaign-id" required pattern="[A-Za-z0-9_-]{2,80}"><input name="name" placeholder="Название" required><input name="group" placeholder="Группа (необязательно)" maxlength="60"><select name="sourceId" style="font:inherit;border-radius:10px;padding:10px 13px;border:1px solid #b8ded9;background:#fff">'+sourceOpts+'</select><button>Создать</button></form>'
      +'<h2>Источники</h2><form id="source-form"><input name="id" placeholder="source-id" required pattern="[A-Za-z0-9_-]{2,80}"><input name="name" placeholder="Название источника" required><select name="costModel" style="font:inherit;border-radius:10px;padding:10px;border:1px solid #b8ded9;background:#fff"><option value="none">Без CPC</option><option value="cpc">CPC</option></select><input name="cpc" type="number" min="0" step="0.000001" placeholder="CPC"><input name="paramMap" placeholder="Параметры JSON: {&quot;sub_id_1&quot;:&quot;ad_id&quot;}"><button>Добавить источник</button></form><ul>'+(Object.entries(src.sources||{}).map(([id,v])=>'<li><b>'+esc(id)+'</b> — '+esc(v.name)+' <small>('+esc(v.costModel||'none')+')</small></li>').join('')||'<li>Источники пока не созданы</li>')+'</ul>'
      +'<h2>Партнёрские сети</h2><form id="network-form"><input name="id" placeholder="network-id" required pattern="[A-Za-z0-9_-]{2,80}"><input name="name" placeholder="Название сети" required><input name="clickIdParam" placeholder="click id: sub1"><input name="payoutParam" placeholder="payout: payout"><button>Добавить сеть</button></form><ul>'+(Object.entries(net.networks||{}).map(([id,v])=>'<li><b>'+esc(id)+'</b> — '+esc(v.name)+' <small>click: '+esc(v.clickIdParam||'sub1')+', payout: '+esc(v.payoutParam||'payout')+'</small></li>').join('')||'<li>Сети пока не созданы</li>')+'</ul>'
      +'<ul>'+(campList||'<li>Нет кампаний</li>')+'</ul>'
      +'<h2>Тренды</h2><div><select id="trend-campaigns" multiple size="4" style="min-width:220px;font:inherit;border:1px solid #b8ded9;border-radius:10px;padding:8px">'+Object.keys(c.campaigns).map(id=>'<option value="'+esc(id)+'">'+esc(id)+'</option>').join('')+'</select><select id="trend-metric" style="font:inherit;border:1px solid #b8ded9;border-radius:10px;padding:10px"><option value="clicks">Клики</option><option value="conversions">Конверсии</option><option value="revenue">Доход</option></select><button id="trend-load">Показать</button></div><div id="trend-output" class="muted" style="margin-top:10px">Выберите до пяти кампаний</div>';
    for(const key of ['campaign','from','to','country','offer','stream'])document.querySelector('#f-'+key).value=q[key]||'';
    document.querySelector('#f-param').value=paramField;
    document.querySelector('#f-param-apply').onclick=()=>render({...q,param:document.querySelector('#f-param').value});
    document.querySelector('#f-apply').onclick=()=>{const f={};for(const key of ['campaign','from','to','country','offer','stream']){const value=document.querySelector('#f-'+key).value;if(value)f[key]=value;}render(f);};
    document.querySelector('#f-csv').onclick=()=>{const rows=['campaign,clicks,conversions,cr,revenue',...Object.entries(lastStats.byCampaign||{}).map(([n,v])=>[n,v.clicks,v.conversions,((v.conversions/Math.max(v.clicks,1))*100).toFixed(2),v.revenue.toFixed(2)].join(','))].join('\\n');csvDownload(rows,'stats.csv');};
    document.querySelector('#trend-load').onclick=async()=>{const ids=[...document.querySelector('#trend-campaigns').selectedOptions].slice(0,5).map(x=>x.value);if(!ids.length)return;const metric=document.querySelector('#trend-metric').value;const rows=await Promise.all(ids.map(async id=>({id,data:(await (await fetch('/stats/timeseries?campaign='+encodeURIComponent(id))).json()).series||[]})));const days=[...new Set(rows.flatMap(x=>x.data.map(v=>v.date)))].sort();document.querySelector('#trend-output').innerHTML=tbl(days.map(day=>'<tr><td>'+day+'</td>'+rows.map(x=>'<td>'+fmt((x.data.find(v=>v.date===day)||{})[metric]||0)+'</td>').join('')+'</tr>').join(''),['День',...rows.map(x=>x.id)]);};
    document.querySelector('#offer-form').onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));if(!body.postbackUrl)delete body.postbackUrl;const r=await fetch('/api/offers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)return alert('Ошибка');render();};
    document.querySelector('#campaign-form').onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));const r=await fetch('/api/campaigns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)return alert('Ошибка');render();};
    document.querySelector('#source-form').onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));if(body.cpc)body.cpc=Number(body.cpc);if(body.paramMap){try{body.paramMap=JSON.parse(body.paramMap);}catch{return alert('Неверный JSON paramMap');}}else delete body.paramMap;const r=await fetch('/api/sources',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)return alert('Ошибка');render();};
    document.querySelector('#network-form').onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));const r=await fetch('/api/networks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)return alert('Ошибка');render();};
    document.querySelectorAll('[data-campaign]').forEach(b=>b.onclick=async()=>{await fetch('/api/campaigns/'+b.dataset.campaign,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({active:b.dataset.active==='true'})});render();});
    document.querySelectorAll('[data-campaign-action]').forEach(b=>b.onclick=async()=>{const id=b.dataset.campaignId;if(b.dataset.campaignAction==='clone')await fetch('/api/campaigns/'+id+'/clone',{method:'POST'});else await fetch('/api/campaigns/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({archived:b.textContent.includes('В архив')})});render();});
    document.querySelectorAll('[data-offer-action]').forEach(b=>b.onclick=async()=>{const id=b.dataset.offer;if(b.dataset.offerAction==='clone')await fetch('/api/offers/'+id+'/clone',{method:'POST'});else await fetch('/api/offers/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({archived:b.textContent.includes('В архив')})});render();});
    document.querySelector('#bulk-offer-archive').onclick=async()=>{const ids=[...document.querySelectorAll('[data-offer-select]:checked')].map(x=>x.dataset.offer);await Promise.all(ids.map(id=>fetch('/api/offers/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({archived:true})})));render();};
  }
  render();
  </script><script type="module" src="/assets/stream-editor.js"></script><script type="module" src="/assets/event-logs.js"></script></html>`);
}

const htmlAttr = (v) => String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Keitaro-style redirect methods: plain 302, meta refresh, or JavaScript (with meta fallback).
function sendRedirect(res, location, method = 'http') {
  if (method === 'meta' || method === 'js') {
    const meta = `<meta http-equiv="refresh" content="0;url=${htmlAttr(location)}">`;
    const script = method === 'js' ? `<script>location.replace(${JSON.stringify(location).replace(/</g, '\\u003c')})</script><noscript>${meta}</noscript>` : meta;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">${script}</head><body><a href="${htmlAttr(location)}">Continue</a></body></html>`);
  }
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  return res.end();
}

// Buyers see and edit only their own campaigns; owners, the admin token and a fresh dev install see everything.
// A viewer is scoped like a buyer unless the owner gave it viewAll (it never writes anyway).
const isBuyer = (req) => (req.user?.role === 'buyer' || (req.user?.role === 'viewer' && !req.user.viewAll)) && !bearerAuthorized(req);
function scopeCampaigns(req) {
  if (!isBuyer(req)) return null;
  return [...campaigns].filter(([, c]) => c.ownerId === req.user.id).map(([id]) => id);
}
// Resolves ?campaign= against the caller's scope: { campaign, allowed } or { forbidden: true }.
function campaignScope(req, requested) {
  const allowed = scopeCampaigns(req);
  if (!allowed) return { campaign: requested, allowed: null };
  if (requested && !allowed.includes(requested)) return { forbidden: true };
  return { campaign: requested, allowed };
}
const canEditCampaign = (req, c) => !isBuyer(req) || c?.ownerId === req.user.id;

// Per-user permission flags (Keitaro «Права пользователей»). They never restrict the owner or ADMIN_TOKEN.
const restrictedUser = (req) => Boolean(req.user) && req.user.role !== 'owner' && !bearerAuthorized(req);
const hidesRevenue = (req) => restrictedUser(req) && req.user.hideRevenue === true;
const isViewer = (req) => req.user?.role === 'viewer' && !bearerAuthorized(req);
// hideRevenue removes these keys (not zeroes them: a zero profit or ROI would be a lie) at any depth of the response.
const REVENUE_KEY = /revenue|profit|payout|earning|^(roi|epc|uepc|rpm)$/i;
const URL_KEY = /^(url|postbackUrl)$/;
function stripRevenue(value, urls) {
  if (Array.isArray(value)) return value.map((v) => stripRevenue(v, urls));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !REVENUE_KEY.test(k) && !(urls && URL_KEY.test(k))).map(([k, v]) => [k, stripRevenue(v, urls)]));
}
// Paths whose responses are filtered for a hideRevenue user; urls: also drop offer/postback URLs.
function revenueFilterFor(path) {
  if (path === '/stats' || path.startsWith('/stats/') || path === '/api/conversions') return { urls: false };
  if (path === '/api/offers' || path.startsWith('/api/offers/') || path === '/api/audit' || path === '/api/simulate' || path === '/api/monitor') return { urls: true };
  return null;
}
// offersAccess 'own': ids of offers used in the streams of campaigns the user can see; null = no restriction.
function visibleOfferIds(req) {
  if (!restrictedUser(req) || req.user.offersAccess !== 'own') return null;
  const allowed = scopeCampaigns(req);
  const ids = new Set();
  for (const [id, c] of campaigns) {
    if (allowed && !allowed.includes(id)) continue;
    for (const st of c.streams || []) (st.offers ? st.offers.map((o) => o.offerId) : st.offerId ? [st.offerId] : []).forEach((o) => ids.add(o));
  }
  return ids;
}

// Change history (Keitaro «Лог»): who changed what and when. Kept in the JSONL journal; never stores passwords.
const PRIMITIVE = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
async function audit(req, action, entity, id, before = null, after = null) {
  const actor = req.user?.email || (bearerAuthorized(req) ? 'admin-token' : 'anonymous');
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
  const changes = Object.fromEntries(keys.map((k) => [k, PRIMITIVE(before?.[k] ?? null) && PRIMITIVE(after?.[k] ?? null) ? [before?.[k] ?? null, after?.[k] ?? null] : null]));
  try { await event('audit', { actor, action, entity, entityId: id, changes }); }
  catch (error) { console.warn('[audit] not written:', error.message); }
}

// Team settings (owner-editable). buyerSharePct: the buyer's share of net profit shown on the dashboard.
// dailyRevenueGoal / dailyProfitGoal: the team's daily plan in the default currency (null = no goal).
const SETTINGS_DEFAULTS = { buyerSharePct: 35, dailyRevenueGoal: null, dailyProfitGoal: null };
const GOAL_KEYS = ['dailyRevenueGoal', 'dailyProfitGoal'];
let settings = { ...SETTINGS_DEFAULTS };
async function loadSettings() {
  try { settings = { ...SETTINGS_DEFAULTS, ...JSON.parse(await readFile(settingsFile, 'utf8')) }; }
  catch (error) { if (error.code !== 'ENOENT') console.warn('[settings] unreadable, using defaults:', error.message); }
}

async function readAudit({ entity, id, limit }) {
  let lines = [];
  try { lines = (await readFile(eventsFile, 'utf8')).split('\n'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    if (!lines[i].includes('"audit"')) continue;
    try {
      const item = JSON.parse(lines[i]);
      if (item.type !== 'audit' || (entity && item.entity !== entity) || (id && item.entityId !== id)) continue;
      out.push({ at: item.at, actor: item.actor, action: item.action, entity: item.entity, entityId: item.entityId, changes: item.changes || {} });
    } catch { /* skip */ }
  }
  return out;
}

async function handleAuthRoute(req, res, url) {
  const path = url.pathname;
  const csrfOk = req.headers['x-requested-with'] === 'umbrella' || bearerAuthorized(req) || Boolean(req.apiKey);
  if (path === '/api/auth/me' && req.method === 'GET') {
    const count = await users.count();
    return json(res, 200, { user: req.user, setupRequired: count === 0, loginRequired: requireLogin || count > 0 });
  }
  // Body is read before any rejection so the client is never cut off mid-upload.
  const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
  if (req.method !== 'GET' && !csrfOk) return json(res, 403, { error: 'csrf_header_required' });
  if (path === '/api/auth/setup' && req.method === 'POST') {
    if ((await users.count()) > 0) return json(res, 409, { error: 'already_set_up' });
    // The first owner can only be created by whoever holds ADMIN_TOKEN, so nobody can claim a fresh public install.
    if (adminToken && !bearerAuthorized(req)) return json(res, 401, { error: 'admin_token_required' });
    const user = await users.create({ email: body.email, password: body.password, role: 'owner' });
    const token = await users.createSession(user.id);
    res.setHeader('set-cookie', sessionCookie(req, token, SESSION_TTL_MS / 1000));
    return json(res, 201, { user });
  }
  if (path === '/api/auth/login' && req.method === 'POST') {
    const ip = clientIp(req) || 'unknown';
    if (loginBlocked(ip)) return json(res, 429, { error: 'too_many_attempts' });
    const user = await users.authenticate(body.email, body.password);
    if (!user) { loginFailures.get(ip).push(Date.now()); return json(res, 401, { error: 'invalid_credentials' }); }
    loginFailures.delete(ip);
    req.user = user;
    await audit(req, 'login', 'user', user.id, null, null);
    const token = await users.createSession(user.id);
    res.setHeader('set-cookie', sessionCookie(req, token, SESSION_TTL_MS / 1000));
    return json(res, 200, { user });
  }
  if (path === '/api/auth/logout' && req.method === 'POST') {
    await users.deleteSession(readCookie(req, SESSION_COOKIE));
    res.setHeader('set-cookie', sessionCookie(req, '', 0));
    return json(res, 200, { ok: true });
  }
  const isOwner = req.user?.role === 'owner' || bearerAuthorized(req);
  if (path === '/api/users' && req.method === 'GET') {
    if (!isOwner) return json(res, 403, { error: 'owner_only' });
    return json(res, 200, { users: await users.list() });
  }
  if (path === '/api/users' && req.method === 'POST') {
    if (!isOwner) return json(res, 403, { error: 'owner_only' });
    const created = await users.create({ email: body.email, password: body.password, role: body.role || 'buyer', hideRevenue: body.hideRevenue, offersAccess: body.offersAccess, viewAll: body.viewAll });
    await audit(req, 'create', 'user', created.id, null, { email: created.email, role: created.role, hideRevenue: created.hideRevenue, offersAccess: created.offersAccess, viewAll: created.viewAll });
    return json(res, 201, { user: created });
  }
  const userDelete = path.match(/^\/api\/users\/([0-9a-f-]{36})$/);
  if (userDelete && req.method === 'PATCH') {
    if (!isOwner) return json(res, 403, { error: 'owner_only' });
    const id = userDelete[1];
    const all = await users.list();
    const target = all.find((u) => u.id === id);
    if (!target) return json(res, 404, { error: 'user_not_found' });
    const input = { role: body.role, hideRevenue: body.hideRevenue, offersAccess: body.offersAccess, viewAll: body.viewAll };
    if (input.role !== undefined && input.role !== target.role) {
      if (req.user?.id === id) return json(res, 409, { error: 'cannot_change_own_role' });
      if (target.role === 'owner' && all.filter((u) => u.role === 'owner').length === 1) return json(res, 409, { error: 'last_owner' });
    }
    const updated = await users.update(id, input);
    const view = (u) => ({ role: u.role, hideRevenue: u.hideRevenue, offersAccess: u.offersAccess, viewAll: u.viewAll });
    await audit(req, 'update', 'user', id, view(target), view(updated));
    return json(res, 200, { user: updated });
  }
  if (userDelete && req.method === 'DELETE') {
    if (!isOwner) return json(res, 403, { error: 'owner_only' });
    const id = userDelete[1];
    if (req.user?.id === id) return json(res, 409, { error: 'cannot_delete_self' });
    const all = await users.list();
    const target = all.find((u) => u.id === id);
    if (!target) return json(res, 404, { error: 'user_not_found' });
    if (target.role === 'owner' && all.filter((u) => u.role === 'owner').length === 1) return json(res, 409, { error: 'last_owner' });
    await users.remove(id);
    await audit(req, 'delete', 'user', id, { email: target.email, role: target.role }, null);
    return json(res, 200, { ok: true });
  }
  // Read-only: the allowlist comes from ADMIN_ALLOWED_IPS only.
  if (path === '/api/security' && req.method === 'GET') {
    if (!isOwner) return json(res, 403, { error: 'owner_only' });
    return json(res, 200, { adminAllowedIps, clientIp: normalizeIp(clientIp(req)) || null, trustProxy: trustProxyHops });
  }
  // Personal API keys: everyone manages their own, the owner (and ADMIN_TOKEN) sees and revokes all.
  if (path === '/api/keys' || path.startsWith('/api/keys/')) {
    if (!req.user && !bearerAuthorized(req)) return json(res, 401, { error: 'login_required' });
    if (path === '/api/keys' && req.method === 'GET') {
      const all = url.searchParams.get('all') === '1';
      if (all && !isOwner) return json(res, 403, { error: 'owner_only' });
      return json(res, 200, { keys: await users.listApiKeys(all || !req.user ? null : req.user.id) });
    }
    if (path === '/api/keys' && req.method === 'POST') {
      if (!req.user) return json(res, 400, { error: 'user_required' });
      // A leaked key must not be able to mint more keys that outlive its revocation.
      if (req.apiKey) return json(res, 403, { error: 'session_required' });
      const { key, secret } = await users.createApiKey(req.user.id, body.name);
      await audit(req, 'create', 'api_key', key.id, null, { name: key.name, userId: key.userId, last4: key.last4 });
      return json(res, 201, { key, secret });
    }
    const keyDelete = path.match(/^\/api\/keys\/([0-9a-f-]{36})$/);
    if (keyDelete && req.method === 'DELETE') {
      const target = await users.getApiKey(keyDelete[1]);
      // Someone else's key looks the same as a missing one.
      if (!target || (!isOwner && target.userId !== req.user?.id)) return json(res, 404, { error: 'key_not_found' });
      await users.deleteApiKey(target.id);
      await audit(req, 'delete', 'api_key', target.id, { name: target.name, userId: target.userId, last4: target.last4 }, null);
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    securityHeaders(res, url.pathname);
    if (onTrackingDomain(req) && !isTrackingPath(url.pathname)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    if (!isTrackingPath(url.pathname) && !adminIpAllowed(req)) return json(res, 403, { error: 'admin_ip_not_allowed' });
    const authorization = String(req.headers.authorization || '');
    if (!isTrackingPath(url.pathname) && authorization.startsWith(`Bearer ${API_KEY_PREFIX}`)) {
      const found = await users.userForApiKey(authorization.slice('Bearer '.length));
      if (!found) return json(res, 401, { error: 'invalid_api_key' });
      req.user = found.user;
      req.apiKey = found.key;
    } else req.user = await sessionUser(req);
    if (requireLogin && isPrivatePath(url.pathname) && !req.user && !bearerAuthorized(req)) {
      if (url.pathname === '/dashboard') { res.writeHead(302, { location: `${basePath}/admin` }); return res.end(); }
      return json(res, 401, { error: 'login_required' });
    }
    // Read-only role: every write to the panel API is refused; signing in and out stays possible.
    if (isViewer(req) && !['GET', 'HEAD'].includes(req.method) && isPrivatePath(url.pathname)) return json(res, 403, { error: 'read_only' });
    if (hidesRevenue(req)) {
      if (url.pathname === '/dashboard') { res.writeHead(302, { location: `${basePath}/admin` }); return res.end(); }
      res.revenueFilter = revenueFilterFor(url.pathname);
    }
    if (url.pathname === '/stats' || url.pathname.startsWith('/stats/') || url.pathname === '/api/clicks' || url.pathname === '/api/conversions' || url.pathname === '/api/bots') {
      req.scope = campaignScope(req, url.searchParams.get('campaign') || null);
      if (req.scope.forbidden) return json(res, 403, { error: 'campaign_not_yours' });
    }
    if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/users' || url.pathname.startsWith('/api/users/')
      || url.pathname === '/api/keys' || url.pathname.startsWith('/api/keys/') || url.pathname === '/api/security') {
      return await handleAuthRoute(req, res, url);
    }
    const logAsset = new Map([['/assets/event-logs.js', ['event-logs.js', 'text/javascript']],
      ['/assets/event-logs.css', ['event-logs.css', 'text/css']]]).get(url.pathname);
    if (logAsset && req.method === 'GET') {
      const asset = await readFile(join(root, 'public', logAsset[0]));
      res.writeHead(200, { 'content-type': `${logAsset[1]}; charset=utf-8`, 'cache-control': 'no-store' });
      return res.end(asset);
    }
    if (url.pathname === '/assets/stream-editor.js' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(await readFile(join(root, 'public', 'stream-editor.js')));
    }
    // Shared click handler for both stream and explicit-offer routes.
    async function handleClick(campaignId, offerId, targetTemplate, streamName = null, countClick = true, extra = {}) {
      const c = campaigns.get(campaignId);
      if (!c || !c.active) return json(res, 404, { error: 'campaign_not_found_or_inactive' });
      if (rateLimited(clientIp(req))) return json(res, 429, { error: 'click_rate_limited' });

      // IP blacklist / whitelist (exact IP or IPv4 CIDR)
      const visitorIp = normalizeIp(clientIp(req));
      if (c.blockedIps?.some((r) => ipMatches(visitorIp, r))) return json(res, 403, { error: 'ip_blocked' });
      if (c.allowedIps?.length && !c.allowedIps.some((r) => ipMatches(visitorIp, r))) return json(res, 403, { error: 'ip_not_allowed' });

      // Bot filter: bots (and, if enabled, data-center traffic) get the same destination but are not counted as clicks.
      const network = lookupAsn(visitorIp);
      const uaBot = c.botFilter && isBot(req.headers['user-agent']);
      const dcBot = c.datacenterAsBot && network?.datacenter;
      if (uaBot || dcBot) {
        await event('bot', { campaign: campaignId, offerId, stream: streamName, userAgent: req.headers['user-agent'] || null, ip: clientIp(req),
          reason: uaBot ? 'user_agent' : 'datacenter', isp: network?.isp ?? null });
        const dest = applyMacros(targetTemplate, { campaign: campaignId, offer_id: offerId });
        res.writeHead(302, { location: dest, 'cache-control': 'no-store' });
        return res.end();
      }

      // Device targeting
      const device = detectDevice(req.headers['user-agent'] || '');
      if (c.allowDevices.length > 0 && !c.allowDevices.includes(device)) {
        return json(res, 403, { error: 'device_not_allowed', device });
      }
      const os = detectOS(req.headers['user-agent'] || '');
      if (c.allowOS?.length && !c.allowOS.includes(os)) return json(res, 403, { error: 'os_not_allowed', os });
      const browser = detectBrowser(req.headers['user-agent'] || '');
      if (c.allowBrowsers?.length && !c.allowBrowsers.includes(browser)) return json(res, 403, { error: 'browser_not_allowed', browser });

      // Geo targeting (fail-open when GEOIP_DB not configured)
      const country = lookupCountry(clientIp(req));
      if (c.allowGeos.length > 0 && country && !c.allowGeos.includes(country)) {
        if (c.geoCapUrl) { res.writeHead(302, { location: c.geoCapUrl, 'cache-control': 'no-store' }); return res.end(); }
        return json(res, 403, { error: 'geo_not_allowed', country });
      }

      const ip = clientIp(req);

      // IP deduplication: skip click if same IP clicked within dedupeWindow minutes
      if (c.dedupeWindow > 0 && await isDuplicateClick(campaignId, ip, c.dedupeWindow)) {
        // Silent redirect to the same destination without recording a new click
        res.writeHead(302, { location: applyMacros(targetTemplate, { campaign: campaignId, offer_id: offerId }), 'cache-control': 'no-store' });
        return res.end();
      }

      // Daily click cap
      if (c.dailyCap !== null) {
        const todayCount = await countTodayClicks(campaignId);
        if (todayCount >= c.dailyCap) {
          if (c.capUrl) { res.writeHead(302, { location: c.capUrl, 'cache-control': 'no-store' }); return res.end(); }
          return json(res, 429, { error: 'daily_cap_reached', dailyCap: c.dailyCap });
        }
      }

      // Revenue cap: stop sending traffic when daily revenue >= revenueCap
      if (c.revenueCap !== null) {
        const rev = await todayRevenue(campaignId);
        if (rev >= c.revenueCap) {
          if (c.capUrl) { res.writeHead(302, { location: c.capUrl, 'cache-control': 'no-store' }); return res.end(); }
          return json(res, 429, { error: 'revenue_cap_reached', revenueCap: c.revenueCap });
        }
      }

      // Offer-level daily cap (shared across all campaigns sending to this offer)
      const offerCap = offers.get(offerId)?.dailyCap;
      if (offerCap && await countClicks({ offerId, since: todayStart() }) >= offerCap) {
        if (c.capUrl) { res.writeHead(302, { location: c.capUrl, 'cache-control': 'no-store' }); return res.end(); }
        return json(res, 429, { error: 'offer_cap_reached', offerId, dailyCap: offerCap });
      }

      // Total (lifetime) cap: campaign auto-pauses when reached
      let totalCount = null;
      if (c.totalCap !== null) {
        totalCount = await countClicks({ campaign: campaignId });
        if (totalCount >= c.totalCap) {
          await pauseCampaign(campaignId, 'total_cap_reached');
          if (c.capUrl) { res.writeHead(302, { location: c.capUrl, 'cache-control': 'no-store' }); return res.end(); }
          return json(res, 429, { error: 'total_cap_reached', totalCap: c.totalCap });
        }
      }

      const clickId = randomUUID();
      const subid = url.searchParams.get('subid') || null;

      // Apply URL macros then append any missing UTM params.
      const params = trackedParams(url.searchParams, c.paramMap);
      let cost = 0;
      if (c.costModel === 'cpc') {
        const rawCost = c.costFromParam ? url.searchParams.get(c.paramMap?.cost || 'cost') : null;
        const fromParam = rawCost === null || rawCost.trim() === '' ? NaN : Number(rawCost);
        cost = Number.isFinite(fromParam) && fromParam >= 0 && fromParam < 1000 ? fromParam : c.cpc;
      }
      const macroVars = { ...params, cost: cost || '', click_id: clickId, subid: subid || '', campaign: campaignId, offer_id: offerId, device, country: country || '',
        lp_click_url: `${publicBase(req)}/lp/click?click_id=${clickId}` };
      const expanded = applyMacros(targetTemplate, macroVars);
      const destination = new URL(expanded);
      if (!targetTemplate.includes('{click_id}')) destination.searchParams.set('click_id', clickId);
      for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'subid']) {
        if (url.searchParams.has(key) && !targetTemplate.includes(`{${key}}`)) {
          destination.searchParams.set(key, url.searchParams.get(key));
        }
      }

      // CPC offer: the payout is earned per click and booked on the click in DEFAULT_CURRENCY (like cost).
      const cpcOffer = offers.get(offerId);
      const clickRevenue = cpcOffer?.payoutType === 'cpc' && cpcOffer.payout
        ? Math.round(cpcOffer.payout * rates.factor(cpcOffer.payoutCurrency || rates.defaultCurrency, rates.defaultCurrency) * 1e6) / 1e6 : 0;
      // Streams with countClicks=false redirect normally but stay out of logs and reports, as in Keitaro.
      if (countClick) {
        const visitor = `${ip}|${req.headers['user-agent'] || ''}`;
        const windowMs = (c.uniquenessHours || 24) * 3600 * 1000;
        const uniqueness = { uniqueCampaign: firstVisit(`c|${campaignId}|${visitor}`, windowMs), uniqueStream: firstVisit(`s|${campaignId}|${streamName || ''}|${visitor}`, windowMs),
          uniqueGlobal: firstVisit(`g|${visitor}`, windowMs) };
        Object.assign(extra, uniqueness);
        const lang = String(req.headers['accept-language'] || '').trim().slice(0, 2).toLowerCase();
        await event('click', { clickId, campaign: campaignId, offerId, path: url.pathname, referrer: req.headers.referer || null, userAgent: req.headers['user-agent'] || null, subid, country, ip,
          device, os, browser, language: /^[a-z]{2}$/.test(lang) ? lang : null,
          ...(network ? { asn: network.asn, isp: network.isp, datacenter: network.datacenter, connection: network.connection } : {}), stream: streamName, ...extra, ...(Object.keys(params).length ? { params } : {}), ...(cost ? { cost } : {}), ...(clickRevenue ? { revenue: clickRevenue } : {}) });
        if (totalCount !== null && totalCount + 1 >= c.totalCap) await pauseCampaign(campaignId, 'total_cap_reached');
      }
      return sendRedirect(res, destination.toString(), c.redirectMethod);
    }

    // /r/:campaign — stream-based routing (Keitaro-style). A stream may hand the click to another campaign.
    const matchStream = url.pathname.match(/^\/r\/([^/]+)$/);
    if (matchStream && req.method === 'GET') {
      const visitor = visitorProfile(req);
      const visited = [];
      let campaignId = matchStream[1];
      for (;;) {
        const c = campaigns.get(campaignId);
        if (!c || !c.active) return json(res, 404, { error: 'campaign_not_found_or_inactive' });
        if (!c.streams?.length) return json(res, 404, { error: 'no_streams_configured' });
        visitor.params = trackedParams(url.searchParams, c.paramMap);
        const routing = await offerRouting(c.streams);
        // Visitor binding: the stream (and offer/landing) this IP + User-Agent got last time, while still valid.
        const bindKey = c.bindVisitors !== 'off' ? bindingKey(campaignId, normalizeIp(clientIp(req)), req.headers['user-agent'] || '') : null;
        const picked = (bindKey && boundChoice({ mode: c.bindVisitors, binding: visitorBindings.get(bindKey, c.bindTtlHours * 3600 * 1000), streams: c.streams,
          matches: (st) => streamMatches(st, visitor), excluded: routing.excluded, pickOffer: weightedPick, pickLanding: weightedPick }))
          || pickStream(c.streams, visitor, routing.excluded, c.streamRotation);
        if (bindKey && picked) visitorBindings.set(bindKey, { stream: streamRef(c.streams, picked.stream), offerId: picked.offerId, landingId: picked.landingId || null });
        // A conversion-capped offer hands the click to its alternative; the click is recorded with the offer actually used.
        if (picked?.offerId && routing.substitutes.has(picked.offerId)) picked.offerId = routing.substitutes.get(picked.offerId);
        if (!picked) return json(res, 404, { error: 'no_matching_stream' });
        const countClick = picked.stream.countClicks !== false;
        const extra = visited.length ? { parentCampaign: visited[0] } : {};
        if (picked.stream.action === 'campaign') {
          visited.push(campaignId);
          if (visited.length > MAX_CAMPAIGN_HOPS || visited.includes(picked.stream.campaignId)) return json(res, 508, { error: 'campaign_loop', path: [...visited, picked.stream.campaignId] });
          campaignId = picked.stream.campaignId;
          continue;
        }
        if (picked.stream.action === 'not_found') {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return res.end('Not Found');
        }
        if (picked.stream.action === 'url') return await handleClick(campaignId, '', picked.stream.url, picked.stream.name || null, countClick, extra);
        const offer = offers.get(picked.offerId);
        if (!offer) return json(res, 404, { error: 'offer_not_found' });
        // Landing first: the visitor sees the landing; its button goes to /lp/click, which sends them to this offer.
        const landing = picked.landingId ? landings.get(picked.landingId) : null;
        if (landing) return await handleClick(campaignId, picked.offerId, landing.url, picked.stream.name || null, countClick, { ...extra, landingId: picked.landingId });
        return await handleClick(campaignId, picked.offerId, offer.url, picked.stream.name || null, countClick, extra);
      }
    }
    // /r/:campaign/:offer — explicit offer routing (backward compat)
    const match = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)$/);
    if (match && req.method === 'GET') {
      const [, campaignId, offerId] = match;
      const offer = offers.get(offerId);
      if (!offer || offer.archived) return json(res, 404, { error: 'offer_not_found' });
      // Conversion cap on an explicit offer: its alternative if one is usable, otherwise capUrl / 429 like the click cap.
      if (offer.conversionCap) {
        const routing = await offerRouting([{ offerId }]);
        const alt = routing.substitutes.get(offerId);
        if (alt) return await handleClick(campaignId, alt, offers.get(alt).url);
        const c = campaigns.get(campaignId);
        if (routing.reasons.get(offerId) === 'conversion_cap' && c?.active) {
          if (c.capUrl) { res.writeHead(302, { location: c.capUrl, 'cache-control': 'no-store' }); return res.end(); }
          return json(res, 429, { error: 'offer_conversion_cap_reached', offerId, conversionCap: offer.conversionCap });
        }
      }
      return await handleClick(campaignId, offerId, offer.url);
    }
    if (url.pathname === '/postback' && req.method === 'GET') {
      if (postbackSecret && !safeEqual(url.searchParams.get('secret'), postbackSecret)) return json(res, 401, { error: 'invalid_postback_secret' });
      try {
        // `payout` is an alias of `revenue`; without either, a CPA offer's payout is used (see recordPostback).
        const result = await recordPostback({ clickId: url.searchParams.get('click_id'),
          revenue: url.searchParams.get('revenue') || url.searchParams.get('payout'), currency: url.searchParams.get('currency'), status: url.searchParams.get('status') });
        return json(res, 200, result);
      } catch (error) {
        if (!error.statusCode) throw error;
        return json(res, error.statusCode, { error: error.message,
          ...(error.conversionWindowDays ? { conversionWindowDays: error.conversionWindowDays } : {}) });
      }
    }
    if (url.pathname === '/stats' && req.method === 'GET') {
      return json(res, 200, await stats({
        currency: reportCurrency(url.searchParams.get('currency')),
        campaign: url.searchParams.get('campaign') || null,
        allowed: req.scope?.allowed || null,
        from: url.searchParams.get('from') || null,
        to: url.searchParams.get('to') || null,
        subid: url.searchParams.get('subid') || null,
        country: url.searchParams.get('country') || null,
        offer: url.searchParams.get('offer') || null,
        stream: url.searchParams.get('stream') || null,
      }));
    }
    if (url.pathname === '/stats/compare' && req.method === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return json(res, 400, { error: 'from_and_to_dates_required' });
      const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return json(res, 400, { error: 'invalid_date_range' });
      const span = end - start + 86400000;
      const previousFrom = new Date(start - span).toISOString().slice(0, 10);
      const previousTo = new Date(start - 86400000).toISOString().slice(0, 10);
      const common = { currency: reportCurrency(url.searchParams.get('currency')), campaign: url.searchParams.get('campaign') || null, allowed: req.scope?.allowed || null, subid: url.searchParams.get('subid') || null, country: url.searchParams.get('country') || null, offer: url.searchParams.get('offer') || null, stream: url.searchParams.get('stream') || null };
      const [current, previous] = await Promise.all([stats({ ...common, from, to }), stats({ ...common, from: previousFrom, to: previousTo })]);
      const delta = (key) => previous[key] ? (current[key] - previous[key]) / Math.abs(previous[key]) * 100 : (current[key] ? null : 0);
      return json(res, 200, { current, previous, previousFrom, previousTo, deltaPct: { clicks: delta('clicks'), conversions: delta('conversions'), revenue: delta('revenue') } });
    }
    // CSV export for spreadsheets and scripts: GET /stats/export?group=campaign|offer|stream|landing|country|day|hour|<param>&from&to&campaign&currency
    if (url.pathname === '/stats/export' && req.method === 'GET') {
      const group = url.searchParams.get('group') || 'campaign';
      const currency = reportCurrency(url.searchParams.get('currency'));
      const from = url.searchParams.get('from') || null;
      const to = url.searchParams.get('to') || null;
      if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) return json(res, 400, { error: 'invalid_date' });
      const campaign = req.scope?.campaign || null;
      const allowed = req.scope?.allowed || null;
      const GROUP_PROP = { campaign: 'byCampaign', offer: 'byOffer', stream: 'byStream', landing: 'byLanding', country: 'byCountry', source: 'bySource', network: 'byNetwork' };
      let rows;
      if (GROUP_PROP[group]) {
        const report = await stats({ campaign, allowed, from, to, currency, subid: url.searchParams.get('subid') || null,
          country: url.searchParams.get('country') || null, offer: url.searchParams.get('offer') || null, stream: url.searchParams.get('stream') || null });
        rows = Object.entries(report[GROUP_PROP[group]]).map(([key, v]) => ({ key, ...v }));
      } else if (TRACK_FIELDS.includes(group) || DIMENSION_FIELDS.includes(group)) {
        rows = (await paramReport({ field: group, campaign, allowed, from, to, currency })).map((r) => ({ key: r.value, ...r }));
      } else return json(res, 400, { error: 'invalid_group' });
      const columns = ['key', 'clicks', 'conversions', 'revenue', 'cost', 'cr', 'epc', 'rpm', 'uniqueClicks', 'leads', 'sales', 'rejected', 'pendingRevenue', 'profit', 'roi']
        .filter((c) => !hidesRevenue(req) || !REVENUE_KEY.test(c));
      // Cells starting with = + - @ are prefixed so spreadsheets do not run them as formulas.
      const cell = (v) => { let text = v === null || v === undefined ? '' : typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : String(v); if (/^[=+\-@]/.test(text) && typeof v !== 'number') text = `'${text}`; return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
      const csv = [['group', ...columns.slice(1)].join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="umbrella-${group}-${currency}.csv"`, 'cache-control': 'no-store' });
      return res.end('\ufeff' + csv);
    }
    if (url.pathname === '/api/clicks' && req.method === 'GET') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      return json(res, 200, await readEventLog({ kind: 'clicks', params: url.searchParams, eventsFile, db, allowedCampaigns: req.scope?.allowed || null,
        onFallback: (error) => console.warn('[db] click log fallback:', error.message) }));
    }
    if (url.pathname === '/api/conversions' && req.method === 'GET') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      return json(res, 200, await readEventLog({ kind: 'conversions', params: url.searchParams, eventsFile, db, allowedCampaigns: req.scope?.allowed || null,
        onFallback: (error) => console.warn('[db] conversion log fallback:', error.message) }));
    }
    if (url.pathname === '/api/bots' && req.method === 'GET') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const botCampaign = url.searchParams.get('campaign') || null;
      const botFrom = url.searchParams.get('from') || null;
      const botTo = url.searchParams.get('to') || null;
      const rawLimit = Number(url.searchParams.get('limit') || 100);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 100;
      if (botFrom && !/^\d{4}-\d{2}-\d{2}$/.test(botFrom)) return json(res, 400, { error: 'invalid_from_date' });
      if (botTo && !/^\d{4}-\d{2}-\d{2}$/.test(botTo)) return json(res, 400, { error: 'invalid_to_date' });
      const botRow = (b) => ({ at: b.at ?? null, campaign: b.campaign ?? null, offerId: b.offerId ?? null, stream: b.stream ?? null, reason: b.reason ?? 'user_agent',
        isp: b.isp ?? null, userAgent: b.userAgent ? String(b.userAgent).slice(0, 200) : null, ip: b.ip ?? null });
      // PostgreSQL first (the bots table, with isp), the JSONL journal as fallback.
      if (db) {
        try {
          const where = [], values = [];
          const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
          if (botCampaign) add('campaign = ?', botCampaign);
          if (req.scope?.allowed) add('campaign = ANY(?::text[])', req.scope.allowed);
          if (botFrom) add('created_at >= ?', `${botFrom}T00:00:00Z`);
          if (botTo) add('created_at <= ?', `${botTo}T23:59:59Z`);
          values.push(limit);
          const { rows } = await db.query(`SELECT created_at, campaign, offer_id, stream, reason, isp, user_agent, ip FROM bots ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY created_at DESC, id DESC LIMIT $${values.length}`, values);
          return json(res, 200, { bots: rows.map((r) => botRow({ at: new Date(r.created_at).toISOString(), campaign: r.campaign, offerId: r.offer_id, stream: r.stream,
            reason: r.reason, isp: r.isp, userAgent: r.user_agent, ip: r.ip })) });
        } catch (e) { console.warn('[db] bot log fallback:', e.message); }
      }
      try {
        const lines = (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const fromMs = botFrom ? Date.parse(`${botFrom}T00:00:00Z`) : null;
        const toMs = botTo ? Date.parse(`${botTo}T23:59:59Z`) : null;
        const bots = lines.filter((item) => {
          if (item.type !== 'bot') return false;
          if (botCampaign && item.campaign !== botCampaign) return false;
          if (req.scope?.allowed && !req.scope.allowed.includes(item.campaign)) return false;
          const t = item.at ? Date.parse(item.at) : null;
          if (fromMs !== null && (t === null || t < fromMs)) return false;
          if (toMs !== null && (t === null || t > toMs)) return false;
          return true;
        }).reverse().slice(0, limit).map(botRow);
        return json(res, 200, { bots });
      } catch (e) {
        if (e.code === 'ENOENT') return json(res, 200, { bots: [] });
        throw e;
      }
    }
    if (url.pathname === '/lp/click' && req.method === 'GET') {
      const clickId = url.searchParams.get('click_id') || '';
      if (!/^[0-9a-f-]{36}$/i.test(clickId)) return json(res, 400, { error: 'click_id_required' });
      const click = await getClickRecord(clickId);
      if (!click) return json(res, 404, { error: 'click_not_found' });
      const offer = offers.get(click.offerId);
      if (!offer) return json(res, 404, { error: 'offer_not_found' });
      await event('lp_click', { clickId, campaign: click.campaign, landingId: click.landingId ?? null });
      const vars = { ...(click.params || {}), cost: click.cost || '', click_id: clickId, subid: click.subid || '', campaign: click.campaign, offer_id: click.offerId, device: '', country: click.country || '' };
      const destination = new URL(applyMacros(offer.url, vars));
      if (!offer.url.includes('{click_id}')) destination.searchParams.set('click_id', clickId);
      return sendRedirect(res, destination.toString(), campaigns.get(click.campaign)?.redirectMethod);
    }
    if (url.pathname === '/api/settings' && req.method === 'GET') return json(res, 200, settings);
    if (url.pathname === '/api/settings' && req.method === 'PATCH') {
      const body = await readJson(req);
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      if (req.user && req.user.role !== 'owner') return json(res, 403, { error: 'owner_only' });
      const patch = {};
      if ('buyerSharePct' in body || !GOAL_KEYS.some((key) => key in body)) {
        const pct = Number(body.buyerSharePct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return json(res, 400, { error: 'invalid_buyer_share' });
        patch.buyerSharePct = Math.round(pct * 100) / 100;
      }
      for (const key of GOAL_KEYS) {
        if (!(key in body)) continue;
        if (body[key] === null || body[key] === '') { patch[key] = null; continue; }
        const goal = typeof body[key] === 'number' || typeof body[key] === 'string' ? Number(body[key]) : NaN;
        if (!Number.isFinite(goal) || goal < 0) return json(res, 400, { error: 'invalid_goal', field: key });
        patch[key] = Math.round(goal * 100) / 100;
      }
      const before = { ...settings };
      settings = { ...settings, ...patch };
      await mkdir(dataDir, { recursive: true });
      await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
      await audit(req, 'update', 'settings', 'team', before, settings);
      return json(res, 200, settings);
    }
    if (url.pathname === '/api/simulate' && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const result = await simulateClick(await readJson(req), (c) => canEditCampaign(req, c));
      return json(res, result.error ? 400 : 200, result);
    }
    if (url.pathname === '/api/audit' && req.method === 'GET') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const entity = url.searchParams.get('entity') || null;
      const entityId = url.searchParams.get('id') || null;
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);
      const mine = scopeCampaigns(req);
      const entries = await readAudit({ entity, id: entityId, limit: mine ? 2000 : limit });
      return json(res, 200, { entries: mine ? entries.filter((e) => e.actor === req.user.email || (e.entity === 'campaign' && mine.includes(e.entityId))).slice(0, limit) : entries });
    }
    if (url.pathname === '/api/monitor' && req.method === 'GET') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      return json(res, 200, { enabled: monitorEnabled, intervalMs: monitorIntervalMs, targets: monitor.snapshot(scopeCampaigns(req)) });
    }
    if (url.pathname === '/api/monitor/check' && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      if (restrictedUser(req)) return json(res, 403, { error: 'owner_only' });
      const result = await monitor.check();
      return json(res, 200, { ...result, targets: monitor.snapshot() });
    }
    if (url.pathname === '/api/domains' && req.method === 'GET') return json(res, 200, { primary: primaryHost || null, domains: await trackingDomains() });
    if (url.pathname === '/api/rates' && req.method === 'GET') return json(res, 200, { defaultCurrency: rates.defaultCurrency, ...rates.info() });
    if (url.pathname === '/api/landings' && req.method === 'GET') return json(res, 200, { landings: Object.fromEntries(landings) });
    if (url.pathname === '/api/landings' && req.method === 'POST') {
      const body = await readJson(req);
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      if (!OFFER_ID_RE.test(String(body.id || ''))) return json(res, 400, { error: 'valid_id_required' });
      const landing = parseLanding(body);
      if (!landing) return json(res, 400, { error: 'https_url_required' });
      landings.set(String(body.id), landing);
      await persistLanding(String(body.id), landing);
      await audit(req, 'create', 'landing', String(body.id), null, landing);
      return json(res, 201, { id: body.id, ...landing });
    }
    const landingUpdate = url.pathname.match(/^\/api\/landings\/([A-Za-z0-9_-]{2,80})$/);
    if (landingUpdate && req.method === 'PATCH') {
      const body = await readJson(req);
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const id = landingUpdate[1];
      const cur = landings.get(id);
      if (!cur) return json(res, 404, { error: 'landing_not_found' });
      const updated = parseLanding({ url: body.url ?? cur.url, name: body.name !== undefined ? body.name : cur.name });
      if (!updated) return json(res, 400, { error: 'https_url_required' });
      landings.set(id, updated);
      await persistLanding(id, updated);
      await audit(req, 'update', 'landing', id, cur, updated);
      return json(res, 200, { id, ...updated });
    }
    if (url.pathname === '/api/offers' && req.method === 'GET') {
      const visible = visibleOfferIds(req);
      return json(res, 200, { offers: Object.fromEntries([...offers].filter(([id]) => !visible || visible.has(id))) });
    }
    if (url.pathname === '/api/offers' && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const body = await readJson(req);
      if (!/^[a-z0-9_-]{2,80}$/i.test(String(body.id || '')) || !/^https:\/\//i.test(String(body.url || ''))) return json(res, 400, { error: 'id_and_https_url_required' });
      // offersAccess 'own' must not overwrite an offer the user cannot see.
      if (offers.has(String(body.id)) && visibleOfferIds(req) && !visibleOfferIds(req).has(String(body.id))) return json(res, 409, { error: 'offer_id_taken' });
      if (body.networkId !== undefined && body.networkId !== null && !networks.has(String(body.networkId))) return json(res, 400, { error: 'network_not_found' });
      const capError = conversionCapError(String(body.id), body) || payoutError(body);
      if (capError) return json(res, 400, { error: capError });
      const offer = parseOffer({ url: String(body.url), postbackUrl: body.postbackUrl, payoutType: body.payoutType, payout: body.payout, payoutCurrency: body.payoutCurrency, dailyCap: body.dailyCap, name: body.name, networkId: body.networkId, archived: body.archived, group: body.group,
        conversionCap: body.conversionCap, capTz: body.capTz, altOfferId: body.altOfferId });
      if (!offer) return json(res, 400, { error: 'id_and_https_url_required' });
      offers.set(String(body.id), offer);
      await persistOffer(String(body.id), offer);
      await audit(req, 'create', 'offer', String(body.id), null, offer);
      return json(res, 201, { id: body.id, ...offer });
    }
    const offerUpdate = url.pathname.match(/^\/api\/offers\/([A-Za-z0-9_-]{2,80})$/);
    const offerClone = url.pathname.match(/^\/api\/offers\/([A-Za-z0-9_-]{2,80})\/clone$/);
    if (offerClone && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res,401,{error:'admin_authorization_required'});
      const id=offerClone[1],cur=offers.get(id); if(!cur || (visibleOfferIds(req) && !visibleOfferIds(req).has(id))) return json(res,404,{error:'offer_not_found'});
      let nextId=`${id}-copy`, n=2; while(offers.has(nextId)) nextId=`${id}-copy${n++}`;
      const copy=parseOffer({...cur,name:`${cur.name||id} (копия)`,archived:false}); offers.set(nextId,copy); await persistOffer(nextId,copy); await audit(req,'create','offer',nextId,null,copy); return json(res,201,{id:nextId,...copy});
    }
    if (offerUpdate && req.method === 'PATCH') {
      const id = offerUpdate[1];
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      if (!offers.has(id) || (visibleOfferIds(req) && !visibleOfferIds(req).has(id))) return json(res, 404, { error: 'offer_not_found' });
      const body = await readJson(req);
      const cur = offers.get(id);
      const newUrl = body.url !== undefined ? String(body.url) : cur.url;
      const newPostbackUrl = body.postbackUrl !== undefined ? body.postbackUrl : cur.postbackUrl;
      const newDailyCap = body.dailyCap !== undefined ? body.dailyCap : cur.dailyCap;
      if (body.networkId !== undefined && body.networkId !== null && !networks.has(String(body.networkId))) return json(res, 400, { error: 'network_not_found' });
      const capError = conversionCapError(id, body) || payoutError(body);
      if (capError) return json(res, 400, { error: capError });
      const updated = parseOffer({ url: newUrl, postbackUrl: newPostbackUrl, payoutType: body.payoutType !== undefined ? body.payoutType : cur.payoutType, payout: body.payout !== undefined ? body.payout : cur.payout, payoutCurrency: body.payoutCurrency !== undefined ? body.payoutCurrency : cur.payoutCurrency, dailyCap: newDailyCap, name: body.name !== undefined ? body.name : cur.name, networkId: body.networkId !== undefined ? body.networkId : cur.networkId, archived: body.archived !== undefined ? body.archived : cur.archived, group: body.group !== undefined ? body.group : cur.group,
        conversionCap: body.conversionCap !== undefined ? body.conversionCap : cur.conversionCap, capTz: body.capTz !== undefined ? body.capTz : cur.capTz, altOfferId: body.altOfferId !== undefined ? body.altOfferId : cur.altOfferId });
      if (!updated) return json(res, 400, { error: 'invalid_url' });
      offers.set(id, updated);
      await persistOffer(id, updated);
      await audit(req, 'update', 'offer', id, cur, updated);
      return json(res, 200, { id, ...updated });
    }
    // Source postback URLs often carry tokens: buyers see them without the query string and cannot change them.
    const canSeeSourcePostback = !restrictedUser(req);
    const publicSource = (s) => (canSeeSourcePostback || !s.postbackUrl ? s : { ...s, postbackUrl: stripQuery(s.postbackUrl), postbackUrlMasked: true });
    if (url.pathname === '/api/sources' && req.method === 'GET') return json(res, 200, { sources: Object.fromEntries([...sources].map(([id, s]) => [id, publicSource(s)])) });
    if (url.pathname === '/api/sources/postback-test' && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      if (restrictedUser(req)) return json(res, 403, { error: 'owner_only' });
      const body = await readJson(req);
      const template = parsePostbackUrl(body.url, { allowHttp: true });
      if (!template) return json(res, 400, { error: 'invalid_postback_url' });
      const status = ['lead', 'sale', 'rejected', 'trash'].includes(body.status) ? body.status : 'sale';
      const target = fillPostbackMacros(template, { ...SAMPLE_MACROS, status });
      const result = await sendPostback(target, { allowPrivate: sourcePostbackAllowPrivate, timeoutMs: 10000 });
      return json(res, 200, { ok: !result.error, httpStatus: result.httpStatus, error: result.error, url: stripQuery(target) });
    }
    if (url.pathname === '/api/sources' && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const body = await readJson(req);
      if (!OFFER_ID_RE.test(String(body.id || ''))) return json(res, 400, { error: 'valid_id_required' });
      if (!canSeeSourcePostback) { delete body.postbackUrl; delete body.postbackStatuses; }
      if (body.postbackUrl && !parsePostbackUrl(body.postbackUrl, { allowHttp: sourcePostbackAllowPrivate })) return json(res, 400, { error: 'invalid_postback_url' });
      const source = parseSource(body);
      if (!source) return json(res, 400, { error: 'invalid_source' });
      sources.set(String(body.id), source);
      await persistSource(String(body.id), source);
      return json(res, 201, { id: body.id, ...publicSource(source) });
    }
    const sourceUpdate = url.pathname.match(/^\/api\/sources\/([A-Za-z0-9_-]{2,80})$/);
    if (sourceUpdate && req.method === 'PATCH') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const id = sourceUpdate[1];
      if (!sources.has(id)) return json(res, 404, { error: 'source_not_found' });
      const body = await readJson(req);
      if (!canSeeSourcePostback) { delete body.postbackUrl; delete body.postbackStatuses; }
      if (body.postbackUrl && !parsePostbackUrl(body.postbackUrl, { allowHttp: sourcePostbackAllowPrivate })) return json(res, 400, { error: 'invalid_postback_url' });
      const cur = sources.get(id);
      const updated = parseSource({
        name: body.name !== undefined ? body.name : cur.name,
        paramMap: body.paramMap !== undefined ? body.paramMap : cur.paramMap,
        costModel: body.costModel !== undefined ? body.costModel : cur.costModel,
        cpc: body.cpc !== undefined ? body.cpc : cur.cpc,
        costFromParam: body.costFromParam !== undefined ? body.costFromParam : cur.costFromParam,
        postbackUrl: body.postbackUrl !== undefined ? body.postbackUrl : cur.postbackUrl,
        postbackStatuses: body.postbackStatuses !== undefined ? body.postbackStatuses : cur.postbackStatuses,
      });
      sources.set(id, updated);
      await persistSource(id, updated);
      return json(res, 200, { id, ...publicSource(updated) });
    }
    if (url.pathname === '/api/networks' && req.method === 'GET') return json(res, 200, { networks: Object.fromEntries(networks) });
    if (url.pathname === '/api/networks' && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const body=await readJson(req), id=String(body.id||''), network=parseNetwork(body);
      if(!OFFER_ID_RE.test(id)) return json(res,400,{error:'valid_id_required'}); if(!network) return json(res,400,{error:'name_required'}); if(networks.has(id)) return json(res,409,{error:'network_exists'});
      networks.set(id,network); await persistNetwork(id,network); await audit(req,'create','network',id,null,network); return json(res,201,{id,...network});
    }
    const networkUpdate=url.pathname.match(/^\/api\/networks\/([A-Za-z0-9_-]{2,80})$/);
    if(networkUpdate && req.method==='PATCH') { if(!(await adminAuthorized(req))) return json(res,401,{error:'admin_authorization_required'}); const id=networkUpdate[1],cur=networks.get(id); if(!cur) return json(res,404,{error:'network_not_found'}); const next=parseNetwork({...cur,...await readJson(req)}); if(!next) return json(res,400,{error:'name_required'}); networks.set(id,next); await persistNetwork(id,next); await audit(req,'update','network',id,cur,next); return json(res,200,{id,...next}); }
    if (url.pathname === '/api/campaigns' && req.method === 'GET') {
      const allowed = scopeCampaigns(req);
      return json(res, 200, { campaigns: Object.fromEntries([...campaigns].filter(([id]) => !allowed || allowed.includes(id))) });
    }
    if (url.pathname === '/api/campaigns' && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const body = await readJson(req);
      if (!/^[a-z0-9_-]{2,80}$/i.test(String(body.id || ''))) return json(res, 400, { error: 'valid_id_required' });
      if (OFFER_ID_RE.test(String(body.sourceId ?? '')) && !sources.has(String(body.sourceId))) return json(res, 400, { error: 'source_not_found' });
      if (body.sourcePostbackUrl && !parsePostbackUrl(body.sourcePostbackUrl, { allowHttp: sourcePostbackAllowPrivate })) return json(res, 400, { error: 'invalid_postback_url' });
      if (campaigns.has(String(body.id)) && !canEditCampaign(req, campaigns.get(String(body.id)))) return json(res, 403, { error: 'campaign_not_yours' });
      // A buyer's new campaign is always theirs; the owner may assign it to someone.
      const ownerId = isBuyer(req) ? req.user.id : (body.ownerId ?? req.user?.id ?? null);
      const sourceDefaults = body.sourceId ? sources.get(String(body.sourceId)) : null;
      campaigns.set(String(body.id), parseCampaign(String(body.id), { ...body, ownerId,
        ...(sourceDefaults ? { paramMap: body.paramMap ?? sourceDefaults.paramMap, costModel: body.costModel ?? sourceDefaults.costModel, cpc: body.cpc ?? sourceDefaults.cpc, costFromParam: body.costFromParam ?? sourceDefaults.costFromParam } : {}) }));
      await persistCampaign(String(body.id), campaigns.get(String(body.id)));
      await audit(req, 'create', 'campaign', String(body.id), null, campaigns.get(String(body.id)));
      return json(res, 201, { id: body.id, ...campaigns.get(String(body.id)) });
    }
    const campaignUpdate = url.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9_-]{2,80})$/);
    const campaignClone = url.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9_-]{2,80})\/clone$/);
    if (campaignClone && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const id=campaignClone[1], cur=campaigns.get(id); if(!cur) return json(res,404,{error:'campaign_not_found'}); if(!canEditCampaign(req,cur)) return json(res,403,{error:'campaign_not_yours'});
      let nextId=`${id}-copy`, n=2; while(campaigns.has(nextId)) nextId=`${id}-copy${n++}`;
      const copy=parseCampaign(nextId,{...cur,name:`${cur.name} (копия)`,active:false,archived:false}); campaigns.set(nextId,copy); await persistCampaign(nextId,copy); await audit(req,'create','campaign',nextId,null,copy); return json(res,201,{id:nextId,...copy});
    }
    if (campaignUpdate && req.method === 'PATCH') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const id = campaignUpdate[1];
      if (!campaigns.has(id)) return json(res, 404, { error: 'campaign_not_found' });
      if (!canEditCampaign(req, campaigns.get(id))) return json(res, 403, { error: 'campaign_not_yours' });
      const body = await readJson(req);
      if (OFFER_ID_RE.test(String(body.sourceId ?? '')) && !sources.has(String(body.sourceId))) return json(res, 400, { error: 'source_not_found' });
      if (body.sourcePostbackUrl && !parsePostbackUrl(body.sourcePostbackUrl, { allowHttp: sourcePostbackAllowPrivate })) return json(res, 400, { error: 'invalid_postback_url' });
      const cur = campaigns.get(id);
      campaigns.set(id, parseCampaign(id, {
        name: body.name === undefined ? cur.name : body.name,
        group: body.group === undefined ? cur.group : body.group,
        active: body.archived === true ? false : (body.active === undefined ? cur.active : body.active),
        archived: body.archived === undefined ? cur.archived : body.archived,
        streams: body.streams === undefined ? cur.streams : body.streams,
        dailyCap: body.dailyCap === undefined ? cur.dailyCap : body.dailyCap,
        capUrl: body.capUrl === undefined ? cur.capUrl : body.capUrl,
        allowDevices: body.allowDevices === undefined ? cur.allowDevices : body.allowDevices,
        allowOS: body.allowOS === undefined ? cur.allowOS : body.allowOS,
        allowBrowsers: body.allowBrowsers === undefined ? cur.allowBrowsers : body.allowBrowsers,
        allowGeos: body.allowGeos === undefined ? cur.allowGeos : body.allowGeos,
        geoCapUrl: body.geoCapUrl === undefined ? cur.geoCapUrl : body.geoCapUrl,
        dedupeWindow: body.dedupeWindow === undefined ? cur.dedupeWindow : body.dedupeWindow,
        revenueCap: body.revenueCap === undefined ? cur.revenueCap : body.revenueCap,
        botFilter: body.botFilter === undefined ? cur.botFilter : body.botFilter,
        datacenterAsBot: body.datacenterAsBot === undefined ? cur.datacenterAsBot : body.datacenterAsBot,
        domain: body.domain === undefined ? cur.domain : body.domain,
        streamRotation: body.streamRotation === undefined ? cur.streamRotation : body.streamRotation,
        uniquenessHours: body.uniquenessHours === undefined ? cur.uniquenessHours : body.uniquenessHours,
        bindVisitors: body.bindVisitors === undefined ? cur.bindVisitors : body.bindVisitors,
        bindTtlHours: body.bindTtlHours === undefined ? cur.bindTtlHours : body.bindTtlHours,
        ownerId: body.ownerId === undefined || req.user?.role === 'buyer' ? cur.ownerId : body.ownerId,
        sourceId: body.sourceId === undefined ? cur.sourceId : body.sourceId,
        redirectMethod: body.redirectMethod === undefined ? cur.redirectMethod : body.redirectMethod,
        blockedIps: body.blockedIps === undefined ? cur.blockedIps : body.blockedIps,
        allowedIps: body.allowedIps === undefined ? cur.allowedIps : body.allowedIps,
        totalCap: body.totalCap === undefined ? cur.totalCap : body.totalCap,
        conversionWindowDays: body.conversionWindowDays === undefined ? cur.conversionWindowDays : body.conversionWindowDays,
        paramMap: body.paramMap === undefined ? cur.paramMap : body.paramMap,
        costModel: body.costModel === undefined ? cur.costModel : body.costModel,
        cpc: body.cpc === undefined ? cur.cpc : body.cpc,
        costFromParam: body.costFromParam === undefined ? cur.costFromParam : body.costFromParam,
        sourcePostbackUrl: body.sourcePostbackUrl === undefined ? cur.sourcePostbackUrl : body.sourcePostbackUrl,
        sourcePostbackStatuses: body.sourcePostbackStatuses === undefined ? cur.sourcePostbackStatuses : body.sourcePostbackStatuses,
        monitoring: body.monitoring === undefined ? cur.monitoring : body.monitoring,
      }));
      await persistCampaign(id, campaigns.get(id));
      await audit(req, 'update', 'campaign', id, cur, campaigns.get(id));
      return json(res, 200, { id, ...campaigns.get(id) });
    }
    // Keitaro «Очистка статистики»: owner only, the body must repeat the campaign id.
    const clearStats = url.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9_-]{2,80})\/clear-stats$/);
    if (clearStats && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      // Owner only: buyers and viewers (even with viewAll or a personal API key) are refused.
      if (restrictedUser(req)) return json(res, 403, { error: 'owner_only' });
      const id = clearStats[1];
      if (!campaigns.has(id)) return json(res, 404, { error: 'campaign_not_found' });
      const body = await readJson(req);
      if (body.confirm !== id) return json(res, 400, { error: 'confirm_mismatch' });
      const before = body.before ?? null;
      if (before !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(String(before)) || Number.isNaN(Date.parse(`${before}T00:00:00Z`)))) return json(res, 400, { error: 'invalid_before_date' });
      const beforeIso = before ? new Date(`${before}T00:00:00Z`).toISOString() : null;
      const removed = await removeStats(campaignPlan(id, beforeIso ? Date.parse(beforeIso) : null), (pool) => clearCampaignRows(pool, id, beforeIso));
      console.log(`[clear-stats] ${id}${before ? ` before ${before}` : ''}: ${JSON.stringify(removed)}`);
      await audit(req, 'clear_stats', 'campaign', id, null, { before: before || 'all', clicks: removed.clicks, conversions: removed.conversions, lpClicks: removed.lpClicks, bots: removed.bots });
      return json(res, 200, { ok: true, campaign: id, before, removed });
    }
    // Dedicated streams endpoint: PUT /api/campaigns/:id/streams
    const streamsUpdate = url.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9_-]{2,80})\/streams$/);
    if (streamsUpdate && req.method === 'PUT') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const id = streamsUpdate[1];
      if (!campaigns.has(id)) return json(res, 404, { error: 'campaign_not_found' });
      if (!canEditCampaign(req, campaigns.get(id))) return json(res, 403, { error: 'campaign_not_yours' });
      const body = await readJson(req);
      if (!Array.isArray(body.streams)) return json(res, 400, { error: 'streams_array_required' });
      const streams = parseStreams(body.streams);
      if (body.streams.length > 0 && streams.length === 0) return json(res, 400, { error: 'invalid_streams_all_rejected' });
      const current = campaigns.get(id);
      campaigns.set(id, { ...current, streams });
      await persistCampaign(id, campaigns.get(id));
      await audit(req, 'update', 'campaign', id, current, campaigns.get(id));
      return json(res, 200, { id, streams });
    }
    if (url.pathname === '/dashboard' && req.method === 'GET') return dashboard(res);
    const adminAsset = { '/admin': ['index.html', 'text/html'], '/admin/': ['index.html', 'text/html'], '/admin/admin.js': ['admin.js', 'text/javascript'], '/admin/admin.css': ['admin.css', 'text/css'] }[url.pathname];
    if (adminAsset && req.method === 'GET') {
      res.writeHead(200, { 'content-type': `${adminAsset[1]}; charset=utf-8`, 'cache-control': 'no-store' });
      const body = await readFile(join(root, 'public', 'admin', adminAsset[0]));
      if (adminAsset[0] !== 'index.html') return res.end(body);
      // The base path goes into a meta tag (not an inline script) so the panel can run under a strict CSP.
      return res.end(String(body).replaceAll('"/admin/', `"${basePath}/admin/`).replace('<head>', `<head>\n<meta name="umbrella-base" content="${basePath}">`));
    }
    if (url.pathname === '/' && req.method === 'GET') { res.writeHead(302, { location: `${basePath}/admin` }); return res.end(); }
    if (url.pathname === '/health') return json(res, 200, { ok: true, storage: db ? 'postgres' : 'jsonl', geo: Boolean(geoReader), isp: Boolean(asnReader), now: new Date().toISOString(), uptime: Math.round(process.uptime()) });
    // Time-series: GET /stats/timeseries?campaign=X&from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|hour
    if (url.pathname === '/stats/timeseries' && req.method === 'GET') {
      const tsFrom = url.searchParams.get('from') || null;
      const tsTo = url.searchParams.get('to') || null;
      const tsCampaign = url.searchParams.get('campaign') || null;
      const tsOffer = url.searchParams.get('offer') || null;
      const granularity = url.searchParams.get('granularity') === 'hour' ? 'hour' : 'day';
      const tsCurrency = reportCurrency(url.searchParams.get('currency'));
      if (tsFrom && !/^\d{4}-\d{2}-\d{2}$/.test(tsFrom)) return json(res, 400, { error: 'invalid_from_date' });
      if (tsTo && !/^\d{4}-\d{2}-\d{2}$/.test(tsTo)) return json(res, 400, { error: 'invalid_to_date' });
      if (db) {
        try {
          const conds = [], params = [];
          if (tsCampaign) { params.push(tsCampaign); conds.push(`c.campaign = $${params.length}`); }
          if (tsOffer) { params.push(tsOffer); conds.push(`c.offer_id = $${params.length}`); }
          if (req.scope?.allowed) { params.push(req.scope.allowed); conds.push(`c.campaign = ANY($${params.length}::text[])`); }
          if (tsFrom) { params.push(`${tsFrom}T00:00:00Z`); conds.push(`c.created_at >= $${params.length}`); }
          if (tsTo) { params.push(`${tsTo}T23:59:59Z`); conds.push(`c.created_at <= $${params.length}`); }
          const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
          const trunc = granularity === 'hour' ? 'hour' : 'day';
          const fx = sqlFx(params, tsCurrency);
          const { rows } = await db.query(`
            SELECT
              DATE_TRUNC('${trunc}', c.created_at) AS bucket,
              COUNT(c.click_id)::int                AS clicks,
              COUNT(c.click_id) FILTER (WHERE c.is_unique_campaign)::int AS unique_clicks,
              ${SQL_CONVERSIONS}::int               AS conversions,
              (${fx.revenue} + ${fx.clickRevenue})::float AS revenue,
              ${fx.cost}::float                     AS cost
            FROM clicks c
            LEFT JOIN conversions cv USING (click_id)
            ${where}
            GROUP BY bucket ORDER BY bucket
          `, params);
          return json(res, 200, { granularity, currency: tsCurrency, series: rows.map((r) => ({ date: r.bucket.toISOString().slice(0, granularity === 'hour' ? 13 : 10), clicks: r.clicks, uniqueClicks: r.unique_clicks, conversions: r.conversions, revenue: r.revenue, cost: r.cost })) });
        } catch (e) { console.warn('[db] timeseries fallback:', e.message); }
      }
      // JSONL fallback
      try {
        const lines = (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
        const fromMs = tsFrom ? Date.parse(`${tsFrom}T00:00:00Z`) : null;
        const toMs = tsTo ? Date.parse(`${tsTo}T23:59:59Z`) : null;
        const allClicks = lines.filter((item) => item.type === 'click');
        const clicks = allClicks.filter((item) => {
          if (tsCampaign && item.campaign !== tsCampaign) return false;
          if (tsOffer && item.offerId !== tsOffer) return false;
          if (req.scope?.allowed && !req.scope.allowed.includes(item.campaign)) return false;
          const t = item.at ? Date.parse(item.at) : null;
          if (fromMs !== null && (t === null || t < fromMs)) return false;
          if (toMs !== null && (t === null || t > toMs)) return false;
          return true;
        });
        const visibleClickIds = new Set(clicks.map((c) => c.clickId));
        const convs = [...latestConversions(lines).values()].filter((item) => visibleClickIds.has(item.clickId) && conversionCounts(item));
        const clickBucket = new Map(clicks.map((c) => [c.clickId, (c.at || '').slice(0, granularity === 'hour' ? 13 : 10)]));
        const buckets = {};
        for (const click of clicks) {
          const b = (click.at || '').slice(0, granularity === 'hour' ? 13 : 10);
          buckets[b] ||= { clicks: 0, uniqueClicks: 0, conversions: 0, revenue: 0, cost: 0 };
          buckets[b].clicks += 1;
          if (click.uniqueCampaign) buckets[b].uniqueClicks += 1;
          buckets[b].cost += Number(click.cost) * rates.factor(rates.defaultCurrency, tsCurrency) || 0;
          buckets[b].revenue += Number(click.revenue) * rates.factor(rates.defaultCurrency, tsCurrency) || 0;
        }
        for (const conv of convs) {
          const b = clickBucket.get(conv.clickId) || '';
          if (!b) continue;
          buckets[b] ||= { clicks: 0, conversions: 0, revenue: 0 };
          buckets[b].conversions += 1;
          buckets[b].revenue += saleRevenue(conv) * rates.factor(conv.currency, tsCurrency);
        }
        const series = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
        return json(res, 200, { granularity, currency: tsCurrency, series });
      } catch (e) {
        if (e.code === 'ENOENT') return json(res, 200, { granularity, currency: tsCurrency, series: [] });
        throw e;
      }
    }
    // Top referrers: GET /stats/referrers?campaign=X&limit=20
    if (url.pathname === '/stats/referrers' && req.method === 'GET') {
      const refCampaign = url.searchParams.get('campaign') || null;
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20)));
      if (db) {
        try {
          const conds = [], params = [];
          if (refCampaign) { params.push(refCampaign); conds.push(`campaign = $${params.length}`); }
          if (req.scope?.allowed) { params.push(req.scope.allowed); conds.push(`campaign = ANY($${params.length}::text[])`); }
          const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
          params.push(limit);
          const { rows } = await db.query(`SELECT COALESCE(referrer,'direct') AS referrer, COUNT(*)::int AS clicks FROM clicks ${where} GROUP BY referrer ORDER BY clicks DESC LIMIT $${params.length}`, params);
          return json(res, 200, { referrers: rows });
        } catch (e) { console.warn('[db] referrers fallback:', e.message); }
      }
      try {
        const lines = (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
        const clicks = lines.filter((item) => item.type === 'click' && (!refCampaign || item.campaign === refCampaign) && (!req.scope?.allowed || req.scope.allowed.includes(item.campaign)));
        const counts = {};
        for (const c of clicks) { const r = c.referrer || 'direct'; counts[r] = (counts[r] || 0) + 1; }
        const referrers = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([referrer, clicks]) => ({ referrer, clicks }));
        return json(res, 200, { referrers });
      } catch (e) { if (e.code === 'ENOENT') return json(res, 200, { referrers: [] }); throw e; }
    }
    // Top paths: GET /stats/paths?campaign=X&limit=20
    // Report by traffic-source parameter: GET /stats/params?field=sub_id_1&campaign=X&from=&to=
    if (url.pathname === '/stats/params' && req.method === 'GET') {
      const field = url.searchParams.get('field') || '';
      if (!TRACK_FIELDS.includes(field) && !DIMENSION_FIELDS.includes(field)) return json(res, 400, { error: 'invalid_field', fields: [...TRACK_FIELDS, ...DIMENSION_FIELDS] });
      const pFrom = url.searchParams.get('from') || null;
      const pTo = url.searchParams.get('to') || null;
      if ((pFrom && !/^\d{4}-\d{2}-\d{2}$/.test(pFrom)) || (pTo && !/^\d{4}-\d{2}-\d{2}$/.test(pTo))) return json(res, 400, { error: 'invalid_date' });
      const pCampaign = url.searchParams.get('campaign') || null;
      const pCurrency = reportCurrency(url.searchParams.get('currency'));
      return json(res, 200, { field, currency: pCurrency, rows: await paramReport({ field, campaign: pCampaign, allowed: req.scope?.allowed || null, from: pFrom, to: pTo, currency: pCurrency }) });
    }
    if (url.pathname === '/stats/bots' && req.method === 'GET') {
      const campaign = url.searchParams.get('campaign') || null;
      const from = url.searchParams.get('from') || null; const to = url.searchParams.get('to') || null;
      if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) return json(res, 400, { error: 'invalid_date' });
      const fromMs = from ? Date.parse(`${from}T00:00:00Z`) : -Infinity; const toMs = to ? Date.parse(`${to}T23:59:59Z`) : Infinity;
      if (db) {
        try {
          const values = []; const where = [];
          if (campaign) { values.push(campaign); where.push(`campaign = $${values.length}`); }
          if (req.scope?.allowed) { values.push(req.scope.allowed); where.push(`campaign = ANY($${values.length}::text[])`); }
          if (from) { values.push(`${from}T00:00:00Z`); where.push(`created_at >= $${values.length}`); }
          if (to) { values.push(`${to}T23:59:59Z`); where.push(`created_at <= $${values.length}`); }
          const { rows } = await db.query(`SELECT campaign, COUNT(*)::int AS count FROM bots ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY campaign`, values);
          const byCampaign = Object.fromEntries(rows.map((r) => [r.campaign, r.count]));
          return json(res, 200, { total: rows.reduce((sum, r) => sum + r.count, 0), byCampaign });
        } catch (error) { console.warn('[db] bots report fallback:', error.message); }
      }
      try {
        const lines = (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
        const byCampaign = {};
        for (const item of lines) if (item.type === 'bot' && (!campaign || item.campaign === campaign) && (!req.scope?.allowed || req.scope.allowed.includes(item.campaign))) {
          const at = Date.parse(item.at || item.created_at || ''); if (at < fromMs || at > toMs) continue;
          byCampaign[item.campaign] = (byCampaign[item.campaign] || 0) + 1;
        }
        return json(res, 200, { total: Object.values(byCampaign).reduce((a, b) => a + b, 0), byCampaign });
      } catch (error) { if (error.code === 'ENOENT') return json(res, 200, { total: 0, byCampaign: {} }); throw error; }
    }
    if (url.pathname === '/stats/paths' && req.method === 'GET') {
      const pathCampaign = url.searchParams.get('campaign') || null;
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20)));
      if (db) {
        try {
          const conds = [], params = [];
          if (pathCampaign) { params.push(pathCampaign); conds.push(`campaign = $${params.length}`); }
          if (req.scope?.allowed) { params.push(req.scope.allowed); conds.push(`campaign = ANY($${params.length}::text[])`); }
          const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
          params.push(limit);
          const { rows } = await db.query(`SELECT COALESCE(path,'/') AS path, COUNT(*)::int AS clicks FROM clicks ${where} GROUP BY path ORDER BY clicks DESC LIMIT $${params.length}`, params);
          return json(res, 200, { paths: rows });
        } catch (e) { console.warn('[db] paths fallback:', e.message); }
      }
      try {
        const lines = (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
        const clicks = lines.filter((item) => item.type === 'click' && (!pathCampaign || item.campaign === pathCampaign) && (!req.scope?.allowed || req.scope.allowed.includes(item.campaign)));
        const counts = {};
        for (const c of clicks) { const p = c.path || '/'; counts[p] = (counts[p] || 0) + 1; }
        const paths = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([path, clicks]) => ({ path, clicks }));
        return json(res, 200, { paths });
      } catch (e) { if (e.code === 'ENOENT') return json(res, 200, { paths: [] }); throw e; }
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    return json(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'internal_error' });
  }
});

await rates.start();
await loadSettings();
await loadSources();
await loadNetworks();
await loadOffers();
await loadLandings();
await loadCampaigns();
// One-time copy of bot events recorded before the bots table existed (only while the table is empty).
if (db) {
  try {
    const { rows } = await db.query('SELECT 1 FROM bots LIMIT 1');
    if (!rows.length) {
      const old = (await readFile(eventsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((e) => e?.type === 'bot' && e.campaign);
      for (let i = 0; i < old.length; i += 500) {
        const chunk = old.slice(i, i + 500); const values = [];
        const tuples = chunk.map((e, j) => { values.push(e.campaign, e.offerId ?? null, e.stream ?? null, e.userAgent ?? null, e.ip ?? null, e.reason ?? null, e.isp ?? null, e.at || new Date().toISOString());
          const b = j * 8; return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`; });
        await db.query(`INSERT INTO bots (campaign, offer_id, stream, user_agent, ip, reason, isp, created_at) VALUES ${tuples.join(',')}`, values);
      }
      if (old.length) console.log(`[db] copied ${old.length} bot events from the journal`);
    }
  } catch (error) { console.warn('[db] bot backfill skipped:', error.message); }
}
if (requirePostgres && !db) throw new Error('REQUIRE_POSTGRES=1, но PostgreSQL недоступен');
server.listen(port, '127.0.0.1', () => console.log(`Product Umbrella listening on http://127.0.0.1:${server.address().port}`));
if (retentionDays > 0) {
  const retentionTick = () => runRetention().catch((error) => console.warn('[retention] failed:', error.message));
  const firstRunMs = Math.max(0, Number(process.env.RETENTION_DELAY_MS ?? 60000));
  setTimeout(() => { retentionTick(); setInterval(retentionTick, 86400000).unref(); }, firstRunMs).unref();
  console.log(`[retention] enabled: ${retentionDays} days`);
}
if (monitorEnabled) monitor.start();

async function shutdown() { monitor.stop(); await new Promise((resolve) => server.close(resolve)); await eventMirror?.drain(); await closeDb(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
