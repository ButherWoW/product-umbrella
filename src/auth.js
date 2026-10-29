// Umbrella's own user accounts and sessions — independent from any other project on the same domain.
// PostgreSQL when available, otherwise JSON files in DATA_DIR (development and tests).
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const ROLES = ['owner', 'buyer'];
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
const publicUser = (u) => (u ? { id: u.id, email: u.email, role: u.role, createdAt: new Date(u.created_at ?? u.createdAt).toISOString() } : null);

export function validateCredentials({ email, password, role = 'buyer' }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) throw fail('invalid_email', 400);
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw fail('password_too_short', 400);
  if (!ROLES.includes(role)) throw fail('invalid_role', 400);
  return { email: normalized, password, role };
}

export function createUserStore({ db = null, dataDir }) {
  const usersFile = join(dataDir, 'users.json');
  const sessionsFile = join(dataDir, 'sessions.json');
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
      if (db) return (await db.query('SELECT id, email, role, created_at FROM users ORDER BY created_at')).rows.map(publicUser);
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
      const record = { id: randomUUID(), email, role, password_hash: await hashPassword(password), created_at: new Date().toISOString() };
      if (db) {
        try { await db.query('INSERT INTO users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)', [record.id, email, role, record.password_hash, record.created_at]); }
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
    async remove(id) {
      if (db) { await db.query('DELETE FROM users WHERE id = $1', [id]); return; }
      await locked(async () => {
        await save(usersFile, (await load(usersFile)).filter((u) => u.id !== id));
        await save(sessionsFile, (await load(sessionsFile)).filter((s) => s.user_id !== id));
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
  };
}

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
