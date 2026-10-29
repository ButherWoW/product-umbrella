import http from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, query, closeDb } from './db.js';
import { reportFromRows, reportFromEvents, metrics } from './stats-report.js';
import { createUserStore, readCookie, SESSION_TTL_MS } from './auth.js';
import { createRates, normalizeCurrency } from './currency.js';
import { readEventLog } from './event-logs.js';
import { createConversionRecorder, hasRecordedConversion, findRecordedConversion } from './conversion-recorder.js';
import { createEventMirror } from './event-mirror.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DATA_DIR || join(root, 'data');
const eventsFile = join(dataDir, 'events.jsonl');
const offersFile = join(dataDir, 'offers.json');
const landingsFile = join(dataDir, 'landings.json');
const settingsFile = join(dataDir, 'settings.json');
const campaignsFile = join(dataDir, 'campaigns.json');
const port = Number(process.env.PORT || 4100);
// Public path prefix when served behind a proxy under a subpath (nginx strips it before proxying).
const basePath = /^\/[A-Za-z0-9_-]{1,40}$/.test(process.env.BASE_PATH || '') ? process.env.BASE_PATH : '';
// Umbrella's own accounts (see src/auth.js). REQUIRE_LOGIN=1 closes reports and APIs to anonymous visitors.
const users = createUserStore({ db, dataDir });
const requireLogin = /^(1|true|yes)$/i.test(process.env.REQUIRE_LOGIN || '');
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
  };
}
// JSONL equivalents.
const convertConversion = (cv, currency) => (cv.revenue === null || cv.revenue === undefined ? cv : { ...cv, revenue: Number(cv.revenue) * rates.factor(cv.currency, currency) });
const convertClickCost = (click, currency) => (click.cost ? { ...click, cost: Number(click.cost) * rates.factor(rates.defaultCurrency, currency) } : click);
const SESSION_COOKIE = 'umb_session';
const loginFailures = new Map();
const postbackSecret = process.env.POSTBACK_SECRET || '';
const adminToken = process.env.ADMIN_TOKEN || '';
const clickRateLimit = Math.max(0, Number(process.env.CLICK_RATE_LIMIT || 120));
const clickRateWindowMs = Math.max(1000, Number(process.env.CLICK_RATE_WINDOW_MS || 60000));
const rateBuckets = new Map();
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
    return { asn: r.autonomousSystemNumber ?? null, isp, datacenter: Boolean(isp && DATACENTER_RE.test(isp)) };
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

const OFFER_ID_RE = /^[a-z0-9_-]{2,80}$/i;
const STREAM_TYPES = ['forced', 'regular', 'fallback'];
const STREAM_ACTIONS = ['offers', 'url', 'not_found', 'campaign'];
const REDIRECT_METHODS = ['http', 'meta', 'js'];
// Hops allowed through "send to campaign" streams before giving up (protects against A → B → A loops).
const MAX_CAMPAIGN_HOPS = 3;

function parseList(raw, normalize, valid) {
  return Array.isArray(raw) ? raw.map(normalize).filter(valid).slice(0, 50) : [];
}

function parseConditions(raw = {}) {
  const lower = (v) => String(v).toLowerCase().slice(0, 20);
  return {
    countries: parseList(raw.countries, (g) => String(g).toUpperCase().slice(0, 2), (g) => /^[A-Z]{2}$/.test(g)),
    devices: parseList(raw.devices, lower, (d) => ['mobile', 'tablet', 'desktop'].includes(d)),
    os: parseList(raw.os, lower, (o) => ['android', 'ios', 'windows', 'macos', 'linux', 'other'].includes(o)),
    browsers: parseList(raw.browsers, lower, (b) => ['chrome', 'safari', 'firefox', 'edge', 'opera', 'samsung', 'other'].includes(b)),
    languages: parseList(raw.languages, (l) => String(l).toLowerCase().slice(0, 2), (l) => /^[a-z]{2}$/.test(l)),
    ...(raw.mode === 'or' ? { mode: 'or' } : {}),
    ...scheduleConditions(raw),
  };
}

// Day parting (Keitaro «Расписание»): ISO weekdays 1 (Mon) … 7 (Sun) and hours 0–23 in an IANA time zone.
// Only stored when set, so streams without a schedule keep their original shape.
function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
function scheduleConditions(raw) {
  const days = [...new Set(parseList(raw.days, Number, (d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
  const hours = [...new Set(parseList(raw.hours, Number, (h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
  if (!days.length && !hours.length) return {};
  const tz = typeof raw.tz === 'string' && validTimeZone(raw.tz) ? raw.tz : 'UTC';
  return { ...(days.length ? { days } : {}), ...(hours.length ? { hours } : {}), tz };
}
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function localDayHour(tz, date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(date).map((p) => [p.type, p.value]));
  return { day: WEEKDAY[parts.weekday], hour: Number(parts.hour) };
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

function streamMatches(stream, visitor) {
  const c = stream.conditions;
  if (!c) return true;
  // Unknown country (no GEOIP_DB) never matches a country condition, so geo streams fall through to others.
  const local = c.days?.length || c.hours?.length ? localDayHour(c.tz || 'UTC', visitor.now || new Date()) : {};
  const checks = [[c.countries, visitor.country], [c.devices, visitor.device], [c.os, visitor.os], [c.browsers, visitor.browser], [c.languages, visitor.language],
    [c.days, local.day], [c.hours, local.hour]]
    .filter(([values]) => values?.length)
    .map(([values, actual]) => values.includes(actual));
  if (!checks.length) return true;
  return c.mode === 'or' ? checks.some(Boolean) : checks.every(Boolean);
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

function visitorProfile(req) {
  const ua = req.headers['user-agent'] || '';
  const lang = String(req.headers['accept-language'] || '').trim().slice(0, 2).toLowerCase();
  return { device: detectDevice(ua), os: detectOS(ua), browser: detectBrowser(ua), language: /^[a-z]{2}$/.test(lang) ? lang : null, country: lookupCountry(clientIp(req)) };
}

// Replace known macros in URL templates (offer URLs and S2S postback URLs).
// Traffic-source parameters recorded per click (Keitaro "Параметры" tab). paramMap renames the query key per campaign.
const TRACK_FIELDS = ['keyword', 'source', 'external_id', 'creative_id', 'ad_campaign_id', ...Array.from({ length: 30 }, (_, i) => `sub_id_${i + 1}`)];
const MAPPABLE_FIELDS = [...TRACK_FIELDS, 'cost'];
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

// Offer ids from the campaign's streams whose offer-level dailyCap is reached today.
async function cappedOffers(streams) {
  const ids = new Set(streams.flatMap((s) => (s.offers ? s.offers.map((o) => o.offerId) : [s.offerId])));
  const capped = new Set();
  for (const id of ids) {
    const cap = offers.get(id)?.dailyCap;
    if (cap && await countClicks({ offerId: id, since: todayStart() }) >= cap) capped.add(id);
  }
  return capped;
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
  const dailyCap = Number.isInteger(raw?.dailyCap) && raw.dailyCap > 0 ? raw.dailyCap : null;
  const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : null;
  return { url: urlStr, postbackUrl, dailyCap, name };
}

async function loadOffers() {
  if (db) {
    try {
      const { rows } = await db.query('SELECT id, url, postback_url, daily_cap, name FROM offers');
      for (const row of rows) if (/^[a-z0-9_-]{2,80}$/i.test(row.id) && /^https:\/\//i.test(row.url)) offers.set(row.id, parseOffer({ url: row.url, postbackUrl: row.postback_url, dailyCap: row.daily_cap, name: row.name }));
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
  if (db) await db.query('INSERT INTO offers (id, url, postback_url, daily_cap, name) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, postback_url = EXCLUDED.postback_url, daily_cap = EXCLUDED.daily_cap, name = EXCLUDED.name', [id, offer.url, offer.postbackUrl, offer.dailyCap ?? null, offer.name ?? null]);
  else await saveOffers();
}

function parseCampaign(id, value) {
  return {
    name: String(value.name || id).slice(0, 120),
    active: value.active !== false,
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

async function event(type, payload) {
  await mkdir(dataDir, { recursive: true });
  const record = { id: randomUUID(), type, at: new Date().toISOString(), ...payload };
  await appendFile(eventsFile, `${JSON.stringify(record)}\n`);
  eventMirror?.enqueue(record);
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
          ${fx.revenue}::float                    AS revenue,
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
      return { ...reportFromRows(rows), currency };
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
    const lpClicked = new Set(lines.filter((item) => item.type === 'lp_click').map((item) => item.clickId));
    return { ...reportFromEvents(clicks.map((c) => convertClickCost(lpClicked.has(c.clickId) ? { ...c, lpClicked: true } : c, currency)),
      conversions.map((cv) => convertConversion(cv, currency))), currency };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...reportFromEvents([], []), currency };
    throw error;
  }
}

// Clicks/conversions/revenue/cost grouped by one tracked parameter value ('' = not passed).
// Click attributes stored as columns (not in params) that reports can group by.
const DIMENSION_FIELDS = ['device', 'os', 'browser', 'language', 'isp'];
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
        SELECT ${isColumn ? `COALESCE(c.${field}, '')` : "COALESCE(c.params->>$1, '')"} AS value, COUNT(c.click_id)::int AS clicks, ${SQL_CONVERSIONS}::int AS conversions,
          ${fx.revenue}::float AS revenue, ${fx.cost}::float AS cost
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
    const g = groups.get(key) || { value: key, clicks: 0, conversions: 0, revenue: 0, cost: 0 };
    const cv = conv.get(click.clickId);
    g.clicks += 1; g.cost += (Number(click.cost) || 0) * rates.factor(rates.defaultCurrency, currency);
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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const recordPostback = createConversionRecorder({
  findClick: getClickData,
  hasConversion: (clickId) => hasRecordedConversion({ clickId, eventsFile, db,
    onFallback: (error) => console.warn('[db] hasConversion fallback:', error.message) }),
  currentConversion: (clickId) => findRecordedConversion({ clickId, eventsFile, db,
    onFallback: (error) => console.warn('[db] currentConversion fallback:', error.message) }),
  windowDaysForClick: (click) => campaigns.get(click.campaign)?.conversionWindowDays,
  record: (payload) => event('conversion', payload),
  onRecorded: ({ click, clickId, revenue, currency, status }) => {
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
    const [s,o,c,ts]=await Promise.all([fetch('/stats?'+p).then(r=>r.json()),fetch('/api/offers').then(r=>r.json()),fetch('/api/campaigns').then(r=>r.json()),fetch('/stats/timeseries?from='+new Date(Date.now()-6*86400000).toISOString().slice(0,10)).then(r=>r.json())]);
    lastStats=s;
    const campRows=Object.entries(s.byCampaign).map(([name,v])=>'<tr><td><a href="?campaign='+encodeURIComponent(name)+'" style="color:#087f7b;text-decoration:none;font-weight:650">'+esc(name)+'</a></td><td>'+v.clicks+'</td><td>'+v.conversions+'</td><td>'+((v.conversions/Math.max(v.clicks,1))*100).toFixed(2)+'%</td><td>'+fmt(v.revenue)+'</td></tr>').join('');
    const ctryRows=Object.entries(s.byCountry||{}).sort((a,b)=>b[1].clicks-a[1].clicks).slice(0,15).map(([ctry,v])=>'<tr><td>'+ctry+'</td><td>'+v.clicks+'</td><td>'+v.conversions+'</td><td>'+fmt(v.revenue)+'</td></tr>').join('');
    const offerRows=Object.entries(s.byOffer||{}).sort((a,b)=>b[1].clicks-a[1].clicks).map(([id,v])=>'<tr><td>'+id+'</td><td>'+v.clicks+'</td><td>'+v.conversions+'</td><td>'+((v.conversions/Math.max(v.clicks,1))*100).toFixed(2)+'%</td><td>'+fmt(v.revenue)+'</td></tr>').join('');
    const streamRows=Object.entries(s.byStream||{}).sort((a,b)=>b[1].clicks-a[1].clicks).map(([name,v])=>'<tr><td>'+esc(name)+'</td><td>'+v.clicks+'</td><td>'+v.conversions+'</td><td>'+((v.cr||0)*100).toFixed(2)+'%</td><td>'+fmt(v.revenue)+'</td><td>'+fmt(v.epc)+'</td></tr>').join('');
    const offerList=Object.entries(o.offers).map(([id,v])=>'<li><b>'+esc(id)+'</b> — '+esc(typeof v==='string'?v:v.url)+(v.postbackUrl?' <small>[S2S]</small>':'')+'</li>').join('');
    const campList=Object.entries(c.campaigns).map(([id,v])=>'<li><b>'+esc(id)+'</b> — '+esc(v.name)+' <button data-campaign="'+esc(id)+'" data-active="'+(!v.active)+'">'+(v.active?'Выключить':'Включить')+'</button></li>').join('');
    const campOpts='<option value="">Все кампании</option>'+Object.keys(c.campaigns).map(id=>'<option>'+id+'</option>').join('');
    const inp=k=>'<input id="f-'+k+'" '+(k==='from'||k==='to'?'type="date"':'placeholder="'+(k==='country'?'Страна (US)':'Оффер')+'"')+' style="font:inherit;border-radius:10px;padding:10px;border:1px solid #b8ded9;background:#fff;width:130px">';
    const spark=ts&&ts.series&&ts.series.length?'<div style="font-family:monospace;font-size:18px;letter-spacing:2px;color:#1a7f6e;margin:-6px 0 6px;line-height:1" title="Клики за 7 дней">'+sparkline(ts.series)+'</div><div style="font-size:11px;color:#999;margin-bottom:8px">7 дней</div>':'';
    document.querySelector('#app').innerHTML=
      '<div class="cards"><div class="card"><div class="muted">Клики</div><div class="value">'+s.clicks+'</div>'+spark+'</div>'
      +'<div class="card"><div class="muted">Конверсии</div><div class="value">'+s.conversions+'</div></div>'
      +'<div class="card"><div class="muted">CR</div><div class="value">'+((s.conversions/Math.max(s.clicks,1))*100).toFixed(2)+'%</div></div>'
      +'<div class="card"><div class="muted">Revenue</div><div class="value">'+fmt(s.revenue)+'</div></div></div>'
      +'<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px;align-items:center">'
      +'<select id="f-campaign" style="font:inherit;border-radius:10px;padding:10px 13px;border:1px solid #b8ded9;background:#fff">'+campOpts+'</select>'
      +inp('from')+inp('to')+inp('country')+inp('offer')
      +'<input id="f-stream" placeholder="Поток (или default)" aria-label="Фильтр по потоку">'
      +'<button id="f-apply">Применить</button>'
      +'<button id="f-csv" style="background:#1a7f6e">CSV</button></div>'
      +'<h2>По кампаниям</h2>'+tbl(campRows,['Кампания','Клики','Конв.','CR','Revenue'])
      +(offerRows?'<h2>По офферам</h2>'+tbl(offerRows,['Оффер','Клики','Конв.','CR','Revenue']):'')
      +(streamRows?'<h2>По потокам</h2>'+tbl(streamRows,['Поток','Клики','Конв.','CR','Revenue','EPC']):'')
      +(ctryRows?'<h2>По странам (топ-15)</h2>'+tbl(ctryRows,['Страна','Клики','Конв.','Revenue']):'')
      +'<h2>Добавить оффер</h2><form id="offer-form"><input name="id" placeholder="offer-id" required pattern="[A-Za-z0-9_-]{2,80}"><input name="url" type="url" placeholder="https://..." required><input name="postbackUrl" type="url" placeholder="S2S URL (необязательно)"><button>Сохранить</button></form>'
      +'<h2>Офферы</h2><ul>'+(offerList||'<li>Пока нет офферов</li>')+'</ul>'
      +'<h2>Кампании</h2><form id="campaign-form"><input name="id" placeholder="campaign-id" required pattern="[A-Za-z0-9_-]{2,80}"><input name="name" placeholder="Название" required><button>Создать</button></form>'
      +'<ul>'+(campList||'<li>Нет кампаний</li>')+'</ul>';
    for(const key of ['campaign','from','to','country','offer','stream'])document.querySelector('#f-'+key).value=q[key]||'';
    document.querySelector('#f-apply').onclick=()=>{const f={};for(const key of ['campaign','from','to','country','offer','stream']){const value=document.querySelector('#f-'+key).value;if(value)f[key]=value;}render(f);};
    document.querySelector('#f-csv').onclick=()=>{const rows=['campaign,clicks,conversions,cr,revenue',...Object.entries(lastStats.byCampaign||{}).map(([n,v])=>[n,v.clicks,v.conversions,((v.conversions/Math.max(v.clicks,1))*100).toFixed(2),v.revenue.toFixed(2)].join(','))].join('\\n');csvDownload(rows,'stats.csv');};
    document.querySelector('#offer-form').onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));if(!body.postbackUrl)delete body.postbackUrl;const r=await fetch('/api/offers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)return alert('Ошибка');render();};
    document.querySelector('#campaign-form').onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));const r=await fetch('/api/campaigns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)return alert('Ошибка');render();};
    document.querySelectorAll('[data-campaign]').forEach(b=>b.onclick=async()=>{await fetch('/api/campaigns/'+b.dataset.campaign,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({active:b.dataset.active==='true'})});render();});
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
const isBuyer = (req) => req.user?.role === 'buyer' && !bearerAuthorized(req);
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
const SETTINGS_DEFAULTS = { buyerSharePct: 35 };
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
  const csrfOk = req.headers['x-requested-with'] === 'umbrella' || bearerAuthorized(req);
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
    const created = await users.create({ email: body.email, password: body.password, role: body.role || 'buyer' });
    await audit(req, 'create', 'user', created.id, null, { email: created.email, role: created.role });
    return json(res, 201, { user: created });
  }
  const userDelete = path.match(/^\/api\/users\/([0-9a-f-]{36})$/);
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
    req.user = await sessionUser(req);
    if (requireLogin && isPrivatePath(url.pathname) && !req.user && !bearerAuthorized(req)) {
      if (url.pathname === '/dashboard') { res.writeHead(302, { location: `${basePath}/admin` }); return res.end(); }
      return json(res, 401, { error: 'login_required' });
    }
    if (url.pathname === '/stats' || url.pathname.startsWith('/stats/') || url.pathname === '/api/clicks' || url.pathname === '/api/conversions') {
      req.scope = campaignScope(req, url.searchParams.get('campaign') || null);
      if (req.scope.forbidden) return json(res, 403, { error: 'campaign_not_yours' });
    }
    if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/users' || url.pathname.startsWith('/api/users/')) {
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
      const params = {};
      for (const field of TRACK_FIELDS) {
        const value = url.searchParams.get(c.paramMap?.[field] || field);
        if (value) params[field] = value.slice(0, 255);
      }
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
          ...(network ? { asn: network.asn, isp: network.isp, datacenter: network.datacenter } : {}), stream: streamName, ...extra, ...(Object.keys(params).length ? { params } : {}), ...(cost ? { cost } : {}) });
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
        const picked = pickStream(c.streams, visitor, await cappedOffers(c.streams), c.streamRotation);
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
      if (!offer) return json(res, 404, { error: 'offer_not_found' });
      return await handleClick(campaignId, offerId, offer.url);
    }
    if (url.pathname === '/postback' && req.method === 'GET') {
      if (postbackSecret && !safeEqual(url.searchParams.get('secret'), postbackSecret)) return json(res, 401, { error: 'invalid_postback_secret' });
      try {
        const result = await recordPostback({ clickId: url.searchParams.get('click_id'),
          revenue: url.searchParams.get('revenue'), currency: url.searchParams.get('currency'), status: url.searchParams.get('status') });
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
      const GROUP_PROP = { campaign: 'byCampaign', offer: 'byOffer', stream: 'byStream', landing: 'byLanding', country: 'byCountry' };
      let rows;
      if (GROUP_PROP[group]) {
        const report = await stats({ campaign, allowed, from, to, currency, subid: url.searchParams.get('subid') || null,
          country: url.searchParams.get('country') || null, offer: url.searchParams.get('offer') || null, stream: url.searchParams.get('stream') || null });
        rows = Object.entries(report[GROUP_PROP[group]]).map(([key, v]) => ({ key, ...v }));
      } else if (TRACK_FIELDS.includes(group) || DIMENSION_FIELDS.includes(group)) {
        rows = (await paramReport({ field: group, campaign, allowed, from, to, currency })).map((r) => ({ key: r.value, ...r }));
      } else return json(res, 400, { error: 'invalid_group' });
      const columns = ['key', 'clicks', 'conversions', 'revenue', 'cost', 'cr', 'epc', 'rpm', 'uniqueClicks', 'leads', 'sales', 'rejected', 'pendingRevenue', 'profit', 'roi'];
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
      const pct = Number(body.buyerSharePct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return json(res, 400, { error: 'invalid_buyer_share' });
      const before = { ...settings };
      settings = { ...settings, buyerSharePct: Math.round(pct * 100) / 100 };
      await mkdir(dataDir, { recursive: true });
      await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
      await audit(req, 'update', 'settings', 'team', before, settings);
      return json(res, 200, settings);
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
      return json(res, 200, { offers: Object.fromEntries(offers) });
    }
    if (url.pathname === '/api/offers' && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const body = await readJson(req);
      if (!/^[a-z0-9_-]{2,80}$/i.test(String(body.id || '')) || !/^https:\/\//i.test(String(body.url || ''))) return json(res, 400, { error: 'id_and_https_url_required' });
      const offer = parseOffer({ url: String(body.url), postbackUrl: body.postbackUrl, dailyCap: body.dailyCap, name: body.name });
      if (!offer) return json(res, 400, { error: 'id_and_https_url_required' });
      offers.set(String(body.id), offer);
      await persistOffer(String(body.id), offer);
      await audit(req, 'create', 'offer', String(body.id), null, offer);
      return json(res, 201, { id: body.id, ...offer });
    }
    const offerUpdate = url.pathname.match(/^\/api\/offers\/([A-Za-z0-9_-]{2,80})$/);
    if (offerUpdate && req.method === 'PATCH') {
      const id = offerUpdate[1];
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      if (!offers.has(id)) return json(res, 404, { error: 'offer_not_found' });
      const body = await readJson(req);
      const cur = offers.get(id);
      const newUrl = body.url !== undefined ? String(body.url) : cur.url;
      const newPostbackUrl = body.postbackUrl !== undefined ? body.postbackUrl : cur.postbackUrl;
      const newDailyCap = body.dailyCap !== undefined ? body.dailyCap : cur.dailyCap;
      const updated = parseOffer({ url: newUrl, postbackUrl: newPostbackUrl, dailyCap: newDailyCap, name: body.name !== undefined ? body.name : cur.name });
      if (!updated) return json(res, 400, { error: 'invalid_url' });
      offers.set(id, updated);
      await persistOffer(id, updated);
      await audit(req, 'update', 'offer', id, cur, updated);
      return json(res, 200, { id, ...updated });
    }
    if (url.pathname === '/api/campaigns' && req.method === 'GET') {
      const allowed = scopeCampaigns(req);
      return json(res, 200, { campaigns: Object.fromEntries([...campaigns].filter(([id]) => !allowed || allowed.includes(id))) });
    }
    if (url.pathname === '/api/campaigns' && req.method === 'POST') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const body = await readJson(req);
      if (!/^[a-z0-9_-]{2,80}$/i.test(String(body.id || ''))) return json(res, 400, { error: 'valid_id_required' });
      if (campaigns.has(String(body.id)) && !canEditCampaign(req, campaigns.get(String(body.id)))) return json(res, 403, { error: 'campaign_not_yours' });
      // A buyer's new campaign is always theirs; the owner may assign it to someone.
      const ownerId = isBuyer(req) ? req.user.id : (body.ownerId ?? req.user?.id ?? null);
      campaigns.set(String(body.id), parseCampaign(String(body.id), { ...body, ownerId }));
      await persistCampaign(String(body.id), campaigns.get(String(body.id)));
      await audit(req, 'create', 'campaign', String(body.id), null, campaigns.get(String(body.id)));
      return json(res, 201, { id: body.id, ...campaigns.get(String(body.id)) });
    }
    const campaignUpdate = url.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9_-]{2,80})$/);
    if (campaignUpdate && req.method === 'PATCH') {
      if (!(await adminAuthorized(req))) return json(res, 401, { error: 'admin_authorization_required' });
      const id = campaignUpdate[1];
      if (!campaigns.has(id)) return json(res, 404, { error: 'campaign_not_found' });
      if (!canEditCampaign(req, campaigns.get(id))) return json(res, 403, { error: 'campaign_not_yours' });
      const body = await readJson(req);
      const cur = campaigns.get(id);
      campaigns.set(id, parseCampaign(id, {
        name: body.name === undefined ? cur.name : body.name,
        active: body.active === undefined ? cur.active : body.active,
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
        ownerId: body.ownerId === undefined || req.user?.role === 'buyer' ? cur.ownerId : body.ownerId,
        redirectMethod: body.redirectMethod === undefined ? cur.redirectMethod : body.redirectMethod,
        blockedIps: body.blockedIps === undefined ? cur.blockedIps : body.blockedIps,
        allowedIps: body.allowedIps === undefined ? cur.allowedIps : body.allowedIps,
        totalCap: body.totalCap === undefined ? cur.totalCap : body.totalCap,
        conversionWindowDays: body.conversionWindowDays === undefined ? cur.conversionWindowDays : body.conversionWindowDays,
        paramMap: body.paramMap === undefined ? cur.paramMap : body.paramMap,
        costModel: body.costModel === undefined ? cur.costModel : body.costModel,
        cpc: body.cpc === undefined ? cur.cpc : body.cpc,
        costFromParam: body.costFromParam === undefined ? cur.costFromParam : body.costFromParam,
      }));
      await persistCampaign(id, campaigns.get(id));
      await audit(req, 'update', 'campaign', id, cur, campaigns.get(id));
      return json(res, 200, { id, ...campaigns.get(id) });
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
      const granularity = url.searchParams.get('granularity') === 'hour' ? 'hour' : 'day';
      const tsCurrency = reportCurrency(url.searchParams.get('currency'));
      if (tsFrom && !/^\d{4}-\d{2}-\d{2}$/.test(tsFrom)) return json(res, 400, { error: 'invalid_from_date' });
      if (tsTo && !/^\d{4}-\d{2}-\d{2}$/.test(tsTo)) return json(res, 400, { error: 'invalid_to_date' });
      if (db) {
        try {
          const conds = [], params = [];
          if (tsCampaign) { params.push(tsCampaign); conds.push(`c.campaign = $${params.length}`); }
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
              ${SQL_CONVERSIONS}::int               AS conversions,
              ${fx.revenue}::float                  AS revenue
            FROM clicks c
            LEFT JOIN conversions cv USING (click_id)
            ${where}
            GROUP BY bucket ORDER BY bucket
          `, params);
          return json(res, 200, { granularity, currency: tsCurrency, series: rows.map((r) => ({ date: r.bucket.toISOString().slice(0, granularity === 'hour' ? 13 : 10), clicks: r.clicks, conversions: r.conversions, revenue: r.revenue })) });
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
          buckets[b] ||= { clicks: 0, conversions: 0, revenue: 0 };
          buckets[b].clicks += 1;
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
await loadOffers();
await loadLandings();
await loadCampaigns();
server.listen(port, '127.0.0.1', () => console.log(`Product Umbrella listening on http://127.0.0.1:${server.address().port}`));

async function shutdown() { await new Promise((resolve) => server.close(resolve)); await eventMirror?.drain(); await closeDb(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
