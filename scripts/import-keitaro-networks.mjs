#!/usr/bin/env node
// Copies affiliate networks from Keitaro into Umbrella and links the already imported offers (kt-<id>) to them.
// Keitaro is only READ (GET). Dry run by default; --apply writes to Umbrella.
//
//   node scripts/import-keitaro-networks.mjs            # networks used by our kt-* offers: preview
//   node scripts/import-keitaro-networks.mjs --apply    # create kt-net-<id> networks, set networkId on kt-* offers
//   node scripts/import-keitaro-networks.mjs --all      # every Keitaro network (not only ours) — preview
//
// Keitaro keeps the network's offer parameters (offer_param) but not the names of its postback macros, so
// clickIdParam is taken from the parameter that carries {subid} in offer_param, and payoutParam defaults to "payout".
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { convertUrl } from './import-keitaro-offers.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const KEITARO_URL = (process.env.KEITARO_URL || 'https://whynot.partners').replace(/\/$/, '');
const UMBRELLA_URL = (process.env.UMBRELLA_URL || 'https://nespizdili.lol/umbrella').replace(/\/$/, '');
const secret = async (envName, file) => process.env[envName] || (await readFile(join(homedir(), file), 'utf8').catch(() => '')).trim();

// Pure mapping, unit-tested in test/import-keitaro-networks.test.mjs.
export function mapNetwork(n) {
  const notes = [];
  const { url: offerParams, dropped } = convertUrl(String(n.offer_param || '').replace(/^[?&]/, ''));
  if (dropped.length) notes.push(`макросы без аналога убраны: ${dropped.map((m) => `{${m}}`).join(' ')}`);
  // The network parameter that receives Keitaro's {subid} is where the network keeps our click id.
  const subidParam = String(n.offer_param || '').split('&').map((p) => p.split('=')).find(([, v]) => /^\{subid\}$/i.test(v || ''))?.[0];
  if (!subidParam) notes.push('в offer_param нет параметра с {subid} — Click ID в постбэке не определён, стоит sub1');
  notes.push('название параметра выплаты в Keitaro не хранится — стоит {payout}, проверьте в кабинете партнёрки');
  return {
    network: { id: `kt-net-${n.id}`, name: String(n.name || `Keitaro ${n.id}`).slice(0, 120), offerParams: offerParams.slice(0, 1000),
      clickIdParam: subidParam || 'sub1', payoutParam: 'payout', notes: `Импорт из Keitaro #${n.id}`.slice(0, 500) },
    notes,
  };
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
  if (!umbrellaToken) throw new Error('No Umbrella token: expected ~/umbrella-admin-token.txt');
  const [networks, ktOffers] = await Promise.all([keitaro('/affiliate_networks', keitaroKey), keitaro('/offers', keitaroKey)]);
  const umbOffers = (await umbrella('/api/offers', umbrellaToken)).offers || {};
  const umbNetworks = (await umbrella('/api/networks', umbrellaToken)).networks || {};
  // Our offers = Umbrella offers imported from Keitaro (kt-<id>).
  const ours = Object.keys(umbOffers).map((id) => /^kt-(\d+)$/.exec(id)).filter(Boolean).map((m) => Number(m[1]));
  const offerNetwork = new Map(ktOffers.filter((o) => ours.includes(o.id)).map((o) => [o.id, o.affiliate_network_id]));
  const wanted = flag('all') ? networks : networks.filter((n) => [...offerNetwork.values()].includes(n.id));

  const plan = wanted.map((n) => ({ ...mapNetwork(n), status: umbNetworks[`kt-net-${n.id}`] ? 'exists' : 'create', offers: [...offerNetwork].filter(([, net]) => net === n.id).map(([id]) => `kt-${id}`) }));
  for (const p of plan) {
    console.log(`${p.status.padEnd(6)} ${p.network.id.padEnd(12)} «${p.network.name}»  click id: {${p.network.clickIdParam}}  выплата: {${p.network.payoutParam}}`);
    console.log(`         параметры: ${p.network.offerParams || '—'}`);
    if (p.offers.length) console.log(`         офферы: ${p.offers.join(', ')}`);
    for (const n of p.notes) console.log(`         ↳ ${n}`);
  }
  if (!flag('apply')) { console.log(`\nПредпросмотр: ${plan.length} сетей. Добавьте --apply. Существующие (exists) не перезаписываются, привязка офферов обновляется.`); return; }
  for (const p of plan) {
    if (p.status === 'create') await umbrella('/api/networks', umbrellaToken, { method: 'POST', body: p.network });
    for (const id of p.offers) if (umbOffers[id]?.networkId !== p.network.id) await umbrella(`/api/offers/${id}`, umbrellaToken, { method: 'PATCH', body: { networkId: p.network.id } });
  }
  console.log(`\nГотово: создано сетей ${plan.filter((p) => p.status === 'create').length}, офферов привязано ${plan.reduce((t, p) => t + p.offers.length, 0)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error('Import failed:', error.message); process.exit(1); });
}
