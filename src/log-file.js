// Optional log file (LOG_FILE=/path): console.log/warn/error keep going to stdout/stderr and are also appended
// to the file with a timestamp and level. Size-based rotation: file → file.1 → file.2 → file.3 (oldest dropped).
// Only what the app already prints is written; the app never prints secrets, so neither does the file.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';

export function createFileLogger({ path, maxBytes = 50 * 1024 * 1024, keep = 3, now = () => new Date() }) {
  mkdirSync(dirname(path), { recursive: true });
  let size = 0;
  try { size = statSync(path).size; } catch {}
  let failed = false;
  function rotate() {
    rmSync(`${path}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      try { renameSync(`${path}.${i}`, `${path}.${i + 1}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (keep > 0) renameSync(path, `${path}.1`); else rmSync(path, { force: true });
    size = 0;
  }
  function write(level, args) {
    const line = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${format(...args)}\n`;
    const bytes = Buffer.byteLength(line);
    try {
      if (size > 0 && size + bytes > maxBytes) rotate();
      // Synchronous on purpose: keeps line order and survives a crash right after the message; the app logs rarely.
      appendFileSync(path, line, { mode: 0o640 });
      size += bytes;
      failed = false;
    } catch (error) {
      // A full disk or a removed directory must never take the tracker down; say so once per failure streak.
      if (!failed) process.stderr.write(`[log] cannot write ${path}: ${error.message}\n`);
      failed = true;
    }
  }
  return { write, path };
}

// Wraps console.log/info/warn/error when LOG_FILE is set. Returns the logger, or null when the file log is off.
export function installLogFile(env = process.env, target = console) {
  const path = String(env.LOG_FILE || '').trim();
  if (!path) return null;
  const mb = Number(env.LOG_MAX_MB);
  const maxBytes = Math.max(1024, Math.round((Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024));
  const logger = createFileLogger({ path, maxBytes, keep: 3 });
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const original = target[method].bind(target);
    target[method] = (...args) => { logger.write(level, args); original(...args); };
  }
  return logger;
}
