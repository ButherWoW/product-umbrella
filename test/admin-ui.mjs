// Optional browser check for /admin. Requires Playwright, or PLAYWRIGHT_MODULE pointing at an existing installation.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './test-server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const TOKEN = 'admin-ui-token';
const dataDir = await mkdtemp(join(tmpdir(), 'umbrella-admin-ui-'));
await writeFile(join(dataDir, 'fx-rates.json'), JSON.stringify({ base: 'EUR', rates: { EUR: 1, USD: 1.25, RUB: 100 }, updatedAt: '2026-10-30T00:00:00.000Z', source: 'test' }));
const server = await startTestServer(dataDir, { ADMIN_TOKEN: TOKEN });
const api = (path, body, method = 'POST') => fetch(server.url + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body) });
let browser;
try {
  await api('/api/campaigns', { id: 'ui-flows', name: 'UI flows', streams: [
    { name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] },
    { name: 'Spare', type: 'fallback', offers: [{ offerId: 'offer-1', weight: 1 }] },
  ] });
  for (let i = 0; i < 3; i++) await fetch(server.url + '/r/ui-flows', { redirect: 'manual' });
  const paidClick = new URL((await fetch(server.url + '/r/demo/offer-1', { redirect: 'manual' })).headers.get('location')).searchParams.get('click_id');
  await fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${paidClick}&revenue=25&currency=USD`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(server.url + '/admin#/campaigns');
  await page.locator('table.grid tbody tr', { hasText: 'UI flows' }).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('[object'), 'no stringified DOM nodes');

  await page.goto(server.url + '/admin#/campaigns/ui-flows');
  await page.locator('.stream .title').first().click();
  const dialog = page.getByRole('dialog', { name: 'Редактирование потока' });
  await dialog.getByRole('tab', { name: 'Схема' }).click();
  await dialog.getByLabel('Прямой URL').check();
  await dialog.locator('input[type=url]').fill('https://landing.example.net/?c={campaign}');
  await dialog.getByRole('tab', { name: 'Основные' }).click();
  await dialog.locator('input[name=scount]').nth(1).check();
  await dialog.getByRole('button', { name: 'Применить' }).click();
  await page.locator('.stream', { hasText: 'Прямой URL: https://landing.example.net/' }).waitFor();
  await page.locator('.stream', { hasText: 'Клики не считаются' }).waitFor();

  // Saving without the key opens the key dialog instead of failing silently.
  await page.locator('.editor-head .btn.primary').click();
  const keyDialog = page.getByRole('dialog', { name: 'Ключ администратора' });
  await keyDialog.waitFor();
  await keyDialog.locator('input[type=password]').fill(TOKEN);
  await keyDialog.getByRole('button', { name: 'Сохранить' }).click();
  await page.locator('.editor-head .btn.primary').click();
  await page.locator('#toast', { hasText: 'Сохранено' }).waitFor();

  // Landings: create in the section, then attach to the Main stream in its «Схема» tab.
  await page.locator('[data-nav=landings]').click();
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const lpDialog = page.getByRole('dialog', { name: 'Создание лендинга' });
  await lpDialog.locator('input').nth(0).fill('lp-ui');
  await lpDialog.locator('input').nth(1).fill('UI landing');
  await lpDialog.locator('input[type=url]').fill('https://lp.example.net/?go={lp_click_url}');
  await lpDialog.getByRole('button', { name: 'Создать' }).click();
  await page.locator('table.grid tbody tr', { hasText: 'UI landing' }).waitFor();
  await page.goto(server.url + '/admin#/campaigns/ui-flows');
  await page.locator('.stream .title').nth(1).click();
  const spare = page.getByRole('dialog', { name: 'Редактирование потока' });
  await spare.getByRole('tab', { name: 'Схема' }).click();
  await spare.getByRole('button', { name: '+ Добавить лендинг' }).click();
  await spare.getByLabel('Лендинг', { exact: true }).selectOption('lp-ui');
  await spare.getByRole('button', { name: 'Применить' }).click();
  await page.locator('.stream', { hasText: 'Лендинги: UI landing' }).waitFor();
  await page.locator('.editor-head .btn.primary').click();
  await page.locator('#toast', { hasText: 'Сохранено' }).waitFor();


  // Currency switch on the dashboard: 25 USD = 20 EUR = 2000 RUB at the fixed test rates.
  await page.goto(server.url + '/admin#/dashboard');
  const revenueTile = page.locator('.kpi', { hasText: 'Доход' }).locator('.v');
  await revenueTile.filter({ hasText: '€' }).waitFor();
  assert.match(await revenueTile.innerText(), /20,00/);
  await page.getByLabel('Валюта').selectOption('RUB');
  await revenueTile.filter({ hasText: '₽' }).waitFor();
  assert.match((await revenueTile.innerText()).replace(/\s/g, ''), /2000,00₽/);
  assert.match(await page.locator('.rates-note').innerText(), /1 EUR = 100 RUB/);
  await page.getByLabel('Валюта').selectOption('EUR');
  // Buyer earnings: 35% of net profit (20 EUR revenue, no cost) = 7 EUR; owner can change the share.
  const earnings = page.locator('.kpi', { hasText: 'Заработок баера' });
  await earnings.locator('.v').filter({ hasText: '7,00' }).waitFor();
  await earnings.click();
  const shareDialog = page.getByRole('dialog', { name: 'Доля баера' });
  await shareDialog.locator('input').fill('50');
  await shareDialog.getByRole('button', { name: 'Сохранить' }).click();
  await earnings.locator('.v').filter({ hasText: '10,00' }).waitFor();
  assert.match(await earnings.locator('.k').innerText(), /50%/);

  const stored = (await (await fetch(server.url + '/api/campaigns')).json()).campaigns['ui-flows'].streams;
  assert.equal(stored[0].action, 'url');
  assert.equal(stored[0].url, 'https://landing.example.net/?c={campaign}');
  assert.equal(stored[0].countClicks, false);
  assert.ok(!('offers' in stored[0]));
  assert.equal(stored[1].name, 'Spare');
  assert.deepEqual(stored[1].landings, [{ landingId: 'lp-ui', weight: 1 }], 'landing attached through the UI is saved');
  assert.equal(stored[0].action, 'url', 'reopening the editor keeps action streams intact');

  // Phone width: no horizontal page scroll on the main screens.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const hash of ['#/dashboard', '#/campaigns', '#/campaigns/ui-flows', '#/reports', '#/clicks']) {
    await page.goto(server.url + '/admin' + hash);
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${hash} overflows by ${overflow}px at 390px`);
  }
  await page.screenshot({ path: join(tmpdir(), 'umbrella-admin-mobile.png'), fullPage: true });

  // Saved reports: save two reports with different groups, reload, verify both persist and load with correct filters.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url + '/admin#/reports');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  // Save first report with group = Страна
  await page.getByRole('button', { name: 'Страна' }).click();
  await page.locator('.chip-btn.on', { hasText: 'Страна' }).waitFor();
  await page.getByRole('button', { name: '💾 Сохранить' }).click();
  const repSaveDialog = page.getByRole('dialog', { name: 'Сохранить отчёт' });
  await repSaveDialog.waitFor();
  await repSaveDialog.getByLabel('Название отчёта').fill('Rep-1');
  await repSaveDialog.getByRole('button', { name: 'Сохранить' }).click();
  await repSaveDialog.waitFor({ state: 'detached' });
  // Save second report with group = Оффер
  await page.getByRole('button', { name: 'Оффер' }).click();
  await page.locator('.chip-btn.on', { hasText: 'Оффер' }).waitFor();
  await page.getByRole('button', { name: '💾 Сохранить' }).click();
  await repSaveDialog.waitFor();
  await repSaveDialog.getByLabel('Название отчёта').fill('Rep-2');
  await repSaveDialog.getByRole('button', { name: 'Сохранить' }).click();
  await repSaveDialog.waitFor({ state: 'detached' });
  // Both chips visible immediately after saving
  await page.getByRole('button', { name: 'Открыть Rep-1' }).waitFor();
  await page.getByRole('button', { name: 'Открыть Rep-2' }).waitFor();
  // Reload and navigate back — chips must survive (localStorage persists)
  await page.reload();
  await page.goto(server.url + '/admin#/reports');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.getByRole('button', { name: 'Открыть Rep-1' }).waitFor();
  await page.getByRole('button', { name: 'Открыть Rep-2' }).waitFor();
  // Click Rep-1 → filters restore to Страна group
  await page.getByRole('button', { name: 'Открыть Rep-1' }).click();
  await page.locator('.chip-btn.on', { hasText: 'Страна' }).waitFor();
  // Click Rep-2 → filters restore to Оффер group
  await page.getByRole('button', { name: 'Открыть Rep-2' }).click();
  await page.locator('.chip-btn.on', { hasText: 'Оффер' }).waitFor();

  assert.deepEqual(errors, []);

  // Accounts: a REQUIRE_LOGIN install starts with the setup screen; owner creates a buyer; logout returns to login.
  const dir2 = await mkdtemp(join(tmpdir(), 'umbrella-admin-auth-'));
  const locked = await startTestServer(dir2, { ADMIN_TOKEN: TOKEN, REQUIRE_LOGIN: '1' });
  try {
    const p2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    p2.on('pageerror', (error) => errors.push(error.message));
    await p2.goto(locked.url + '/admin#/campaigns');
    await p2.getByRole('heading', { name: 'Первый запуск' }).waitFor();
    assert.ok(await p2.locator('#sidebar').isHidden(), 'navigation hidden before login');
    await p2.getByLabel('Email').fill('owner@example.com');
    await p2.getByLabel('Пароль', { exact: false }).first().fill('owner-password-1');
    await p2.getByRole('textbox', { name: 'Ключ администратора' }).fill('wrong-key');
    await p2.getByRole('button', { name: 'Создать владельца' }).click();
    await p2.getByText('Неверный ключ администратора.').waitFor();
    await p2.getByRole('textbox', { name: 'Ключ администратора' }).fill(TOKEN);
    await p2.getByRole('button', { name: 'Создать владельца' }).click();
    await p2.locator('#user-box', { hasText: 'owner@example.com' }).waitFor();
    await p2.locator('[data-nav=users]').click();
    await p2.getByRole('heading', { name: 'Пользователи' }).waitFor();
    await p2.getByRole('button', { name: 'Создать', exact: true }).click();
    const dlg = p2.getByRole('dialog', { name: 'Новый пользователь' });
    await dlg.locator('input[type=email]').fill('buyer@example.com');
    await dlg.locator('input[type=password]').fill('buyer-password-1');
    await dlg.getByRole('button', { name: 'Создать' }).click();
    await p2.locator('table.grid tbody tr', { hasText: 'buyer@example.com' }).waitFor();
    await p2.locator('[data-nav=dashboard]').click();
    await p2.getByRole('heading', { name: 'Баеры' }).waitFor();
    await p2.getByRole('button', { name: 'Выйти' }).click();
    await p2.getByRole('heading', { name: 'Вход в Umbrella' }).waitFor();
    await p2.getByLabel('Email').fill('buyer@example.com');
    await p2.getByLabel('Пароль').fill('buyer-password-1');
    await p2.getByRole('button', { name: 'Войти' }).click();
    await p2.locator('#user-box', { hasText: 'buyer@example.com' }).waitFor();
    assert.ok(await p2.locator('[data-nav=users]').isHidden(), 'buyers do not see the users section');
    await p2.locator('[data-nav=dashboard]').click();
    await p2.locator('.kpi', { hasText: 'Заработок баера' }).waitFor();
    assert.equal(await p2.getByRole('heading', { name: 'Баеры' }).count(), 0, 'buyers do not see the per-buyer table');
    await p2.screenshot({ path: join(tmpdir(), 'umbrella-admin-buyer.png') });
  } finally { await locked.stop(); await rm(dir2, { recursive: true, force: true }); }

  assert.deepEqual(errors, []);
  console.log('Admin UI browser test passed');
} finally {
  await browser?.close();
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
}
