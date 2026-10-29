// Optional browser integration check, using an existing Playwright installation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-logs-ui-'));
const clicks = Array.from({ length: 27 }, (_, index) => ({ type: 'click',
  clickId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
  campaign: 'demo', offerId: 'offer-1', stream: 'mobile', country: 'US',
  at: `2026-10-29T12:00:${String(index).padStart(2, '0')}.000Z`,
  path: '/r/demo', userAgent: '<img src=x onerror="throw new Error(\'unsafe HTML\')">', ip: '127.0.0.1' }));
const conversions = clicks.slice(0, 2).map((click) => ({ type: 'conversion', clickId: click.clickId,
  at: '2026-10-29T13:00:00.000Z', revenue: 2.5, currency: 'USD' }));
await writeFile(join(dataDir, 'events.jsonl'), [...clicks, ...conversions].map((item) => JSON.stringify(item)).join('\n') + '\n');
const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: '4213', DATA_DIR: dataDir,
  DATABASE_URL: '', GEOIP_DB: '', ADMIN_TOKEN: 'log-ui-token', CLICK_RATE_LIMIT: '0', MONITOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
let output = '';
child.stderr.on('data', (chunk) => { output += chunk; });

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Log UI server timeout: ${output}`)), 5000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Log UI server exited ${code}: ${output}`)); });
    child.once('error', reject);
  });
  const unauthorized = await fetch('http://127.0.0.1:4213/api/clicks');
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: 'admin_authorization_required' });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:4213/dashboard');
  const logs = page.locator('#event-logs');
  await logs.getByRole('status').filter({ hasText: 'Укажите административный токен' }).waitFor();
  await logs.getByLabel('Административный токен журнала', { exact: true }).fill('log-ui-token');
  await logs.getByRole('button', { name: 'Применить к журналу', exact: true }).click();
  await logs.getByRole('status').filter({ hasText: 'Кликов на странице: 25' }).waitFor();
  assert.equal(await logs.locator('tbody tr').count(), 25);
  await logs.getByRole('button', { name: 'Следующая страница журнала', exact: true }).click();
  await logs.getByRole('status').filter({ hasText: 'Кликов на странице: 2' }).waitFor();
  assert.equal(await logs.getByRole('button', { name: 'Следующая страница журнала', exact: true }).isDisabled(), true);
  await logs.getByRole('button', { name: 'Предыдущая страница журнала', exact: true }).click();
  await logs.getByRole('status').filter({ hasText: 'Кликов на странице: 25' }).waitFor();
  await logs.getByLabel('Поток журнала', { exact: true }).fill('missing');
  await logs.getByRole('button', { name: 'Применить к журналу', exact: true }).click();
  await logs.getByText('Нет событий по выбранным условиям.', { exact: true }).waitFor();
  await logs.getByRole('button', { name: 'Сбросить фильтры журнала', exact: true }).click();
  await logs.getByRole('status').filter({ hasText: 'Кликов на странице: 25' }).waitFor();
  await logs.getByRole('tab', { name: 'Конверсии', exact: true }).click();
  await logs.getByRole('status').filter({ hasText: 'Конверсий на странице: 2' }).waitFor();
  assert.equal(await logs.locator('tbody tr').count(), 2);
  assert.ok((await logs.locator('table').innerText()).includes('2.5'));
  await logs.getByLabel('С даты (UTC)', { exact: true }).fill('2026-10-30');
  await logs.getByLabel('По дату (UTC)', { exact: true }).fill('2026-10-29');
  await logs.getByRole('button', { name: 'Применить к журналу', exact: true }).click();
  await logs.getByRole('status').filter({ hasText: 'Дата начала должна быть не позже' }).waitFor();
  await logs.getByRole('button', { name: 'Сбросить фильтры журнала', exact: true }).click();
  await logs.getByRole('status').filter({ hasText: 'Конверсий на странице: 2' }).waitFor();
  await logs.getByRole('tab', { name: 'Клики', exact: true }).click();
  await logs.getByRole('status').filter({ hasText: 'Кликов на странице: 25' }).waitFor();
  await logs.locator('tbody details summary').first().click();
  assert.equal(await logs.locator('img').count(), 0, 'raw User-Agent must never become HTML');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await logs.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  assert.deepEqual(errors, [], 'event logs UI must have no page errors');
  if (process.env.LOG_UI_SCREENSHOT_PATH) await logs.screenshot({ path: process.env.LOG_UI_SCREENSHOT_PATH });
  console.log('Event log browser integration passed');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.kill('SIGTERM'); await exited; clearTimeout(timer);
  }
  await rm(dataDir, { recursive: true, force: true });
}
