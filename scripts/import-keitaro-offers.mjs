#!/usr/bin/env node
// Copies offers from Keitaro into Umbrella. Keitaro is only READ (GET), never written.
// Dry run by default; --apply writes to Umbrella (creates kt-<id> offers, updates them on re-run).
//
//   node scripts/import-keitaro-offers.mjs                         # list groups/networks + preview
//   node scripts/import-keitaro-offers.mjs --groups "Sweep new"    # preview a group
//   node scripts/import-keitaro-offers.mjs --ids 313,320 --apply   # import specific offers
//
// Secrets come from files so they never appear on the command line or in chat:
//   ~/.keitaro-api-key          Keitaro admin API key (or KEITARO_API_KEY)
//   ~/umbrella-admin-token.txt  Umbrella ADMIN_TOKEN   (or UMBRELLA_TOKEN)
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const list = (value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);

const KEITARO_URL = (process.env.KEITARO_URL || 'https://whynot.partners').replace(/\/$/, '');
const UMBRELLA_URL = (process.env.UMBRELLA_URL || 'https://nespizdili.lol/umbrella').replace(/\/$/, '');
const secret = async (envName, file) => process.env[envName] || (await readFile(join(homedir(), file), 'utf8').catch(() => '')).trim();

// Keitaro macro → Umbrella macro. Anything else is dropped (and reported) so networks never receive a literal "{os}".
const MACROS = {
  subid: '{click_id}', campaign_id: '{campaign}', campaign_name: '{campaign}', offer_id: '{offer_id}',
  country: '{country}', device_type: '{device}', external_id: '{external_id}', creative_id: '{creative_id}',
  ad_campaign_id: '{ad_campaign_id}', keyword: '{keyword}', source: '{source}',
  ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`sub_id_${i + 1}`, `{sub_id_${i + 1}}`])),
};

export function convertUrl(url) {
  const dropped = new Set();
  const converted = String(url).replace(/\{([a-z0-9_]+)\}/gi, (_, name) => {
    const key = name.toLowerCase();
    if (MACROS[key]) return MACROS[key];
    dropped.add(name);
    return '';
  });
  return { url: converted, dropped: [...dropped] };
}

// Keitaro appends the affiliate network's offer_param to the offer URL; Umbrella stores the final URL.
export function buildUrl(offerUrl, networkParam) {
  const base = String(offerUrl || '').trim();
  const extra = String(networkParam || '').trim().replace(/^[?&]/, '');
  if (!extra) return base;
  return base + (base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?') + extra;
}

async function keitaro(path, key) {
  const res = await fetch(`${KEITARO_URL}/admin_api/v1${path}`, {
    headers: { 'Api-Key': key, 'User-Agent': 'Mozilla/5.0', accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Keitaro GET ${path} → ${res.status}`);
  return res.json();
}

async function umbrella(path, token, { method = 'GET', body } = {}) {
  const res = await fetch(UMBRELLA_URL + path, {
    method, signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Umbrella ${method} ${path} → ${res.status} ${data.error || ''}`);
  return data;
}

async function main() {
  const keitaroKey = await secret('KEITARO_API_KEY', '.keitaro-api-key');
  const umbrellaToken = await secret('UMBRELLA_TOKEN', 'umbrella-admin-token.txt');
  if (!keitaroKey) throw new Error('No Keitaro API key: put it into ~/.keitaro-api-key');
  if (!umbrellaToken) throw new Error('No Umbrella token: expected ~/umbrella-admin-token.txt');

  const [offers, networks, groups] = await Promise.all([
    keitaro('/offers', keitaroKey), keitaro('/affiliate_networks', keitaroKey),
    keitaro('/groups?type=offers', keitaroKey).catch(() => []),
  ]);
  const networkById = new Map(networks.map((n) => [n.id, n]));
  const groupById = new Map(groups.map((g) => [g.id, g.name]));
  const wantGroups = list(option('groups')); const wantIds = list(option('ids')).map(Number); const wantNetworks = list(option('networks'));
  const includeArchived = flag('include-archived');

  const selected = offers.filter((o) => {
    if (!includeArchived && o.state && o.state !== 'active') return false;
    if (wantIds.length && !wantIds.includes(o.id)) return false;
    if (wantGroups.length && !wantGroups.includes(groupById.get(o.group_id) || '')) return false;
    if (wantNetworks.length && !wantNetworks.includes(networkById.get(o.affiliate_network_id)?.name || '')) return false;
    return true;
  });

  if (!wantGroups.length && !wantIds.length && !wantNetworks.length) {
    const count = (keyOf) => Object.entries(selected.reduce((acc, o) => { const k = keyOf(o); acc[k] = (acc[k] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]);
    console.log(`Keitaro: ${offers.length} offers, active: ${selected.length}\n\nBy group (--groups):`);
    for (const [k, n] of count((o) => groupById.get(o.group_id) || '(no group)')) console.log(`  ${String(n).padStart(4)}  ${k}`);
    console.log('\nBy network (--networks):');
    for (const [k, n] of count((o) => networkById.get(o.affiliate_network_id)?.name || '(no network)')) console.log(`  ${String(n).padStart(4)}  ${k}`);
    console.log('\nPick offers with --groups, --networks or --ids, then add --apply.');
    return;
  }

  const existing = (await umbrella('/api/offers', umbrellaToken)).offers || {};
  const plan = selected.map((o) => {
    const id = `kt-${o.id}`;
    const network = networkById.get(o.affiliate_network_id);
    const base = { id, keitaroId: o.id, name: String(o.name || '').slice(0, 200), network: network?.name || '' };
    if (o.action_type && o.action_type !== 'http') return { ...base, status: 'skip', reason: `type "${o.action_type}" (only redirect offers)` };
    const { url, dropped } = convertUrl(buildUrl(o.action_payload, network?.offer_param));
    if (!/^https:\/\//i.test(url)) return { ...base, status: 'skip', reason: 'URL is not https' };
    const current = existing[id];
    const status = !current ? 'create' : current.url === url && current.name === base.name ? 'same' : 'update';
    return { ...base, url, dropped, status };
  });

  for (const p of plan) {
    console.log(`${p.status.padEnd(6)} ${p.id.padEnd(9)} ${p.network.padEnd(18).slice(0, 18)} ${p.name}`);
    if (p.reason) console.log(`         ↳ ${p.reason}`);
    if (p.dropped?.length) console.log(`         ↳ macros without an Umbrella equivalent, removed: ${p.dropped.map((m) => `{${m}}`).join(' ')}`);
  }
  const todo = plan.filter((p) => p.status === 'create' || p.status === 'update');
  console.log(`\n${plan.length} selected: ${todo.filter((p) => p.status === 'create').length} new, ${todo.filter((p) => p.status === 'update').length} to update, ${plan.filter((p) => p.status === 'same').length} unchanged, ${plan.filter((p) => p.status === 'skip').length} skipped`);
  if (!flag('apply')) { console.log('Dry run — nothing written. Add --apply to import.'); return; }

  let done = 0;
  for (const p of todo) {
    if (p.status === 'create') await umbrella('/api/offers', umbrellaToken, { method: 'POST', body: { id: p.id, name: p.name, url: p.url } });
    else await umbrella(`/api/offers/${p.id}`, umbrellaToken, { method: 'PATCH', body: { name: p.name, url: p.url } });
    done += 1;
  }
  console.log(`Imported ${done} offers into ${UMBRELLA_URL}. Conversions still go to Keitaro until the network postback points to Umbrella.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error('Import failed:', error.message); process.exit(1); });
}
