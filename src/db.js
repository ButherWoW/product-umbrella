// PostgreSQL client with graceful fallback.
// If DATABASE_URL is not set or pg is not installed, db === null and all
// callers silently fall back to JSONL storage.

let db = null;

if (process.env.DATABASE_URL) {
  try {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
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

export async function closeDb() {
  if (db?.end) await db.end();
}
