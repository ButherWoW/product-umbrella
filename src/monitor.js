import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

// Stream monitoring (Keitaro audit): offers, landings and direct-URL streams of active campaigns are fetched
// on a timer. A target is down after DOWN_AFTER consecutive failures and up again after one success.
// Per campaign `monitoring`: 'off' — not checked, 'notify' — event + audit entry, 'disable' — the stream is
// also switched off (disabledBy: 'monitor') and switched back on by the monitor once the target answers.
export const MONITOR_MODES = ['off', 'notify', 'disable'];
const DOWN_AFTER = 2;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 5;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Loopback, private, link-local (cloud metadata), CGNAT, multicast and reserved ranges are never fetched.
const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(net, bits, 'ipv6');

export function isPrivateAddress(address) {
  const ip = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  const family = isIP(ip);
  if (!family) return true;
  return PRIVATE.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

// Macros have no visitor behind them during a check: click ids get a sample value, everything else is empty.
export function expandForCheck(template) {
  return String(template).replace(/\{([a-z0-9_]+)\}/gi, (_, k) => (['click_id', 'subid'].includes(k.toLowerCase()) ? 'monitor-check' : ''));
}

// Shown in the API, events and the panel: affiliate tokens usually live in the query string.
export function displayUrl(raw) {
  try { const u = new URL(raw); return u.origin + u.pathname; } catch { return String(raw).split('?')[0].slice(0, 300); }
}

async function resolvePublic(hostname, allowPrivate) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw Object.assign(new Error('no_address'), { code: 'no_address' });
  // Every address must be public: otherwise a host with one public and one private record could still reach inside.
  if (addresses.some((a) => isPrivateAddress(a.address) && !allowPrivate.has(a.address))) throw Object.assign(new Error('private_address'), { code: 'private_address' });
  return addresses[0];
}

function request(url, pinned, signal) {
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    // The connection goes to the address that was checked, so DNS cannot change between check and connect.
    const req = lib.request(url, { method: 'GET', agent: false, signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
      lookup: (_host, options, cb) => (options?.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family)) }, (res) => {
      res.destroy();
      resolve({ status: res.statusCode, location: res.headers.location || null });
    });
    req.on('error', reject);
    req.end();
  });
}

// One check: GET with up to MAX_REDIRECTS redirects, a shared timeout, only http(s) and only public addresses.
export async function probe(rawUrl, { timeoutMs = 10000, allowPrivate = new Set() } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url;
  try { url = new URL(rawUrl); } catch { return { ok: false, status: null, error: 'invalid_url' }; }
  for (let hop = 0; ; hop += 1) {
    if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, status: null, error: 'unsupported_protocol' };
    try {
      const pinned = await resolvePublic(url.hostname, allowPrivate);
      if (signal.aborted) return { ok: false, status: null, error: 'timeout' };
      const { status, location } = await request(url, pinned, signal);
      if (status >= 300 && status < 400 && location) {
        if (hop >= MAX_REDIRECTS) return { ok: false, status, error: 'too_many_redirects' };
        url = new URL(location, url);
        continue;
      }
      return { ok: status < 400, status, error: status < 400 ? null : `http_${status}` };
    } catch (error) {
      const timedOut = signal.aborted || error.name === 'AbortError' || error.name === 'TimeoutError';
      return { ok: false, status: null, error: timedOut ? 'timeout' : String(error.code || error.message || 'error').slice(0, 80) };
    }
  }
}

export function createMonitor({ campaigns, offers, landings, persistCampaign, event, intervalMs = 600000, timeoutMs = 10000, allowPrivate = [], log = console }) {
  const allowed = new Set(allowPrivate);
  // key (URL with macros expanded) → { url, ok, status, error, checkedAt, downSince, failures }
  const states = new Map();
  let running = null;
  let timer = null;

  const modeOf = (c) => (MONITOR_MODES.includes(c.monitoring) ? c.monitoring : 'notify');

  // Every URL a stream can send a visitor to, with what it is in the campaign.
  function streamTargets(stream) {
    const out = [];
    if (stream.action === 'url' && stream.url) out.push({ target: 'url', template: stream.url });
    if (stream.action) return out;
    for (const o of stream.offers || (stream.offerId ? [{ offerId: stream.offerId }] : [])) {
      const offer = offers.get(o.offerId);
      if (offer?.url && !offer.archived) out.push({ target: `offer:${o.offerId}`, template: offer.url });
    }
    for (const l of stream.landings || []) {
      const landing = landings.get(l.landingId);
      if (landing?.url) out.push({ target: `landing:${l.landingId}`, template: landing.url });
    }
    return out.map((t) => ({ ...t, key: expandForCheck(t.template) }));
  }

  // Active campaigns; streams switched off by hand are skipped, streams the monitor switched off are still checked.
  function references() {
    const refs = [];
    for (const [id, c] of campaigns) {
      if (!c.active || c.archived) continue;
      (c.streams || []).forEach((s, index) => {
        const ownDisabled = s.enabled === false && s.disabledBy === 'monitor';
        if ((s.enabled === false && !ownDisabled) || (modeOf(c) === 'off' && !ownDisabled)) return;
        for (const t of streamTargets(s)) refs.push({ campaign: id, index, stream: s.name || `#${index + 1}`, ...t });
      });
    }
    return refs;
  }

  async function runChecks(keys) {
    const results = new Map();
    const queue = [...keys];
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) { const key = queue.shift(); results.set(key, await probe(key, { timeoutMs, allowPrivate: allowed })); }
    }));
    return results;
  }

  const systemAudit = (action, campaign, changes) => event('audit', { actor: 'system', action, entity: 'campaign', entityId: campaign, changes });

  async function apply(newlyDown) {
    const byStream = new Map();
    for (const ref of references()) {
      const k = `${ref.campaign}\u0000${ref.index}`;
      if (!byStream.has(k)) byStream.set(k, []);
      byStream.get(k).push(ref);
    }
    const changed = new Set();
    for (const refs of byStream.values()) {
      const { campaign: id, index } = refs[0];
      const c = campaigns.get(id);
      const stream = c?.streams?.[index];
      if (!stream) continue;
      const mode = modeOf(c);
      const name = refs[0].stream;
      const fresh = refs.filter((r) => newlyDown.has(r.key));
      if (mode !== 'off') {
        for (const r of fresh) {
          const st = states.get(r.key);
          const payload = { campaign: id, stream: name, target: r.target, url: displayUrl(r.key), status: st.status, error: st.error };
          await event('monitor', { ...payload, state: 'down', action: mode });
          await systemAudit('monitor_down', id, { stream: [null, name], target: [null, r.target], url: [null, payload.url], status: [null, st.status], error: [null, st.error] });
        }
      }
      if (mode === 'disable' && fresh.length && stream.enabled !== false) {
        const reason = `не отвечает ${fresh[0].target} (${displayUrl(fresh[0].key)})`;
        c.streams = c.streams.map((s, i) => (i === index ? { ...s, enabled: false, disabledBy: 'monitor' } : s));
        changed.add(id);
        await systemAudit('disable_stream', id, { stream: [null, name], enabled: [true, false], reason: [null, reason] });
        continue;
      }
      // Only a stream the monitor itself switched off is switched back on, and only when every target answers.
      const allUp = refs.every((r) => states.get(r.key)?.checkedAt && !states.get(r.key).down);
      if (stream.enabled === false && stream.disabledBy === 'monitor' && allUp) {
        c.streams = c.streams.map((s, i) => { if (i !== index) return s; const { enabled, disabledBy, ...rest } = s; return rest; });
        changed.add(id);
        await event('monitor', { campaign: id, stream: name, target: refs.map((r) => r.target).join(', '), url: displayUrl(refs[0].key), status: states.get(refs[0].key).status, error: null, state: 'up', action: 'enable' });
        await systemAudit('enable_stream', id, { stream: [null, name], enabled: [false, true], reason: [null, 'цели снова отвечают'] });
      }
    }
    for (const id of changed) {
      const c = campaigns.get(id);
      campaigns.set(id, { ...c });
      try { await persistCampaign(id, campaigns.get(id)); } catch (error) { log.warn('[monitor] campaign not saved:', error.message); }
    }
  }

  async function checkOnce() {
    const keys = [...new Set(references().map((r) => r.key))];
    const results = await runChecks(keys);
    const now = new Date().toISOString();
    const newlyDown = new Set();
    for (const [key, result] of results) {
      const st = states.get(key) || { url: displayUrl(key), failures: 0, down: false, downSince: null };
      Object.assign(st, { status: result.status, error: result.error, checkedAt: now });
      if (result.ok) { st.failures = 0; st.down = false; st.downSince = null; }
      else {
        st.failures += 1;
        if (st.failures >= DOWN_AFTER && !st.down) { st.down = true; st.downSince = now; newlyDown.add(key); }
      }
      states.set(key, st);
    }
    for (const key of states.keys()) if (!results.has(key)) states.delete(key);
    await apply(newlyDown);
    return { checked: results.size, down: [...states.values()].filter((s) => s.down).length };
  }

  // Overlapping calls (timer + manual check) share one run.
  function check() {
    if (!running) running = checkOnce().catch((error) => { log.warn('[monitor] check failed:', error.message); return { error: error.message }; }).finally(() => { running = null; });
    return running;
  }

  // Current state per target; `visible` limits the campaigns (a buyer's own), null = all.
  function snapshot(visible = null) {
    const byKey = new Map();
    for (const ref of references()) {
      if (visible && !visible.includes(ref.campaign)) continue;
      const st = states.get(ref.key);
      if (!st) continue;
      const row = byKey.get(ref.key) || { url: st.url, ok: !st.down, status: st.status, error: st.error, checkedAt: st.checkedAt, downSince: st.downSince, failures: st.failures, campaigns: [] };
      if (!row.campaigns.some((x) => x.campaign === ref.campaign && x.stream === ref.stream && x.target === ref.target)) {
        row.campaigns.push({ campaign: ref.campaign, name: campaigns.get(ref.campaign)?.name || ref.campaign, stream: ref.stream, target: ref.target, mode: modeOf(campaigns.get(ref.campaign)) });
      }
      byKey.set(ref.key, row);
    }
    return [...byKey.values()].sort((a, b) => Number(a.ok) - Number(b.ok) || a.url.localeCompare(b.url));
  }

  function start() {
    if (timer || !(intervalMs > 0)) return;
    timer = setInterval(() => { check(); }, intervalMs);
    timer.unref();
    setTimeout(() => { check(); }, Math.min(intervalMs, 30000)).unref();
  }
  function stop() { clearInterval(timer); timer = null; }

  return { check, snapshot, start, stop, modeOf };
}
