// Postback to the traffic source (Keitaro «Постбэк в источник трафика»).
// On a conversion status listed in the source's (or the campaign's) postbackStatuses the tracker sends
// GET <postbackUrl with macros> once per (click, status). Delivery is fire-and-forget with retries and
// an SSRF guard: only http(s), and every address the host resolves to must be public.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { readFile } from 'node:fs/promises';

export const SOURCE_POSTBACK_STATUSES = ['lead', 'sale', 'rejected', 'trash'];
export const DEFAULT_SOURCE_POSTBACK_STATUSES = ['sale'];

const TRACK_MACROS = ['keyword', 'source', 'external_id', 'creative_id', 'ad_campaign_id', ...Array.from({ length: 30 }, (_, i) => `sub_id_${i + 1}`)];
const KNOWN_MACROS = new Set([...TRACK_MACROS, 'click_id', 'subid', 'campaign', 'offer_id', 'country', 'cost', 'status', 'revenue', 'currency', 'payout']);

// Sample values for the «Тестовый постбэк» button.
export const SAMPLE_MACROS = { click_id: '00000000-0000-4000-8000-000000000000', external_id: 'test_external_id', subid: 'test_subid', campaign: 'test-campaign',
  offer_id: 'test-offer', country: 'FR', cost: '0.10', status: 'sale', revenue: '10.00', currency: 'EUR', payout: '10.00', keyword: 'test', source: 'test',
  creative_id: 'test_creative', ad_campaign_id: 'test_ad_campaign', ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`sub_id_${i + 1}`, `sub${i + 1}`])) };

export const allowPrivateFromEnv = (env = process.env) => /^(1|true|yes)$/i.test(env.SOURCE_POSTBACK_ALLOW_PRIVATE || '');

// https only; plain http is accepted only in the private test mode (local mock servers).
export function parsePostbackUrl(raw, { allowHttp = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim().slice(0, 2048);
  if (!(allowHttp ? /^https?:\/\//i : /^https:\/\//i).test(value)) return null;
  try { new URL(value.replace(/\{[a-z0-9_]+\}/gi, 'x')); } catch { return null; }
  return value;
}

// Subset of lead/sale/rejected/trash in canonical order; anything else → fallback.
export function parsePostbackStatuses(raw, fallback = DEFAULT_SOURCE_POSTBACK_STATUSES) {
  if (!Array.isArray(raw)) return [...fallback];
  const wanted = new Set(raw.map((s) => String(s).trim().toLowerCase()));
  return SOURCE_POSTBACK_STATUSES.filter((s) => wanted.has(s));
}

// Known macros are replaced with URL-encoded values (missing → empty); unknown {…} stay as written.
export function fillPostbackMacros(template, vars) {
  return template.replace(/\{([a-z0-9_]+)\}/gi, (whole, key) => (KNOWN_MACROS.has(key) ? encodeURIComponent(vars[key] ?? '') : whole));
}

// Logged URL: scheme, host and path only — query strings carry tokens and visitor data.
export function stripQuery(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}`; }
  catch { return String(url).split(/[?#]/)[0].slice(0, 2048); }
}

const blocked = new net.BlockList();
for (const [addr, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(addr, prefix, 'ipv4');
// NAT64 is refused outright: a public postback host never resolves to it. IPv4-mapped IPv6 is refused in
// isBlockedAddress (a ::ffff:0:0/96 rule here would also match every plain IPv4 address).
for (const [addr, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) blocked.addSubnet(addr, prefix, 'ipv6');
const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

export function isBlockedAddress(ip, { allowPrivate = false } = {}) {
  const family = net.isIP(ip);
  if (!family) return true;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (allowPrivate && loopback.check(ip, type)) return false;
  if (type === 'ipv6' && /^(0{0,4}:){0,5}:?ffff:/i.test(ip)) return true;
  return blocked.check(ip, type);
}

const refused = () => Object.assign(new Error('private_address_refused'), { code: 'EPRIVATEADDR', noRetry: true });

// One GET without redirects. The DNS answer is checked inside the socket's lookup, so the checked
// address is the one connected to (no re-resolution window). Resolves { httpStatus, error }.
export function sendPostback(url, { allowPrivate = false, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { return resolve({ httpStatus: null, error: 'invalid_url', noRetry: true }); }
    if (!['http:', 'https:'].includes(target.protocol)) return resolve({ httpStatus: null, error: 'invalid_scheme', noRetry: true });
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isBlockedAddress(host, { allowPrivate })) return resolve({ httpStatus: null, error: 'private_address_refused', noRetry: true });
    const lookup = (hostname, options, callback) => {
      dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error);
        const ok = addresses.filter((a) => !isBlockedAddress(a.address, { allowPrivate }));
        if (!ok.length || ok.length !== addresses.length) return callback(refused());
        if (options?.all) return callback(null, ok);
        return callback(null, ok[0].address, ok[0].family);
      });
    };
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const req = (target.protocol === 'https:' ? https : http).request(target, { method: 'GET', lookup, timeout: timeoutMs,
      headers: { 'user-agent': 'ProductUmbrella-Postback/1.0', accept: '*/*' } }, (res) => {
      res.resume();
      finish({ httpStatus: res.statusCode, error: res.statusCode >= 200 && res.statusCode < 300 ? null : `http_${res.statusCode}` });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => finish({ httpStatus: null, error: error.code === 'EPRIVATEADDR' ? 'private_address_refused' : (error.message || 'request_failed').slice(0, 200),
      noRetry: error.code === 'EPRIVATEADDR' }));
    req.end();
  });
}

// Small retry helper: up to `attempts` tries with linear backoff. Retries network errors, 5xx and 429;
// another 4xx or an SSRF refusal is final.
export async function deliverWithRetry(send, { attempts = 3, backoffMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await send(attempt);
    const retryable = !result.noRetry && (result.httpStatus === null || result.httpStatus >= 500 || result.httpStatus === 429);
    if (!result.error || !retryable || attempt === attempts) return { httpStatus: result.httpStatus, error: result.error, attempts: attempt };
    await sleep(backoffMs * attempt);
  }
  return { httpStatus: result?.httpStatus ?? null, error: result?.error ?? 'not_sent', attempts };
}

// Has a source postback for this (click, status) already been recorded in the JSONL journal?
export async function journalHasSourcePostback(eventsFile, clickId, status) {
  try {
    for (const line of (await readFile(eventsFile, 'utf8')).split('\n')) {
      if (!line.includes(clickId) || !line.includes('"source_postback"')) continue;
      try { const item = JSON.parse(line); if (item.type === 'source_postback' && item.clickId === clickId && item.status === status) return true; } catch { /* skip */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return false;
}

// Effective target for a campaign: its own URL/statuses override the source's (empty = inherit).
export function resolveSourcePostback(campaign, source) {
  const url = campaign?.sourcePostbackUrl || source?.postbackUrl || null;
  if (!url) return null;
  const statuses = campaign?.sourcePostbackStatuses?.length ? campaign.sourcePostbackStatuses
    : (source?.postbackStatuses?.length ? source.postbackStatuses : DEFAULT_SOURCE_POSTBACK_STATUSES);
  return { url, statuses };
}

export function createSourcePostbacks({ targetFor, loadClick, alreadySent, record, send = sendPostback, allowPrivate = false, backoffMs = 500, onError = () => {} }) {
  const inFlight = new Set();
  async function run({ clickId, status, revenue, currency, previousStatus, click }) {
    const target = targetFor(click);
    if (!target || !target.statuses.includes(status)) return null;
    const key = `${clickId}:${status}`;
    if (inFlight.has(key)) return null;
    inFlight.add(key);
    try {
      // A first conversion of a click cannot have an earlier source postback; only status changes need the journal check.
      if (previousStatus && await alreadySent(clickId, status)) return null;
      const full = (await loadClick(clickId)) || click;
      const vars = { ...(full?.params || {}), click_id: clickId, subid: full?.subid ?? '', campaign: full?.campaign ?? click.campaign ?? '',
        offer_id: full?.offerId ?? click.offerId ?? '', country: full?.country ?? '', cost: full?.cost ?? '', status,
        revenue: revenue ?? '', currency: currency ?? '', payout: revenue ?? '' };
      const url = fillPostbackMacros(target.url, vars);
      const result = await deliverWithRetry(() => send(url, { allowPrivate }), { backoffMs });
      await record({ clickId, campaign: click.campaign ?? null, status, httpStatus: result.httpStatus, error: result.error, attempts: result.attempts, url: stripQuery(url) });
      return result;
    } finally { inFlight.delete(key); }
  }
  // Never awaited by /postback: the returned promise is for tests and graceful shutdown only.
  return { dispatch: (payload) => run(payload).catch((error) => { onError(error); return null; }) };
}
