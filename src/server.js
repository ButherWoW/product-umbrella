import './env-local.js'; // must stay first: .env.local overrides are read before any other module looks at process.env
import './log-setup.js';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, appendFile, readFile, writeFile as fsWriteFile, chmod, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, query, closeDb, dbStatus } from './db.js';
import { readJournal, endsWithNewline, journalBadLines, noteBadLines } from './journal.js';
import { reconcileJournal, ReconcileStopped } from './reconcile.js';
import { reportFromRows, reportFromEvents, metrics } from './stats-report.js';
import { createUserStore, readCookie, SESSION_TTL_MS, API_KEY_PREFIX } from './auth.js';
import { createRates, normalizeCurrency } from './currency.js';
import { readEventLog } from './event-logs.js';
import { createConversionRecorder, hasRecordedConversion, findRecordedConversion, conversionKey } from './conversion-recorder.js';
import { createEventMirror } from './event-mirror.js';
import { createConversionCapCounter, resolveOffer, zonedDayStart } from './conversion-cap.js';
import { parseTz, dayRange, localBucket } from './report-tz.js';
import { createJournalGate, filterJournal, campaignPlan, retentionPlan, clearCampaignRows, retentionRows } from './retention.js';
import { createSourcePostbacks, resolveSourcePostback, parsePostbackUrl, parsePostbackStatuses, journalHasSourcePostback, sendPostback, deliverWithRetry, fillPostbackMacros, stripQuery, allowPrivateFromEnv, SAMPLE_MACROS } from './source-postback.js';
import { connectionType, CONNECTION_TYPES } from './connection-type.js';
import { createBindingStore, bindingKey, boundChoice, streamRef, parseBindMode, parseBindTtl } from './visitor-binding.js';
import { createMonitor, MONITOR_MODES } from './monitor.js';
import { BOT_UA_RE, DATACENTER_RE, cloakingCondition, cloakingMessage, disabledByPolicy, streamPolicyError } from './stream-policy.js';
import { createRateLimiter, createLoginLimiter, loginLimitsFromEnv } from './rate-limit.js';
import { DEMO_PREFIX, isDemoPanelPath, isDemoPath, isPanelPath } from './panel-routes.js';
import { createJournalIndex, createClickCounters, createScanQueue, createOldClickLookup, scanJournalLines } from './journal-index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DATA_DIR || join(root, 'data');
const eventsFile = join(dataDir, 'events.jsonl');
const offersFile = join(dataDir, 'offers.json');
const landingsFile = join(dataDir, 'landings.json');
const settingsFile = join(dataDir, 'settings.json');
const campaignsFile = join(dataDir, 'campaigns.json');
const sourcesFile = join(dataDir, 'sources.json');
const networksFile = join(dataDir, 'networks.json');
// Data files hold postback URLs with network credentials, visitor IPs and settings: owner-only (0600).
// The journal is appended with the same mode; files created by older versions are tightened at startup.
const DATA_FILE_MODE = 0o600;
const writeFile = (file, data, options = {}) => fsWriteFile(file, data, { mode: DATA_FILE_MODE, ...options });
async function tightenDataFiles() {
  for (const file of [eventsFile, offersFile, landingsFile, settingsFile, campaignsFile, sourcesFile, networksFile, join(dataDir, 'users.json'), join(dataDir, 'sessions.json'), join(dataDir, 'fx-rates.json')]) {
    try { await chmod(file, DATA_FILE_MODE); } catch (error) { if (error.code !== 'ENOENT') console.warn('[data] chmod failed:', file, error.message); }
  }
}
const port = Number(process.env.PORT || 4100);
// Public path prefix when served behind a proxy under a subpath (nginx strips it before proxying).
const basePath = /^\/[A-Za-z0-9_-]{1,40}$/.test(process.env.BASE_PATH || '') ? process.env.BASE_PATH : '';
// Umbrella's own accounts (see src/auth.js). REQUIRE_LOGIN=1 closes reports and APIs to anonymous visitors.
const users = createUserStore({ db, dataDir });
const requireLogin = /^(1|true|yes)$/i.test(process.env.REQUIRE_LOGIN || '');
// Source postbacks to loopback (and plain http) only in tests: SOURCE_POSTBACK_ALLOW_PRIVATE=1.
const sourcePostbackAllowPrivate = allowPrivateFromEnv();
// Offer S2S postbacks go through the same hardened sender; S2S_ALLOW_PRIVATE=1 (or the flag above) is for tests only.
const s2sAllowPrivate = sourcePostbackAllowPrivate || /^(1|true|yes)$/i.test(process.env.S2S_ALLOW_PRIVATE || '');
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
    // revenue_ignored: a CPC offer's postback amount — the offer earns per click (clickRevenue), never per postback.
    revenue: `COALESCE(SUM(${amount}) FILTER (WHERE cv.status = 'sale' AND NOT cv.revenue_ignored), 0)`,
    pending: `COALESCE(SUM(${amount}) FILTER (WHERE cv.status = 'lead' AND NOT cv.revenue_ignored), 0)`,
    cost: `COALESCE(SUM(c.cost), 0) * $${n}::float`,
    // CPC offer payout booked on the click itself (stored in DEFAULT_CURRENCY, like cost).
    clickRevenue: `COALESCE(SUM(c.revenue), 0) * $${n}::float`,
    // Per-click reports: a click can have several conversions (upsells, one per tid), so they are summed per click
    // first (alias cvs) and the click row is never duplicated — clicks and cost stay exact.
    join: `LEFT JOIN LATERAL (SELECT
        COUNT(*) FILTER (WHERE x.status IN ('lead', 'sale')) AS conversions,
        COUNT(*) FILTER (WHERE x.status = 'lead') AS leads, COUNT(*) FILTER (WHERE x.status = 'sale') AS sales,
        COUNT(*) FILTER (WHERE x.status = 'rejected') AS rejected, COUNT(*) FILTER (WHERE x.status = 'trash') AS trash,
        COALESCE(SUM(${amount.replaceAll('cv.', 'x.')}) FILTER (WHERE x.status = 'sale' AND NOT x.revenue_ignored), 0) AS revenue,
        COALESCE(SUM(${amount.replaceAll('cv.', 'x.')}) FILTER (WHERE x.status = 'lead' AND NOT x.revenue_ignored), 0) AS pending
      FROM conversions x WHERE x.click_id = c.click_id) cvs ON true`,
    sum: (column) => `COALESCE(SUM(cvs.${column}), 0)`,
  };
}
// JSONL equivalents.
// `to` dates are inclusive: a range ends before the next midnight (UTC), the same bound in SQL and in the journal.
const dayEndIso = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString();
const convertConversion = (cv, currency) => (cv.revenue === null || cv.revenue === undefined ? cv : { ...cv, revenue: Number(cv.revenue) * rates.factor(cv.currency, currency) });
const convertClickCost = (click, currency) => (click.cost || click.revenue ? { ...click, cost: Number(click.cost || 0) * rates.factor(rates.defaultCurrency, currency),
  revenue: Number(click.revenue || 0) * rates.factor(rates.defaultCurrency, currency) } : click);
const SESSION_COOKIE = 'umb_session';
const loginLimiter = createLoginLimiter(loginLimitsFromEnv());
const postbackSecret = process.env.POSTBACK_SECRET || '';
const adminToken = process.env.ADMIN_TOKEN || '';
const requirePostgres = /^(1|true|yes)$/i.test(process.env.REQUIRE_POSTGRES || '');
const clickRateLimit = Math.max(0, Number(process.env.CLICK_RATE_LIMIT || 120));
const clickRateWindowMs = Math.max(1000, Number(process.env.CLICK_RATE_WINDOW_MS || 60000));
// Separate, more generous limits for the landing click-out and incoming postbacks (per IP and minute window; 0 = off).
const envLimit = (name, fallback) => { const n = Number.parseInt(process.env[name] ?? '', 10); return Number.isFinite(n) && n >= 0 ? n : fallback; };
const clickLimiter = createRateLimiter({ limit: clickRateLimit, windowMs: clickRateWindowMs });
const lpClickLimiter = createRateLimiter({ limit: envLimit('LP_CLICK_RATE_LIMIT', 300), windowMs: Math.max(1000, envLimit('LP_CLICK_RATE_WINDOW_MS', 60000)) });
const postbackLimiter = createRateLimiter({ limit: envLimit('POSTBACK_RATE_LIMIT', 1200), windowMs: Math.max(1000, envLimit('POSTBACK_RATE_WINDOW_MS', 60000)) });
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
// Hosting / cloud networks (DATACENTER_RE) and bot User-Agents (BOT_UA_RE) live in stream-policy.js, shared with the no-cloaking check.
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

function rateLimited(ip, limiter = clickLimiter) {
  return limiter.hit(ip);
}
const campaigns = new Map([['demo', { name: 'Demo campaign', active: true, streams: [], dailyCap: null, capUrl: null, allowDevices: [], allowGeos: [], geoCapUrl: null }]]);
// Clicks whose PostgreSQL insert failed: only for these may getClickRecord fall back to the JSONL journal.
const unmirroredClicks = new Set();
const eventMirror = db ? createEventMirror({ query,
  onError: (type, error, payload) => {
    console.warn(`[db] ${type} insert failed (reconciliation will replay it):`, error.message);
    if (type === 'click' && payload?.clickId) {
      unmirroredClicks.add(payload.clickId);
      if (unmirroredClicks.size > 100000) unmirroredClicks.delete(unmirroredClicks.values().next().value);
    }
  } }) : null;
// The click path never reads the whole journal: click counts, last click per (campaign, IP), recent clicks (LRU),
// conversions and source postbacks are indexed in memory (src/journal-index.js). Reports stream the journal,
// one scan at a time. CLICK_INDEX_LIMIT: clicks kept for /lp/click and postback lookups and (campaign, IP) visitors kept
// for deduplication; older ones are streamed from the journal.
const clickIndexLimit = Number.parseInt(process.env.CLICK_INDEX_LIMIT || '', 10);
const indexLimit = clickIndexLimit > 0 ? clickIndexLimit : 200000;
const journalIndex = createJournalIndex({ clickLimit: indexLimit, visitorLimit: indexLimit });
const journalScans = createScanQueue();
const journalRecords = (types = null) => journalScans.run(() => readJournal(eventsFile, types));
const lookupOldClick = createOldClickLookup(eventsFile, journalScans);
// Journal size the index covers: what it was built from plus this process's own appends. A different size on disk
// means someone else appended (tests, manual repair), and the index is rebuilt before it answers "not found".
let indexedBytes = 0;
const journalSize = () => stat(eventsFile).then((s) => s.size, (error) => { if (error.code === 'ENOENT') return 0; throw error; });
async function buildJournalIndex() {
  const { bad } = await journalIndex.build(eventsFile);
  noteBadLines(bad, eventsFile);
  indexedBytes = await journalSize();
}
async function syncJournalIndex() {
  if (await journalSize() === indexedBytes) return false;
  return journalGate.rewrite(async () => {
    if (await journalSize() === indexedBytes) return false;
    await buildJournalIndex();
    clickCounters.clear();
    return true;
  });
}

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
      // Switched off by the no-cloaking policy (src/stream-policy.js); the reason is shown in the panel.
      if (s.enabled === false && s.disabledBy === 'policy') {
        stream.disabledBy = 'policy';
        if (s.disabledReason) stream.disabledReason = String(s.disabledReason).slice(0, 500);
      }
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
// sub_id_1..30 sent with a postback (G6): they overwrite the click's parameters. Empty values are ignored.
const SUB_ID_FIELDS = TRACK_FIELDS.filter((field) => field.startsWith('sub_id_'));
function postbackClickParams(query) {
  const params = {};
  for (const field of SUB_ID_FIELDS) { const v = query.get(field); if (v) params[field] = v.slice(0, 255); }
  return params;
}
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
// Macros in the host part (https://{source}/, https://{sub_id_1}.example.com/) would let a visitor choose where
// a redirect or postback goes (open redirect), and encoding does not help: URL parsing decodes %2E in hosts.
// Rule: a macro may only stand for subdomain labels in front of a literal domain of at least two labels
// (https://{x}.example.com/ — the result must stay under .example.com). A host that is all macro, a macro
// glued to the domain (https://{x}example.com) or a result outside the literal domain is refused.
const AUTHORITY_RE = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;
function hostSafe(template, result) {
  const authority = String(template).match(AUTHORITY_RE)?.[1];
  if (authority === undefined) return true;
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  const macros = [...host.matchAll(MACRO_RE)];
  if (!macros.length) return true;
  const last = macros.at(-1);
  const suffix = host.slice(last.index + last[0].length).replace(/:[^:\]]*$/, '').toLowerCase();
  if (!/^\.[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(suffix)) return false;
  try {
    const hostname = new URL(result).hostname.toLowerCase();
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  } catch { return false; }
}
// applyMacros for a redirect or postback target: null when a host-position macro moved the host.
function expandUrl(template, vars) {
  const result = applyMacros(template, vars);
  return hostSafe(template, result) ? result : null;
}
// Same, for request handlers: an unsafe destination answers 404 (nothing is recorded before it).
function expandUrlOrFail(template, vars) {
  const result = expandUrl(template, vars);
  if (result === null) throw Object.assign(new Error('unsafe_destination'), { statusCode: 404 });
  return result;
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
  // Journal index: whole UTC days (`since` is the start of a day) or all time, per campaign or per offer.
  const day = since ? String(since).slice(0, 10) : null;
  if (day) return journalIndex.count(campaign ? `c|${campaign}|${day}` : `o|${offerId}|${day}`);
  return campaign ? journalIndex.count(`t|${campaign}`) : 0;
}

const todayStart = () => `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;

// Click cap counters: c|campaign|day, o|offer|day (UTC days) and t|campaign (lifetime). Seeded from PostgreSQL
// (or the journal index), refreshed in the background every CAP_REFRESH_MS, reserved synchronously per click.
const capDayKey = (kind, id) => `${kind}|${id}|${todayStart().slice(0, 10)}`;
const capRefreshMs = Number.parseInt(process.env.CAP_REFRESH_MS || '', 10);
const clickCounters = createClickCounters({ ttlMs: capRefreshMs > 0 ? capRefreshMs : 60000, seed: (key) => {
  const [kind, id, day] = key.split('|');
  if (kind === 't') return countClicks({ campaign: id });
  return countClicks(kind === 'c' ? { campaign: id, since: `${day}T00:00:00Z` } : { offerId: id, since: `${day}T00:00:00Z` });
} });

const conversionCaps = createConversionCapCounter({ db, eventsFile,
  countJournal: (offerId, since) => journalIndex.conversionCapCount(offerId, since.getTime()),
  onFallback: (error) => console.warn('[db] conversion cap fallback:', error.message) });

// null when the offer can take traffic, otherwise why not: missing, archived, click_cap (dailyCap) or conversion_cap.
async function offerState(id) {
  const offer = offers.get(id);
  if (!offer) return 'missing';
  if (offer.archived) return 'archived';
  if (offer.dailyCap) {
    const key = capDayKey('o', id);
    await clickCounters.ensure([key]);
    if (clickCounters.get(key) >= offer.dailyCap) return 'click_cap';
  }
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

// Same IP clicked this campaign within the dedup window (minutes)? The journal index knows every click of this
// process (marked at decision time, so concurrent clicks see each other); PostgreSQL covers clicks from before
// a restart with an empty data directory.
const recentClick = (campaign, ip, windowMinutes) => Boolean(windowMinutes && ip)
  && (journalIndex.lastClickAt(campaign, ip) ?? -Infinity) >= Date.now() - windowMinutes * 60 * 1000;
async function isDuplicateClick(campaign, ip, windowMinutes) {
  if (!windowMinutes || !ip) return false;
  if (recentClick(campaign, ip, windowMinutes)) return true;
  const sinceMs = Date.now() - windowMinutes * 60 * 1000;
  if (db) {
    try {
      const { rows } = await db.query(
        'SELECT 1 FROM clicks WHERE campaign = $1 AND ip = $2 AND created_at >= $3 LIMIT 1',
        [campaign, ip, new Date(sinceMs).toISOString()],
      );
      if (rows.length) return true;
    } catch (e) { console.warn('[db] dedupe fallback:', e.message); }
  } else if (!journalIndex.visitorsCompleteSince(sinceMs)) {
    // JSONL only: the index pushed out visitors seen inside this window, so a miss is not final — read the journal.
    let lastAt = -Infinity;
    await journalScans.run(() => scanJournalLines(eventsFile, (line) => {
      if (!line.includes(ip)) return;
      let item; try { item = JSON.parse(line); } catch { return; }
      if (item.type === 'click' && item.campaign === campaign && item.ip === ip) lastAt = Math.max(lastAt, Date.parse(item.at) || -Infinity);
    }));
    if (lastAt >= sinceMs) { journalIndex.markClick(campaign, ip, lastAt); return true; }
  }
  return false;
}

// Sum revenue from conversions today for a campaign. Non-fatal — returns 0 on error.
// Conversions with statuses: a click's latest conversion event wins. Events written before statuses existed are sales.
// "Conversions" = lead + sale; revenue counts only sales (lead amounts are pending revenue).
// Keyed by click and tid: upsells (other tids) are separate conversions of the same click.
function latestConversions(lines) {
  const latest = new Map();
  for (const item of lines) if (item?.type === 'conversion') latest.set(conversionKey(item), item);
  return latest;
}
// clickId → [conversions] (main conversion and upsells).
function conversionsByClick(conversions) {
  const byClick = new Map();
  for (const cv of conversions) { const list = byClick.get(cv.clickId); if (list) list.push(cv); else byClick.set(cv.clickId, [cv]); }
  return byClick;
}
// Later journal events that change a click, applied in journal order (PostgreSQL does the same in the mirror):
// sub_id_N sent with postbacks overwrite its parameters (G6), a manual cost update replaces its cost (G8).
function applyClickUpdates(lines) {
  const params = new Map(), costs = new Map();
  for (const item of lines) {
    if (item?.type === 'conversion' && item.params) params.set(item.clickId, { ...(params.get(item.clickId) || {}), ...item.params });
    else if (item?.type === 'cost_update' && Array.isArray(item.clickIds)) {
      for (const id of item.clickIds) costs.set(id, item.cost);
      if (item.lastClickId) costs.set(item.lastClickId, item.lastCost);
    }
  }
  if (!params.size && !costs.size) return lines;
  return lines.map((item) => {
    if (item?.type !== 'click' || (!params.has(item.clickId) && !costs.has(item.clickId))) return item;
    const updated = { ...item };
    if (params.has(item.clickId)) updated.params = { ...(item.params || {}), ...params.get(item.clickId) };
    if (costs.has(item.clickId)) updated.cost = costs.get(item.clickId);
    return updated;
  });
}
const conversionCounts = (cv) => ['lead', 'sale'].includes(cv?.status || 'sale');
// revenueIgnored (CPC offer postback): the amount is stored but is not revenue — the offer earns per click.
const saleRevenue = (cv) => ((cv?.status || 'sale') === 'sale' && !cv.revenueIgnored ? Number(cv.revenue) || 0 : 0);

// Revenue cap: revenue (DEFAULT_CURRENCY) of the campaign's conversions whose latest status is sale and whose latest
// event (the one that made it a sale) was recorded today, UTC — whatever day the click was. PostgreSQL and the
// journal count the same thing; the result is cached for 30 s per campaign (like the offer conversion cap) and
// dropped when a conversion of the campaign is recorded.
const revenueCache = new Map();
const REVENUE_CACHE_MS = 30000;
function invalidateRevenue(campaign, settled = null) {
  revenueCache.delete(campaign);
  settled?.then(() => revenueCache.delete(campaign), () => revenueCache.delete(campaign));
}
async function todayRevenue(campaign) {
  const since = todayStart();
  const hit = revenueCache.get(campaign);
  if (hit && hit.since === since && Date.now() - hit.at < REVENUE_CACHE_MS) return hit.value;
  let value = null;
  if (db) {
    try {
      const amount = 'cv.revenue * COALESCE(($3::jsonb ->> COALESCE(cv.currency, $4))::float, 1)';
      // CPC offers' postback amounts (revenue_ignored) are not revenue, as in every report (saleRevenue in the journal).
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(${amount}), 0)::float AS rev
         FROM conversions cv
         JOIN clicks c USING (click_id)
         WHERE c.campaign = $1 AND cv.status = 'sale' AND NOT cv.revenue_ignored AND COALESCE(cv.updated_at, cv.created_at) >= $2`,
        [campaign, since, JSON.stringify(rates.factors(rates.defaultCurrency)), rates.defaultCurrency],
      );
      value = rows[0].rev;
    } catch (e) { console.warn('[db] todayRevenue fallback:', e.message); }
  }
  if (value === null) {
    try {
      const lines = await readJournal(eventsFile);
      const sinceMs = Date.parse(since);
      const clickIds = new Set(lines.filter((item) => item.type === 'click' && item.campaign === campaign).map((item) => item.clickId));
      value = [...latestConversions(lines).values()]
        .filter((item) => clickIds.has(item.clickId) && Date.parse(item.at) >= sinceMs)
        .reduce((sum, item) => sum + saleRevenue(item) * rates.factor(item.currency, rates.defaultCurrency), 0);
    } catch (e) { console.warn('[journal] todayRevenue failed:', e.message); return 0; }
  }
  revenueCache.set(campaign, { value, since, at: Date.now() });
  return value;
}

// Owner of an offer, landing, source or network: the id of the user who created it; null = team (owner / ADMIN_TOKEN).
function parseOwnerId(value) {
  return /^[0-9a-f-]{36}$/i.test(String(value || '')) ? String(value).toLowerCase() : null;
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
    conversionCap, capTz, altOfferId, ownerId: parseOwnerId(raw?.ownerId) };
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
      const { rows } = await db.query('SELECT id, url, postback_url, payout_type, payout, payout_currency, daily_cap, name, network_id, "group", archived, conversion_cap, cap_tz, alt_offer_id, owner_id FROM offers');
      for (const row of rows) if (/^[a-z0-9_-]{2,80}$/i.test(row.id) && /^https:\/\//i.test(row.url)) offers.set(row.id, parseOffer({ url: row.url, postbackUrl: row.postback_url, payoutType: row.payout_type, payout: row.payout, payoutCurrency: row.payout_currency, dailyCap: row.daily_cap, name: row.name, networkId: row.network_id, group: row.group, archived: row.archived === true,
        conversionCap: row.conversion_cap, capTz: row.cap_tz, altOfferId: row.alt_offer_id, ownerId: row.owner_id }));
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
  if (db) await db.query('INSERT INTO offers (id, url, postback_url, daily_cap, name, network_id, "group", archived, conversion_cap, cap_tz, alt_offer_id, payout_type, payout, payout_currency, owner_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, postback_url = EXCLUDED.postback_url, payout_type = EXCLUDED.payout_type, payout = EXCLUDED.payout, payout_currency = EXCLUDED.payout_currency, daily_cap = EXCLUDED.daily_cap, name = EXCLUDED.name, network_id = EXCLUDED.network_id, "group" = EXCLUDED."group", archived = EXCLUDED.archived, conversion_cap = EXCLUDED.conversion_cap, cap_tz = EXCLUDED.cap_tz, alt_offer_id = EXCLUDED.alt_offer_id, owner_id = EXCLUDED.owner_id', [id, offer.url, offer.postbackUrl, offer.dailyCap ?? null, offer.name ?? null, offer.networkId ?? null, offer.group ?? '', offer.archived === true, offer.conversionCap ?? null, offer.capTz || 'UTC', offer.altOfferId ?? null, offer.payoutType || 'cpa', offer.payout ?? null, offer.payoutCurrency ?? null, offer.ownerId ?? null]);
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
    ownerId: parseOwnerId(raw.ownerId),
  };
}

async function loadSources() {
  if (db) {
    try {
      const { rows } = await db.query('SELECT id, name, param_map, cost_model, cpc, cost_from_param, postback_url, postback_statuses, owner_id FROM sources');
      for (const row of rows) if (OFFER_ID_RE.test(row.id)) {
        const s = parseSource({ name: row.name, paramMap: row.param_map, costModel: row.cost_model, cpc: row.cpc, costFromParam: row.cost_from_param,
          postbackUrl: row.postback_url, postbackStatuses: row.postback_statuses, ownerId: row.owner_id });
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
  if (db) await db.query('INSERT INTO sources (id, name, param_map, cost_model, cpc, cost_from_param, postback_url, postback_statuses, owner_id) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, param_map = EXCLUDED.param_map, cost_model = EXCLUDED.cost_model, cpc = EXCLUDED.cpc, cost_from_param = EXCLUDED.cost_from_param, postback_url = EXCLUDED.postback_url, postback_statuses = EXCLUDED.postback_statuses, owner_id = EXCLUDED.owner_id',
    [id, value.name ?? null, JSON.stringify(value.paramMap || {}), value.costModel, value.cpc, value.costFromParam, value.postbackUrl ?? null, JSON.stringify(value.postbackStatuses || ['sale']), value.ownerId ?? null]);
  else await saveSources();
}

function parseNetwork(raw) {
  const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 120) : '';
  if (!name) return null;
  return { name, offerParams: typeof raw?.offerParams === 'string' ? raw.offerParams.trim().slice(0, 1000) : '', clickIdParam: typeof raw?.clickIdParam === 'string' ? raw.clickIdParam.trim().slice(0, 80) : 'sub1', payoutParam: typeof raw?.payoutParam === 'string' ? raw.payoutParam.trim().slice(0, 80) : 'payout', notes: typeof raw?.notes === 'string' ? raw.notes.slice(0, 2000) : '', ownerId: parseOwnerId(raw?.ownerId) };
}
async function loadNetworks() {
  if (db) { try { const { rows } = await db.query('SELECT id,name,offer_params,click_id_param,payout_param,notes,owner_id FROM networks'); for (const r of rows) { const n=parseNetwork({name:r.name,offerParams:r.offer_params,clickIdParam:r.click_id_param,payoutParam:r.payout_param,notes:r.notes,ownerId:r.owner_id}); if(n) networks.set(r.id,n); } return; } catch (e) { console.warn('[db] networks load fallback:', e.message); } }
  try { const saved=JSON.parse(await readFile(networksFile,'utf8')); for (const [id,raw] of Object.entries(saved||{})) if (OFFER_ID_RE.test(id) && parseNetwork(raw)) networks.set(id,parseNetwork(raw)); } catch (e) { if(e.code!=='ENOENT') console.warn('[networks] invalid config ignored'); }
}
async function saveNetworks() { await mkdir(dataDir,{recursive:true}); await writeFile(networksFile,JSON.stringify(Object.fromEntries(networks),null,2)+'\n'); }
async function persistNetwork(id,v) { if(db) await db.query('INSERT INTO networks (id,name,offer_params,click_id_param,payout_param,notes,owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,offer_params=EXCLUDED.offer_params,click_id_param=EXCLUDED.click_id_param,payout_param=EXCLUDED.payout_param,notes=EXCLUDED.notes,owner_id=EXCLUDED.owner_id',[id,v.name,v.offerParams,v.clickIdParam,v.payoutParam,v.notes,v.ownerId??null]); else await saveNetworks(); }

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

// No-cloaking policy on stored campaigns: a stream with a forbidden condition is kept (so the owner sees what it was)
// but switched off with the reason, once, with an audit entry from «system».
async function enforceStreamPolicy() {
  for (const [id, c] of campaigns) {
    let changed = false;
    const streams = (c.streams || []).map((s) => {
      const found = s.conditions && !disabledByPolicy(s) ? cloakingCondition(s.conditions) : null;
      if (!found) return s;
      changed = true;
      return { ...s, enabled: false, disabledBy: 'policy', disabledReason: cloakingMessage(s.name, found), _wasEnabled: s.enabled !== false };
    });
    if (!changed) continue;
    for (const s of streams.filter((x) => '_wasEnabled' in x)) {
      console.warn(`[policy] campaign ${id}: stream «${s.name || ''}» switched off — ${s.disabledReason}`);
      await event('audit', { actor: 'system', action: 'disable_stream', entity: 'campaign', entityId: id,
        changes: { stream: [null, s.name ?? null], enabled: [s._wasEnabled, false], reason: [null, s.disabledReason] } });
    }
    campaigns.set(id, { ...c, streams: streams.map(({ _wasEnabled, ...s }) => s) });
    await persistCampaign(id, campaigns.get(id));
  }
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
// A torn last line (crash or full disk in the middle of an append) would swallow the next event: before the first
// append (and after a failed one) the journal is checked and a newline is written when it does not end with one.
let journalTailChecked = false;
async function event(type, payload) {
  await mkdir(dataDir, { recursive: true });
  return journalGate.shared(async () => {
    const record = { id: randomUUID(), type, at: new Date().toISOString(), ...payload };
    let line = `${JSON.stringify(record)}\n`;
    if (!journalTailChecked) {
      if (!(await endsWithNewline(eventsFile))) { line = `\n${line}`; console.warn('[journal] last line was incomplete; it is kept and skipped by readers'); }
      journalTailChecked = true;
    }
    try { await appendFile(eventsFile, line, { mode: DATA_FILE_MODE }); }
    catch (error) { journalTailChecked = false; throw error; }
    indexedBytes += Buffer.byteLength(line);
    journalIndex.observe(record);
    // `mirrored` settles once PostgreSQL has the event (null without a database).
    return { mirrored: eventMirror?.enqueue(record) ?? null };
  });
}

// Removes events from the journal and the matching rows from PostgreSQL. New events wait meanwhile;
// the mirror is drained first so a queued insert cannot bring a deleted row back.
async function removeStats(plan, deleteRows) {
  const result = await journalGate.rewrite(async () => {
    // A reconciliation running on the old journal must not bring deleted rows back: stopped and held off meanwhile.
    await reconciler.pause();
    try {
      await eventMirror?.drain();
      let postgres = null;
      const counts = await filterJournal(eventsFile, plan, async () => { if (db) postgres = await deleteRows(db); });
      await buildJournalIndex();
      return { ...counts, postgres };
    } finally { reconciler.resume(); }
  });
  clickCounters.clear();
  for (const offerId of offers.keys()) conversionCaps.invalidate(offerId);
  revenueCache.clear();
  recentConversions.clear();
  return result;
}

// Reconciliation of PostgreSQL with the journal (src/reconcile.js): at startup (whole journal) and every
// RECONCILE_INTERVAL_MS (default 15 min; 0 = off) for the events appended since the previous successful run.
// Events in the journal before a run's snapshot have finished mirroring (flush) before the run compares them.
const reconcileIntervalMs = Math.max(0, Number(process.env.RECONCILE_INTERVAL_MS ?? 900000) || 0);
const reconciler = (() => {
  let watermark = 0; // journal lines (complete JSON objects) already reconciled
  let running = null;
  let paused = 0;
  let last = null;
  async function run({ full = false } = {}) {
    if (!db || paused) return null;
    if (running) return running;
    running = (async () => {
      const from = full ? 0 : watermark;
      const started = Date.now();
      try {
        // Streams the journal: memory is bounded by the window of new events, not by the journal size.
        const { counts, total } = await reconcileJournal({ db, eventsFile, from, shouldStop: () => paused > 0, beforeCompare: async () => { await eventMirror?.flush(); } });
        watermark = total;
        const replayed = Object.values(counts).reduce((a, b) => a + b, 0);
        last = { at: new Date().toISOString(), ok: true, replayed };
        if (replayed) console.log(`[reconcile] PostgreSQL was missing journal data, replayed: ${JSON.stringify(counts)} (${Date.now() - started} ms)`);
        return counts;
      } catch (error) {
        last = { at: new Date().toISOString(), ok: false, replayed: 0 };
        if (!(error instanceof ReconcileStopped)) console.warn('[reconcile] failed, will retry:', error.message);
        return null;
      }
    })().finally(() => { running = null; });
    return running;
  }
  // Stops a running reconciliation (between batches) and holds new runs off until resume();
  // the next run covers the whole rewritten journal.
  async function pause() {
    paused += 1;
    await running;
  }
  function resume() { paused -= 1; watermark = 0; }
  return { run, pause, resume, status: () => last };
})();

// RETENTION_DAYS=N: daily removal of unconverted clicks, their landing clicks, bot events and postback journal entries
// older than N days.
const retentionDays = Number.parseInt(process.env.RETENTION_DAYS || '', 10);
async function runRetention() {
  const cutoff = new Date(Date.now() - retentionDays * 86400000);
  const removed = await removeStats(retentionPlan(cutoff.getTime()), (pool) => retentionRows(pool, cutoff.toISOString()));
  console.log(`[retention] older than ${cutoff.toISOString()}: removed ${removed.clicks} clicks, ${removed.lpClicks} lp clicks, ${removed.bots} bots, ${removed.postbacks} postbacks from the journal`
    + (removed.postgres ? `; PostgreSQL: ${removed.postgres.clicks} clicks, ${removed.postgres.bots} bots, ${removed.postgres.postbacks} postbacks` : ''));
  await event('audit', { actor: 'system', action: 'retention', entity: 'stats', entityId: 'retention',
    changes: { days: [null, retentionDays], clicks: [null, removed.clicks], lpClicks: [null, removed.lpClicks], bots: [null, removed.bots], postbacks: [null, removed.postbacks] } });
  return removed;
}

async function stats({ campaign = null, allowed = null, from = null, to = null, subid = null, country = null, offer = null, stream = null, currency = rates.defaultCurrency, tz = null } = {}) {
  const range = dayRange(from, to, tz);
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw Object.assign(new Error('invalid_from_date'), { statusCode: 400 });
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw Object.assign(new Error('invalid_to_date'), { statusCode: 400 });

  // PG path — groups by campaign+country+offer_id in one query to produce byCampaign, byCountry, byOffer
  if (db) {
    try {
      const conditions = [];
      const params = [];
      if (campaign) { params.push(campaign); conditions.push(`c.campaign = $${params.length}`); }
      if (allowed) { params.push(allowed); conditions.push(`c.campaign = ANY($${params.length}::text[])`); }
      if (from) { params.push(range.fromIso); conditions.push(`c.created_at >= $${params.length}`); }
      if (to) { params.push(range.toIso); conditions.push(`c.created_at < $${params.length}`); }
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
          ${fx.sum('conversions')}::int           AS conversions,
          (${fx.sum('revenue')} + ${fx.clickRevenue})::float AS revenue,
          ${fx.sum('leads')}::int                 AS leads,
          ${fx.sum('sales')}::int                 AS sales,
          ${fx.sum('rejected')}::int              AS rejected,
          ${fx.sum('trash')}::int                 AS trash,
          ${fx.sum('pending')}::float AS pending_revenue,
          ${fx.cost}::float                       AS cost
        FROM clicks c
        ${fx.join}
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
    const lines = applyClickUpdates(await journalRecords(['click', 'conversion', 'lp_click', 'cost_update']));
    const { fromMs, toMs } = range;
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
      if (toMs !== null && (t === null || t >= toMs)) return false;
      return true;
    });
    const visibleClickIds = new Set(clicks.map((c) => c.clickId));
    const conversions = [...latestConversions(lines).values()].filter((item) => visibleClickIds.has(item.clickId));
    const lpClicked = new Set(lines.filter((item) => item.type === 'lp_click').map((item) => item.clickId));
    // Amounts in the report currency, for the totals and for bySource/byNetwork alike.
    const reportClicks = clicks.map((c) => convertClickCost(lpClicked.has(c.clickId) ? { ...c, lpClicked: true } : c, currency));
    const reportConversions = conversions.map((cv) => convertConversion(cv, currency));
    const conversionByClick = conversionsByClick(reportConversions);
    const report = { ...reportFromEvents(reportClicks, reportConversions), currency };
    report.bySource = Object.create(null); report.byNetwork = Object.create(null);
    for (const click of reportClicks) { const source = campaigns.get(click.campaign)?.sourceId || 'none'; const network = offers.get(click.offerId)?.networkId || 'none'; const one = reportFromEvents([click], conversionByClick.get(click.clickId) || []); for (const [key,id] of [['bySource',source],['byNetwork',network]]) { report[key][id] ||= { clicks:0, conversions:0, revenue:0, cost:0, uniqueClicks:0 }; for (const f of ['clicks','conversions','revenue','cost','uniqueClicks','leads','sales','rejected','trash','pendingRevenue']) report[key][id][f] = (report[key][id][f] || 0) + (one[f] || 0); } }
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
async function paramReport({ field, campaign, allowed = null, from, to, currency = rates.defaultCurrency, tz = null }) {
  const range = dayRange(from, to, tz);
  const isColumn = DIMENSION_FIELDS.includes(field);
  if (db) {
    try {
      const conditions = []; const values = isColumn ? [] : [field];
      if (campaign) { values.push(campaign); conditions.push(`c.campaign = $${values.length}`); }
      if (allowed) { values.push(allowed); conditions.push(`c.campaign = ANY($${values.length}::text[])`); }
      if (from) { values.push(range.fromIso); conditions.push(`c.created_at >= $${values.length}`); }
      if (to) { values.push(range.toIso); conditions.push(`c.created_at < $${values.length}`); }
      const fx = sqlFx(values, currency);
      const { rows } = await db.query(`
        SELECT ${isColumn ? `COALESCE(c.${field}, '')` : "COALESCE(c.params->>$1, '')"} AS value, COUNT(c.click_id)::int AS clicks, COUNT(c.click_id) FILTER (WHERE c.is_unique_campaign IS DISTINCT FROM false)::int AS unique_clicks, ${fx.sum('conversions')}::int AS conversions,
          (${fx.sum('revenue')} + ${fx.clickRevenue})::float AS revenue, ${fx.cost}::float AS cost
        FROM clicks c ${fx.join}
        ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
        GROUP BY 1 ORDER BY clicks DESC LIMIT 500`, values);
      // Same fields as the JSONL rows below (uniqueClicks only, no SQL alias).
      return rows.map(({ unique_clicks: uniqueClicks, ...row }) => metrics({ ...row, uniqueClicks }));
    } catch (e) { console.warn('[db] paramReport fallback:', e.message); }
  }
  let lines = [];
  lines = await journalRecords(['click', 'conversion', 'cost_update']);
  const { fromMs, toMs } = range;
  lines = applyClickUpdates(lines);
  const conv = conversionsByClick(latestConversions(lines).values());
  const groups = new Map();
  for (const click of lines) {
    if (click.type !== 'click' || (campaign && click.campaign !== campaign) || (allowed && !allowed.includes(click.campaign))) continue;
    const t = Date.parse(click.at);
    if ((fromMs !== null && t < fromMs) || (toMs !== null && t >= toMs)) continue;
    const key = (isColumn ? click[field] : click.params?.[field]) ?? '';
    const g = groups.get(key) || { value: key, clicks: 0, uniqueClicks: 0, conversions: 0, revenue: 0, cost: 0 };
    g.clicks += 1; if (click.uniqueCampaign !== false) g.uniqueClicks += 1; g.cost += (Number(click.cost) || 0) * rates.factor(rates.defaultCurrency, currency);
    g.revenue += (Number(click.revenue) || 0) * rates.factor(rates.defaultCurrency, currency);
    for (const cv of conv.get(click.clickId) || []) if (conversionCounts(cv)) { g.conversions += 1; g.revenue += saleRevenue(cv) * rates.factor(cv.currency, currency); }
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
  return { url: url.slice(0, 2048), name, ownerId: parseOwnerId(raw?.ownerId) };
}

async function loadLandings() {
  if (db) {
    try {
      const { rows } = await db.query('SELECT id, url, name, owner_id FROM landings');
      for (const row of rows) { const l = OFFER_ID_RE.test(row.id) && parseLanding({ ...row, ownerId: row.owner_id }); if (l) landings.set(row.id, l); }
      return;
    } catch (error) { console.warn('[db] landings load fallback:', error.message); }
  }
  try {
    for (const [id, raw] of Object.entries(JSON.parse(await readFile(landingsFile, 'utf8')))) { const l = OFFER_ID_RE.test(id) && parseLanding(raw); if (l) landings.set(id, l); }
  } catch (error) { if (error.code !== 'ENOENT') console.warn('[landings] invalid config ignored'); }
}

async function persistLanding(id, landing) {
  if (db) await db.query('INSERT INTO landings (id, url, name, owner_id) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, name = EXCLUDED.name, owner_id = EXCLUDED.owner_id', [id, landing.url, landing.name, landing.ownerId ?? null]);
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
// /health is public: the database check is shared by concurrent requests and cached for 2 s.
let healthDb = { at: 0, value: null, pending: null };
async function healthDbState() {
  if (!db) return process.env.DATABASE_URL ? 'down' : null;
  if (Date.now() - healthDb.at < 2000) return healthDb.value;
  healthDb.pending ||= dbStatus(1500).then((value) => { healthDb = { at: Date.now(), value, pending: null }; return value; });
  return healthDb.pending;
}
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

// Full click record for /lp/click. PostgreSQL first. A missing row is answered from PostgreSQL alone (after the
// mirror's queued inserts are flushed): /lp/click is public, and scanning the whole JSONL journal for every
// unknown click id would let anyone load the server. The journal is read only when the query itself fails or
// when this click's mirror insert failed (unmirroredClicks).
async function getClickRecord(clickId) {
  if (db) {
    try {
      const select = async () => {
        const { rows } = await db.query('SELECT campaign, offer_id, landing_id, subid, country, params, cost FROM clicks WHERE click_id = $1', [clickId]);
        const r = rows[0];
        return r ? { campaign: r.campaign, offerId: r.offer_id, landingId: r.landing_id, subid: r.subid, country: r.country, params: r.params, cost: Number(r.cost) || 0 } : null;
      };
      let found = await select();
      if (!found && eventMirror) { await eventMirror.flush(); found = await select(); }
      if (found) return found;
      if (!unmirroredClicks.has(clickId)) return null;
    } catch (e) { console.warn('[db] getClickRecord fallback:', e.message); }
  }
  return journalClick(clickId);
}

// A click from the journal index; only a click older than the index (CLICK_INDEX_LIMIT) is streamed from the file.
async function journalClick(clickId) {
  let cached = journalIndex.click(clickId);
  if (cached) return { ...cached };
  if (await syncJournalIndex()) { cached = journalIndex.click(clickId); if (cached) return { ...cached }; }
  if (journalIndex.complete) return null;
  let found = null;
  try { found = await lookupOldClick(clickId); } catch { /* non-fatal */ }
  if (!found) return null;
  journalIndex.remember(clickId, found);
  return { ...journalIndex.click(clickId) };
}

async function getClickData(clickId) {
  if (db) {
    try {
      const { rows } = await db.query('SELECT offer_id, campaign, created_at FROM clicks WHERE click_id = $1', [clickId]);
      if (rows.length) return { offerId: rows[0].offer_id, campaign: rows[0].campaign, at: new Date(rows[0].created_at).toISOString() };
    } catch (e) { console.warn('[db] getClickData fallback:', e.message); }
  }
  const click = await journalClick(clickId);
  return click ? { offerId: click.offerId, campaign: click.campaign, at: click.at } : null;
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
  if (isPanelPath(path) || isDemoPath(path) || path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/') || path === '/stats' || path.startsWith('/stats/') || path.startsWith('/assets/')) {
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
  }
  if (isPanelPath(path) || isDemoPath(path) || path === '/admin' || path.startsWith('/admin/')) res.setHeader('content-security-policy', ADMIN_CSP);
}

function json(res, status, body) {
  if (res.revenueFilter) body = stripRevenue(body, res.revenueFilter.urls);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// Postback journals (G7). Stored URLs never keep credentials: user:password@ is dropped and the values of
// secret/token/password/key/signature-like parameters are replaced, so the log can be shown to buyers.
const CREDENTIAL_PARAM = /secret|token|passw|^pass$|^pwd$|auth|signature|^sig$|^sign$|api_?key|^key$|_key$|hash|credential/i;
function redactUrl(raw) {
  try {
    const u = new URL(raw, 'http://localhost');
    u.username = ''; u.password = '';
    for (const name of new Set(u.searchParams.keys())) if (CREDENTIAL_PARAM.test(name)) u.searchParams.set(name, '***');
    return (/^https?:\/\//i.test(raw) ? u.toString() : u.pathname + u.search).slice(0, 2048);
  } catch { return null; }
}
async function logPostback(type, payload) {
  try { await event(type, payload); } catch (error) { console.warn('[postbacks] journal not written:', error.message); }
}
// Outgoing S2S postback: up to 3 attempts (network error, 5xx or 429), pause S2S_RETRY_MS × attempt; every attempt is logged.
// Sent by the hardened sender of src/source-postback.js (SSRF guard): https only, every resolved address must be
// public and is pinned for the connection, redirects are not followed. A refusal is final and journaled.
const S2S_ATTEMPTS = 3;
const s2sRetryMs = Number.isFinite(Number(process.env.S2S_RETRY_MS)) && process.env.S2S_RETRY_MS !== '' ? Number(process.env.S2S_RETRY_MS) : 2000;
async function deliverS2s(s2sUrl, meta, send = sendPostback) {
  const result = await deliverWithRetry(async (attempt) => {
    let outcome;
    if (!s2sUrl) outcome = { httpStatus: null, error: 'unsafe_destination', noRetry: true };
    else if (!s2sAllowPrivate && !/^https:\/\//i.test(s2sUrl)) outcome = { httpStatus: null, error: 'invalid_scheme', noRetry: true };
    else outcome = await send(s2sUrl, { allowPrivate: s2sAllowPrivate, timeoutMs: 10000 });
    const error = outcome.error && /^http_\d+$/.test(outcome.error) ? `HTTP ${outcome.httpStatus}` : (outcome.error ? String(outcome.error).slice(0, 300) : null);
    await logPostback('postback_out', { ...meta, url: s2sUrl ? redactUrl(s2sUrl) : null, statusCode: outcome.httpStatus, error, attempt });
    return { ...outcome, error };
  }, { attempts: S2S_ATTEMPTS, backoffMs: s2sRetryMs });
  if (result.error) console.warn('[s2s] postback failed:', result.error, `(attempt ${result.attempts})`);
  return result;
}
// Postbacks that change nothing (wrong secret 401, unknown or malformed click 404/400, repeated status 200 «duplicate»):
// the first one per IP, response and minute is journaled as usual, the rest only counted; at the end of the minute the count
// is journaled as one event («invalid_postback_secret ×N more»). A flood with a leaked secret cannot grow the journal.
const rejectedPostbacks = (() => {
  const windows = new Map();
  const flush = (all = false) => {
    const now = Date.now(), writes = [];
    for (const [key, w] of windows) {
      if (!all && now - w.since < 60000) continue;
      windows.delete(key);
      if (w.suppressed) writes.push(logPostback('postback_in', { clickId: null, campaign: null, offerId: null, tid: null, status: null, revenue: null, currency: null,
        url: null, statusCode: w.statusCode, error: `${w.reason} ×${w.suppressed} more`, ip: w.ip === 'unknown' || w.ip === 'other' ? null : w.ip }));
    }
    return Promise.all(writes);
  };
  setInterval(flush, 60000).unref();
  return {
    // true → journal this one; false → counted only.
    note(ip, statusCode = 401, reason = 'invalid_postback_secret') {
      const now = Date.now();
      const key = `${ip}|${statusCode}|${reason}`;
      const w = windows.get(key);
      if (w && now - w.since < 60000) { w.suppressed += 1; return false; }
      if (w) flush();
      if (windows.size >= 10000) {
        const otherKey = `other|${statusCode}|${reason}`;
        const other = windows.get(otherKey) || { since: now, suppressed: 0, ip: 'other', statusCode, reason };
        other.suppressed += 1; windows.set(otherKey, other); return false;
      }
      windows.set(key, { since: now, suppressed: 0, ip, statusCode, reason });
      return true;
    },
    flush,
  };
})();
// GET /api/postbacks: PostgreSQL first, the JSONL journal as fallback. Newest first.
async function readPostbacks({ direction, campaign, allowed, from, to, limit }) {
  const fromMs = from ? Date.parse(`${from}T00:00:00Z`) : null;
  const toMs = to ? Date.parse(dayEndIso(to)) : null;
  if (db) {
    try {
      const conditions = ['direction = $1'], values = [direction];
      const add = (sql, value) => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
      if (campaign) add('campaign = ?', campaign);
      if (allowed) add('campaign = ANY(?::text[])', allowed);
      if (fromMs !== null) add('created_at >= ?', new Date(fromMs).toISOString());
      if (toMs !== null) add('created_at < ?', new Date(toMs).toISOString());
      values.push(limit);
      const { rows } = await db.query(`SELECT click_id, campaign, offer_id, tid, status, revenue, currency, url, status_code, error, attempt, ip, created_at
        FROM postbacks WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${values.length}`, values);
      return { storage: 'postgres', postbacks: rows.map((r) => ({ at: new Date(r.created_at).toISOString(), direction, clickId: r.click_id, campaign: r.campaign, offerId: r.offer_id,
        tid: r.tid, status: r.status, revenue: r.revenue, currency: r.currency, url: r.url, statusCode: r.status_code, error: r.error, attempt: r.attempt, ip: r.ip })) };
    } catch (error) { console.warn('[db] postbacks fallback:', error.message); }
  }
  // Streamed oldest → newest; only the newest `limit` matches are kept.
  const type = `"postback_${direction}"`;
  const items = [];
  await journalScans.run(() => scanJournalLines(eventsFile, (line) => {
    if (!line.includes(type)) return;
    let item; try { item = JSON.parse(line); } catch { return; }
    if (item?.type !== `postback_${direction}`) return;
    if (campaign && item.campaign !== campaign) return;
    if (allowed && !allowed.includes(item.campaign)) return;
    const t = Date.parse(item.at);
    if ((fromMs !== null && !(t >= fromMs)) || (toMs !== null && !(t < toMs))) return;
    items.push(item);
    if (items.length > limit * 2) items.splice(0, items.length - limit);
  }));
  const out = [];
  for (let i = items.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const item = items[i];
    out.push({ at: item.at, direction, clickId: item.clickId ?? null, campaign: item.campaign ?? null, offerId: item.offerId ?? null, tid: item.tid ?? null,
      status: item.status ?? null, revenue: item.revenue ?? null, currency: item.currency ?? null, url: item.url ?? null, statusCode: item.statusCode ?? null,
      error: item.error ?? null, attempt: item.attempt ?? null, ip: item.ip ?? null });
  }
  return { storage: 'jsonl', postbacks: out };
}

// Manual cost update (G8). Matching clicks: campaign, local dates from..to in tz, optional offer/stream/tracked-parameter
// filters (source, sub_id_N, ad_campaign_id, …), optionally unique clicks only. Bots are never clicks, so they get no cost.
// The amount (in `currency`) is converted to DEFAULT_CURRENCY and split equally; the last click takes the rounding
// remainder, so the sum is exact.
const COST_FILTERS = ['offer', 'stream', ...TRACK_FIELDS];
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const nextIsoDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
function costAmount(raw) {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e8 ? value : null;
}
function costCurrency(raw) {
  const value = raw === undefined || raw === null || raw === '' ? rates.defaultCurrency : String(raw).toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : null;
}
const costTz = (raw) => {
  const tz = raw === undefined || raw === null || raw === '' ? 'UTC' : raw;
  return typeof tz === 'string' && validTimeZone(tz) ? tz : null;
};

// The JSONL journal, read once per cost update or import (`cache` lives for one request).
async function cachedJournal(cache) {
  if (!cache.lines) {
    cache.lines = await journalRecords(['click', 'conversion', 'cost_update']);
  }
  return cache.lines;
}

// Click ids of the campaigns in [start, end) that match the filters, in time order.
async function matchCostClicks({ campaignIds, start, end, filters, uniqueOnly }, cache) {
  const paramFilters = Object.entries(filters).filter(([key]) => key !== 'offer' && key !== 'stream');
  if (db && !cache.dbFailed) {
    try {
      if (!cache.flushed) { await eventMirror?.flush(); cache.flushed = true; } // clicks still queued for PostgreSQL must be matched too
      const values = [campaignIds, new Date(start).toISOString(), new Date(end).toISOString()];
      const conditions = ['campaign = ANY($1::text[])', 'created_at >= $2', 'created_at < $3'];
      if (filters.offer) { values.push(filters.offer); conditions.push(`offer_id = $${values.length}`); }
      if (filters.stream) { values.push(filters.stream); conditions.push(`COALESCE(NULLIF(stream, ''), 'default') = $${values.length}`); }
      for (const [key, value] of paramFilters) { values.push(key, value); conditions.push(`params->>$${values.length - 1} = $${values.length}`); }
      if (uniqueOnly) conditions.push('is_unique_campaign');
      const { rows } = await db.query(`SELECT click_id FROM clicks WHERE ${conditions.join(' AND ')} ORDER BY created_at, click_id`, values);
      return rows.map((r) => String(r.click_id));
    } catch (error) { cache.dbFailed = true; console.warn('[db] cost update fallback:', error.message); }
  }
  if (!cache.clicks) cache.clicks = applyClickUpdates(await cachedJournal(cache)).filter((item) => item.type === 'click');
  return cache.clicks.filter((item) => {
    if (!campaignIds.includes(item.campaign)) return false;
    const t = Date.parse(item.at);
    if (!(t >= start && t < end)) return false;
    if (filters.offer && item.offerId !== filters.offer) return false;
    if (filters.stream && (item.stream || 'default') !== filters.stream) return false;
    if (paramFilters.some(([key, value]) => item.params?.[key] !== value)) return false;
    return !uniqueOnly || item.uniqueCampaign !== false;
  }).map((item) => item.clickId);
}

// One cost_update event: `total` split equally over the clicks, the remainder on the last one. Answers once
// PostgreSQL has the new costs too, so a report right after the update shows them.
async function writeCostSplit({ campaignIds, clickIds, total, importKey }) {
  const perClick = clickIds.length ? Math.floor(total * 1e6 / clickIds.length) / 1e6 : 0;
  const lastCost = clickIds.length ? round6(total - perClick * (clickIds.length - 1)) : 0;
  const { mirrored } = await event('cost_update', { campaign: campaignIds[0], ...(campaignIds.length > 1 ? { campaigns: campaignIds } : {}), clickIds, cost: perClick,
    ...(clickIds.length && lastCost !== perClick ? { lastClickId: clickIds.at(-1), lastCost } : {}),
    ...(importKey ? { importKey, importCost: total } : {}) });
  await mirrored;
  return perClick;
}

async function updateCosts(body, req) {
  const campaignId = String(body?.campaign || '');
  const campaign = campaigns.get(campaignId);
  if (!campaign) return { status: 404, error: 'campaign_not_found' };
  if (!canEditCampaign(req, campaign)) return { status: 403, error: 'campaign_not_yours' };
  const from = isoDate(body.from), to = isoDate(body.to);
  if (!from || !to) return { status: 400, error: 'from_and_to_dates_required' };
  if (to < from) return { status: 400, error: 'invalid_date_range' };
  const tz = costTz(body.tz);
  if (!tz) return { status: 400, error: 'invalid_tz' };
  const amount = costAmount(body.amount);
  if (amount === null) return { status: 400, error: 'invalid_amount' };
  const currency = costCurrency(body.currency);
  if (!currency) return { status: 400, error: 'invalid_currency' };
  const rawFilters = body.filters ?? {};
  if (typeof rawFilters !== 'object' || Array.isArray(rawFilters)) return { status: 400, error: 'invalid_filters' };
  const filters = {};
  for (const [key, value] of Object.entries(rawFilters)) {
    if (!COST_FILTERS.includes(key)) return { status: 400, error: 'invalid_filter', filter: key };
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string' || value.length > 255) return { status: 400, error: 'invalid_filter', filter: key };
    filters[key] = value;
  }
  const uniqueOnly = body.uniqueOnly === true;
  const clickIds = await matchCostClicks({ campaignIds: [campaignId], start: zonedDayStart(from, tz), end: zonedDayStart(nextIsoDay(to), tz), filters, uniqueOnly }, {});
  const total = round6(amount * rates.factor(currency, rates.defaultCurrency));
  const result = { ok: true, campaign: campaignId, from, to, tz, amount, currency, cost: total, costCurrency: rates.defaultCurrency, updated: clickIds.length };
  if (!clickIds.length) return { ...result, perClick: 0 };
  const perClick = await writeCostSplit({ campaignIds: [campaignId], clickIds, total });
  await audit(req, 'update', 'costs', campaignId, null, { amount, currency, from, to, tz, clicks: clickIds.length, perClick,
    filters: Object.keys(filters).length ? JSON.stringify(filters) : null, uniqueOnly });
  return { ...result, perClick };
}

// Spend import (e.g. a Facebook Ads Manager CSV parsed in /admin). Each row {date, id, amount, currency} is a cost update
// of the chosen campaign(s) for that local day (tz), filtered by `param` = id (sub_id_2 = ad set id, …).
// Idempotency: the import key `campaigns|param|id|date` is stored on the cost_update event (and in cost_imports in
// PostgreSQL). Re-importing the same key replaces the previous import: its clicks get the new split, and clicks it
// had but that no longer match are reset to 0 — so the spend is never counted twice. Rows of one request with the same
// key are summed (e.g. an export broken down by placement).
const COST_IMPORT_MAX_ROWS = 5000;
async function previousCostImports(keys, cache) {
  const found = new Map();
  if (!keys.length) return found;
  if (db) {
    try {
      const { rows } = await db.query('SELECT import_key, click_ids FROM cost_imports WHERE import_key = ANY($1::text[])', [keys]);
      for (const row of rows) found.set(row.import_key, (row.click_ids || []).map(String));
      return found;
    } catch (error) { console.warn('[db] cost import lookup fallback:', error.message); }
  }
  const wanted = new Set(keys);
  for (const item of await cachedJournal(cache)) if (item.type === 'cost_update' && wanted.has(item.importKey)) found.set(item.importKey, item.clickIds || []);
  return found;
}

async function importCosts(body, req) {
  const rawCampaigns = Array.isArray(body?.campaign) ? body.campaign : Array.isArray(body?.campaigns) ? body.campaigns : [body?.campaign];
  const campaignIds = [...new Set(rawCampaigns.filter((c) => typeof c === 'string' && c))].sort();
  if (!campaignIds.length || campaignIds.length > 50) return { status: 400, error: 'campaign_required' };
  for (const id of campaignIds) {
    if (!campaigns.has(id)) return { status: 404, error: 'campaign_not_found' };
    if (!canEditCampaign(req, campaigns.get(id))) return { status: 403, error: 'campaign_not_yours' };
  }
  const param = String(body.param || '');
  if (!TRACK_FIELDS.includes(param)) return { status: 400, error: 'invalid_param' };
  const tz = costTz(body.tz);
  if (!tz) return { status: 400, error: 'invalid_tz' };
  if (!Array.isArray(body.rows) || !body.rows.length) return { status: 400, error: 'rows_required' };
  if (body.rows.length > COST_IMPORT_MAX_ROWS) return { status: 400, error: 'too_many_rows' };
  const uniqueOnly = body.uniqueOnly === true;

  const results = body.rows.map((row, index) => {
    const rawId = typeof row?.id === 'number' ? String(row.id) : typeof row?.id === 'string' ? row.id.trim() : '';
    const out = { row: index, date: typeof row?.date === 'string' ? row.date : null, id: rawId, amount: costAmount(row?.amount), currency: costCurrency(row?.currency), clicks: 0, cost: 0 };
    if (!isoDate(row?.date)) return { ...out, error: 'invalid_date' };
    if (!rawId || rawId.length > 255) return { ...out, error: 'invalid_id' };
    if (out.amount === null) return { ...out, error: 'invalid_amount' };
    if (!out.currency) return { ...out, error: 'invalid_currency' };
    return out;
  });
  const groups = new Map();
  for (const row of results) {
    if (row.error) continue;
    row.cost = round6(row.amount * rates.factor(row.currency, rates.defaultCurrency));
    const key = `${campaignIds.join(',')}|${param}|${row.id}|${row.date}`;
    if (groups.has(key)) groups.get(key).push(row); else groups.set(key, [row]);
  }
  const cache = {};
  const previous = await previousCostImports([...groups.keys()], cache);
  for (const [key, rows] of groups) {
    const { date, id } = rows[0];
    const clickIds = await matchCostClicks({ campaignIds, start: zonedDayStart(date, tz), end: zonedDayStart(nextIsoDay(date), tz), filters: { [param]: id }, uniqueOnly }, cache);
    const before = previous.get(key);
    const fresh = new Set(clickIds);
    const stale = (before || []).filter((clickId) => !fresh.has(clickId));
    if (stale.length) {
      const { mirrored } = await event('cost_update', { campaign: campaignIds[0], clickIds: stale, cost: 0, importReset: key });
      await mirrored;
    }
    // Recorded even without clicks when the key was imported before, so the next import knows there is nothing to reset.
    if (clickIds.length || before) await writeCostSplit({ campaignIds, clickIds, total: clickIds.length ? round6(rows.reduce((t, r) => t + r.cost, 0)) : 0, importKey: key });
    for (const row of rows) {
      row.clicks = clickIds.length;
      if (before) row.replaced = true;
      if (rows.length > 1) row.merged = rows.length;
      if (!clickIds.length) row.error = 'no_matching_clicks';
    }
  }
  const applied = results.filter((r) => !r.error);
  const summary = { rows: results.length, applied: applied.length, failed: results.length - applied.length,
    clicks: [...groups.values()].reduce((t, rows) => t + (rows[0].error ? 0 : rows[0].clicks), 0), cost: round6(applied.reduce((t, r) => t + r.cost, 0)) };
  await audit(req, 'import', 'costs', campaignIds.join(','), null, { ...summary, param, tz, uniqueOnly });
  return { ok: true, campaigns: campaignIds, param, tz, costCurrency: rates.defaultCurrency, ...summary, results };
}

const sourcePostbacks = createSourcePostbacks({
  targetFor: (click) => { const c = campaigns.get(click.campaign); return resolveSourcePostback(c, c?.sourceId ? sources.get(c.sourceId) : null); },
  loadClick: getClickRecord,
  alreadySent: async (clickId, status) => journalIndex.hasSourcePostback(clickId, status),
  record: (payload) => event('source_postback', payload),
  allowPrivate: sourcePostbackAllowPrivate,
  onError: (error) => console.warn('[source-postback] failed:', error.message),
});

// Latest conversion per (click, tid) recorded by this process, consulted before PostgreSQL: the mirror is asynchronous
// (and may have failed), so a PostgreSQL row can still hold an older status — a repeated sale would then be taken for an
// update and the S2S postbacks sent twice. Older conversions: wait for the click's queued mirror writes, then read
// PostgreSQL (kept in line with the journal by the reconciliation job), then the journal.
const recentConversions = new Map();
const RECENT_CONVERSIONS_MAX = 50000;
function rememberConversion(payload) {
  const key = `${payload.clickId}|${payload.tid || ''}`;
  recentConversions.delete(key);
  recentConversions.set(key, { status: payload.status || 'sale', revenue: payload.revenue ?? null, currency: payload.currency ?? null });
  if (recentConversions.size > RECENT_CONVERSIONS_MAX) recentConversions.delete(recentConversions.keys().next().value);
}

const recordPostback = createConversionRecorder({
  findClick: getClickData,
  hasConversion: (clickId, tid) => hasRecordedConversion({ clickId, tid, eventsFile, db, journal: journalIndex,
    onFallback: (error) => console.warn('[db] hasConversion fallback:', error.message) }),
  currentConversion: async (clickId, tid) => {
    const recent = recentConversions.get(`${clickId}|${tid}`);
    if (recent) return recent;
    await eventMirror?.settledFor(clickId);
    return findRecordedConversion({ clickId, tid, eventsFile, db, journal: journalIndex,
      onFallback: (error) => console.warn('[db] currentConversion fallback:', error.message) });
  },
  windowDaysForClick: (click) => campaigns.get(click.campaign)?.conversionWindowDays,
  // A postback without revenue earns the CPA offer's payout (CPC offers are paid per click, not here).
  defaultRevenue: (click) => {
    const offer = offers.get(click.offerId);
    return offer?.payoutType === 'cpa' && offer.payout !== null && offer.payout !== undefined
      ? { revenue: String(offer.payout), currency: offer.payoutCurrency } : null;
  },
  // CPC offers: revenue comes only from clicks; a postback still sets the status, its amount is kept but not counted.
  ignoreRevenue: (click) => offers.get(click.offerId)?.payoutType === 'cpc',
  record: async (payload) => { const recorded = await event('conversion', payload); rememberConversion(payload); return recorded; },
  onRecorded: ({ click, clickId, tid, revenue, currency, status, previousStatus, recorded }) => {
    // Recount the offer's conversion cap and the campaign's revenue cap now and again once PostgreSQL has the conversion.
    if (click.offerId) conversionCaps.invalidate(click.offerId, recorded?.mirrored);
    if (click.campaign) invalidateRevenue(click.campaign, recorded?.mirrored);
    // Postback to the traffic source: fire-and-forget, never delays the /postback response.
    sourcePostbacks.dispatch({ clickId, status: status || 'sale', revenue, currency, previousStatus, click });
    const offer = offers.get(click.offerId);
    if (!offer?.postbackUrl) return;
    const s2sUrl = expandUrl(offer.postbackUrl, { click_id: clickId, tid: tid ?? '', revenue: revenue ?? '', currency: currency ?? '', status: status || 'sale' });
    deliverS2s(s2sUrl, { clickId, campaign: click.campaign ?? null, offerId: click.offerId ?? null, tid: tid || null, status: status || 'sale' })
      .catch((error) => console.warn('[s2s] postback failed:', error.message));
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

// Panel pages (src/panel-routes.js) are not private: the shell loads without a session and shows /login.
const isPrivatePath = (p) => (p.startsWith('/api/') && !p.startsWith('/api/auth/')) || p === '/stats' || p.startsWith('/stats/') || p.startsWith('/assets/');

async function readJson(req, maxBytes = 64 * 1024) {
  // Already read by the hideRevenue write check (with the largest route limit); the route's own limit still applies.
  if (req.jsonBody !== undefined) {
    if (req.jsonBodyBytes > maxBytes) throw Object.assign(new Error('request_too_large'), { statusCode: 413 });
    return req.jsonBody;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('request_too_large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  req.jsonBodyBytes = size;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid_json'), { statusCode: 400 }); }
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
// Names of postback parameters (a network's payoutParam) are configuration, not amounts.
const isRevenueKey = (k) => REVENUE_KEY.test(k) && !/Param$/.test(k);
// urls mode also drops destination URLs: offer/postback URLs and the landing URL in /api/simulate.
const URL_KEY = /^(url|postbackUrl|landing)$/;
function stripRevenue(value, urls) {
  if (Array.isArray(value)) return value.map((v) => stripRevenue(v, urls));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !isRevenueKey(k) && !(urls && URL_KEY.test(k))).map(([k, v]) => [k, stripRevenue(v, urls)]));
}
// Every /api/* and /stats* JSON response is filtered for a hideRevenue user (so a new endpoint cannot leak revenue,
// revenueCap or the team's revenue/profit goals by default). Not filtered: the account/user/key routes, whose
// payload carries the permission flags themselves (hideRevenue would match REVENUE_KEY).
const REVENUE_FILTER_EXEMPT = (path) => path.startsWith('/api/auth/') || path === '/api/users' || path.startsWith('/api/users/')
  || path === '/api/keys' || path.startsWith('/api/keys/') || path === '/api/security';
// urls: also drop offer/postback/landing URLs (postback journals: the URLs carry revenue/payout values).
function revenueFilterFor(path) {
  if (path === '/api/offers' || path.startsWith('/api/offers/') || path === '/api/audit' || path === '/api/simulate' || path === '/api/monitor' || path === '/api/postbacks') return { urls: true };
  if ((path.startsWith('/api/') && !REVENUE_FILTER_EXEMPT(path)) || path === '/stats' || path.startsWith('/stats/')) return { urls: false };
  return null;
}
// Top-level body fields a hideRevenue user may not write: payout, payoutType, payoutCurrency, revenueCap,
// dailyRevenueGoal, dailyProfitGoal… (every key the filter hides from them, even null to clear a value).
const revenueWriteFields = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).filter(isRevenueKey) : []);
// Offer and landing ids referenced by streams (conditional and legacy flat streams).
function streamRefs(streams) {
  const refs = { offers: new Set(), landings: new Set() };
  for (const st of streams || []) {
    (st.offers ? st.offers.map((o) => o.offerId) : st.offerId ? [st.offerId] : []).forEach((o) => refs.offers.add(o));
    (st.landings || []).forEach((l) => refs.landings.add(l.landingId));
  }
  return refs;
}
// offersAccess 'own': the user's own offers plus the offers used in the streams of campaigns the user can see
// (those are read-only unless the user owns them); null = no restriction.
function visibleOfferIds(req) {
  if (!restrictedUser(req) || req.user.offersAccess !== 'own') return null;
  const allowed = scopeCampaigns(req);
  const ids = new Set([...offers].filter(([, o]) => o.ownerId === req.user.id).map(([id]) => id));
  for (const [id, c] of campaigns) {
    if (allowed && !allowed.includes(id)) continue;
    streamRefs(c.streams).offers.forEach((o) => ids.add(o));
  }
  return ids;
}
// Ownership of offers, landings, sources and networks. The owner, ADMIN_TOKEN and a fresh dev install manage everything;
// anyone else changes (edits, archives, clones) only entities whose ownerId is their own id. Team entities (ownerId null)
// and other users' entities are read-only for them.
const canManage = (req, entity) => !restrictedUser(req) || (Boolean(entity?.ownerId) && entity.ownerId === req.user.id);
// ownerId of a new entity: the creating user; the owner / ADMIN_TOKEN create team entities unless they name an owner.
const creatorOwnerId = (req, body) => (restrictedUser(req) ? req.user.id : parseOwnerId(body?.ownerId));
// The owner may reassign an entity (PATCH ownerId); everyone else keeps the current owner.
const nextOwnerId = (req, body, cur) => (!restrictedUser(req) && body?.ownerId !== undefined ? parseOwnerId(body.ownerId) : cur.ownerId ?? null);
// May the user send traffic to this offer? Team offers and their own ('own' access: only the offers visible to them).
function offerUsable(req, id, visible = visibleOfferIds(req)) {
  if (!restrictedUser(req)) return true;
  const offer = offers.get(id);
  if (!offer) return false;
  return visible ? visible.has(id) : !offer.ownerId || offer.ownerId === req.user.id;
}
function landingUsable(req, id) {
  if (!restrictedUser(req)) return true;
  const landing = landings.get(id);
  return Boolean(landing) && (!landing.ownerId || landing.ownerId === req.user.id);
}
// Every offer and landing a restricted user puts into streams must be usable by them. Ids already present in the
// campaign's current streams stay allowed (the owner may have put them there), so saving such a campaign keeps working.
function streamRefsError(req, streams, current = []) {
  if (!restrictedUser(req)) return null;
  const keep = streamRefs(current), refs = streamRefs(streams), visible = visibleOfferIds(req);
  for (const id of refs.offers) if (!keep.offers.has(id) && !offerUsable(req, id, visible)) return { error: 'offer_not_usable', offerId: id };
  for (const id of refs.landings) if (!keep.landings.has(id) && !landingUsable(req, id)) return { error: 'landing_not_usable', landingId: id };
  return null;
}
// /r/:campaign/:offer may only send traffic to an offer of that campaign's streams. A legacy campaign without offer
// streams accepts team offers and offers of the campaign's owner. Unknown campaigns fall through to the usual 404.
function explicitOfferAllowed(campaign, offerId, offer) {
  if (!campaign) return true;
  const refs = streamRefs(campaign.streams).offers;
  if (refs.size) return refs.has(offerId);
  return !offer.ownerId || offer.ownerId === campaign.ownerId;
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
  // Streamed oldest → newest; only the newest `limit` matches are kept.
  const items = [];
  await journalScans.run(() => scanJournalLines(eventsFile, (line) => {
    if (!line.includes('"audit"')) return;
    try {
      const item = JSON.parse(line);
      if (item.type !== 'audit' || (entity && item.entity !== entity) || (id && item.entityId !== id)) return;
      items.push(item);
      if (items.length > limit * 2) items.splice(0, items.length - limit);
    } catch { /* skip */ }
  }));
  return items.slice(-limit).reverse().map((item) => ({ at: item.at, actor: item.actor, action: item.action, entity: item.entity, entityId: item.entityId, changes: item.changes || {} }));
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
    // Reserved before the (slow, async) password check: parallel guesses are counted too. See src/rate-limit.js.
    const ticket = loginLimiter.reserve(body.email, ip);
    if (!ticket) return json(res, 429, { error: 'too_many_attempts' });
    const user = await users.authenticate(body.email, body.password);
    if (!user) return json(res, 401, { error: 'invalid_credentials' });
    loginLimiter.success(ticket);
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

// Static panel files: /admin/<name> and, for the public demo, /demo/admin/<name>. stream-policy.js is the no-cloaking
// rule shared with the server (the editor and the API refuse the same conditions); stats-report.js builds the demo's
// reports the same way the server builds the real ones.
const PANEL_ASSETS = {
  '/admin/admin.js': ['public/admin/admin.js', 'text/javascript'], '/admin/admin.css': ['public/admin/admin.css', 'text/css'],
  '/admin/demo.js': ['public/admin/demo.js', 'text/javascript'], '/admin/stream-policy.js': ['src/stream-policy.js', 'text/javascript'],
  '/admin/stats-report.js': ['src/stats-report.js', 'text/javascript'],
};
// PANEL_BUILD=1 (production): the same files from build/panel/, made by scripts/obfuscate-panel.mjs in the deploy —
// obfuscated JS, CSS and the shell without comments. Checked at startup, so a release without them never goes live.
const panelBuild = /^(1|true|yes)$/i.test(process.env.PANEL_BUILD || '') ? join(root, 'build', 'panel') : null;
const panelFile = (file) => (panelBuild ? join(panelBuild, basename(file)) : join(root, file));
if (panelBuild) {
  for (const file of [...Object.values(PANEL_ASSETS).map(([f]) => f), 'public/admin/index.html']) {
    if (!existsSync(panelFile(file))) throw new Error(`PANEL_BUILD=1 but ${panelFile(file)} is missing (run scripts/obfuscate-panel.mjs)`);
  }
}
async function sendPanelAsset(res, path) {
  const [file, type] = PANEL_ASSETS[path];
  res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  return res.end(await readFile(panelFile(file)));
}

// The panel page. Root-relative links (assets and menu) get the base path. It goes into a meta tag (not an inline
// script) so the panel can run under a strict CSP. The demo shell links inside /demo, carries the umbrella-demo marker
// that switches admin.js to made-up data, and shows the demo strip without any script.
async function panelShell({ demo = false } = {}) {
  const body = await readFile(panelFile('public/admin/index.html'), 'utf8');
  const html = body.replaceAll('="/', `="${basePath}${demo ? DEMO_PREFIX : ''}/`).replace('<head>', `<head>\n<meta name="umbrella-base" content="${basePath}">`);
  if (!demo) return html;
  return html.replace('<head>', `<head>\n<meta name="umbrella-demo" content="1">\n<meta name="robots" content="noindex">`)
    .replace('<body>', '<body class="demo">\n<div class="demo-banner" role="note">ДЕМО-РЕЖИМ — данные выдуманные, изменения не сохраняются</div>');
}

async function serveDemo(req, res, url) {
  const asset = url.pathname.slice(DEMO_PREFIX.length);
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
  if (asset.startsWith('/admin/') && Object.hasOwn(PANEL_ASSETS, asset)) return sendPanelAsset(res, asset);
  if (!isDemoPanelPath(url.pathname)) return json(res, 404, { error: 'not_found' });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  return res.end(await panelShell({ demo: true }));
}

// The port is bound before the stores and the journal index are built (a big journal takes longer than a deploy's
// health-check window); until `ready` every request gets 503 and /health says «starting» (release.sh keeps waiting).
let ready = false;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    securityHeaders(res, url.pathname);
    if (!ready) {
      res.setHeader('retry-after', '2');
      return json(res, 503, url.pathname === '/health' ? { ok: false, starting: true, uptime: Math.round(process.uptime()) } : { error: 'starting' });
    }
    if (onTrackingDomain(req) && !isTrackingPath(url.pathname)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    // Public demo (src/panel-routes.js): the shell and the panel's static files only, served before the IP allowlist and
    // any session lookup. The demo answers its API calls in the browser (public/admin/demo.js) and never calls /api.
    if (isDemoPath(url.pathname)) return await serveDemo(req, res, url);
    if (!isTrackingPath(url.pathname) && !adminIpAllowed(req)) return json(res, 403, { error: 'admin_ip_not_allowed' });
    const authorization = String(req.headers.authorization || '');
    if (!isTrackingPath(url.pathname) && authorization.startsWith(`Bearer ${API_KEY_PREFIX}`)) {
      const found = await users.userForApiKey(authorization.slice('Bearer '.length));
      if (!found) return json(res, 401, { error: 'invalid_api_key' });
      req.user = found.user;
      req.apiKey = found.key;
    } else req.user = await sessionUser(req);
    if (requireLogin && isPrivatePath(url.pathname) && !req.user && !bearerAuthorized(req)) return json(res, 401, { error: 'login_required' });
    // Read-only role: every write to the panel API is refused; signing in and out stays possible.
    if (isViewer(req) && !['GET', 'HEAD'].includes(req.method) && isPrivatePath(url.pathname)) return json(res, 403, { error: 'read_only' });
    if (hidesRevenue(req)) {
      res.revenueFilter = revenueFilterFor(url.pathname);
      // Revenue settings cannot be written by someone who cannot see them. The body is read here once and
      // handed to the route through readJson (req.jsonBody).
      if (res.revenueFilter && ['POST', 'PATCH', 'PUT'].includes(req.method)) {
        req.jsonBody = await readJson(req, 2 * 1024 * 1024);
        const fields = revenueWriteFields(req.jsonBody);
        if (fields.length) return json(res, 403, { error: 'revenue_hidden', fields });
      }
    }
    if (url.pathname === '/stats' || url.pathname.startsWith('/stats/') || url.pathname === '/api/clicks' || url.pathname === '/api/conversions' || url.pathname === '/api/bots'
      || url.pathname === '/api/postbacks') {
      req.scope = campaignScope(req, url.searchParams.get('campaign') || null);
      if (req.scope.forbidden) return json(res, 403, { error: 'campaign_not_yours' });
    }
    if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/users' || url.pathname.startsWith('/api/users/')
      || url.pathname === '/api/keys' || url.pathname.startsWith('/api/keys/') || url.pathname === '/api/security') {
      return await handleAuthRoute(req, res, url);
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
        const dest = expandUrlOrFail(targetTemplate, { campaign: campaignId, offer_id: offerId });
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
        res.writeHead(302, { location: expandUrlOrFail(targetTemplate, { campaign: campaignId, offer_id: offerId }), 'cache-control': 'no-store' });
        return res.end();
      }

      // Revenue cap: stop sending traffic when daily revenue >= revenueCap
      if (c.revenueCap !== null) {
        const rev = await todayRevenue(campaignId);
        if (rev >= c.revenueCap) {
          if (c.capUrl) { res.writeHead(302, { location: c.capUrl, 'cache-control': 'no-store' }); return res.end(); }
          return json(res, 429, { error: 'revenue_cap_reached', revenueCap: c.revenueCap });
        }
      }

      // Click caps: daily, offer daily (shared across all campaigns sending to this offer) and total (lifetime,
      // the campaign auto-pauses). Counters are seeded first; from here to the reservation nothing awaits, so
      // concurrent clicks see each other's reservations and a cap is never overrun (single process; several
      // instances would need the reservation in the database).
      const offerCap = offers.get(offerId)?.dailyCap;
      const dayKey = capDayKey('c', campaignId), offerKey = offerId ? capDayKey('o', offerId) : null, totalKey = `t|${campaignId}`;
      const capKeys = [dayKey, totalKey, ...(offerKey ? [offerKey] : [])];
      await clickCounters.ensure([...(c.dailyCap !== null ? [dayKey] : []), ...(offerCap ? [offerKey] : []), ...(c.totalCap !== null ? [totalKey] : [])]);
      // A concurrent click from the same IP may have been accepted while this one awaited.
      if (c.dedupeWindow > 0 && recentClick(campaignId, ip, c.dedupeWindow)) {
        res.writeHead(302, { location: expandUrlOrFail(targetTemplate, { campaign: campaignId, offer_id: offerId }), 'cache-control': 'no-store' });
        return res.end();
      }
      const capped = (body) => {
        if (c.capUrl) { res.writeHead(302, { location: c.capUrl, 'cache-control': 'no-store' }); return res.end(); }
        return json(res, 429, body);
      };
      if (c.dailyCap !== null && clickCounters.get(dayKey) >= c.dailyCap) return capped({ error: 'daily_cap_reached', dailyCap: c.dailyCap });
      if (offerCap && clickCounters.get(offerKey) >= offerCap) return capped({ error: 'offer_cap_reached', offerId, dailyCap: offerCap });
      if (c.totalCap !== null && clickCounters.get(totalKey) >= c.totalCap) {
        await pauseCampaign(campaignId, 'total_cap_reached');
        return capped({ error: 'total_cap_reached', totalCap: c.totalCap });
      }

      const clickId = randomUUID();
      const subid = url.searchParams.get('subid') || null;

      // Apply URL macros then append any missing UTM params.
      const params = trackedParams(url.searchParams, c.paramMap);
      let cost = 0;
      if (c.costModel === 'cpc') {
        const rawCost = c.costFromParam ? url.searchParams.get(c.paramMap?.cost || 'cost') : null;
        const fromParam = rawCost === null || rawCost.trim() === '' ? NaN : Number(rawCost);
        // Rounded like PostgreSQL clicks.cost NUMERIC(12,6), so the journal and the database hold the same amount.
        cost = round6(Number.isFinite(fromParam) && fromParam >= 0 && fromParam < 1000 ? fromParam : c.cpc);
      }
      const macroVars = { ...params, cost: cost || '', click_id: clickId, subid: subid || '', campaign: campaignId, offer_id: offerId, device, country: country || '',
        lp_click_url: `${publicBase(req)}/lp/click?click_id=${clickId}` };
      const expanded = expandUrlOrFail(targetTemplate, macroVars);
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
        // Still no await since the cap checks: reserve the click on its counters and mark the IP for deduplication.
        const reservation = clickCounters.reserve(capKeys);
        journalIndex.markClick(campaignId, ip);
        let recorded;
        try {
          recorded = await event('click', { clickId, campaign: campaignId, offerId, path: url.pathname, referrer: req.headers.referer || null, userAgent: req.headers['user-agent'] || null, subid, country, ip,
            device, os, browser, language: /^[a-z]{2}$/.test(lang) ? lang : null,
            ...(network ? { asn: network.asn, isp: network.isp, datacenter: network.datacenter, connection: network.connection } : {}), stream: streamName, ...extra, ...(Object.keys(params).length ? { params } : {}), ...(cost ? { cost } : {}), ...(clickRevenue ? { revenue: clickRevenue } : {}) });
        } catch (error) { reservation.release(); throw error; }
        // The reservation stays "not yet in storage" until PostgreSQL has the click (JSONL: written already).
        if (recorded?.mirrored) recorded.mirrored.then(() => reservation.settle(), () => reservation.settle());
        else reservation.settle();
        if (c.totalCap !== null && clickCounters.get(totalKey) >= c.totalCap) await pauseCampaign(campaignId, 'total_cap_reached');
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
      if (!offer || offer.archived || !explicitOfferAllowed(campaigns.get(campaignId), offerId, offer)) return json(res, 404, { error: 'offer_not_found' });
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
      if (rateLimited(clientIp(req), postbackLimiter)) return json(res, 429, { error: 'postback_rate_limited' });
      // Every incoming postback is journaled with its response code (G7). Rejected secrets are aggregated
      // (one journal event per IP and minute, see rejectedPostbacks) so a flood cannot grow the journal.
      const q = (key) => (url.searchParams.get(key) || '').slice(0, 200) || null;
      const context = {};
      const logIncoming = (statusCode, error = null) => logPostback('postback_in', { clickId: q('click_id'), campaign: context.click?.campaign ?? null,
        offerId: context.click?.offerId ?? null, tid: q('tid'), status: q('status'), revenue: q('revenue') || q('payout'), currency: q('currency'),
        url: redactUrl(req.url), statusCode, error, ip: clientIp(req) || null });
      if (postbackSecret && !safeEqual(url.searchParams.get('secret'), postbackSecret)) {
        if (rejectedPostbacks.note(clientIp(req) || 'unknown', 401, 'invalid_postback_secret')) await logIncoming(401, 'invalid_postback_secret');
        return json(res, 401, { error: 'invalid_postback_secret' });
      }
      const ip = clientIp(req) || 'unknown';
      try {
        // `payout` is an alias of `revenue`; without either, a CPA offer's payout is used (see recordPostback).
        const result = await recordPostback({ clickId: url.searchParams.get('click_id'), context,
          tid: url.searchParams.get('tid'), params: postbackClickParams(url.searchParams),
          revenue: url.searchParams.get('revenue') || url.searchParams.get('payout'), currency: url.searchParams.get('currency'), status: url.searchParams.get('status') });
        await logIncoming(200);
        return json(res, 200, result);
      } catch (error) {
        // The same status again: networks retry anything but 2xx, so a repeat is acknowledged (nothing is recorded or re-sent).
        if (error.statusCode === 409 && error.message === 'conversion_already_recorded') {
          if (rejectedPostbacks.note(ip, 200, 'conversion_already_recorded')) await logIncoming(200, 'conversion_already_recorded');
          return json(res, 200, { ok: true, duplicate: true });
        }
        // Unknown or malformed click_id / bad values: aggregated like a wrong secret.
        const aggregated = (error.statusCode === 400 || error.statusCode === 404) && !rejectedPostbacks.note(ip, error.statusCode, String(error.message).slice(0, 80));
        if (!aggregated) await logIncoming(error.statusCode || 500, String(error.message || error).slice(0, 300));
        if (!error.statusCode) throw error;
        return json(res, error.statusCode, { error: error.message,
          ...(error.conversionWindowDays ? { conversionWindowDays: error.conversionWindowDays } : {}) });
      }
    }
    if (url.pathname === '/stats' && req.method === 'GET') {
      return json(res, 200, await stats({
        currency: reportCurrency(url.searchParams.get('currency')),
        tz: parseTz(url.searchParams.get('tz')),
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
      const common = { currency: reportCurrency(url.searchParams.get('currency')), tz: parseTz(url.searchParams.get('tz')), campaign: url.searchParams.get('campaign') || null, allowed: req.scope?.allowed || null, subid: url.searchParams.get('subid') || null, country: url.searchParams.get('country') || null, offer: url.searchParams.get('offer') || null, stream: url.searchParams.get('stream') || null };
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
      const tz = parseTz(url.searchParams.get('tz'));
      const GROUP_PROP = { campaign: 'byCampaign', offer: 'byOffer', stream: 'byStream', landing: 'byLanding', country: 'byCountry', source: 'bySource', network: 'byNetwork' };
      let rows;
      if (GROUP_PROP[group]) {
        const report = await stats({ campaign, allowed, from, to, currency, tz, subid: url.searchParams.get('subid') || null,
          country: url.searchParams.get('country') || null, offer: url.searchParams.get('offer') || null, stream: url.searchParams.get('stream') || null });
        rows = Object.entries(report[GROUP_PROP[group]]).map(([key, v]) => ({ key, ...v }));
      } else if (TRACK_FIELDS.includes(group) || DIMENSION_FIELDS.includes(group)) {
        rows = (await paramReport({ field: group, campaign, allowed, from, to, currency, tz })).map((r) => ({ key: r.value, ...r }));
      } else return json(res, 400, { error: 'invalid_group' });
      const columns = ['key', 'clicks', 'conversions', 'revenue', 'cost', 'cr', 'epc', 'rpm', 'uniqueClicks', 'leads', 'sales', 'rejected', 'pendingRevenue', 'profit', 'roi']
        .filter((c) => !hidesRevenue(req) || !REVENUE_KEY.test(c));
      // Text cells starting with = + - @ tab or CR are prefixed with ' so spreadsheets do not run them as formulas.
      const cell = (v) => { let text = v === null || v === undefined ? '' : typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : String(v); if (/^[=+\-@\t\r]/.test(text) && typeof v !== 'number') text = `'${text}`; return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
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
          if (botTo) add('created_at < ?', dayEndIso(botTo));
          values.push(limit);
          const { rows } = await db.query(`SELECT created_at, campaign, offer_id, stream, reason, isp, user_agent, ip FROM bots ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY created_at DESC, id DESC LIMIT $${values.length}`, values);
          return json(res, 200, { bots: rows.map((r) => botRow({ at: new Date(r.created_at).toISOString(), campaign: r.campaign, offerId: r.offer_id, stream: r.stream,
            reason: r.reason, isp: r.isp, userAgent: r.user_agent, ip: r.ip })) });
        } catch (e) { console.warn('[db] bot log fallback:', e.message); }
      }
      try {
        const lines = await journalRecords(['bot']);
        const fromMs = botFrom ? Date.parse(`${botFrom}T00:00:00Z`) : null;
        const toMs = botTo ? Date.parse(dayEndIso(botTo)) : null;
        const bots = lines.filter((item) => {
          if (item.type !== 'bot') return false;
          if (botCampaign && item.campaign !== botCampaign) return false;
          if (req.scope?.allowed && !req.scope.allowed.includes(item.campaign)) return false;
          const t = item.at ? Date.parse(item.at) : null;
          if (fromMs !== null && (t === null || t < fromMs)) return false;
          if (toMs !== null && (t === null || t >= toMs)) return false;
          return true;
        }).reverse().slice(0, limit).map(botRow);
        return json(res, 200, { bots });
      } catch (e) {
        if (e.code === 'ENOENT') return json(res, 200, { bots: [] });
        throw e;
      }
    }
    if (url.pathname === '/lp/click' && req.method === 'GET') {
      if (rateLimited(clientIp(req), lpClickLimiter)) return json(res, 429, { error: 'click_rate_limited' });
      const clickId = url.searchParams.get('click_id') || '';
      if (!/^[0-9a-f-]{36}$/i.test(clickId)) return json(res, 400, { error: 'click_id_required' });
      const click = await getClickRecord(clickId);
      if (!click) return json(res, 404, { error: 'click_not_found' });
      const offer = offers.get(click.offerId);
      if (!offer) return json(res, 404, { error: 'offer_not_found' });
      const vars = { ...(click.params || {}), cost: click.cost || '', click_id: clickId, subid: click.subid || '', campaign: click.campaign, offer_id: click.offerId, device: '', country: click.country || '' };
      const destination = new URL(expandUrlOrFail(offer.url, vars));
      await event('lp_click', { clickId, campaign: click.campaign, landingId: click.landingId ?? null });
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
    // Postback journals (G7): GET /api/postbacks?direction=in|out&campaign&from&to&limit. Buyers see their campaigns only.
    if (url.pathname === '/api/postbacks' && req.method === 'GET') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const direction = url.searchParams.get('direction') || 'in';
      if (!['in', 'out'].includes(direction)) return json(res, 400, { error: 'invalid_direction' });
      const from = url.searchParams.get('from') || null, to = url.searchParams.get('to') || null;
      if ((from && !isoDate(from)) || (to && !isoDate(to))) return json(res, 400, { error: 'invalid_date' });
      const rawLimit = Number(url.searchParams.get('limit') || 100);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
      const result = await readPostbacks({ direction, campaign: req.scope?.campaign || null, allowed: req.scope?.allowed || null, from, to, limit });
      return json(res, 200, { direction, ...result });
    }
    // Manual cost update (G8, Keitaro «Обновить расходы»): the amount is split equally over the matching clicks.
    if (url.pathname === '/api/costs' && req.method === 'POST') {
      const body = await readJson(req);
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const result = await updateCosts(body, req);
      if (result.error) return json(res, result.status, { error: result.error });
      return json(res, 200, result);
    }
    // Spend import (FB Ads Manager CSV parsed in the browser): one cost update per row and day, idempotent per import key.
    if (url.pathname === '/api/costs/import' && req.method === 'POST') {
      const body = await readJson(req, 2 * 1024 * 1024);
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const result = await importCosts(body, req);
      if (result.error) return json(res, result.status, { error: result.error });
      return json(res, 200, result);
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
      if (landings.has(String(body.id))) return json(res, 409, { error: 'id_taken' });
      const landing = parseLanding({ ...body, ownerId: creatorOwnerId(req, body) });
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
      if (!canManage(req, cur)) return json(res, 403, { error: 'landing_not_yours' });
      const updated = parseLanding({ url: body.url ?? cur.url, name: body.name !== undefined ? body.name : cur.name, ownerId: nextOwnerId(req, body, cur) });
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
      // POST never overwrites: changes go through PATCH, where ownership is checked.
      if (offers.has(String(body.id))) return json(res, 409, { error: 'id_taken' });
      if (body.altOfferId && !offerUsable(req, String(body.altOfferId))) return json(res, 403, { error: 'offer_not_usable', offerId: String(body.altOfferId) });
      if (body.networkId !== undefined && body.networkId !== null && !networks.has(String(body.networkId))) return json(res, 400, { error: 'network_not_found' });
      const capError = conversionCapError(String(body.id), body) || payoutError(body);
      if (capError) return json(res, 400, { error: capError });
      const offer = parseOffer({ url: String(body.url), postbackUrl: body.postbackUrl, payoutType: body.payoutType, payout: body.payout, payoutCurrency: body.payoutCurrency, dailyCap: body.dailyCap, name: body.name, networkId: body.networkId, archived: body.archived, group: body.group,
        conversionCap: body.conversionCap, capTz: body.capTz, altOfferId: body.altOfferId, ownerId: creatorOwnerId(req, body) });
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
      if (!canManage(req, cur)) return json(res, 403, { error: 'offer_not_yours' });
      let nextId=`${id}-copy`, n=2; while(offers.has(nextId)) nextId=`${id}-copy${n++}`;
      const copy=parseOffer({...cur,name:`${cur.name||id} (копия)`,archived:false,ownerId:creatorOwnerId(req, {})}); offers.set(nextId,copy); await persistOffer(nextId,copy); await audit(req,'create','offer',nextId,null,copy); return json(res,201,{id:nextId,...copy});
    }
    if (offerUpdate && req.method === 'PATCH') {
      const id = offerUpdate[1];
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      if (!offers.has(id) || (visibleOfferIds(req) && !visibleOfferIds(req).has(id))) return json(res, 404, { error: 'offer_not_found' });
      if (!canManage(req, offers.get(id))) return json(res, 403, { error: 'offer_not_yours' });
      const body = await readJson(req);
      const cur = offers.get(id);
      if (body.altOfferId && String(body.altOfferId) !== cur.altOfferId && !offerUsable(req, String(body.altOfferId))) return json(res, 403, { error: 'offer_not_usable', offerId: String(body.altOfferId) });
      const newUrl = body.url !== undefined ? String(body.url) : cur.url;
      const newPostbackUrl = body.postbackUrl !== undefined ? body.postbackUrl : cur.postbackUrl;
      const newDailyCap = body.dailyCap !== undefined ? body.dailyCap : cur.dailyCap;
      if (body.networkId !== undefined && body.networkId !== null && !networks.has(String(body.networkId))) return json(res, 400, { error: 'network_not_found' });
      const capError = conversionCapError(id, body) || payoutError(body);
      if (capError) return json(res, 400, { error: capError });
      const updated = parseOffer({ url: newUrl, postbackUrl: newPostbackUrl, payoutType: body.payoutType !== undefined ? body.payoutType : cur.payoutType, payout: body.payout !== undefined ? body.payout : cur.payout, payoutCurrency: body.payoutCurrency !== undefined ? body.payoutCurrency : cur.payoutCurrency, dailyCap: newDailyCap, name: body.name !== undefined ? body.name : cur.name, networkId: body.networkId !== undefined ? body.networkId : cur.networkId, archived: body.archived !== undefined ? body.archived : cur.archived, group: body.group !== undefined ? body.group : cur.group,
        conversionCap: body.conversionCap !== undefined ? body.conversionCap : cur.conversionCap, capTz: body.capTz !== undefined ? body.capTz : cur.capTz, altOfferId: body.altOfferId !== undefined ? body.altOfferId : cur.altOfferId, ownerId: nextOwnerId(req, body, cur) });
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
      if (sources.has(String(body.id))) return json(res, 409, { error: 'id_taken' });
      if (!canSeeSourcePostback) { delete body.postbackUrl; delete body.postbackStatuses; }
      if (body.postbackUrl && !parsePostbackUrl(body.postbackUrl, { allowHttp: sourcePostbackAllowPrivate })) return json(res, 400, { error: 'invalid_postback_url' });
      const source = parseSource({ ...body, ownerId: creatorOwnerId(req, body) });
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
      if (!canManage(req, sources.get(id))) return json(res, 403, { error: 'source_not_yours' });
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
        ownerId: nextOwnerId(req, body, cur),
      });
      sources.set(id, updated);
      await persistSource(id, updated);
      return json(res, 200, { id, ...publicSource(updated) });
    }
    if (url.pathname === '/api/networks' && req.method === 'GET') return json(res, 200, { networks: Object.fromEntries(networks) });
    if (url.pathname === '/api/networks' && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const body=await readJson(req), id=String(body.id||''), network=parseNetwork({ ...body, ownerId: creatorOwnerId(req, body) });
      if(!OFFER_ID_RE.test(id)) return json(res,400,{error:'valid_id_required'}); if(!network) return json(res,400,{error:'name_required'}); if(networks.has(id)) return json(res,409,{error:'id_taken'});
      networks.set(id,network); await persistNetwork(id,network); await audit(req,'create','network',id,null,network); return json(res,201,{id,...network});
    }
    const networkUpdate=url.pathname.match(/^\/api\/networks\/([A-Za-z0-9_-]{2,80})$/);
    if(networkUpdate && req.method==='PATCH') { if(!(await adminAuthorized(req))) return json(res,401,{error:'admin_authorization_required'}); const id=networkUpdate[1],cur=networks.get(id); if(!cur) return json(res,404,{error:'network_not_found'}); if(!canManage(req,cur)) return json(res,403,{error:'network_not_yours'}); const body=await readJson(req); const next=parseNetwork({...cur,...body,ownerId:nextOwnerId(req,body,cur)}); if(!next) return json(res,400,{error:'name_required'}); networks.set(id,next); await persistNetwork(id,next); await audit(req,'update','network',id,cur,next); return json(res,200,{id,...next}); }
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
      const cloaking = streamPolicyError(parseStreams(body.streams));
      if (cloaking) return json(res, 400, cloaking);
      const refsError = streamRefsError(req, parseStreams(body.streams), campaigns.get(String(body.id))?.streams);
      if (refsError) return json(res, 403, refsError);
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
      const cloaking = body.streams === undefined ? null : streamPolicyError(parseStreams(body.streams));
      if (cloaking) return json(res, 400, cloaking);
      if (OFFER_ID_RE.test(String(body.sourceId ?? '')) && !sources.has(String(body.sourceId))) return json(res, 400, { error: 'source_not_found' });
      if (body.sourcePostbackUrl && !parsePostbackUrl(body.sourcePostbackUrl, { allowHttp: sourcePostbackAllowPrivate })) return json(res, 400, { error: 'invalid_postback_url' });
      const cur = campaigns.get(id);
      const refsError = body.streams === undefined ? null : streamRefsError(req, parseStreams(body.streams), cur.streams);
      if (refsError) return json(res, 403, refsError);
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
      const cloaking = streamPolicyError(streams);
      if (cloaking) return json(res, 400, cloaking);
      const current = campaigns.get(id);
      const refsError = streamRefsError(req, streams, current.streams);
      if (refsError) return json(res, 403, refsError);
      campaigns.set(id, { ...current, streams });
      await persistCampaign(id, campaigns.get(id));
      await audit(req, 'update', 'campaign', id, current, campaigns.get(id));
      return json(res, 200, { id, streams });
    }
    if (Object.hasOwn(PANEL_ASSETS, url.pathname) && req.method === 'GET') return await sendPanelAsset(res, url.pathname);
    // The panel used to live at /admin#/section. The browser keeps the #fragment across the redirect and the
    // panel turns #/campaigns into /campaigns.
    if ((url.pathname === '/admin' || url.pathname === '/admin/') && req.method === 'GET') { res.writeHead(302, { location: `${basePath}/` }); return res.end(); }
    // Panel pages: /, /login, /dashboard, /campaigns, /campaigns/<id>, /reports… (src/panel-routes.js) get the same shell.
    if (req.method === 'GET' && (url.pathname === '/' || isPanelPath(url.pathname))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(await panelShell());
    }
    if (url.pathname === '/health') {
      // db: 'up' | 'down' (SELECT 1 with a short timeout) when PostgreSQL is attached; degraded when DATABASE_URL is set
      // but PostgreSQL is down or was unreachable at startup (JSONL fallback). Counters only, no error texts.
      const dbState = await healthDbState();
      const degraded = Boolean(process.env.DATABASE_URL) && dbState !== 'up';
      const ok = !(requirePostgres && dbState !== 'up');
      return json(res, ok ? 200 : 503, { ok, storage: db ? 'postgres' : 'jsonl', ...(dbState ? { db: dbState } : {}), ...(degraded ? { degraded: true } : {}),
        ...(eventMirror ? { mirrorErrors: eventMirror.stats().errors } : {}), journalBadLines: journalBadLines(),
        geo: Boolean(geoReader), isp: Boolean(asnReader), now: new Date().toISOString(), uptime: Math.round(process.uptime()),
        memory: { rssMb: Math.round(process.memoryUsage().rss / 1048576), heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576) } });
    }
    // Time-series: GET /stats/timeseries?campaign=X&from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|hour
    if (url.pathname === '/stats/timeseries' && req.method === 'GET') {
      const tsFrom = url.searchParams.get('from') || null;
      const tsTo = url.searchParams.get('to') || null;
      const tsCampaign = url.searchParams.get('campaign') || null;
      const tsOffer = url.searchParams.get('offer') || null;
      const granularity = url.searchParams.get('granularity') === 'hour' ? 'hour' : 'day';
      const tsCurrency = reportCurrency(url.searchParams.get('currency'));
      const tsTz = parseTz(url.searchParams.get('tz'));
      const tsRange = dayRange(tsFrom, tsTo, tsTz);
      if (tsFrom && !/^\d{4}-\d{2}-\d{2}$/.test(tsFrom)) return json(res, 400, { error: 'invalid_from_date' });
      if (tsTo && !/^\d{4}-\d{2}-\d{2}$/.test(tsTo)) return json(res, 400, { error: 'invalid_to_date' });
      if (db) {
        try {
          const conds = [], params = [];
          if (tsCampaign) { params.push(tsCampaign); conds.push(`c.campaign = $${params.length}`); }
          if (tsOffer) { params.push(tsOffer); conds.push(`c.offer_id = $${params.length}`); }
          if (req.scope?.allowed) { params.push(req.scope.allowed); conds.push(`c.campaign = ANY($${params.length}::text[])`); }
          if (tsFrom) { params.push(tsRange.fromIso); conds.push(`c.created_at >= $${params.length}`); }
          if (tsTo) { params.push(tsRange.toIso); conds.push(`c.created_at < $${params.length}`); }
          const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
          const trunc = granularity === 'hour' ? 'hour' : 'day';
          // Default: UTC buckets whatever the TimeZone setting. With tz: the local day/hour of that zone, as a text label.
          let bucketSql = `(DATE_TRUNC('${trunc}', c.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
          if (tsTz) { params.push(tsTz); bucketSql = `to_char(DATE_TRUNC('${trunc}', c.created_at AT TIME ZONE $${params.length}::text), '${trunc === 'hour' ? 'YYYY-MM-DD"T"HH24' : 'YYYY-MM-DD'}')`; }
          const fx = sqlFx(params, tsCurrency);
          const { rows } = await db.query(`
            SELECT
              ${bucketSql} AS bucket,
              COUNT(c.click_id)::int                AS clicks,
              COUNT(c.click_id) FILTER (WHERE c.is_unique_campaign)::int AS unique_clicks,
              ${fx.sum('conversions')}::int         AS conversions,
              (${fx.sum('revenue')} + ${fx.clickRevenue})::float AS revenue,
              ${fx.cost}::float                     AS cost
            FROM clicks c
            ${fx.join}
            ${where}
            GROUP BY bucket ORDER BY bucket
          `, params);
          return json(res, 200, { granularity, currency: tsCurrency, series: rows.map((r) => ({ date: tsTz ? r.bucket : r.bucket.toISOString().slice(0, granularity === 'hour' ? 13 : 10), clicks: r.clicks, uniqueClicks: r.unique_clicks, conversions: r.conversions, revenue: r.revenue, cost: r.cost })) });
        } catch (e) { console.warn('[db] timeseries fallback:', e.message); }
      }
      // JSONL fallback
      try {
        const lines = applyClickUpdates(await journalRecords(['click', 'conversion', 'cost_update']));
        const { fromMs, toMs } = tsRange;
        const bucketOf = (at) => (tsTz ? localBucket(at, tsTz, granularity === 'hour') : (at || '').slice(0, granularity === 'hour' ? 13 : 10));
        const allClicks = lines.filter((item) => item.type === 'click');
        const clicks = allClicks.filter((item) => {
          if (tsCampaign && item.campaign !== tsCampaign) return false;
          if (tsOffer && item.offerId !== tsOffer) return false;
          if (req.scope?.allowed && !req.scope.allowed.includes(item.campaign)) return false;
          const t = item.at ? Date.parse(item.at) : null;
          if (fromMs !== null && (t === null || t < fromMs)) return false;
          if (toMs !== null && (t === null || t >= toMs)) return false;
          return true;
        });
        const visibleClickIds = new Set(clicks.map((c) => c.clickId));
        const convs = [...latestConversions(lines).values()].filter((item) => visibleClickIds.has(item.clickId) && conversionCounts(item));
        const clickBucket = new Map(clicks.map((c) => [c.clickId, bucketOf(c.at)]));
        const buckets = {};
        for (const click of clicks) {
          const b = bucketOf(click.at);
          buckets[b] ||= { clicks: 0, uniqueClicks: 0, conversions: 0, revenue: 0, cost: 0 };
          buckets[b].clicks += 1;
          if (click.uniqueCampaign !== false) buckets[b].uniqueClicks += 1;
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
        const lines = await journalRecords(['click']);
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
      return json(res, 200, { field, currency: pCurrency, rows: await paramReport({ field, campaign: pCampaign, allowed: req.scope?.allowed || null, from: pFrom, to: pTo, currency: pCurrency, tz: parseTz(url.searchParams.get('tz')) }) });
    }
    if (url.pathname === '/stats/bots' && req.method === 'GET') {
      const campaign = url.searchParams.get('campaign') || null;
      const from = url.searchParams.get('from') || null; const to = url.searchParams.get('to') || null;
      if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) return json(res, 400, { error: 'invalid_date' });
      const botTz = parseTz(url.searchParams.get('tz'));
      const botRange = dayRange(from, to, botTz);
      const fromMs = botRange.fromMs ?? -Infinity; const toMs = botRange.toMs ?? Infinity;
      if (db) {
        try {
          const values = []; const where = [];
          if (campaign) { values.push(campaign); where.push(`campaign = $${values.length}`); }
          if (req.scope?.allowed) { values.push(req.scope.allowed); where.push(`campaign = ANY($${values.length}::text[])`); }
          if (from) { values.push(botRange.fromIso); where.push(`created_at >= $${values.length}`); }
          if (to) { values.push(botRange.toIso); where.push(`created_at < $${values.length}`); }
          const { rows } = await db.query(`SELECT campaign, COUNT(*)::int AS count FROM bots ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY campaign`, values);
          const byCampaign = Object.fromEntries(rows.map((r) => [r.campaign, r.count]));
          return json(res, 200, { total: rows.reduce((sum, r) => sum + r.count, 0), byCampaign });
        } catch (error) { console.warn('[db] bots report fallback:', error.message); }
      }
      try {
        const lines = await journalRecords(['bot']);
        const byCampaign = {};
        for (const item of lines) if (item.type === 'bot' && (!campaign || item.campaign === campaign) && (!req.scope?.allowed || req.scope.allowed.includes(item.campaign))) {
          const at = Date.parse(item.at || item.created_at || ''); if (at < fromMs || at >= toMs) continue;
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
        const lines = await journalRecords(['click']);
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

server.listen(port, '127.0.0.1', () => console.log(`[start] port bound on http://127.0.0.1:${server.address().port}, loading data (503 until ready)`));
await once(server, 'listening');
await tightenDataFiles();
await rates.start({ blocking: false });
await loadSettings();
await loadSources();
await loadNetworks();
await loadOffers();
await loadLandings();
await loadCampaigns();
await enforceStreamPolicy();
if (requirePostgres && !db) throw new Error('REQUIRE_POSTGRES=1, но PostgreSQL недоступен');
{
  const started = Date.now();
  await buildJournalIndex();
  const size = journalIndex.stats();
  console.log(`[journal] index ready in ${Date.now() - started} ms: ${size.clicks} recent clicks, ${size.conversions} conversions`);
}
ready = true;
console.log(`Product Umbrella listening on http://127.0.0.1:${server.address().port}`);
if (retentionDays > 0) {
  const retentionTick = () => runRetention().catch((error) => console.warn('[retention] failed:', error.message));
  const firstRunMs = Math.max(0, Number(process.env.RETENTION_DELAY_MS ?? 60000));
  setTimeout(() => { retentionTick(); setInterval(retentionTick, 86400000).unref(); }, firstRunMs).unref();
  console.log(`[retention] enabled: ${retentionDays} days`);
}
if (monitorEnabled) monitor.start();
// Startup reconciliation (whole journal) also replaces the old one-time bot backfill: attaching PostgreSQL to an
// existing journal copies its clicks, conversions, bots, postbacks and cost updates.
if (db && reconcileIntervalMs > 0) {
  const reconcileTick = () => reconciler.run().catch((error) => console.warn('[reconcile] failed:', error.message));
  setTimeout(() => reconciler.run({ full: true }).catch((error) => console.warn('[reconcile] failed:', error.message)), Math.max(0, Number(process.env.RECONCILE_DELAY_MS ?? 5000))).unref();
  setInterval(reconcileTick, reconcileIntervalMs).unref();
  console.log(`[reconcile] enabled: every ${Math.round(reconcileIntervalMs / 1000)} s`);
}

async function shutdown() { monitor.stop(); await rejectedPostbacks.flush(true); await new Promise((resolve) => server.close(resolve)); await reconciler.pause(); await eventMirror?.drain(); await closeDb(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
