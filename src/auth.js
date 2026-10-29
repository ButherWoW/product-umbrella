// Umbrella's own user accounts and sessions — independent from any other project on the same domain.
// PostgreSQL when available, otherwise JSON files in DATA_DIR (development and tests).
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
// viewer: read-only, sees its own campaigns (or all of them with viewAll).
export const ROLES = ['owner', 'buyer', 'viewer'];
export const OFFERS_ACCESS = ['all', 'own'];
export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const fail = (error, statusCode) => Object.assign(new Error(error), { statusCode });

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltHex, keyHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(String(password), Buffer.from(saltHex, 'hex'), key.length);
  return timingSafeEqual(key, actual);
}

// Real hash of a random password: unknown emails take as long to reject as wrong passwords.
const DUMMY_HASH = await hashPassword(randomBytes(12).toString('hex'));
const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');
export const API_KEY_PREFIX = 'umb_';
const API_KEY_TOUCH_MS = 60 * 1000;
// Permission flags live next to the role: PG columns hide_revenue / offers_access / view_all, the same snake_case keys in users.json.
const publicUser = (u) => (u ? { id: u.id, email: u.email, role: u.role, createdAt: new Date(u.created_at ?? u.createdAt).toISOString(),
  hideRevenue: Boolean(u.hide_revenue), offersAccess: u.offers_access === 'own' ? 'own' : 'all', viewAll: Boolean(u.view_all) } : null);

// Validates the role and permission flags present in input; absent fields are left out of the result.
export function validatePermissions(input = {}) {
  const out = {};
  if (input.role !== undefined) { if (!ROLES.includes(input.role)) throw fail('invalid_role', 400); out.role = input.role; }
  for (const [key, column] of [['hideRevenue', 'hide_revenue'], ['viewAll', 'view_all']]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') throw fail(`invalid_${column}`, 400);
    out[column] = input[key];
  }
  if (input.offersAccess !== undefined) { if (!OFFERS_ACCESS.includes(input.offersAccess)) throw fail('invalid_offers_access', 400); out.offers_access = input.offersAccess; }
  return out;
}

export function validateCredentials({ email, password, role = 'buyer' }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) throw fail('invalid_email', 400);
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw fail('password_too_short', 400);
  if (!ROLES.includes(role)) throw fail('invalid_role', 400);
  return { email: normalized, password, role };
}

// The secret itself is never stored: only its SHA-256 (lookup key) and the last 4 characters for display.
const publicKey = (k) => (k ? { id: k.id, name: k.name, last4: k.last4, userId: k.user_id, ...(k.email ? { email: k.email } : {}),
  createdAt: new Date(k.created_at).toISOString(), lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null } : null);
export function validateKeyName(name) {
  const normalized = String(name ?? '').trim();
  if (!normalized || normalized.length > 60) throw fail('invalid_key_name', 400);
  return normalized;
}

export function createUserStore({ db = null, dataDir }) {
  const usersFile = join(dataDir, 'users.json');
  const sessionsFile = join(dataDir, 'sessions.json');
  const keysFile = join(dataDir, 'api_keys.json');
  let chain = Promise.resolve();
  // Serializes read-modify-write cycles on the JSON files.
  const locked = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  const load = async (file) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  const save = async (file, data) => { await mkdir(dataDir, { recursive: true }); await writeFile(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); };

  return {
    async count() {
      if (db) return (await db.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
      return (await load(usersFile)).length;
    },
    async list() {
      if (db) return (await db.query('SELECT id, email, role, created_at, hide_revenue, offers_access, view_all FROM users ORDER BY created_at')).rows.map(publicUser);
      return (await load(usersFile)).map(publicUser);
    },
    async authenticate(email, password) {
      const normalized = String(email || '').trim().toLowerCase();
      const user = db
        ? (await db.query('SELECT * FROM users WHERE email = $1', [normalized])).rows[0]
        : (await load(usersFile)).find((u) => u.email === normalized);
      // Always run scrypt so response time does not reveal whether the email exists.
      const ok = await verifyPassword(String(password || ''), user?.password_hash || DUMMY_HASH);
      return ok && user ? publicUser(user) : null;
    },
    async create(input) {
      const { email, password, role } = validateCredentials(input);
      const flags = { hide_revenue: false, offers_access: 'all', view_all: false, ...validatePermissions({ hideRevenue: input.hideRevenue, offersAccess: input.offersAccess, viewAll: input.viewAll }) };
      const record = { id: randomUUID(), email, role, password_hash: await hashPassword(password), created_at: new Date().toISOString(), ...flags };
      if (db) {
        try { await db.query('INSERT INTO users (id, email, role, password_hash, created_at, hide_revenue, offers_access, view_all) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [record.id, email, role, record.password_hash, record.created_at, flags.hide_revenue, flags.offers_access, flags.view_all]); }
        catch (e) { if (e.code === '23505') throw fail('email_taken', 409); throw e; }
        return publicUser(record);
      }
      return locked(async () => {
        const users = await load(usersFile);
        if (users.some((u) => u.email === email)) throw fail('email_taken', 409);
        users.push(record);
        await save(usersFile, users);
        return publicUser(record);
      });
    },
    // Changes role and permission flags; returns the updated user or null if there is no such user.
    async update(id, input) {
      const patch = validatePermissions(input);
      const keys = Object.keys(patch);
      if (db) {
        if (!keys.length) return publicUser((await db.query('SELECT * FROM users WHERE id = $1', [id])).rows[0]);
        const { rows } = await db.query(`UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => patch[k])]);
        return publicUser(rows[0]);
      }
      return locked(async () => {
        const users = await load(usersFile);
        const user = users.find((u) => u.id === id);
        if (!user) return null;
        Object.assign(user, patch);
        await save(usersFile, users);
        return publicUser(user);
      });
    },
    async remove(id) {
      if (db) { await db.query('DELETE FROM users WHERE id = $1', [id]); return; }
      await locked(async () => {
        await save(usersFile, (await load(usersFile)).filter((u) => u.id !== id));
        await save(sessionsFile, (await load(sessionsFile)).filter((s) => s.user_id !== id));
        await save(keysFile, (await load(keysFile)).filter((k) => k.user_id !== id));
      });
    },
    async createSession(userId) {
      const token = randomBytes(32).toString('base64url');
      const row = { token_hash: tokenHash(token), user_id: userId, expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
      if (db) await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)', [row.token_hash, row.user_id, row.expires_at]);
      else await locked(async () => { const now = Date.now(); await save(sessionsFile, [...(await load(sessionsFile)).filter((s) => Date.parse(s.expires_at) > now), row]); });
      return token;
    },
    async userForToken(token) {
      if (!token) return null;
      const hash = tokenHash(token);
      if (db) {
        const { rows } = await db.query('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()', [hash]);
        return publicUser(rows[0]);
      }
      const session = (await load(sessionsFile)).find((s) => s.token_hash === hash && Date.parse(s.expires_at) > Date.now());
      return session ? publicUser((await load(usersFile)).find((u) => u.id === session.user_id)) : null;
    },
    async deleteSession(token) {
      if (!token) return;
      const hash = tokenHash(token);
      if (db) { await db.query('DELETE FROM sessions WHERE token_hash = $1', [hash]); return; }
      await locked(async () => save(sessionsFile, (await load(sessionsFile)).filter((s) => s.token_hash !== hash)));
    },
    // Returns the secret exactly once; afterwards only its hash exists.
    async createApiKey(userId, name) {
      const secret = API_KEY_PREFIX + randomBytes(32).toString('base64url');
      const row = { id: randomUUID(), user_id: userId, name: validateKeyName(name), key_hash: tokenHash(secret), last4: secret.slice(-4), created_at: new Date().toISOString(), last_used_at: null };
      if (db) await db.query('INSERT INTO api_keys (id, user_id, name, key_hash, last4, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [row.id, row.user_id, row.name, row.key_hash, row.last4, row.created_at]);
      else await locked(async () => save(keysFile, [...(await load(keysFile)), row]));
      return { key: publicKey(row), secret };
    },
    // userId: only that user's keys; null: every key, with the owner's email.
    async listApiKeys(userId = null) {
      if (db) {
        const { rows } = await db.query(`SELECT k.*, u.email FROM api_keys k JOIN users u ON u.id = k.user_id ${userId ? 'WHERE k.user_id = $1' : ''} ORDER BY k.created_at`, userId ? [userId] : []);
        return rows.map(publicKey);
      }
      const all = await load(usersFile);
      return (await load(keysFile)).filter((k) => !userId || k.user_id === userId)
        .map((k) => publicKey({ ...k, email: all.find((u) => u.id === k.user_id)?.email || null }));
    },
    async getApiKey(id) {
      if (db) return publicKey((await db.query('SELECT * FROM api_keys WHERE id = $1', [id])).rows[0]);
      return publicKey((await load(keysFile)).find((k) => k.id === id));
    },
    async deleteApiKey(id) {
      if (db) { await db.query('DELETE FROM api_keys WHERE id = $1', [id]); return; }
      await locked(async () => save(keysFile, (await load(keysFile)).filter((k) => k.id !== id)));
    },
    // Looks the key up by its SHA-256, so no secret is ever compared byte by byte. lastUsedAt is written
    // at most once a minute per key to keep API traffic from turning into a write per request.
    async userForApiKey(secret) {
      if (!String(secret || '').startsWith(API_KEY_PREFIX)) return null;
      const hash = tokenHash(secret);
      const now = Date.now();
      if (db) {
        const { rows } = await db.query('SELECT k.id AS key_id, k.name AS key_name, k.last_used_at, u.* FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1', [hash]);
        const row = rows[0];
        if (!row) return null;
        if (!row.last_used_at || now - new Date(row.last_used_at).getTime() >= API_KEY_TOUCH_MS) {
          await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id]);
        }
        return { user: publicUser(row), key: { id: row.key_id, name: row.key_name } };
      }
      const key = (await load(keysFile)).find((k) => k.key_hash === hash);
      const user = key && (await load(usersFile)).find((u) => u.id === key.user_id);
      if (!user) return null;
      if (!key.last_used_at || now - Date.parse(key.last_used_at) >= API_KEY_TOUCH_MS) {
        await locked(async () => {
          const keys = await load(keysFile);
          const current = keys.find((k) => k.id === key.id);
          if (!current) return;
          current.last_used_at = new Date(now).toISOString();
          await save(keysFile, keys);
        });
      }
      return { user: publicUser(user), key: { id: key.id, name: key.name } };
    },
  };
}

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
