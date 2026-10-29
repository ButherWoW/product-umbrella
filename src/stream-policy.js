// No-cloaking policy (owner's rule): bots, crawlers and ad-platform reviewers must get the same destination as people.
// A stream condition that singles them out (data-center connections, bot/crawler/ad-review User-Agents, ISPs of ad
// platforms or cloud hosts — positive or under «НЕ») is refused on save and switches the stream off on load.
// Pure and dependency-free: imported by the server, the Keitaro import script and the admin panel (/admin/stream-policy.js).

// Bot / crawler / automation User-Agents. Matched against the visitor's User-Agent for the bot filter.
export const BOT_UA_RE = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|headless|phantomjs|selenium|puppeteer|playwright|lighthouse|pingdom|uptimerobot|scrapy|curl\/|wget\/|python-requests|python-urllib|aiohttp|go-http-client|java\/|okhttp|apache-httpclient|libwww-perl/i;
// Hosting / cloud networks: real visitors do not browse from these; crawlers, scanners and review bots do.
export const DATACENTER_RE = /\b(amazon|google llc|google cloud|microsoft|azure|digitalocean|ovh|hetzner|linode|akamai|vultr|oracle|alibaba|tencent|cloudflare|leaseweb|contabo|scaleway|choopa|m247|datacamp|facebook|hostinger|ionos|hosting|servers?|data ?cent(er|re)s?|colocation)\b/i;

// Ad-review and crawler agents. A User-Agent condition that is part of one of these (e.g. "google", "bing", "meta")
// or contains one is refused. Plain browser tokens (chrome, safari, iphone, fban…) are not on the list.
const REVIEW_AGENTS = ['facebookexternalhit', 'facebookcatalog', 'facebot', 'meta-externalagent', 'meta-externalfetcher', 'meta-webindexer',
  'googlebot', 'adsbot-google', 'mediapartners-google', 'google-inspectiontool', 'googleother', 'apis-google', 'storebot-google', 'google-adwords', 'feedfetcher-google',
  'bingbot', 'adidxbot', 'bingpreview', 'msnbot', 'bytespider', 'bytedance', 'tiktok', 'tiktokspider', 'applebot', 'twitterbot', 'pinterestbot',
  'linkedinbot', 'yandexbot', 'yandexdirect', 'baiduspider', 'duckduckbot', 'petalbot', 'amazonbot', 'semrushbot', 'ahrefsbot'];
// Ad platforms and cloud hosts. An ISP condition naming (part of) one of these is refused.
const PLATFORM_ISPS = ['facebook', 'meta platforms', 'meta', 'instagram', 'google', 'youtube', 'microsoft', 'azure', 'bing', 'amazon', 'aws',
  'tiktok', 'bytedance', 'apple', 'twitter', 'x corp', 'pinterest', 'snap inc', 'linkedin', 'yandex', 'baidu', 'cloudflare', 'digitalocean', 'ovh', 'hetzner',
  'linode', 'akamai', 'vultr', 'oracle', 'alibaba', 'tencent', 'leaseweb', 'contabo', 'scaleway', 'choopa', 'm247', 'datacamp', 'hostinger', 'ionos', 'fastly', 'zscaler'];

const fragmentOf = (value, list) => list.some((item) => value.includes(item) || (value.length >= 3 && item.includes(value)));
const LABELS = { connections: 'Тип соединения', userAgents: 'User-Agent', isps: 'Провайдеры' };

// First forbidden value in a stream's conditions → { condition, value } or null.
export function cloakingCondition(conditions) {
  const c = conditions && typeof conditions === 'object' ? conditions : {};
  const connections = Array.isArray(c.connections) ? c.connections.map((x) => String(x).toLowerCase()) : [];
  if (connections.includes('datacenter')) return { condition: 'connections', value: 'datacenter' };
  // «mobile + broadband» is «everything except data centers» spelled the other way round.
  if (connections.includes('mobile') && connections.includes('broadband')) return { condition: 'connections', value: connections.join(', ') };
  for (const raw of Array.isArray(c.userAgents) ? c.userAgents : []) {
    const value = String(raw).trim().toLowerCase();
    if (value && (BOT_UA_RE.test(value) || fragmentOf(value, REVIEW_AGENTS))) return { condition: 'userAgents', value };
  }
  for (const raw of Array.isArray(c.isps) ? c.isps : []) {
    const value = String(raw).trim().toLowerCase();
    if (value && (DATACENTER_RE.test(value) || fragmentOf(value, PLATFORM_ISPS))) return { condition: 'isps', value };
  }
  return null;
}

export const cloakingMessage = (streamName, found) => `Поток «${streamName || 'без названия'}»: условие «${LABELS[found.condition]}» со значением «${found.value}» запрещено. `
  + 'Боты, модераторы и проверки рекламных систем должны попадать туда же, куда и люди — клоакинг не допускается. Уберите это условие (и с «НЕ» тоже).';

// A stream switched off because of this policy keeps its conditions so the owner can see and fix them.
export const disabledByPolicy = (s) => s?.enabled === false && s.disabledBy === 'policy';

// Streams about to be saved → the 400 body for the first forbidden one, or null. Streams already switched off by the
// policy are allowed through unchanged, so the rest of the campaign stays editable; they cannot be switched back on
// while the condition is there.
export function streamPolicyError(streams) {
  for (const s of Array.isArray(streams) ? streams : []) {
    if (!s || typeof s !== 'object' || disabledByPolicy(s)) continue;
    const found = cloakingCondition(s.conditions);
    if (found) return { error: 'cloaking_condition_not_allowed', stream: s.name ?? null, condition: found.condition, value: found.value, message: cloakingMessage(s.name, found) };
  }
  return null;
}
