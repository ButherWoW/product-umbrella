// Optional browser integration check. Requires Playwright, or PLAYWRIGHT_MODULE
// pointing at an existing installation. Uses a disposable server and data directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-editor-ui-'));
const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: '4212',
  DATA_DIR: dataDir, DATABASE_URL: '', GEOIP_DB: '', ADMIN_TOKEN: 'ui-test-token', CLICK_RATE_LIMIT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
let output = '';
child.stderr.on('data', (chunk) => { output += chunk; });

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`UI server timeout: ${output}`)), 5000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`UI server exited ${code}: ${output}`)); });
    child.once('error', reject);
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:4212/dashboard');
  await page.locator('#app .cards').waitFor();
  const editor = page.locator('#stream-editor');
  await editor.getByRole('button', { name: '+ Поток', exact: true }).click();
  await editor.getByLabel('Название', { exact: true }).fill('iOS <safe>');
  await editor.getByLabel('Тип', { exact: true }).selectOption('forced');
  await editor.getByText('Условия отбора — пустые поля подходят всем').click();
  await editor.getByLabel('ОС: android, ios, windows, macos, linux, other', { exact: true }).fill('ios');
  await editor.getByRole('button', { name: 'Сохранить потоки', exact: true }).click();
  await editor.getByRole('status').filter({ hasText: 'укажите административный токен' }).waitFor();
  await editor.getByText('Административный токен (если включён)', { exact: true }).click();
  await editor.getByLabel('Токен хранится только до перезагрузки страницы', { exact: true }).fill('ui-test-token');
  await editor.getByRole('button', { name: 'Сохранить потоки', exact: true }).click();
  await editor.getByRole('status').filter({ hasText: 'Потоки сохранены' }).waitFor();
  const saved = await (await fetch('http://127.0.0.1:4212/api/campaigns')).json();
  assert.equal(saved.campaigns.demo.streams[0].name, 'iOS <safe>');
  assert.deepEqual(saved.campaigns.demo.streams[0].conditions.os, ['ios']);
  assert.equal(saved.campaigns.demo.streams[0].type, 'forced');
  await page.reload();
  await editor.getByLabel('Название', { exact: true }).waitFor();
  assert.equal(await editor.getByLabel('Название', { exact: true }).inputValue(), 'iOS <safe>');
  await editor.getByLabel('Название', { exact: true }).fill('Unsaved');
  await editor.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  assert.equal(await editor.getByLabel('Название', { exact: true }).inputValue(), 'iOS <safe>');
  await page.setViewportSize({ width: 390, height: 844 });
  const fits = await editor.evaluate((node) => node.scrollWidth <= node.clientWidth);
  assert.equal(fits, true, 'stream editor must fit a mobile viewport');
  assert.deepEqual(errors, [], 'dashboard must have no browser errors');
  if (process.env.UI_SCREENSHOT_PATH) await page.screenshot({ path: process.env.UI_SCREENSHOT_PATH, fullPage: true });
  console.log('Stream editor browser integration passed');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    const stopTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(stopTimer);
  }
  await rm(dataDir, { recursive: true, force: true });
}
