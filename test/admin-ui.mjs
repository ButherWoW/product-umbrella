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

  // Stream filters with «НЕ»: everything except US, from Facebook, sub_id_3=fb.
  await page.locator('.stream .title').first().click();
  const filters = page.getByRole('dialog', { name: 'Редактирование потока' });
  await filters.getByRole('tab', { name: 'Фильтры' }).click();
  await filters.getByLabel('Страны', { exact: true }).fill('us');
  await filters.getByLabel('Страны: НЕ', { exact: true }).check();
  await filters.getByLabel('Реферер', { exact: true }).fill('facebook.com');
  await filters.getByLabel('Параметры', { exact: true }).fill('sub_id_3=fb, tt');
  await filters.getByRole('button', { name: 'Применить' }).click();
  await page.locator('.stream', { hasText: 'Страны НЕ: US · Реферер: facebook.com · sub_id_3: fb, tt' }).waitFor();
  await page.locator('.editor-head .btn.primary').click();
  await page.locator('#toast', { hasText: 'Сохранено' }).waitFor();
  const filtered = (await (await fetch(server.url + '/api/campaigns')).json()).campaigns['ui-flows'].streams[0].conditions;
  assert.deepEqual([filtered.countries, filtered.not, filtered.referrers, filtered.params], [['US'], ['countries'], ['facebook.com'], { sub_id_3: ['fb', 'tt'] }]);

  // Offer conversion cap: cap, its time zone and the alternative offer from the offer dialog.
  await api('/api/offers', { id: 'ui-alt', url: 'https://alt.example.net/', name: 'Alt offer' });
  await page.goto(server.url + '/admin#/offers');
  await page.locator('table.grid tbody tr', { hasText: 'offer-1' }).getByRole('button', { name: 'Изменить' }).click();
  const offerDialog = page.getByRole('dialog', { name: 'Редактирование оффера' });
  await offerDialog.getByRole('tab', { name: 'Настройки' }).click();
  await offerDialog.getByLabel('Кап конверсий в день').fill('5');
  await offerDialog.getByLabel('Часовой пояс капа').selectOption('Europe/Paris');
  await offerDialog.getByLabel('Запасной оффер').selectOption('ui-alt');
  await offerDialog.getByRole('button', { name: 'Сохранить' }).click();
  await page.locator('#toast', { hasText: 'Сохранено' }).waitFor();
  const savedOffer = (await (await fetch(server.url + '/api/offers')).json()).offers['offer-1'];
  assert.deepEqual([savedOffer.conversionCap, savedOffer.capTz, savedOffer.altOfferId], [5, 'Europe/Paris', 'ui-alt']);
  await api('/api/offers/offer-1', { conversionCap: null, altOfferId: null }, 'PATCH');

  // Partner networks: generated postback is visible/copyable, and offers can be linked to a network.
  await page.goto(server.url + '/admin#/networks');
  await page.waitForFunction(() => location.hash === '#/networks');
  await page.locator('table.grid').waitFor();
  const createNetwork = page.getByRole('button', { name: 'Создать сеть' });
  await createNetwork.waitFor();
  await createNetwork.click();
  await page.waitForTimeout(250);
  assert.deepEqual(errors, [], 'network modal click must not raise page errors');
  const networkDialog = page.getByRole('dialog', { name: 'Новая сеть' });
  await networkDialog.waitFor();
  await networkDialog.locator('input').nth(0).fill('net-ui');
  await networkDialog.locator('input').nth(1).fill('Network UI');
  await networkDialog.locator('input').nth(2).fill('sub1={click_id}');
  await networkDialog.getByRole('button', { name: 'Сохранить' }).click();
  await page.locator('table.grid tbody tr', { hasText: 'Network UI' }).waitFor();
  await page.locator('table.grid tbody tr', { hasText: 'Network UI' }).getByRole('button', { name: 'Изменить' }).click();
  const savedNetworkDialog = page.getByRole('dialog', { name: 'Редактирование сети' });
  const postbackInput = savedNetworkDialog.locator('input[readonly]').nth(1);
  await postbackInput.waitFor();
  assert.match(await postbackInput.inputValue(), /click_id=\{sub1\}&secret=POSTBACK_SECRET&revenue=\{payout\}/);
  assert.match(await savedNetworkDialog.innerText(), /POSTBACK_SECRET/);
  await savedNetworkDialog.getByRole('button', { name: 'Копировать' }).click();
  await savedNetworkDialog.getByRole('button', { name: 'Отмена' }).click();

  await page.goto(server.url + '/admin#/offers');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const networkOfferDialog = page.getByRole('dialog', { name: 'Создание оффера' });
  await networkOfferDialog.locator('input').nth(0).fill('offer-ui');
  await networkOfferDialog.locator('input').nth(1).fill('UI offer');
  await networkOfferDialog.locator('input[type=url]').first().fill('https://offer.example.net/?x=1');
  await networkOfferDialog.getByLabel('Партнёрская сеть').selectOption('net-ui');
  await networkOfferDialog.getByRole('button', { name: 'Создать' }).click();
  await page.locator('table.grid tbody tr', { hasText: 'UI offer' }).waitFor();
  const createdOffers = await (await fetch(server.url + '/api/offers')).json();
  assert.equal(createdOffers.offers['offer-ui'].networkId, 'net-ui', 'offer keeps selected partner network');


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

  // Saved reports: save two reports with different groups+periods, reload, verify both persist and restore filters.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url + '/admin#/reports');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  // Save first report: group = Страна, period = Вчера
  await page.getByLabel('Период').selectOption('yesterday');
  await page.getByRole('button', { name: 'Страна' }).click();
  await page.locator('.chip-btn.on', { hasText: 'Страна' }).waitFor();
  await page.getByRole('button', { name: '💾 Сохранить' }).click();
  const repSaveDialog = page.getByRole('dialog', { name: 'Сохранить отчёт' });
  await repSaveDialog.waitFor();
  await repSaveDialog.getByLabel('Название отчёта').fill('Rep-1');
  await repSaveDialog.getByRole('button', { name: 'Сохранить' }).click();
  await repSaveDialog.waitFor({ state: 'detached' });
  // Save second report: group = Оффер, period = Последние 7 дней
  await page.getByLabel('Период').selectOption('last_7_days');
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
  // Click Rep-1 → full page re-render: Страна group active, period = yesterday
  await page.getByRole('button', { name: 'Открыть Rep-1' }).click();
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.locator('.chip-btn.on', { hasText: 'Страна' }).waitFor();
  assert.equal(await page.getByLabel('Период').inputValue(), 'yesterday', 'Rep-1 period restored');
  // Click Rep-2 → full page re-render: Оффер group active, period = last_7_days
  await page.getByRole('button', { name: 'Открыть Rep-2' }).click();
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.locator('.chip-btn.on', { hasText: 'Оффер' }).waitFor();
  assert.equal(await page.getByLabel('Период').inputValue(), 'last_7_days', 'Rep-2 period restored');

  // Heatmap: 7×24 grid (168 cells), click sum matches /stats, no page horizontal scroll at 390px.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url + '/admin#/reports');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  const statsForHeatmap = await (await fetch(server.url + '/stats', { headers: { authorization: 'Bearer ' + TOKEN } })).json();
  await page.getByRole('button', { name: 'Карта по часам' }).click();
  await page.locator('table.heatmap').waitFor();
  const hmCells = await page.locator('table.heatmap tbody td').count();
  assert.equal(hmCells, 168, `heatmap must have 7×24=168 cells, got ${hmCells}`);
  const hmClickSum = await page.locator('table.heatmap tbody td').evaluateAll((tds) => tds.reduce((s, td) => s + Number(td.dataset.clicks || 0), 0));
  assert.equal(hmClickSum, statsForHeatmap.clicks || 0, 'heatmap click sum matches /stats total');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const hmOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(hmOverflow <= 1, `heatmap page overflows at 390px by ${hmOverflow}px`);

  // D10: black/white lists for parameter reports
  await api('/api/campaigns', { id: 'd10-bw', name: 'D10 BW', streams: [{ name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] }], costModel: 'cpc', cpc: 1.0 });
  const d10ra = await fetch(server.url + '/r/d10-bw?sub_id_1=value-a', { redirect: 'manual' });
  const d10cid = new URL(d10ra.headers.get('location')).searchParams.get('click_id');
  await fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${d10cid}&revenue=10&currency=USD`);
  await fetch(server.url + '/r/d10-bw?sub_id_1=value-b', { redirect: 'manual' });
  await fetch(server.url + '/r/d10-bw?sub_id_1=value-b', { redirect: 'manual' });
  await page.goto(server.url + '/admin#/reports?field=sub_id_1&campaign=d10-bw');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.locator('table.grid tbody tr').first().waitFor();
  assert.ok(await page.getByRole('button', { name: 'Списки' }).isVisible(), 'lists button visible when list-type parameter field selected');
  await page.getByRole('button', { name: 'Списки' }).click();
  const listsDialog = page.getByRole('dialog', { name: 'Списки' });
  await listsDialog.waitFor();
  await listsDialog.getByLabel('Минимум кликов').fill('1');
  await listsDialog.getByLabel('Минимум кликов').dispatchEvent('input');
  await page.waitForTimeout(150);
  const listOrder = await listsDialog.evaluate((el) => {
    const headings = [...el.querySelectorAll('h3')].map((h) => h.textContent.trim());
    const texts = [...el.querySelectorAll('h3 + div')].map((d) => d.textContent.replace('Копировать', '').trim());
    return headings.map((h, i) => ({ list: h, values: texts[i] || '' }));
  });
  const blackEntry = listOrder.find((e) => e.list === 'Чёрный список');
  const whiteEntry = listOrder.find((e) => e.list === 'Белый список');
  assert.ok(blackEntry?.values.includes('value-b'), `black list should contain value-b, got: ${blackEntry?.values}`);
  assert.ok(whiteEntry?.values.includes('value-a'), `white list should contain value-a, got: ${whiteEntry?.values}`);
  await page.keyboard.press('Escape');

  // D11: uEPC, Approve %, CR (холд), CPA columns
  await api('/api/campaigns', { id: 'd11', name: 'D11 Test', streams: [{ name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] }] });
  const d11r1 = await fetch(server.url + '/r/d11', { redirect: 'manual' });
  const d11cid = new URL(d11r1.headers.get('location')).searchParams.get('click_id');
  await fetch(server.url + '/r/d11', { redirect: 'manual' });
  await fetch(`${server.url}/postback?secret=conversion-test-secret&click_id=${d11cid}&revenue=10&currency=USD`);
  const d11Stats = await (await fetch(server.url + '/stats?campaign=d11', { headers: { authorization: 'Bearer ' + TOKEN } })).json();
  await page.setViewportSize({ width: 1280, height: 900 }); // earlier checks leave a phone-width viewport (headers hidden)
  await page.goto(server.url + '/admin#/campaigns');
  await page.locator('table.grid tbody tr', { hasText: 'D11 Test' }).waitFor();
  await page.locator('button[aria-label="Колонки"]').click();
  const d11Chooser = page.getByRole('dialog', { name: 'Выбор колонок' });
  await d11Chooser.waitFor();
  await d11Chooser.locator('.col-list label', { hasText: 'uEPC' }).waitFor();
  await d11Chooser.locator('.col-list label', { hasText: 'Approve %' }).waitFor();
  await d11Chooser.locator('.col-list label', { hasText: 'CR (холд)' }).waitFor();
  await d11Chooser.locator('.col-list label', { hasText: 'CPA' }).waitFor();
  await d11Chooser.locator('.col-list label', { hasText: 'uEPC' }).locator('input[type=checkbox]').check();
  await d11Chooser.locator('.col-list label', { hasText: 'Approve %' }).locator('input[type=checkbox]').check();
  await d11Chooser.getByRole('button', { name: 'Применить' }).click();
  await d11Chooser.waitFor({ state: 'detached' });
  await page.locator('table.grid th', { hasText: 'uEPC' }).waitFor();
  await page.locator('table.grid th', { hasText: 'Approve %' }).waitFor();
  const d11TableText = await page.locator('table.grid').innerText();
  assert.ok(!d11TableText.includes('[object'), 'no stringified DOM nodes with new metric columns');
  if (d11Stats.sales > 0 && !d11Stats.leads && !d11Stats.rejected) {
    const approvePct = await page.evaluate(() => {
      const ths = [...document.querySelectorAll('table.grid th')];
      const idx = ths.findIndex((th) => th.textContent.trim() === 'Approve %');
      const row = [...document.querySelectorAll('table.grid tbody tr')].find((r) => r.textContent.includes('D11 Test'));
      return row?.querySelectorAll('td')[idx]?.textContent?.trim() || null;
    });
    assert.match(approvePct || '', /100/, `Approve % should show 100% for 1 sale, got: ${approvePct}`);
  }

  // D12: expandable rows in report
  await api('/api/campaigns', { id: 'd12-camp', name: 'D12 Camp', streams: [{ name: 'S1', offers: [{ offerId: 'offer-1', weight: 1 }] }] });
  await fetch(server.url + '/r/d12-camp', { redirect: 'manual' });
  await page.goto(server.url + '/admin#/reports?group=campaign');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.locator('table.grid tbody tr', { hasText: 'D12 Camp' }).waitFor();
  const d12Row = page.locator('table.grid tbody tr', { hasText: 'D12 Camp' });
  const expandBtn = d12Row.locator('button[aria-label="Развернуть"]');
  await expandBtn.waitFor();
  await expandBtn.click();
  const subRow = page.locator('tr.sub-row');
  await subRow.waitFor();
  assert.ok(await subRow.isVisible(), 'sub-row visible after expand');
  await expandBtn.click();
  await subRow.waitFor({ state: 'detached' });
  assert.ok(true, 'sub-row removed on second click');

  // D13: attention block on dashboard
  await api('/api/campaigns', { id: 'd13-bad', name: 'D13 Bad ROI', streams: [{ name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] }], costModel: 'cpc', cpc: 1.0 });
  await Promise.all(Array.from({ length: 100 }, () => fetch(server.url + '/r/d13-bad', { redirect: 'manual' })));
  await page.goto(server.url + '/admin#/');
  await page.getByRole('heading', { name: 'Дашборд' }).waitFor();
  const attentionCard = page.locator('.card', { hasText: 'Требуют внимания' });
  await attentionCard.waitFor({ timeout: 10000 });
  assert.ok(await attentionCard.isVisible(), 'attention block appears with bad-ROI campaign');
  const attentionText = await attentionCard.innerText();
  assert.ok(/D13 Bad ROI|d13-bad/.test(attentionText) && /ROI/.test(attentionText), `attention block has campaign info, got: ${attentionText.slice(0, 100)}`);

  // D15: compare two campaigns
  await api('/api/campaigns', { id: 'd15-alpha', name: 'D15 Alpha', streams: [{ name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] }] });
  await api('/api/campaigns', { id: 'd15-beta', name: 'D15 Beta', streams: [{ name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] }] });
  for (let i = 0; i < 3; i++) await fetch(server.url + '/r/d15-alpha', { redirect: 'manual' });
  await fetch(server.url + '/r/d15-beta', { redirect: 'manual' });
  await page.goto(server.url + '/admin#/campaigns');
  await page.locator('table.grid tbody tr', { hasText: 'D15 Alpha' }).waitFor();
  await page.locator('table.grid tbody tr', { hasText: 'D15 Alpha' }).locator('input[type=checkbox]').check();
  await page.locator('table.grid tbody tr', { hasText: 'D15 Beta' }).locator('input[type=checkbox]').check();
  await page.locator('button', { hasText: 'Сравнить' }).waitFor();
  await page.locator('button', { hasText: 'Сравнить' }).click();
  const cmpDialog = page.getByRole('dialog', { name: 'Сравнение кампаний' });
  await cmpDialog.waitFor();
  const cmpText = await cmpDialog.innerText();
  assert.ok(cmpText.includes('D15 Alpha'), `compare dialog should show first campaign, got: ${cmpText.slice(0, 200)}`);
  assert.ok(cmpText.includes('D15 Beta'), 'compare dialog should show second campaign');
  assert.ok(cmpText.includes('Клики'), 'compare dialog should show metrics');
  const cmpRows = await cmpDialog.locator('table.grid tbody tr').count();
  assert.equal(cmpRows, 9, `compare table should have 9 metric rows, got ${cmpRows}`);
  await page.keyboard.press('Escape');
  // D16: landing LP CTR and CR columns in reports
  await api('/api/landings', { id: 'landing-d16', name: 'D16 Landing', url: server.url + '/admin' });
  await api('/api/campaigns', { id: 'd16-camp', name: 'D16 Camp', streams: [{ name: 'Main', landingId: 'landing-d16', offers: [{ offerId: 'offer-1', weight: 1 }] }] });
  const d16r1 = await fetch(server.url + '/r/d16-camp', { redirect: 'manual' });
  const d16cid = d16r1.headers.get('location') ? new URL(d16r1.headers.get('location')).searchParams.get('click_id') : null;
  await fetch(server.url + '/r/d16-camp', { redirect: 'manual' });
  await fetch(server.url + '/r/d16-camp', { redirect: 'manual' });
  if (d16cid) await fetch(server.url + '/lp/click?click_id=' + d16cid, { redirect: 'manual' });
  await page.goto(server.url + '/admin#/reports?group=landing');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.locator('button.chip-btn', { hasText: 'Лендинг' }).waitFor();
  await page.locator('button.chip-btn', { hasText: 'Лендинг' }).click();
  await page.locator('table.grid').waitFor({ timeout: 5000 });
  const lpHeaders = await page.locator('table.grid thead th').allInnerTexts();
  assert.ok(lpHeaders.some((h) => h === 'LP CTR'), `landing report should have LP CTR column, got: ${lpHeaders.join(', ')}`);
  assert.ok(lpHeaders.some((h) => h.includes('CR (LP)')), `landing report should have CR (LP) column`);

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
    await p2.locator('.ip-allowlist', { hasText: 'Ограничения нет' }).waitFor();

    // API keys: the secret is shown once with a copy button, the list shows only the last 4 characters,
    // deletion needs a second click on the same row button (no confirm()).
    await p2.locator('[data-nav=keys]').click();
    await p2.getByRole('heading', { name: 'API-ключи' }).waitFor();
    await p2.getByRole('button', { name: 'Создать', exact: true }).click();
    const keyDlg = p2.getByRole('dialog', { name: 'Новый API-ключ' });
    await keyDlg.getByLabel('Название').fill('UI script');
    await keyDlg.getByRole('button', { name: 'Создать' }).click();
    const secretDlg = p2.getByRole('dialog', { name: 'Ключ создан' });
    const secret = await secretDlg.getByRole('textbox', { name: 'API-ключ' }).inputValue();
    assert.match(secret, /^umb_[A-Za-z0-9_-]{43}$/);
    assert.ok(await secretDlg.getByRole('button', { name: 'Копировать' }).isVisible());
    assert.equal((await fetch(locked.url + '/api/auth/me', { headers: { authorization: 'Bearer ' + secret } }).then((r) => r.json())).user.email, 'owner@example.com', 'the shown key works');
    await secretDlg.getByRole('button', { name: 'Готово' }).click();
    const keyRow = p2.locator('table.grid tbody tr', { hasText: 'UI script' });
    await keyRow.waitFor();
    assert.ok((await keyRow.innerText()).includes('umb_…' + secret.slice(-4)));
    assert.ok(!(await p2.locator('body').innerText()).includes(secret), 'the secret is gone after closing the dialog');
    await p2.setViewportSize({ width: 390, height: 844 });
    for (const hash of ['#/keys', '#/users']) {
      await p2.goto(locked.url + '/admin' + hash);
      await p2.locator('table.grid').waitFor();
      const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `${hash} overflows by ${overflow}px at 390px`);
    }
    await p2.setViewportSize({ width: 1280, height: 900 });
    await p2.goto(locked.url + '/admin#/keys');
    const del = p2.locator('table.grid tbody tr', { hasText: 'UI script' }).getByRole('button', { name: 'Удалить ключ UI script' });
    await del.click();
    await p2.locator('table.grid tbody tr', { hasText: 'Удалить?' }).waitFor();
    await del.click();
    await p2.locator('#toast', { hasText: 'Ключ удалён' }).waitFor();
    await p2.locator('table.grid tbody tr', { hasText: 'UI script' }).waitFor({ state: 'detached' });
    assert.equal((await fetch(locked.url + '/api/auth/me', { headers: { authorization: 'Bearer ' + secret } })).status, 401, 'deleted key stops working');
    await p2.locator('[data-nav=dashboard]').click();
    await p2.getByRole('heading', { name: 'Баеры' }).waitFor();

    // D9: buyers summary — 2 campaigns, 2 rows, click total matches /stats
    const lockedApi = (path, body) => fetch(locked.url + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }, body: body ? JSON.stringify(body) : undefined });
    const usersData = await (await lockedApi('/api/users')).json();
    const buyerUser = usersData.users.find((u) => u.email === 'buyer@example.com');
    await lockedApi('/api/campaigns', { id: 'buyers-c1', name: 'Buyers C1', streams: [{ name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] }], ownerId: buyerUser.id });
    await lockedApi('/api/campaigns', { id: 'buyers-c2', name: 'Buyers C2', streams: [{ name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] }] });
    await fetch(locked.url + '/r/buyers-c1', { redirect: 'manual' });
    await fetch(locked.url + '/r/buyers-c1', { redirect: 'manual' });
    await fetch(locked.url + '/r/buyers-c2', { redirect: 'manual' });
    await p2.goto(locked.url + '/admin#/buyers');
    await p2.getByRole('heading', { name: 'Сводка по баерам' }).waitFor();
    assert.ok(await p2.locator('[data-nav=buyers]').isVisible(), 'owner sees buyers summary nav item');
    const buyersRows = await p2.locator('table.grid tbody tr').count();
    assert.equal(buyersRows, 2, `buyers summary: expected 2 rows (buyer + unassigned), got ${buyersRows}`);
    const lockedStats = await (await lockedApi('/stats')).json();
    const buyersClickTotal = await p2.locator('table.grid tfoot tr').evaluateAll(
      (rows) => { const td = rows[0]?.querySelectorAll('td')[2]; return parseInt(td?.textContent?.replace(/\D/g, '') || '0', 10) || 0; });
    assert.equal(buyersClickTotal, lockedStats.clicks || 0, 'buyers report tfoot clicks matches /stats');

    await p2.getByRole('button', { name: 'Выйти' }).click();
    await p2.getByRole('heading', { name: 'Вход в Umbrella' }).waitFor();
    await p2.getByLabel('Email').fill('buyer@example.com');
    await p2.getByLabel('Пароль').fill('buyer-password-1');
    await p2.getByRole('button', { name: 'Войти' }).click();
    await p2.locator('#user-box', { hasText: 'buyer@example.com' }).waitFor();
    assert.ok(await p2.locator('[data-nav=users]').isHidden(), 'buyers do not see the users section');
    assert.ok(await p2.locator('[data-nav=buyers]').isHidden(), 'buyers do not see the buyers summary nav item');
    // Navigating directly to #/buyers redirects buyer to dashboard
    await p2.goto(locked.url + '/admin#/buyers');
    await p2.getByRole('heading', { name: 'Дашборд' }).waitFor();
    await p2.locator('[data-nav=dashboard]').click();
    await p2.locator('.kpi', { hasText: 'Заработок баера' }).waitFor();
    assert.equal(await p2.getByRole('heading', { name: 'Баеры' }).count(), 0, 'buyers do not see the per-buyer table');
    await p2.screenshot({ path: join(tmpdir(), 'umbrella-admin-buyer.png') });
  } finally { await locked.stop(); await rm(dir2, { recursive: true, force: true }); }

  // Task 8: period comparison adds Δ% columns, «—» without previous data, disabled for «За всё время».
  await page.setViewportSize({ width: 1280, height: 900 });
  await api('/api/campaigns', { id: 't8-compare', name: 'T8 Compare', streams: [{ name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] }] });
  await fetch(server.url + '/r/t8-compare', { redirect: 'manual' });
  await page.goto(server.url + '/admin#/reports?group=campaign&campaign=t8-compare');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.getByRole('combobox', { name: 'Период' }).selectOption('today');
  const t8Row = page.locator('table.grid tbody tr', { hasText: 'T8 Compare' });
  await t8Row.waitFor();
  const t8Box = page.getByRole('checkbox', { name: 'Сравнить с предыдущим периодом' });
  assert.ok(await t8Box.isEnabled(), 'compare checkbox enabled for «Сегодня»');
  assert.equal(await page.locator('table.grid th', { hasText: 'Δ%' }).count(), 0, 'no Δ% columns before compare');
  await t8Box.check();
  await page.locator('table.grid th', { hasText: 'Δ%' }).first().waitFor();
  assert.equal(await page.locator('table.grid th', { hasText: 'Δ%' }).count(), 4, 'Δ% next to clicks, conversions, revenue, profit');
  const t8Cells = await page.evaluate(() => {
    const ths = [...document.querySelectorAll('table.grid thead th')];
    const row = [...document.querySelectorAll('table.grid tbody tr')].find((r) => r.textContent.includes('T8 Compare'));
    const tds = [...row.querySelectorAll('td')];
    return ths.map((th, i) => [th.textContent.trim(), tds[i]?.textContent.trim()]);
  });
  const t8ClicksIdx = t8Cells.findIndex(([l]) => l.startsWith('Клики'));
  assert.ok(t8Cells[t8ClicksIdx + 1][0].startsWith('Δ%'), 'Δ% column follows clicks');
  assert.equal(t8Cells[t8ClicksIdx + 1][1], '—', 'Δ% is «—» when the previous period has no clicks');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('umbrella:reports:compare'))), true, 'compare choice persisted');
  await page.reload();
  await page.locator('table.grid tbody tr', { hasText: 'T8 Compare' }).waitFor();
  await page.locator('table.grid th', { hasText: 'Δ%' }).first().waitFor();
  assert.ok(await page.getByRole('checkbox', { name: 'Сравнить с предыдущим периодом' }).isChecked(), 'compare checkbox restored after reload');
  await page.getByRole('combobox', { name: 'Период' }).selectOption('all');
  await page.locator('table.grid tbody tr', { hasText: 'T8 Compare' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('table.grid th')?.closest('table')?.textContent.includes('Δ%'));
  assert.ok(await page.getByRole('checkbox', { name: 'Сравнить с предыдущим периодом' }).isDisabled(), 'compare disabled for «За всё время»');
  await page.getByRole('combobox', { name: 'Период' }).selectOption('today');
  await page.locator('.chip-btn', { hasText: 'День' }).click();
  assert.ok(await page.getByRole('checkbox', { name: 'Сравнить с предыдущим периодом' }).isDisabled(), 'compare disabled for day grouping');
  await page.evaluate(() => localStorage.removeItem('umbrella:reports:compare'));

  // Task 7: groups of campaigns and offers (editor + offer modal with datalist, «Группа» column and filter), archive hidden by default.
  await page.setViewportSize({ width: 1280, height: 900 });
  const t7Stream = [{ name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] }];
  await api('/api/campaigns', { id: 't7-camp-a', name: 'T7 Camp A', group: 'T7-old', streams: t7Stream });
  await api('/api/campaigns', { id: 't7-camp-b', name: 'T7 Camp B', streams: t7Stream });
  for (const id of ['t10-o1', 't10-o2', 't10-o3']) await api('/api/offers', { id, url: `https://example.com/${id}`, group: 'T10' });
  await page.goto(server.url + '/admin#/campaigns/t7-camp-b');
  await page.reload(); // the key from earlier steps was lost on reload; enter it explicitly
  await page.locator('#token-btn').click();
  const t7Key = page.getByRole('dialog', { name: 'Ключ администратора' });
  await t7Key.locator('input[type=password]').fill(TOKEN);
  await t7Key.getByRole('button', { name: 'Сохранить' }).click();
  const t7GroupInput = page.locator('.editor').getByRole('combobox', { name: 'Группа' });
  await t7GroupInput.waitFor();
  const t7Datalist = await t7GroupInput.evaluate((el) => [...el.list.options].map((o) => o.value));
  assert.ok(t7Datalist.includes('T7-old'), `campaign datalist offers existing groups, got: ${t7Datalist}`);
  await t7GroupInput.fill('T7-new');
  await page.locator('.editor-head .btn.primary').click();
  await page.locator('#toast', { hasText: 'Сохранено' }).waitFor();
  assert.equal((await (await fetch(server.url + '/api/campaigns')).json()).campaigns['t7-camp-b'].group, 'T7-new', 'campaign group saved from the editor');
  await page.goto(server.url + '/admin#/campaigns');
  await page.locator('table.grid tbody tr', { hasText: 'T7 Camp B' }).filter({ hasText: 'T7-new' }).waitFor();
  const campGroupSel = page.getByLabel('Фильтр по группе');
  await campGroupSel.locator('option[value="T7-new"]').waitFor({ state: 'attached' });
  await campGroupSel.selectOption('T7-new');
  await page.locator('table.grid tbody tr', { hasText: 'T7 Camp A' }).waitFor({ state: 'detached' });
  assert.deepEqual(await page.locator('table.grid tbody tr td:nth-child(3)').allInnerTexts(), ['t7-camp-b'], 'group filter leaves only the campaigns of that group');
  await campGroupSel.selectOption('');
  await api('/api/campaigns/t7-camp-a', { archived: true }, 'PATCH');
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await page.locator('table.grid tbody tr', { hasText: 'T7 Camp B' }).waitFor();
  await page.locator('table.grid tbody tr', { hasText: 'T7 Camp A' }).waitFor({ state: 'detached' });
  await page.getByLabel('Состояние').selectOption('archived');
  await page.locator('table.grid tbody tr', { hasText: 'T7 Camp A' }).waitFor();
  assert.equal(await page.locator('table.grid tbody tr', { hasText: 'T7 Camp B' }).count(), 0, 'archive view shows only archived campaigns');
  // Offer modal: group field with existing groups, value sent on save.
  await page.goto(server.url + '/admin#/offers');
  await page.locator('table.grid tbody tr', { hasText: 't10-o3' }).getByRole('button', { name: 'Изменить' }).click();
  const t7OfferDlg = page.getByRole('dialog', { name: 'Редактирование оффера' });
  const t7OfferGroup = t7OfferDlg.getByRole('combobox', { name: 'Группа' });
  assert.equal(await t7OfferGroup.inputValue(), 'T10');
  assert.ok((await t7OfferGroup.evaluate((el) => [...el.list.options].map((o) => o.value))).includes('T10'), 'offer datalist offers existing groups');
  await t7OfferGroup.fill('T10-solo');
  await t7OfferDlg.getByRole('button', { name: 'Сохранить' }).click();
  await t7OfferDlg.waitFor({ state: 'detached' });
  assert.equal((await (await fetch(server.url + '/api/offers')).json()).offers['t10-o3'].group, 'T10-solo', 'offer group saved from the modal');

  // Task 10: bulk actions with selected offers — daily cap, group, archive (with in-page confirmation).
  const offerRow = (id) => page.locator('table.grid tbody tr').filter({ has: page.getByRole('link', { name: id, exact: true }) });
  const offersGroupSel = page.getByLabel('Фильтр по группе');
  await offersGroupSel.locator('option[value="T10"]').waitFor({ state: 'attached' });
  await offersGroupSel.selectOption('T10');
  await offerRow('t10-o3').waitFor({ state: 'detached' });
  assert.equal(await page.locator('table.grid tbody tr').count(), 2, 'offers group filter leaves the two T10 offers');
  const selectT10 = async () => { for (const id of ['t10-o1', 't10-o2']) await offerRow(id).getByRole('checkbox', { name: 'Выбрать' }).check(); };
  await selectT10();
  await page.getByRole('button', { name: 'Задать дневной кап…' }).click();
  const capDlg = page.getByRole('dialog', { name: 'Дневной кап для офферов' });
  await capDlg.getByLabel('Дневной кап кликов').fill('7');
  await capDlg.getByRole('button', { name: 'Применить' }).click();
  await page.locator('#toast', { hasText: 'Кап задан: 2' }).waitFor();
  let t10Offers = (await (await fetch(server.url + '/api/offers')).json()).offers;
  assert.deepEqual([t10Offers['t10-o1'].dailyCap, t10Offers['t10-o2'].dailyCap, t10Offers['t10-o3'].dailyCap], [7, 7, null], 'bulk cap applied to the selected offers only');
  await selectT10();
  await page.getByRole('button', { name: 'Сменить группу…' }).click();
  const grpDlg = page.getByRole('dialog', { name: 'Группа для офферов' });
  await grpDlg.getByRole('combobox', { name: 'Группа' }).fill('T10-bulk');
  await grpDlg.getByRole('button', { name: 'Применить' }).click();
  await page.locator('#toast', { hasText: 'Группа изменена: 2' }).waitFor();
  t10Offers = (await (await fetch(server.url + '/api/offers')).json()).offers;
  assert.deepEqual([t10Offers['t10-o1'].group, t10Offers['t10-o2'].group], ['T10-bulk', 'T10-bulk']);
  await offersGroupSel.locator('option[value="T10-bulk"]').waitFor({ state: 'attached' });
  await offersGroupSel.selectOption('T10-bulk');
  await offerRow('t10-o3').waitFor({ state: 'detached' });
  await selectT10();
  await page.getByRole('button', { name: 'В архив', exact: true }).click();
  assert.ok(!(await t10OffersArchived()), 'first click only asks for confirmation');
  await page.getByRole('button', { name: /В архив 2\? Нажмите ещё раз/ }).click();
  await page.locator('#toast', { hasText: 'В архиве: 2' }).waitFor();
  await offerRow('t10-o1').waitFor({ state: 'detached' });
  assert.equal(await offerRow('t10-o2').count(), 0, 'archived offers are hidden from the list');
  assert.ok(await t10OffersArchived(), 'bulk archive stored');
  await page.getByLabel('Состояние').selectOption('archived');
  await offerRow('t10-o1').waitFor();
  await offerRow('t10-o2').waitFor();
  assert.equal(await page.locator('#view .err[role=alert]').count(), 0, 'no per-offer errors');
  assert.ok(!(await page.locator('body').innerText()).includes('[object'), 'no stringified DOM nodes on offers page');
  async function t10OffersArchived() { const o = (await (await fetch(server.url + '/api/offers')).json()).offers; return o['t10-o1'].archived && o['t10-o2'].archived; }

  // Tasks 5–6 (PR #31): network postback with the network's own click-id macro, offer URL params, copy and archive from the row menu.
  await page.setViewportSize({ width: 1280, height: 900 });
  await api('/api/networks', { id: 't6-net', name: 'T6 Net', offerParams: 'sub1={click_id}&sub2={campaign}', clickIdParam: '{sub1}', payoutParam: 'amount' });
  await page.goto(server.url + '/admin#/networks');
  await page.locator('table.grid tbody tr', { hasText: 'T6 Net' }).getByRole('button', { name: 'Изменить' }).click();
  const t6NetDlg = page.getByRole('dialog', { name: 'Редактирование сети' });
  const t6Postback = await t6NetDlg.getByLabel('URL постбэка').inputValue();
  assert.ok(t6Postback.endsWith('/postback?click_id={sub1}&secret=POSTBACK_SECRET&revenue={amount}&currency=EUR'), 'postback uses the network macros: ' + t6Postback);
  assert.ok(!t6Postback.includes('{{'), 'no doubled braces');
  await t6NetDlg.getByRole('button', { name: 'Отмена' }).click();

  await api('/api/offers', { id: 't6-offer', url: 'https://t6.example.net/?x=1', name: 'T6 offer', networkId: 't6-net' });
  await page.goto(server.url + '/admin#/offers');
  const t6Row = (id) => page.locator('table.grid tbody tr').filter({ has: page.getByRole('link', { name: id, exact: true }) });
  await t6Row('t6-offer').getByRole('button', { name: 'Изменить' }).click();
  const t6OfferDlg = page.getByRole('dialog', { name: 'Редактирование оффера' });
  const t6AddParams = t6OfferDlg.getByRole('button', { name: 'Добавить параметры сети в URL' });
  await t6AddParams.click();
  await t6AddParams.click();
  const t6Url = await t6OfferDlg.locator('input[type=url]').first().inputValue();
  assert.equal(t6Url, 'https://t6.example.net/?x=1&sub1={click_id}&sub2={campaign}', 'network params appended once');
  await t6OfferDlg.getByRole('button', { name: 'Сохранить' }).click();
  await t6OfferDlg.waitFor({ state: 'detached' });
  assert.equal((await (await fetch(server.url + '/api/offers')).json()).offers['t6-offer'].url, t6Url);

  await t6Row('t6-offer').getByRole('button', { name: 'Копировать', exact: true }).click();
  await page.locator('#toast', { hasText: 'Копия создана: t6-offer-copy' }).waitFor();
  await page.locator('table.grid tbody tr', { hasText: 'T6 offer (копия)' }).waitFor();
  await t6Row('t6-offer-copy').getByRole('button', { name: 'Архивировать' }).click();
  assert.equal((await (await fetch(server.url + '/api/offers')).json()).offers['t6-offer-copy'].archived, false, 'first click only arms the archive button');
  await t6Row('t6-offer-copy').getByRole('button', { name: 'Архивировать' }).click();
  await t6Row('t6-offer-copy').waitFor({ state: 'detached' });
  assert.equal((await (await fetch(server.url + '/api/offers')).json()).offers['t6-offer-copy'].archived, true);
  await page.getByLabel('Состояние').selectOption('archived');
  await t6Row('t6-offer-copy').waitFor();
  await t6Row('t6-offer-copy').getByRole('button', { name: 'Вернуть из архива' }).click();
  await t6Row('t6-offer-copy').getByRole('button', { name: 'Вернуть из архива' }).click();
  await t6Row('t6-offer-copy').waitFor({ state: 'detached' });
  assert.equal((await (await fetch(server.url + '/api/offers')).json()).offers['t6-offer-copy'].archived, false, 'restored from archive');

  await api('/api/campaigns', { id: 't6-camp', name: 'T6 camp', active: true, streams: [{ name: 'Main', offers: [{ offerId: 't6-offer', weight: 1 }] }] });
  await page.goto(server.url + '/admin#/campaigns');
  const t6CampRow = (id) => page.locator('table.grid tbody tr').filter({ has: page.locator('td', { hasText: new RegExp('^' + id + '$') }) });
  await t6CampRow('t6-camp').getByRole('button', { name: 'Копировать', exact: true }).click();
  await page.locator('#toast', { hasText: 'Копия создана (выключена): t6-camp-copy' }).waitFor();
  await page.locator('table.grid tbody tr', { hasText: 'T6 camp (копия)' }).waitFor();
  let t6Camps = (await (await fetch(server.url + '/api/campaigns')).json()).campaigns;
  assert.equal(t6Camps['t6-camp-copy'].name, 'T6 camp (копия)');
  assert.equal(t6Camps['t6-camp-copy'].active, false, 'campaign copy is created disabled');
  await t6CampRow('t6-camp-copy').getByRole('button', { name: 'Архивировать' }).click();
  await t6CampRow('t6-camp-copy').getByRole('button', { name: 'Архивировать' }).click();
  await t6CampRow('t6-camp-copy').waitFor({ state: 'detached' });
  t6Camps = (await (await fetch(server.url + '/api/campaigns')).json()).campaigns;
  assert.equal(t6Camps['t6-camp-copy'].archived, true);
  await t6CampRow('t6-camp').waitFor();
  await page.getByLabel('Состояние').selectOption('archived');
  await t6CampRow('t6-camp-copy').waitFor();
  assert.equal(await t6CampRow('t6-camp').count(), 0, 'archive view shows only archived campaigns');
  // Visitor binding: campaign editor fields «Привязка посетителя» and «Срок привязки, часов» round-trip through save.
  await page.setViewportSize({ width: 1280, height: 900 });
  await api('/api/campaigns', { id: 'bind-ui', name: 'Bind UI', streams: [{ name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] }] });
  await page.goto(server.url + '/admin#/campaigns/bind-ui');
  const bindSelect = page.getByRole('combobox', { name: 'Привязка посетителя' });
  await bindSelect.waitFor();
  assert.equal(await bindSelect.inputValue(), 'off', 'binding is off by default');
  assert.deepEqual(await bindSelect.locator('option').allTextContents(), ['Нет', 'К потоку', 'К потоку и офферу']);
  await bindSelect.selectOption('stream_offer');
  await page.getByRole('spinbutton', { name: 'Срок привязки, часов' }).fill('48');
  await page.locator('.editor-head .btn.primary').click();
  // The admin key lives only in tab memory; earlier reloads dropped it.
  const bindKeyDialog = page.getByRole('dialog', { name: 'Ключ администратора' });
  if (await bindKeyDialog.waitFor({ timeout: 1500 }).then(() => true, () => false)) {
    await bindKeyDialog.locator('input[type=password]').fill(TOKEN);
    await bindKeyDialog.getByRole('button', { name: 'Сохранить' }).click();
    await page.locator('.editor-head .btn.primary').click();
  }
  await page.locator('#toast', { hasText: 'Сохранено' }).waitFor();
  const bindSaved = (await (await api('/api/campaigns', undefined, 'GET')).json()).campaigns['bind-ui'];
  assert.deepEqual([bindSaved.bindVisitors, bindSaved.bindTtlHours], ['stream_offer', 48], 'binding settings saved');

  assert.deepEqual(errors, []);
  console.log('Admin UI browser test passed');
} finally {
  await browser?.close();
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
}
