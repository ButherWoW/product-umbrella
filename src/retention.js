// Removing statistics from the JSONL journal (source of truth) and the PostgreSQL mirror:
// «Очистка статистики» of one campaign and the RETENTION_DAYS job. Nightly backups are the way back.
import { createReadStream } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';

// Appends share the journal; a rewrite takes it exclusively. A rewrite waits for in-flight appends,
// and appends that arrive during a rewrite wait until the new file is in place.
export function createJournalGate() {
  let active = 0;
  let exclusive = null;
  let idle = [];
  async function shared(fn) {
    while (exclusive) await exclusive;
    active += 1;
    try { return await fn(); } finally {
      active -= 1;
      if (!active) { const waiters = idle; idle = []; waiters.forEach((resolve) => resolve()); }
    }
  }
  async function rewrite(fn) {
    while (exclusive) await exclusive;
    let release;
    exclusive = new Promise((resolve) => { release = resolve; });
    try {
      while (active) await new Promise((resolve) => idle.push(resolve));
      return await fn();
    } finally { exclusive = null; release(); }
  }
  return { shared, rewrite };
}

async function* journalLines(eventsFile) {
  let input;
  try { input = createReadStream(eventsFile, { encoding: 'utf8' }); await new Promise((resolve, reject) => { input.once('open', resolve); input.once('error', reject); }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line) continue;
    let record = null;
    try { record = JSON.parse(line); } catch { /* unreadable lines are kept as they are */ }
    yield [line, record];
  }
}

const EMPTY = () => ({ clicks: 0, conversions: 0, lpClicks: 0, bots: 0 });
const COUNTER = { click: 'clicks', conversion: 'conversions', lp_click: 'lpClicks', bot: 'bots' };
const before = (at, limitMs) => { const t = Date.parse(at); return Number.isFinite(t) && t < limitMs; };

// Two passes over the journal: plan.observe(record) collects click ids, plan.drop(record) decides.
// The kept lines go to a temp file next to the journal; commit(counts) runs before the atomic rename
// (PostgreSQL deletion), and a failed commit leaves the journal untouched.
export async function filterJournal(eventsFile, plan, commit = async () => {}) {
  for await (const [, record] of journalLines(eventsFile)) if (record) plan.observe(record);
  const counts = EMPTY();
  let mode = 0o644;
  try { mode = (await stat(eventsFile)).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; await commit(counts); return counts; }
  const temp = `${eventsFile}.rewrite-${process.pid}-${Date.now()}`;
  const out = await open(temp, 'w', mode);
  let chunk = '';
  try {
    for await (const [line, record] of journalLines(eventsFile)) {
      if (record && COUNTER[record.type] && plan.drop(record)) { counts[COUNTER[record.type]] += 1; continue; }
      chunk += line + '\n';
      if (chunk.length > 1 << 20) { await out.write(chunk); chunk = ''; }
    }
    if (chunk) await out.write(chunk);
    await out.sync();
    await out.close();
    await commit(counts);
    await rename(temp, eventsFile);
  } catch (error) {
    await out.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
  return counts;
}

// One campaign: its clicks (all or created before `beforeMs`), their conversions and landing clicks, its bot events.
export function campaignPlan(campaign, beforeMs = null) {
  const clickIds = new Set();
  const inRange = (at) => beforeMs === null || before(at, beforeMs);
  return {
    observe(e) { if (e.type === 'click' && e.campaign === campaign && inRange(e.at)) clickIds.add(e.clickId); },
    drop(e) {
      if (e.type === 'bot') return e.campaign === campaign && inRange(e.at);
      return clickIds.has(e.clickId);
    },
  };
}

// Retention: clicks older than the cutoff without any conversion (and their landing clicks), old bot events.
// Converted clicks and their conversions are kept forever.
export function retentionPlan(cutoffMs) {
  const converted = new Set();
  const old = new Set();
  return {
    observe(e) {
      if (e.type === 'conversion') converted.add(e.clickId);
      else if (e.type === 'click' && before(e.at, cutoffMs)) old.add(e.clickId);
    },
    drop(e) {
      if (e.type === 'bot') return before(e.at, cutoffMs);
      if (e.type === 'click' || e.type === 'lp_click') return old.has(e.clickId) && !converted.has(e.clickId);
      return false;
    },
  };
}

async function inTransaction(db, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export function clearCampaignRows(db, campaign, beforeIso = null) {
  const where = beforeIso ? 'campaign = $1 AND created_at < $2' : 'campaign = $1';
  const params = beforeIso ? [campaign, beforeIso] : [campaign];
  return inTransaction(db, async (client) => {
    const conversions = await client.query(`DELETE FROM conversions WHERE click_id IN (SELECT click_id FROM clicks WHERE ${where})`, params);
    const clicks = await client.query(`DELETE FROM clicks WHERE ${where} RETURNING lp_clicked_at`, params);
    const bots = await client.query(`DELETE FROM bots WHERE ${where}`, params);
    return { clicks: clicks.rowCount, conversions: conversions.rowCount, lpClicks: clicks.rows.filter((r) => r.lp_clicked_at).length, bots: bots.rowCount };
  });
}

export function retentionRows(db, cutoffIso) {
  return inTransaction(db, async (client) => {
    const clicks = await client.query(`DELETE FROM clicks c WHERE c.created_at < $1
      AND NOT EXISTS (SELECT 1 FROM conversions v WHERE v.click_id = c.click_id) RETURNING lp_clicked_at`, [cutoffIso]);
    const bots = await client.query('DELETE FROM bots WHERE created_at < $1', [cutoffIso]);
    return { clicks: clicks.rowCount, conversions: 0, lpClicks: clicks.rows.filter((r) => r.lp_clicked_at).length, bots: bots.rowCount };
  });
}
