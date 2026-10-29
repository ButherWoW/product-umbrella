// PostgreSQL client with graceful fallback.
// If DATABASE_URL is not set or pg is not installed, db === null and all
// callers silently fall back to JSONL storage.
//
// A PostgreSQL restart must never take the tracker down: idle pool clients that lose their connection emit
// 'error' on the pool, which is logged here (an unhandled 'error' event would terminate the process). The pool
// opens new connections on the next query, so the queries that fail during the outage fall back to JSONL and
// later ones work again. Every connection uses UTC, so DATE_TRUNC buckets and ::date casts do not depend on the
// database or role TimeZone setting.

let db = null;
let lastError = null;

// Pool options shared with scripts (reconcile-db.mjs) that open their own pool.
export function poolOptions(connectionString, extra = {}) {
  // TimeZone=UTC as a startup parameter: applies to every new connection before its first query.
  return { connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, options: '-c TimeZone=UTC', ...extra };
}

// Registers the resilience handlers on a pg.Pool: logged 'error' events instead of a crash.
export function hardenPool(pool, { log = console } = {}) {
  pool.on('error', (error) => {
    lastError = { at: Date.now(), message: error.message };
    log.warn('[db] idle PostgreSQL connection lost:', error.message);
  });
  // A client of the pool also emits 'error' on itself; the pool listener above covers idle clients,
  // this one covers checked-out clients between queries.
  pool.on('connect', (client) => {
    client.on('error', (error) => { lastError = { at: Date.now(), message: error.message }; });
  });
  return pool;
}

if (process.env.DATABASE_URL) {
  try {
    const { default: pg } = await import('pg');
    const pool = hardenPool(new pg.Pool(poolOptions(process.env.DATABASE_URL)));
    // Verify connection on startup; if it fails we keep db = null.
    await pool.query('SELECT 1');
    db = pool;
    console.log('[db] PostgreSQL connected');
  } catch (err) {
    console.warn('[db] PostgreSQL unavailable, using JSONL fallback:', err.message);
  }
}

export { db };

/** Run a query; returns null if db is not available. */
export async function query(sql, params) {
  if (!db) return null;
  return db.query(sql, params);
}

// 'up' | 'down' | null (no database configured). A short SELECT 1 with a timeout, for /health.
export async function dbStatus(timeoutMs = 1500) {
  if (!db) return null;
  let timer;
  try {
    await Promise.race([db.query('SELECT 1'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })]);
    return 'up';
  } catch (error) {
    lastError = { at: Date.now(), message: error.message };
    return 'down';
  } finally { clearTimeout(timer); }
}

export const lastDbError = () => lastError;

export async function closeDb() {
  if (db?.end) await db.end();
}
