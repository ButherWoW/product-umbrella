#!/usr/bin/env node
// Copies OUR campaigns (Keitaro group "Erland") with their streams into Umbrella. Keitaro is only READ (GET).
// Dry run by default; --apply writes to Umbrella. Imported campaigns are created DISABLED — switch them on yourself.
//
//   node scripts/import-keitaro-campaigns.mjs                       # list our campaigns
//   node scripts/import-keitaro-campaigns.mjs --ids 4982,4980       # preview the mapping
//   node scripts/import-keitaro-campaigns.mjs --ids 4982 --apply    # import
//
// Not carried over on purpose: landings (retailer look-alike pages are not imported — streams go straight to the offer),
// filters without an Umbrella counterpart (the whole stream is skipped), the Keitaro tracking domain. All of this is printed per campaign.
// Reject-mode filters become `conditions.not`.
// Offers must already be in Umbrella as kt-<id> (scripts/import-keitaro-offers.mjs).
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { convertUrl } from './import-keitaro-offers.mjs';

const OUR_GROUPS = ['Erland'];
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const KEITARO_URL = (process.env.KEITARO_URL || 'https://whynot.partners').replace(/\/$/, '');
const UMBRELLA_URL = (process.env.UMBRELLA_URL || 'https://nespizdili.lol/umbrella').replace(/\/$/, '');
const secret = async (envName, file) => process.env[envName] || (await readFile(join(homedir(), file), 'utf8').catch(() => '')).trim();

const TYPES = { regular: 'regular', forced: 'forced', default: 'fallback' };
const DEVICES = { mobile: 'mobile', tablet: 'tablet', desktop: 'desktop' };
const OS = { android: 'android', ios: 'ios', windows: 'windows', 'mac os x': 'macos', macos: 'macos', 'os x': 'macos', linux: 'linux' };
const BROWSERS = { chrome: 'chrome', 'chrome mobile': 'chrome', safari: 'safari', 'mobile safari': 'safari', firefox: 'firefox', edge: 'edge', opera: 'opera', 'samsung internet': 'samsung', 'samsung browser': 'samsung' };
const FILTERS = {
  country: ['countries', (v) => String(v).toUpperCase().slice(0, 2)],
  device_type: ['devices', (v) => DEVICES[String(v).toLowerCase()]],
  os: ['os', (v) => OS[String(v).toLowerCase()]],
  browser: ['browsers', (v) => BROWSERS[String(v).toLowerCase()]],
  language: ['languages', (v) => String(v).toLowerCase().slice(0, 2)],
  // Umbrella matches the referrer's host+path, so the scheme is dropped.
  referrer: ['referrers', (v) => String(v).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').slice(0, 200)],
  keyword: ['keywords', (v) => String(v).trim().toLowerCase().slice(0, 200)],
  user_agent: ['userAgents', (v) => String(v).trim().toLowerCase().slice(0, 200)],
  ip: ['ips', (v) => (IP_RE.test(String(v).trim()) ? String(v).trim() : null)],
};
// Exact IPv4/IPv6 or IPv4 CIDR; Keitaro ranges like 1.2.3.1-1.2.3.9 are not carried over.
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|[0-9a-f:]*:[0-9a-f:]*)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
// Keitaro campaign parameter → Umbrella tracked field (paramMap renames the query key).
const PARAM_FIELDS = ['keyword', 'source', 'external_id', 'creative_id', 'ad_campaign_id', ...Array.from({ length: 30 }, (_, i) => `sub_id_${i + 1}`)];

// Pure mapping, unit-tested in test/import-keitaro-campaigns.test.mjs.
export function mapCampaign(c, streams, umbrellaOffers) {
  const notes = [];
  const id = /^[A-Za-z0-9_-]{2,80}$/.test(c.alias || '') ? c.alias : `kt-c${c.id}`;
  const paramMap = {};
  for (const field of [...PARAM_FIELDS, 'cost']) {
    const key = c.parameters?.[field]?.name;
    if (key && key !== field && /^[A-Za-z0-9_.\-[\]]{1,64}$/.test(key)) paramMap[field] = key;
  }
  const out = [];
  for (const s of [...streams].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    const label = `поток «${s.name}»`;
    if (s.state && s.state !== 'active') { notes.push(`${label}: выключен в Keitaro — пропущен`); continue; }
    const type = TYPES[s.type];
    if (!type) { notes.push(`${label}: тип ${s.type} не поддерживается — пропущен`); continue; }
    const conditions = {};
    let skip = false;
    const not = [];
    for (const f of s.filters || []) {
      const reject = f.mode === 'reject';
      if (f.mode && !['accept', 'reject'].includes(f.mode)) { notes.push(`${label}: фильтр «${f.name}» с режимом ${f.mode} не поддерживается — поток пропущен`); skip = true; break; }
      if (f.name === 'empty_referrer') { conditions.emptyReferrer = !reject; continue; }
      if (f.name === 'interval') {
        // Dates only: {from, to[, timezone]} with YYYY-MM-DD prefixes. "Outside the range" cannot be expressed with AND.
        const p = f.payload || {};
        const from = DATE_RE.test(p.from || '') ? p.from.slice(0, 10) : null; const to = DATE_RE.test(p.to || '') ? p.to.slice(0, 10) : null;
        if (reject || (!from && !to)) { notes.push(`${label}: фильтр «interval»${reject ? ' с исключением' : ''} не перенесён (${JSON.stringify(f.payload)}) — поток пропущен`); skip = true; break; }
        Object.assign(conditions, from ? { dateFrom: from } : {}, to ? { dateTo: to } : {}, { tz: p.timezone || 'UTC' });
        continue;
      }
      const map = FILTERS[f.name];
      if (!map) { notes.push(`${label}: фильтр «${f.name}» не поддерживается — поток пропущен`); skip = true; break; }
      const raw = [].concat(f.payload || []);
      const values = raw.map(map[1]).filter(Boolean);
      if (!values.length) { notes.push(`${label}: значения фильтра «${f.name}» не распознаны — поток пропущен`); skip = true; break; }
      if (values.length < raw.length) notes.push(`${label}: часть значений фильтра «${f.name}» не перенесена (${raw.filter((v) => !map[1](v)).join(', ')})`);
      conditions[map[0]] = values;
      if (reject) not.push(map[0]);
    }
    if (not.length) conditions.not = not;
    if (skip) continue;
    if (s.filter_or) conditions.mode = 'or';
    const base = { name: String(s.name || 'Flow').slice(0, 80), type, ...(type === 'regular' ? { weight: Math.max(1, Number(s.weight) || 1) } : {}), conditions };
    if (s.schema === 'redirect') {
      const { url, dropped } = convertUrl(s.action_payload || '');
      if (!/^https:\/\//i.test(url)) { notes.push(`${label}: адрес редиректа не https — пропущен`); continue; }
      if (dropped.length) notes.push(`${label}: макросы без аналога убраны: ${dropped.map((m) => `{${m}}`).join(' ')}`);
      out.push({ ...base, action: 'url', url });
    } else if (s.schema === 'landings' || s.schema === 'offers') {
      if (s.schema === 'landings' && (s.landings || []).length) notes.push(`${label}: лендинг не перенесён — трафик пойдёт сразу на оффер`);
      const offers = (s.offers || []).filter((o) => o.state !== 'disabled').map((o) => ({ offerId: `kt-${o.offer_id}`, weight: Math.max(1, Number(o.share) || 1) }));
      const missing = offers.filter((o) => !umbrellaOffers[o.offerId]).map((o) => o.offerId);
      if (missing.length) { notes.push(`${label}: нет офферов в Umbrella (${missing.join(', ')}) — сначала import-keitaro-offers.mjs --ids ${missing.map((m) => m.slice(3)).join(',')}; поток пропущен`); continue; }
      if (!offers.length) { notes.push(`${label}: без офферов — пропущен`); continue; }
      out.push({ ...base, offers });
    } else { notes.push(`${label}: схема ${s.schema}/${s.action_type} не поддерживается — пропущен`); }
  }
  if (c.domain) notes.push(`домен Keitaro ${c.domain} не перенесён — ссылка будет на домене Umbrella`);
  const cpc = c.cost_type === 'CPC' && Number(c.cost_value) > 0 ? Number(c.cost_value) : 0;
  const costFromParam = Boolean(c.parameters?.cost?.name);
  const campaign = {
    id, name: String(c.name || id).slice(0, 200), active: false, streams: out,
    streamRotation: c.type === 'position' ? 'position' : 'weight',
    uniquenessHours: Math.min(720, Math.max(1, Number(c.cookies_ttl) || 24)),
    paramMap, costModel: cpc || costFromParam ? 'cpc' : 'none', cpc, costFromParam,
  };
  return { campaign, notes };
}

async function keitaro(path, key) {
  const res = await fetch(`${KEITARO_URL}/admin_api/v1${path}`, { headers: { 'Api-Key': key, 'User-Agent': 'Mozilla/5.0', accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Keitaro GET ${path} → ${res.status}`);
  return res.json();
}
async function umbrella(path, token, { method = 'GET', body } = {}) {
  const res = await fetch(UMBRELLA_URL + path, { method, signal: AbortSignal.timeout(60000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Umbrella ${method} ${path} → ${res.status} ${data.error || ''}`);
  return data;
}

async function main() {
  const keitaroKey = await secret('KEITARO_API_KEY', '.keitaro-api-key');
  const umbrellaToken = await secret('UMBRELLA_TOKEN', 'umbrella-admin-token.txt');
  if (!keitaroKey) throw new Error('No Keitaro API key: put it into ~/.keitaro-api-key');
  const [campaigns, groups] = await Promise.all([keitaro('/campaigns', keitaroKey), keitaro('/groups?type=campaigns', keitaroKey)]);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const ours = campaigns.filter((c) => OUR_GROUPS.includes(groupName.get(c.group_id)));
  const wantIds = (option('ids') || '').split(',').map((s) => Number(s.trim())).filter(Boolean);

  if (!wantIds.length) {
    console.log(`Наши кампании в Keitaro (группы: ${OUR_GROUPS.join(', ')}): ${ours.length}`);
    for (const c of ours.filter((x) => flag('all') || x.state === 'active')) console.log(`  #${String(c.id).padEnd(5)} ${(c.alias || '').padEnd(22)} ${c.name}`);
    console.log('\nВыберите --ids через запятую (предпросмотр), затем добавьте --apply.');
    return;
  }
  const foreign = wantIds.filter((id) => !ours.some((c) => c.id === id));
  if (foreign.length) throw new Error(`Кампании ${foreign.join(', ')} не из наших групп (${OUR_GROUPS.join(', ')}) — не импортирую`);
  if (!umbrellaToken) throw new Error('No Umbrella token: expected ~/umbrella-admin-token.txt');
  const umbrellaOffers = (await umbrella('/api/offers', umbrellaToken)).offers || {};
  const existing = (await umbrella('/api/campaigns', umbrellaToken)).campaigns || {};

  const plan = [];
  for (const id of wantIds) {
    const c = ours.find((x) => x.id === id);
    const { campaign, notes } = mapCampaign(c, await keitaro(`/campaigns/${id}/streams`, keitaroKey), umbrellaOffers);
    const status = existing[campaign.id] ? 'exists' : campaign.streams.length ? 'create' : 'skip';
    plan.push({ campaign, status });
    console.log(`${status.padEnd(6)} #${id} → /r/${campaign.id}  «${campaign.name}»  потоков: ${campaign.streams.length}, ротация: ${campaign.streamRotation}, CPC: ${campaign.costModel === 'cpc' ? (campaign.costFromParam ? 'из параметра' : campaign.cpc) : 'нет'}`);
    for (const s of campaign.streams) console.log(`         ${s.type.padEnd(8)} ${s.name}: ${s.action === 'url' ? 'редирект ' + s.url : s.offers.map((o) => `${o.offerId}×${o.weight}`).join(', ')}${Object.keys(s.conditions).length ? '  если ' + JSON.stringify(s.conditions) : ''}`);
    for (const n of notes) console.log(`         ↳ ${n}`);
  }
  if (!flag('apply')) { console.log('\nПредпросмотр — ничего не записано. Добавьте --apply. Существующие кампании (exists) не перезаписываются.'); return; }
  let done = 0;
  for (const p of plan.filter((x) => x.status === 'create')) { await umbrella('/api/campaigns', umbrellaToken, { method: 'POST', body: p.campaign }); done += 1; }
  console.log(`\nСоздано ${done} кампаний в ${UMBRELLA_URL} — все выключены. Проверьте потоки в /admin и включите сами.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error('Import failed:', error.message); process.exit(1); });
}
