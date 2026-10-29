// Reading and appending the JSONL journal (events.jsonl, the source of truth).
// A torn line (crash or full disk in the middle of an append) must not break reports: readers skip
// unparsable lines and count them, and the next append starts on a fresh line.
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';

let badLines = 0; // unparsable lines seen by the last full read (process-wide, for /health)

export const journalBadLines = () => badLines;

// Parses journal text: objects only, in file order; unparsable or non-object lines are skipped and counted.
export function parseJournal(text) {
  const events = [];
  let bad = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { bad += 1; continue; }
    if (item && typeof item === 'object' && !Array.isArray(item)) events.push(item); else bad += 1;
  }
  return { events, bad };
}

// All events of the journal ([] when it does not exist yet), streamed line by line so memory holds the parsed
// events only, never the whole file as text. `types` keeps only those event types (a cheap text check skips the
// other lines before JSON.parse); unreadable lines are counted for /health on full reads only. Other errors are thrown.
export async function readJournal(eventsFile, types = null) {
  let input;
  try {
    input = createReadStream(eventsFile, { encoding: 'utf8', highWaterMark: 256 * 1024 });
    await new Promise((resolve, reject) => { input.once('open', resolve); input.once('error', reject); });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const wanted = types ? new Set(types) : null;
  const needles = types ? types.map((type) => `"${type}"`) : null;
  const events = [];
  let bad = 0;
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    if (needles && !needles.some((needle) => line.includes(needle))) continue;
    let item;
    try { item = JSON.parse(line); } catch { bad += 1; continue; }
    if (!item || typeof item !== 'object' || Array.isArray(item)) { bad += 1; continue; }
    if (!wanted || wanted.has(item.type)) events.push(item);
  }
  if (!types) noteBadLines(bad, eventsFile);
  return events;
}

// Unreadable lines found by a full pass over the journal (readJournal, the in-memory index build).
export function noteBadLines(bad, eventsFile) {
  if (bad === badLines) return;
  if (bad > badLines) console.warn(`[journal] ${bad} unreadable line(s) in ${eventsFile} skipped`);
  badLines = bad;
}

// True when the file is missing, empty or ends with a newline.
export async function endsWithNewline(eventsFile) {
  let handle;
  try { handle = await open(eventsFile, 'r'); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  try {
    const { size } = await handle.stat();
    if (!size) return true;
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally { await handle.close(); }
}
