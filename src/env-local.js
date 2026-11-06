// Optional overrides that survive a deploy. The deploy rewrites /opt/umbrella/.env from scratch on every release,
// so a variable added there by hand disappears. Variables put in a second file are read by the app on top of the
// environment (systemd loads .env first): ENV_LOCAL_FILE, or `.env.local` one level above DATA_DIR
// (/opt/umbrella/.env.local on the server). ENV_LOCAL_FILE=off turns the file off. Imported first by server.js.
// Format: KEY=value per line, `#` comments, optional single/double quotes. Values are never logged.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.indexOf(quote, 1) > 0) value = value.slice(1, value.indexOf(quote, 1));
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}

export function envLocalPath(env = process.env) {
  const explicit = env.ENV_LOCAL_FILE;
  if (explicit !== undefined && explicit !== '') return /^(off|0|false|no)$/i.test(explicit) ? null : resolve(explicit);
  return env.DATA_DIR ? join(dirname(resolve(env.DATA_DIR)), '.env.local') : null;
}

// Applies the file over `env`; returns the names set (never the values). A missing file is normal; an unreadable one
// is reported once, without its content.
export function loadEnvLocal(env = process.env) {
  const path = envLocalPath(env);
  if (!path) return [];
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[env] ${path} is not readable: ${error.code || 'error'}`);
    return [];
  }
  const values = parseEnvFile(text);
  delete values.ENV_LOCAL_FILE;
  Object.assign(env, values);
  const names = Object.keys(values);
  if (names.length) console.log(`[env] ${path}: ${names.length} variable(s) override the service environment (${names.join(', ')})`);
  return names;
}

loadEnvLocal();
