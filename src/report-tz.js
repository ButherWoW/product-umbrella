// Report day boundaries in a time zone. By default reports use UTC days (`from=2026-11-05` is 2026-11-05T00:00Z …
// 2026-11-06T00:00Z); with `tz=Europe/Paris` the same dates mean local days of that zone (the cost import already
// distributes ad-account costs by the account's local days, README «Расходы»). No `tz`, `UTC` and `Etc/UTC` are the default.
import { zonedDayStart } from './conversion-cap.js';

const DAY = 86400000;
const UTC_NAMES = /^(utc|etc\/utc|gmt|etc\/gmt|z)$/i;

// null → UTC days (default). Invalid zone → Error with statusCode 400.
export function parseTz(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const tz = String(raw).trim();
  if (UTC_NAMES.test(tz)) return null;
  if (tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) throw Object.assign(new Error('invalid_tz'), { statusCode: 400 });
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); } catch { throw Object.assign(new Error('invalid_tz'), { statusCode: 400 }); }
  return tz;
}

const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

// Instant (ms) at which the report day `day` (YYYY-MM-DD) starts.
export const dayStartMs = (day, tz = null) => (tz ? zonedDayStart(day, tz) : Date.parse(`${day}T00:00:00Z`));

// [from, to] inclusive dates → half-open instants. Missing dates → null.
export function dayRange(from, to, tz = null) {
  const fromMs = from ? dayStartMs(from, tz) : null;
  const toMs = to ? dayStartMs(nextDay(to), tz) : null;
  return { fromMs, toMs, fromIso: fromMs === null ? null : new Date(fromMs).toISOString(), toIso: toMs === null ? null : new Date(toMs).toISOString() };
}

// 'YYYY-MM-DD' (or 'YYYY-MM-DDTHH' for hours) of an instant in `tz`.
export function localBucket(at, tz, hour = false) {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
    .formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}${hour ? `T${p.hour}` : ''}`;
}
