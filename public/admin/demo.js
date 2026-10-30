// Public demo (/demo): the panel on made-up data. admin.js sends every request here instead of the network (see `send`
// in admin.js), so nobody without an account reaches the real API. Reads get answers in the same shape as the real
// endpoints (src/server.js, src/event-logs.js); every write is refused with 403. The traffic is generated
// deterministically for the last DAYS days up to now, and reports are built from it with the server's own module
// (src/stats-report.js, served as stats-report.js), so filters, groupings and logs agree with each other.
import { metrics, reportFromEvents } from './stats-report.js';

export const DENIED = 'Хуй тебе';
const DAYS = 45;
const DAY_MS = 86400000;
const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const dayIso = (n) => new Date(Date.parse(TODAY + 'T00:00:00Z') - n * DAY_MS).toISOString().slice(0, 10);

// ---------- deterministic random ----------
function seeded(text) {
  let a = 2166136261;
  for (const ch of text) a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickWeighted = (rnd, items, weight = (x) => x.weight ?? 1) => {
  const total = items.reduce((s, x) => s + weight(x), 0);
  let r = rnd() * total;
  for (const x of items) { r -= weight(x); if (r < 0) return x; }
  return items[items.length - 1];
};
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
const hex = (rnd, n) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
const uuid = (rnd) => `${hex(rnd, 8)}-${hex(rnd, 4)}-4${hex(rnd, 3)}-a${hex(rnd, 3)}-${hex(rnd, 12)}`;
const round = (v, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;

// ---------- team and settings ----------
const at = (daysAgo, hour = 10) => new Date(Date.parse(dayIso(daysAgo) + 'T00:00:00Z') + hour * 3600000).toISOString();
const OWNER = { id: '00000000-0000-4000-a000-000000000001', email: 'demo@demo.example', role: 'owner', createdAt: at(120), hideRevenue: false, offersAccess: 'all', viewAll: false };
const USERS = [OWNER,
  { id: '00000000-0000-4000-a000-000000000002', email: 'anna.buyer@demo.example', role: 'buyer', createdAt: at(90), hideRevenue: false, offersAccess: 'all', viewAll: false },
  { id: '00000000-0000-4000-a000-000000000003', email: 'ivan.buyer@demo.example', role: 'buyer', createdAt: at(60), hideRevenue: true, offersAccess: 'own', viewAll: false },
  { id: '00000000-0000-4000-a000-000000000004', email: 'analyst@demo.example', role: 'viewer', createdAt: at(30), hideRevenue: false, offersAccess: 'all', viewAll: true }];
const [, ANNA, IVAN] = USERS;
const KEYS = [
  { id: '00000000-0000-4000-b000-000000000001', name: 'Отчёты в таблицу (demo)', last4: 'd3m0', userId: OWNER.id, email: OWNER.email, createdAt: at(40), lastUsedAt: at(0, 6) },
  { id: '00000000-0000-4000-b000-000000000002', name: 'Скрипт расходов (demo)', last4: 'x9k2', userId: ANNA.id, email: ANNA.email, createdAt: at(20), lastUsedAt: null }];
const SETTINGS = { buyerSharePct: 30, dailyRevenueGoal: 1500, dailyProfitGoal: 600 };
const RATES = { defaultCurrency: 'EUR', base: 'EUR', updatedAt: at(0, 3), source: 'demo', currencies: ['EUR', 'USD', 'RUB'], rates: { EUR: 1, USD: 1.08, RUB: 98.5 } };
const DOMAINS = { primary: 'tracker.demo.example', domains: ['go.demo.example', 'click.demo.example'] };

// ---------- references ----------
const NETWORKS = {
  'demo-net-alpha': { name: 'Alpha Leads (demo)', offerParams: 'aff_id=1001&sub1={click_id}', clickIdParam: 'sub1', payoutParam: 'payout', notes: 'Выдуманная партнёрка для демо.', ownerId: null },
  'demo-net-beta': { name: 'Beta CPA (demo)', offerParams: 'pid=demo&clickid={click_id}', clickIdParam: 'clickid', payoutParam: 'sum', notes: '', ownerId: ANNA.id },
  'demo-net-gamma': { name: 'Gamma Ads (demo)', offerParams: '', clickIdParam: 'sub1', payoutParam: 'payout', notes: 'Только CPC-офферы.', ownerId: null },
};
const SOURCES = {
  'demo-facebook': { name: 'Facebook (demo)', paramMap: { sub_id_1: 'ad_id', sub_id_2: 'adset_id', creative_id: 'ad_name' }, costModel: 'cpc', cpc: 0.11, costFromParam: false,
    postbackUrl: null, postbackStatuses: ['sale'], ownerId: null },
  'demo-tiktok': { name: 'TikTok (demo)', paramMap: { sub_id_1: 'cid', sub_id_2: 'aid' }, costModel: 'cpc', cpc: 0.08, costFromParam: true,
    postbackUrl: 'https://postback.demo.example/tt?click={external_id}&event={status}', postbackStatuses: ['lead', 'sale'], ownerId: ANNA.id },
  'demo-push': { name: 'Push network (demo)', paramMap: { sub_id_1: 'zone' }, costModel: 'none', cpc: 0, costFromParam: false, postbackUrl: null, postbackStatuses: ['sale'], ownerId: null },
};
const LANDINGS = {
  'demo-lp-quiz': { url: 'https://lp.demo.example/quiz', name: 'Квиз «Подбери наушники»', ownerId: null },
  'demo-lp-review': { url: 'https://lp.demo.example/review', name: 'Обзор-сравнение', ownerId: ANNA.id },
  'demo-lp-video': { url: 'https://lp.demo.example/video', name: 'Видео-преленд', ownerId: null },
  'demo-lp-story': { url: 'https://lp.demo.example/story', name: 'История покупателя', ownerId: IVAN.id },
};
const offer = (o) => ({ url: '', postbackUrl: null, payoutType: 'cpa', payout: null, payoutCurrency: 'EUR', dailyCap: null, name: null, networkId: null, archived: false, group: '',
  conversionCap: null, capTz: 'UTC', altOfferId: null, ownerId: null, ...o });
const OFFERS = {
  'demo-offer-headphones': offer({ url: 'https://offers.demo.example/headphones?cid={click_id}', name: 'Наушники Demo Pro', payout: 24, networkId: 'demo-net-alpha', group: 'Электроника', cr: 0.045 }),
  'demo-offer-speaker': offer({ url: 'https://offers.demo.example/speaker?cid={click_id}', name: 'Колонка Demo Boom', payout: 18, networkId: 'demo-net-alpha', group: 'Электроника', cr: 0.05,
    conversionCap: 40, capTz: 'Europe/Paris', altOfferId: 'demo-offer-headphones' }),
  'demo-offer-vacuum': offer({ url: 'https://offers.demo.example/vacuum?cid={click_id}', name: 'Робот-пылесос Demo', payout: 42, networkId: 'demo-net-beta', group: 'Дом', cr: 0.028, ownerId: ANNA.id }),
  'demo-offer-blender': offer({ url: 'https://offers.demo.example/blender?cid={click_id}', name: 'Блендер Demo Mix', payout: 15, networkId: 'demo-net-beta', group: 'Дом', cr: 0.06, dailyCap: 3000 }),
  'demo-offer-watch': offer({ url: 'https://offers.demo.example/watch?cid={click_id}', name: 'Смарт-часы Demo Fit', payout: 30, networkId: 'demo-net-alpha', group: 'Электроника', cr: 0.035 }),
  'demo-offer-garden': offer({ url: 'https://offers.demo.example/garden?cid={click_id}', name: 'Садовый набор Demo', payout: 0.35, payoutType: 'cpc', networkId: 'demo-net-gamma', group: 'Сад', cr: 0, ownerId: IVAN.id }),
  'demo-offer-coffee': offer({ url: 'https://offers.demo.example/coffee?cid={click_id}', name: 'Кофемашина Demo Bar', payout: 55, networkId: 'demo-net-beta', group: 'Дом', cr: 0.022 }),
  'demo-offer-old': offer({ url: 'https://offers.demo.example/old?cid={click_id}', name: 'Старый оффер (архив)', payout: 12, networkId: 'demo-net-alpha', archived: true, cr: 0.03 }),
};
const NO_CONDITIONS = { countries: [], devices: [], os: [], browsers: [], languages: [], isps: [] };
const stream = (s) => ({ name: 'Main', type: 'regular', conditions: { ...NO_CONDITIONS, ...(s.conditions || {}) }, weight: 1, offers: [], ...s });
const campaign = (c) => ({ name: '', group: '', active: true, archived: false, streams: [], dailyCap: null, capUrl: null, allowDevices: [], allowOS: [], allowBrowsers: [], allowGeos: [],
  geoCapUrl: null, dedupeWindow: 0, revenueCap: null, botFilter: true, datacenterAsBot: false, domain: null, streamRotation: 'weight', uniquenessHours: 24, bindVisitors: 'off',
  bindTtlHours: 24, ownerId: OWNER.id, redirectMethod: 'http', blockedIps: [], allowedIps: [], totalCap: null, paramMap: {}, costModel: 'cpc', cpc: 0.1, costFromParam: false,
  conversionWindowDays: null, sourceId: null, sourcePostbackUrl: null, sourcePostbackStatuses: [], monitoring: 'notify', ...c });
// Not part of the API answer: how much traffic the generator makes for a campaign.
const TRAFFIC = {
  'demo-fr-audio': { daily: 260, geos: ['FR', 'BE', 'CH'], trend: 0.012 },
  'demo-de-home': { daily: 190, geos: ['DE', 'AT', 'CH'], trend: 0.004 },
  'demo-es-watch': { daily: 150, geos: ['ES', 'PT'], trend: -0.006 },
  'demo-it-mix': { daily: 120, geos: ['IT'], trend: 0.02 },
  'demo-pl-garden': { daily: 90, geos: ['PL', 'CZ'], trend: 0, pausedDaysAgo: 6 },
  'demo-uk-coffee': { daily: 70, geos: ['GB', 'IE'], trend: 0, endedDaysAgo: 20 },
};
const CAMPAIGNS = {
  'demo-fr-audio': campaign({ name: 'Demo Campaign FR — наушники', group: 'Электроника', sourceId: 'demo-facebook', cpc: 0.24, paramMap: SOURCES['demo-facebook'].paramMap, domain: 'go.demo.example',
    allowGeos: ['FR', 'BE', 'CH'], streams: [
      stream({ name: 'iOS', type: 'forced', conditions: { os: ['ios'] }, offers: [{ offerId: 'demo-offer-headphones', weight: 1 }], landings: [{ landingId: 'demo-lp-quiz', weight: 1 }] }),
      stream({ name: 'Main', weight: 3, offers: [{ offerId: 'demo-offer-headphones', weight: 60 }, { offerId: 'demo-offer-speaker', weight: 40 }], landings: [{ landingId: 'demo-lp-quiz', weight: 1 }, { landingId: 'demo-lp-review', weight: 1 }] }),
      stream({ name: 'Rest', type: 'fallback', offers: [{ offerId: 'demo-offer-speaker', weight: 1 }] })] }),
  'demo-de-home': campaign({ name: 'Demo Campaign DE — дом', group: 'Дом', sourceId: 'demo-facebook', cpc: 0.3, paramMap: SOURCES['demo-facebook'].paramMap, ownerId: ANNA.id, dailyCap: 5000,
    streams: [
      stream({ name: 'Main', offers: [{ offerId: 'demo-offer-vacuum', weight: 50 }, { offerId: 'demo-offer-blender', weight: 50 }], landings: [{ landingId: 'demo-lp-review', weight: 1 }] }),
      stream({ name: 'Rest', type: 'fallback', offers: [{ offerId: 'demo-offer-blender', weight: 1 }] })] }),
  'demo-es-watch': campaign({ name: 'Demo Campaign ES — часы', group: 'Электроника', sourceId: 'demo-tiktok', cpc: 0.18, costFromParam: true, paramMap: SOURCES['demo-tiktok'].paramMap, ownerId: ANNA.id,
    streams: [stream({ name: 'Main', offers: [{ offerId: 'demo-offer-watch', weight: 1 }], landings: [{ landingId: 'demo-lp-video', weight: 1 }] })] }),
  'demo-it-mix': campaign({ name: 'Demo Campaign IT — сплит-тест', group: 'Тесты', sourceId: 'demo-tiktok', cpc: 0.42, ownerId: IVAN.id, streamRotation: 'position',
    streams: [
      stream({ name: 'A', weight: 1, offers: [{ offerId: 'demo-offer-watch', weight: 1 }], landings: [{ landingId: 'demo-lp-story', weight: 1 }] }),
      stream({ name: 'B', weight: 1, offers: [{ offerId: 'demo-offer-headphones', weight: 1 }], landings: [{ landingId: 'demo-lp-quiz', weight: 1 }] })] }),
  'demo-pl-garden': campaign({ name: 'Demo Campaign PL — сад (пауза)', group: 'Сад', active: false, sourceId: 'demo-push', costModel: 'cpc', cpc: 0.26, ownerId: IVAN.id,
    streams: [stream({ name: 'Main', offers: [{ offerId: 'demo-offer-garden', weight: 1 }] })] }),
  'demo-uk-coffee': campaign({ name: 'Demo Campaign UK — кофе (архив)', group: 'Дом', active: false, archived: true, sourceId: 'demo-facebook', cpc: 0.3,
    streams: [stream({ name: 'Main', offers: [{ offerId: 'demo-offer-coffee', weight: 1 }] })] }),
};
const publicOffers = () => Object.fromEntries(Object.entries(OFFERS).map(([id, { cr, ...o }]) => [id, o]));

// ---------- traffic ----------
const LANGUAGE = { FR: 'fr', BE: 'fr', CH: 'de', DE: 'de', AT: 'de', ES: 'es', PT: 'pt', IT: 'it', PL: 'pl', CZ: 'cs', GB: 'en', IE: 'en' };
const ISPS = ['Demo Mobile', 'Example Telecom', 'Sample Fiber', 'Test Cable Net'];
const UA = {
  ios: ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', 'safari'],
  android: ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', 'chrome'],
  samsung: ['Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36', 'samsung'],
  windows: ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'chrome'],
  edge: ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0', 'edge'],
  macos: ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', 'safari'],
  ipad: ['Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', 'safari'],
};
const BOT_UA = [['Mozilla/5.0 (compatible; DemoCrawler/2.1; +https://bot.demo.example)', 'user_agent'], ['python-requests/2.31.0', 'user_agent'], ['curl/8.4.0', 'user_agent'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'datacenter']];
const REFERRERS = { 'demo-facebook': ['https://m.facebook.com/', 'https://l.facebook.com/', null], 'demo-tiktok': ['https://www.tiktok.com/', null], 'demo-push': [null] };
const SOURCE_TAG = { 'demo-facebook': 'facebook', 'demo-tiktok': 'tiktok', 'demo-push': 'push' };
const docIp = (rnd) => `${pick(rnd, ['192.0.2', '198.51.100', '203.0.113'])}.${1 + Math.floor(rnd() * 254)}`;

const clicks = [];
const conversions = [];
const bots = [];
for (const [id, c] of Object.entries(CAMPAIGNS)) {
  const t = TRAFFIC[id];
  const streams = c.streams.filter((s) => s.type !== 'fallback' && s.type !== 'forced');
  const forced = c.streams.find((s) => s.type === 'forced');
  const fallback = c.streams.find((s) => s.type === 'fallback');
  for (let back = DAYS - 1; back >= 0; back--) {
    if (t.pausedDaysAgo !== undefined && back < t.pausedDaysAgo) continue;
    if (t.endedDaysAgo !== undefined && back < t.endedDaysAgo) continue;
    const day = dayIso(back);
    const rnd = seeded(`${id}|${day}`);
    const dayStart = Date.parse(day + 'T00:00:00Z');
    const weekend = [0, 6].includes(new Date(dayStart).getUTCDay()) ? 0.82 : 1;
    let count = Math.round(t.daily * weekend * Math.max(0.3, 1 + t.trend * (DAYS - back - 30)) * (0.75 + rnd() * 0.5));
    const span = back === 0 ? Math.max(0, NOW - dayStart) : DAY_MS;
    if (back === 0) count = Math.round(count * span / DAY_MS);
    for (let i = 0; i < count; i++) {
      // Daytime peak: more clicks between 08:00 and 23:00.
      let offsetMs = rnd() * span;
      const peak = (8 + rnd() * 15) * 3600000;
      if (rnd() < 0.35 && peak < span) offsetMs = peak;
      const time = dayStart + offsetMs;
      const device = pickWeighted(rnd, [{ v: 'mobile', weight: 70 }, { v: 'desktop', weight: 22 }, { v: 'tablet', weight: 8 }]).v;
      const uaKey = device === 'mobile' ? pickWeighted(rnd, [{ v: 'ios', weight: 45 }, { v: 'android', weight: 40 }, { v: 'samsung', weight: 15 }]).v
        : device === 'tablet' ? 'ipad' : pickWeighted(rnd, [{ v: 'windows', weight: 55 }, { v: 'edge', weight: 15 }, { v: 'macos', weight: 30 }]).v;
      const os = { ios: 'ios', ipad: 'ios', android: 'android', samsung: 'android', windows: 'windows', edge: 'windows', macos: 'macos' }[uaKey];
      const s = forced && os === 'ios' ? forced : rnd() < 0.08 && fallback ? fallback : pickWeighted(rnd, streams.length ? streams : c.streams);
      const offerId = pickWeighted(rnd, s.offers).offerId;
      const landingId = s.landings?.length ? pickWeighted(rnd, s.landings).landingId : null;
      const country = rnd() < 0.82 ? t.geos[0] : rnd() < 0.85 ? pick(rnd, t.geos) : pick(rnd, ['US', 'NL', 'SE']);
      const o = OFFERS[offerId];
      const ad = 1 + Math.floor(rnd() * 6);
      const clickId = uuid(rnd);
      const click = { type: 'click', clickId, campaign: id, offerId, at: new Date(time).toISOString(), stream: s.name, path: `/r/${id}`,
        referrer: pick(rnd, REFERRERS[c.sourceId] || [null]), userAgent: UA[uaKey][0], subid: `s${1 + Math.floor(rnd() * 20)}`, country, ip: docIp(rnd),
        params: { sub_id_1: `ad_${id.split('-')[1]}_${ad}`, sub_id_2: `adset_${1 + (ad % 3)}`, creative_id: `cr-${String(ad).padStart(2, '0')}`, source: SOURCE_TAG[c.sourceId] || 'direct' },
        cost: c.costModel === 'cpc' ? round(c.cpc * (0.7 + rnd() * 0.6)) : 0, landingId,
        device, os, browser: UA[uaKey][1], language: LANGUAGE[country] || 'en', isp: pick(rnd, ISPS), connection: rnd() < 0.62 ? 'mobile' : 'broadband' };
      click.uniqueCampaign = rnd() < 0.88;
      click.uniqueStream = click.uniqueCampaign || rnd() < 0.3;
      click.uniqueGlobal = click.uniqueCampaign && rnd() < 0.9;
      click.lpClicked = Boolean(landingId) && rnd() < 0.42;
      if (o.payoutType === 'cpc') click.revenue = o.payout;
      clicks.push(click);
      // Conversions: ad 1 and 2 convert better, so reports by sub_id_1 show winners and losers.
      const cr = 0.8 * o.cr * (ad <= 2 ? 1.6 : ad >= 5 ? 0.5 : 1) * (landingId && !click.lpClicked ? 0.4 : 1.2);
      if (o.payoutType === 'cpa' && rnd() < cr) {
        const status = pickWeighted(rnd, [{ v: 'sale', weight: 58 }, { v: 'lead', weight: 27 }, { v: 'rejected', weight: 11 }, { v: 'trash', weight: 4 }]).v;
        const convAt = Math.min(NOW - 1000, time + (5 + rnd() * 360) * 60000);
        conversions.push({ type: 'conversion', clickId, campaign: id, offerId, at: new Date(convAt).toISOString(), updatedAt: new Date(convAt).toISOString(), stream: s.name,
          revenue: o.payout, status, currency: o.payoutCurrency || 'EUR', tid: '', revenueIgnored: false });
      }
    }
    // Bots: a few per day, more on the push campaign.
    const botCount = Math.round(count * (c.sourceId === 'demo-push' ? 0.12 : 0.03) * rnd() * 2);
    for (let i = 0; i < botCount; i++) {
      const [userAgent, reason] = pick(rnd, BOT_UA);
      const s = c.streams[0];
      bots.push({ at: new Date(dayStart + rnd() * span).toISOString(), campaign: id, offerId: s.offers[0].offerId, stream: s.name, reason,
        isp: reason === 'datacenter' ? 'Demo Cloud Hosting' : pick(rnd, ISPS), userAgent, ip: docIp(rnd) });
    }
  }
}
const byTimeDesc = (a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : b.clickId < a.clickId ? -1 : 1);
clicks.sort(byTimeDesc);
conversions.sort(byTimeDesc);
bots.sort((a, b) => (b.at < a.at ? -1 : 1));
const conversionsByClick = new Map(conversions.map((cv) => [cv.clickId, [cv]]));

// ---------- audit ----------
const AUDIT = (() => {
  const rnd = seeded('audit');
  const list = [];
  const actors = [OWNER.email, ANNA.email, IVAN.email];
  for (let back = 1; back <= 30; back++) {
    for (let i = 0; i < 2; i++) {
      const [entity, entityId] = pick(rnd, [...Object.keys(CAMPAIGNS).map((x) => ['campaign', x]), ...Object.keys(OFFERS).map((x) => ['offer', x]), ...Object.keys(LANDINGS).map((x) => ['landing', x])]);
      const action = pick(rnd, ['update', 'update', 'update', 'pause', 'login']);
      const changes = action === 'login' ? null : action === 'pause' ? { active: [true, false], reason: [null, 'dailyCap'] }
        : entity === 'campaign' ? { cpc: [round(0.05 + rnd() * 0.1, 2), round(0.05 + rnd() * 0.1, 2)] }
          : entity === 'offer' ? { payout: [Math.round(10 + rnd() * 40), Math.round(10 + rnd() * 40)] } : { name: ['Старое название', LANDINGS[entityId].name] };
      list.push({ at: at(back, 9 + Math.floor(rnd() * 12)), actor: pick(rnd, actors), action, entity: action === 'login' ? 'user' : entity,
        entityId: action === 'login' ? OWNER.id : entityId, changes });
    }
  }
  for (const [id, c] of Object.entries(CAMPAIGNS)) list.push({ at: at(DAYS + 2), actor: OWNER.email, action: 'create', entity: 'campaign', entityId: id, changes: { name: [null, c.name] } });
  return list.sort((a, b) => (b.at < a.at ? -1 : 1));
})();

// ---------- monitor ----------
const MONITOR = (() => {
  const checkedAt = new Date(NOW - 4 * 60000).toISOString();
  const targets = [];
  for (const [id, c] of Object.entries(CAMPAIGNS)) {
    if (!c.active) continue;
    for (const s of c.streams) for (const o of s.offers) {
      const url = OFFERS[o.offerId].url.split('?')[0];
      let row = targets.find((x) => x.url === url);
      const down = o.offerId === 'demo-offer-blender';
      if (!row) targets.push(row = { url, ok: !down, status: down ? 503 : 200, error: null, checkedAt, downSince: down ? new Date(NOW - 47 * 60000).toISOString() : null, failures: down ? 3 : 0, campaigns: [] });
      if (!row.campaigns.some((x) => x.campaign === id && x.stream === s.name)) row.campaigns.push({ campaign: id, name: c.name, stream: s.name, target: 'offer', mode: c.monitoring });
    }
  }
  return { enabled: true, intervalMs: 600000, targets: targets.sort((a, b) => Number(a.ok) - Number(b.ok) || a.url.localeCompare(b.url)) };
})();

// ---------- queries ----------
const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const inRange = (iso, from, to) => (!from || iso.slice(0, 10) >= from) && (!to || iso.slice(0, 10) <= to);
const factorOf = (currency) => (RATES.rates[currency] || 1) / RATES.rates[RATES.defaultCurrency];
const reportCurrency = (q) => (RATES.currencies.includes(q.get('currency')) ? q.get('currency') : RATES.defaultCurrency);

function selectClicks(q, { filters = true } = {}) {
  const campaign = q.get('campaign'); const from = date(q.get('from')); const to = date(q.get('to'));
  const offer = filters ? q.get('offer') : null; const country = filters ? q.get('country') : null;
  const streamName = filters ? q.get('stream') : null; const subid = filters ? q.get('subid') : null;
  return clicks.filter((c) => (!campaign || c.campaign === campaign) && (!offer || c.offerId === offer) && (!country || c.country === country.toUpperCase())
    && (!streamName || c.stream === streamName) && (!subid || c.subid === subid) && inRange(c.at, from, to));
}
// Amounts in the report currency, as the server converts them.
const inCurrency = (list, f, key = 'cost') => (f === 1 ? list : list.map((x) => ({ ...x, [key]: (Number(x[key]) || 0) * f, ...(x.revenue !== undefined ? { revenue: x.revenue * f } : {}) })));

function stats(q) {
  const currency = reportCurrency(q);
  const f = factorOf(currency);
  const list = inCurrency(selectClicks(q), f);
  const convs = inCurrency(list.flatMap((c) => conversionsByClick.get(c.clickId) || []), f, 'revenue');
  const report = { ...reportFromEvents(list, convs), currency };
  const convsOf = new Map(convs.map((cv) => [cv.clickId, [cv]]));
  for (const [key, of] of [['bySource', (c) => CAMPAIGNS[c.campaign]?.sourceId || 'none'], ['byNetwork', (c) => OFFERS[c.offerId]?.networkId || 'none']]) {
    const groups = new Map();
    for (const c of list) { const k = of(c); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
    report[key] = Object.fromEntries([...groups].map(([k, part]) => {
      const r = reportFromEvents(part, part.flatMap((c) => convsOf.get(c.clickId) || []));
      return [k, metrics({ clicks: r.clicks, conversions: r.conversions, revenue: r.revenue, cost: r.cost, uniqueClicks: r.uniqueClicks, leads: r.leads, sales: r.sales,
        rejected: r.rejected, trash: r.trash, pendingRevenue: r.pendingRevenue })];
    }));
  }
  return report;
}
const counts = (cv) => ['lead', 'sale'].includes(cv.status);
const saleRevenue = (cv) => (cv.status === 'sale' && !cv.revenueIgnored ? cv.revenue : 0);

function timeseries(q) {
  const currency = reportCurrency(q); const f = factorOf(currency);
  const granularity = q.get('granularity') === 'hour' ? 'hour' : 'day';
  const len = granularity === 'hour' ? 13 : 10;
  const buckets = {};
  for (const c of selectClicks(q, { filters: false }).filter((c) => !q.get('offer') || c.offerId === q.get('offer'))) {
    const b = buckets[c.at.slice(0, len)] ||= { clicks: 0, uniqueClicks: 0, conversions: 0, revenue: 0, cost: 0 };
    b.clicks += 1; if (c.uniqueCampaign) b.uniqueClicks += 1;
    b.cost += c.cost * f; b.revenue += (c.revenue || 0) * f;
    for (const cv of conversionsByClick.get(c.clickId) || []) if (counts(cv)) { b.conversions += 1; b.revenue += saleRevenue(cv) * f; }
  }
  return { granularity, currency, series: Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b)).map(([d, v]) => ({ date: d, ...v })) };
}

const DIMENSIONS = ['device', 'os', 'browser', 'language', 'isp', 'connection'];
function params(q) {
  const field = q.get('field') || '';
  const currency = reportCurrency(q); const f = factorOf(currency);
  const groups = new Map();
  for (const c of selectClicks(q, { filters: false })) {
    const key = (DIMENSIONS.includes(field) ? c[field] : c.params?.[field]) ?? '';
    const g = groups.get(key) || { value: key, clicks: 0, uniqueClicks: 0, conversions: 0, revenue: 0, cost: 0 };
    g.clicks += 1; if (c.uniqueCampaign) g.uniqueClicks += 1;
    g.cost += c.cost * f; g.revenue += (c.revenue || 0) * f;
    for (const cv of conversionsByClick.get(c.clickId) || []) if (counts(cv)) { g.conversions += 1; g.revenue += saleRevenue(cv) * f; }
    groups.set(key, g);
  }
  return { field, currency, rows: [...groups.values()].sort((a, b) => b.clicks - a.clicks).slice(0, 500).map(metrics) };
}

function top(q, key, fallback) {
  const campaign = q.get('campaign');
  const limit = Math.min(100, Math.max(1, Number(q.get('limit') || 20)));
  const tally = {};
  for (const c of clicks) if (!campaign || c.campaign === campaign) { const k = c[key] || fallback; tally[k] = (tally[k] || 0) + 1; }
  return Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, n]) => ({ [key]: value, clicks: n }));
}

function logPage(kind, q) {
  const limit = Math.min(Math.max(Number.parseInt(q.get('limit') || '50', 10) || 50, 1), 100);
  const offset = Math.max(Number.parseInt(q.get('offset') || '0', 10) || 0, 0);
  const from = date(q.get('from')); const to = date(q.get('to'));
  const source = kind === 'clicks' ? clicks : conversions;
  const rows = source.filter((x) => (!q.get('campaign') || x.campaign === q.get('campaign')) && (!q.get('offer') || x.offerId === q.get('offer'))
    && (!q.get('stream') || x.stream === q.get('stream')) && (!q.get('click') || x.clickId === q.get('click')) && inRange(x.at, from, to));
  const page = rows.slice(offset, offset + limit).map((x) => (kind === 'clicks'
    ? (({ lpClicked, revenue, ...c }) => ({ ...c, click_id: c.clickId, offer_id: c.offerId, created_at: c.at, user_agent: c.userAgent }))(x)
    : { ...x, click_id: x.clickId, offer_id: x.offerId, created_at: x.at }));
  const hasMore = rows.length > offset + limit;
  return { [kind]: page, limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null, storage: 'postgres' };
}

function botsIn(q) {
  const from = date(q.get('from')); const to = date(q.get('to')); const campaign = q.get('campaign');
  return bots.filter((b) => (!campaign || b.campaign === campaign) && inRange(b.at, from, to));
}

// GET path → answer. Paths are the panel's own (/api/…, /stats…), without the base path.
const ROUTES = {
  '/api/auth/me': () => ({ user: OWNER, setupRequired: false, loginRequired: true }),
  '/api/offers': () => ({ offers: publicOffers() }),
  '/api/campaigns': () => ({ campaigns: CAMPAIGNS }),
  '/api/landings': () => ({ landings: LANDINGS }),
  '/api/sources': () => ({ sources: SOURCES }),
  '/api/networks': () => ({ networks: NETWORKS }),
  '/api/domains': () => DOMAINS,
  '/api/users': () => ({ users: USERS }),
  '/api/rates': () => RATES,
  '/api/settings': () => SETTINGS,
  '/api/monitor': () => MONITOR,
  '/api/security': () => ({ adminAllowedIps: [], clientIp: '203.0.113.10', trustProxy: 1 }),
  '/api/keys': (q) => ({ keys: q.get('all') === '1' ? KEYS : KEYS.filter((k) => k.userId === OWNER.id) }),
  '/api/audit': (q) => {
    const limit = Math.min(Math.max(Number.parseInt(q.get('limit') || '100', 10) || 100, 1), 500);
    return { entries: AUDIT.filter((e) => (!q.get('entity') || e.entity === q.get('entity')) && (!q.get('id') || e.entityId === q.get('id'))).slice(0, limit) };
  },
  '/api/clicks': (q) => logPage('clicks', q),
  '/api/conversions': (q) => logPage('conversions', q),
  '/api/bots': (q) => ({ bots: botsIn(q).slice(0, Math.min(Math.max(Number(q.get('limit')) || 100, 1), 1000)) }),
  '/api/postbacks': (q) => ({ direction: q.get('direction') === 'out' ? 'out' : 'in', storage: 'postgres', postbacks: [] }),
  '/stats': stats,
  '/stats/timeseries': timeseries,
  '/stats/params': params,
  '/stats/bots': (q) => {
    const byCampaign = {};
    for (const b of botsIn(q)) byCampaign[b.campaign] = (byCampaign[b.campaign] || 0) + 1;
    return { total: Object.values(byCampaign).reduce((a, b) => a + b, 0), byCampaign };
  },
  '/stats/referrers': (q) => ({ referrers: top(q, 'referrer', 'direct') }),
  '/stats/paths': (q) => ({ paths: top(q, 'path', '/') }),
};

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** The demo's fetch: same arguments as fetch(ROOT + path, init), answered locally. */
export async function request(path, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return reply(403, { error: DENIED });
  const url = new URL(path, 'https://demo.invalid');
  const route = ROUTES[url.pathname];
  if (!route) return reply(404, { error: 'not_found' });
  return reply(200, route(url.searchParams));
}
