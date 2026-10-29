// In-memory sliding-window limiters (one process, reset on restart).

// Per-key counter: hit(key) records an attempt and returns true when the key is already over the limit.
// limit 0 turns the limiter off.
export function createRateLimiter({ limit, windowMs, maxKeys = 10000 }) {
  const buckets = new Map();
  function prune(now) {
    if (buckets.size <= maxKeys) return;
    for (const [key, values] of buckets) if (!values.length || now - values.at(-1) >= windowMs) buckets.delete(key);
  }
  return {
    limit,
    hit(key, now = Date.now()) {
      if (!limit || !key) return false;
      const bucket = (buckets.get(key) || []).filter((at) => now - at < windowMs);
      if (bucket.length >= limit) { buckets.set(key, bucket); return true; }
      bucket.push(now); buckets.set(key, bucket);
      prune(now);
      return false;
    },
  };
}

// Login attempts. The attempt is reserved synchronously BEFORE the password is checked (scrypt is slow and
// async), so parallel requests cannot all pass the check before any failure is recorded.
// Three counters per attempt: (email + IP), email (any IP: a distributed guess at one account) and IP (one
// address guessing many accounts). A success clears only its own (email + IP) counter and un-counts its own
// attempt elsewhere, so logging into your own account does not reset the counters of somebody else's.
export const LOGIN_DEFAULTS = { windowMs: 15 * 60 * 1000, perPair: 10, perEmail: 30, perIp: 50 };

export function loginLimitsFromEnv(env = process.env) {
  const num = (name, fallback) => { const n = Number.parseInt(env[name] ?? '', 10); return Number.isFinite(n) && n >= 0 ? n : fallback; };
  return { windowMs: Math.max(1000, num('LOGIN_WINDOW_MS', LOGIN_DEFAULTS.windowMs)), perPair: num('LOGIN_LIMIT_PER_EMAIL_IP', LOGIN_DEFAULTS.perPair),
    perEmail: num('LOGIN_LIMIT_PER_EMAIL', LOGIN_DEFAULTS.perEmail), perIp: num('LOGIN_LIMIT_PER_IP', LOGIN_DEFAULTS.perIp) };
}

export function createLoginLimiter({ windowMs = LOGIN_DEFAULTS.windowMs, perPair = LOGIN_DEFAULTS.perPair, perEmail = LOGIN_DEFAULTS.perEmail,
  perIp = LOGIN_DEFAULTS.perIp, maxKeys = 50000 } = {}) {
  const buckets = new Map();
  const recent = (key, now) => {
    const values = (buckets.get(key) || []).filter((at) => now - at < windowMs);
    if (values.length) buckets.set(key, values); else buckets.delete(key);
    return values;
  };
  const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase().slice(0, 320);
  function keysFor(email, ip) {
    const e = normalizeEmail(email), i = String(ip || 'unknown');
    return [[`p:${e}\n${i}`, perPair], [`e:${e}`, perEmail], [`i:${i}`, perIp]];
  }
  // Returns null when blocked, otherwise a ticket for success()/failure().
  function reserve(email, ip, now = Date.now()) {
    const keys = keysFor(email, ip);
    if (keys.some(([key, limit]) => limit && recent(key, now).length >= limit)) return null;
    for (const [key, limit] of keys) if (limit) { const values = buckets.get(key) || []; values.push(now); buckets.set(key, values); }
    if (buckets.size > maxKeys) for (const key of buckets.keys()) recent(key, now);
    return { keys, at: now };
  }
  // A successful login: its (email + IP) counter is cleared; its own attempt is removed from the other two.
  function success(ticket) {
    if (!ticket) return;
    const [[pairKey], ...others] = ticket.keys;
    buckets.delete(pairKey);
    for (const [key] of others) {
      const values = buckets.get(key);
      const index = values ? values.indexOf(ticket.at) : -1;
      if (index >= 0) values.splice(index, 1);
      if (values && !values.length) buckets.delete(key);
    }
  }
  return { reserve, success };
}
