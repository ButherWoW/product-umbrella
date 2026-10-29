// Reading and appending the JSONL journal (events.jsonl, the source of truth).
// A torn line (crash or full disk in the middle of an append) must not break reports: readers skip
// unparsable lines and count them, and the next append starts on a fresh line.
import { open, readFile } from 'node:fs/promises';

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

// All events of the journal ([] when it does not exist yet). Other read errors are thrown.
export async function readJournal(eventsFile) {
  let text;
  try { text = await readFile(eventsFile, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const { events, bad } = parseJournal(text);
  if (bad !== badLines) {
    if (bad > badLines) console.warn(`[journal] ${bad} unreadable line(s) in ${eventsFile} skipped`);
    badLines = bad;
  }
  return events;
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
