#!/usr/bin/env node
// Replays into PostgreSQL every journal event it lacks (clicks, conversions with their latest status, landing clicks,
// bots, postbacks, cost updates). Idempotent: running it again changes nothing. Safe while the tracker runs (new events
// are mirrored by the tracker itself); do not run it during «Очистка статистики» / retention (the tracker's own
// reconciliation job pauses for those).
//   DATABASE_URL=postgresql://… DATA_DIR=/opt/umbrella/data node scripts/reconcile-db.mjs [--data-dir DIR]
// Prints the number of replayed rows per kind as JSON; exit code 1 when PostgreSQL is unreachable or a write fails.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dirFlag = args.indexOf('--data-dir');
const dataDir = dirFlag >= 0 ? args[dirFlag + 1] : (process.env.DATA_DIR || join(dirname(dirname(fileURLToPath(import.meta.url))), 'data'));
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }

const { db, closeDb } = await import('../src/db.js');
const { reconcileJournal } = await import('../src/reconcile.js');
if (!db) { console.error('PostgreSQL is unreachable'); process.exit(1); }

try {
  const started = Date.now();
  const { counts: replayed, total } = await reconcileJournal({ db, eventsFile: join(dataDir, 'events.jsonl') });
  console.log(JSON.stringify({ ok: true, events: total, replayed, ms: Date.now() - started }));
} catch (error) {
  console.error('[reconcile] failed:', error.message);
  process.exitCode = 1;
} finally { await closeDb(); }
