// Shared setup for the browser checks of the panel (test/ui/*.mjs). Every check file starts its own server with
// its own data directory and browser, so the files are independent and can run in parallel and in any order:
//   node --test $(ls test/ui/*.mjs | grep -v setup.mjs)      or      node test/ui/<file>.mjs
// Requires Playwright, or PLAYWRIGHT_MODULE pointing at an existing installation.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from '../test-server.mjs';

export const TOKEN = 'admin-ui-token';
export const SECRET = 'conversion-test-secret';
// Fixed rates so currency checks are deterministic: 25 USD = 20 EUR = 2000 RUB.
export const TEST_RATES = { base: 'EUR', rates: { EUR: 1, USD: 1.25, RUB: 100 }, updatedAt: '2026-10-30T00:00:00.000Z', source: 'test' };
export const MAIN_STREAM = [{ name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] }];

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

/** Starts a server (fresh data dir) and a browser. `env` goes to the server on top of the test defaults. */
export async function startUi(name, { env = {}, rates = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), `umbrella-ui-${name}-`));
  if (rates) await writeFile(join(dataDir, 'fx-rates.json'), JSON.stringify(TEST_RATES));
  const server = await startTestServer(dataDir, { ADMIN_TOKEN: TOKEN, ...env });
  let browser;
  try { browser = await chromium.launch({ headless: true }); } catch (error) { await server.stop(); await rm(dataDir, { recursive: true, force: true }); throw error; }
  const errors = [];
  const url = server.url;

  const ui = {
    url, dataDir, browser, errors,
    /** JSON API call with the admin token. GET when `body` is undefined and no method is given. */
    api: (path, body, method = body === undefined ? 'GET' : 'POST') => fetch(url + path, { method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) }),
    json: async (path) => (await ui.api(path)).json(),
    /** One tracked click; returns its click id (null when the campaign answered without a redirect). */
    click: async (path, headers = {}) => {
      const res = await fetch(url + path, { redirect: 'manual', headers });
      const location = res.headers.get('location');
      return location ? new URL(location, url).searchParams.get('click_id') : null;
    },
    postback: (query) => fetch(`${url}/postback?secret=${SECRET}&${query}`),
    campaign: (id, name, extra = {}) => ui.api('/api/campaigns', { id, name, streams: MAIN_STREAM, ...extra }),
    async newPage(viewport = { width: 1280, height: 900 }) {
      const page = await browser.newPage({ viewport });
      page.on('pageerror', (error) => errors.push(error.message));
      return page;
    },
    /** Opens the panel at `path` (/campaigns, /reports?group=…) and stores the admin key in the tab (it lives in memory until a reload). */
    async openWithKey(page, path) {
      // Landings need no key, so no key dialog pops up on its own before we open it.
      await page.goto(url + '/landings');
      await page.locator('table.grid').waitFor();
      const dialog = page.getByRole('dialog', { name: 'Ключ администратора' });
      if (!(await dialog.isVisible())) await page.locator('#token-btn').click();
      await dialog.locator('input[type=password]').fill(TOKEN);
      await dialog.getByRole('button', { name: 'Сохранить' }).click();
      await dialog.waitFor({ state: 'detached' });
      await ui.go(page, path);
    },
    /** In-panel navigation (history.pushState, as a link click does): no reload, so the in-memory admin key stays. */
    async go(page, path) {
      if (!page.url().startsWith(url + '/')) return void await page.goto(url + path); // a fresh tab: first load
      await page.evaluate((p) => { history.pushState(null, '', p); dispatchEvent(new PopStateEvent('popstate')); }, path);
    },
    async save(page, toast = 'Сохранено') {
      await page.locator('.editor-head .btn.primary').click();
      await page.locator('#toast', { hasText: toast }).waitFor();
    },
    async stop() {
      await browser.close().catch(() => {});
      await server.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  return ui;
}

/** Runs `body(ui)` against a fresh server and browser, checks there were no page errors, always cleans up. */
export async function runUi(name, options, body) {
  if (typeof options === 'function') { body = options; options = {}; }
  const ui = await startUi(name, options);
  try {
    await body(ui);
    assert.deepEqual(ui.errors, [], 'no page errors');
    console.log(`UI ${name}: passed`);
  } finally { await ui.stop(); }
}

/** Header text → cell text of the first table.grid row (tbody or tfoot) containing `text`. */
export function rowCells(page, text, section = 'tbody') {
  return page.evaluate(([needle, part]) => {
    const ths = [...document.querySelectorAll('table.grid thead th')].map((th) => th.textContent.trim());
    const row = [...document.querySelectorAll(`table.grid ${part} tr`)].find((r) => !needle || r.textContent.includes(needle));
    if (!row) return null;
    const tds = [...row.querySelectorAll('td, th')].map((td) => td.textContent.trim());
    return Object.fromEntries(ths.map((t, i) => [t, tds[i]]));
  }, [text, section]);
}

/** Horizontal overflow of the page in px after the current layout settles. */
export async function pageOverflow(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}
