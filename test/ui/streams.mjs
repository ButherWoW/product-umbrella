// Campaign editor, streams: direct-URL action, «Клики не считаются», key dialog on save, landing attached in «Схема»,
// filters with «НЕ», connection type filter + report grouping, visitor binding fields.
import assert from 'node:assert/strict';
import { runUi, TOKEN, MAIN_STREAM } from './setup.mjs';

await runUi('streams', async (ui) => {
  await ui.api('/api/campaigns', { id: 'ui-flows', name: 'UI flows', streams: [
    { name: 'Main', offers: [{ offerId: 'offer-1', weight: 1 }] },
    { name: 'Spare', type: 'fallback', offers: [{ offerId: 'offer-1', weight: 1 }] },
  ] });
  for (let i = 0; i < 3; i++) await ui.click('/r/ui-flows');
  const page = await ui.newPage();

  await ui.go(page, '/campaigns');
  await page.locator('table.grid tbody tr', { hasText: 'UI flows' }).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('[object'), 'no stringified DOM nodes');

  await ui.go(page, '/campaigns/ui-flows');
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
  await ui.save(page);

  // Landings: create in the section, then attach to the Spare stream in its «Схема» tab.
  await page.locator('[data-nav=landings]').click();
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const lpDialog = page.getByRole('dialog', { name: 'Создание лендинга' });
  await lpDialog.locator('input').nth(0).fill('lp-ui');
  await lpDialog.locator('input').nth(1).fill('UI landing');
  await lpDialog.locator('input[type=url]').fill('https://lp.example.net/?go={lp_click_url}');
  await lpDialog.getByRole('button', { name: 'Создать' }).click();
  await page.locator('table.grid tbody tr', { hasText: 'UI landing' }).waitFor();
  await ui.go(page, '/campaigns/ui-flows');
  await page.locator('.stream .title').nth(1).click();
  const spare = page.getByRole('dialog', { name: 'Редактирование потока' });
  await spare.getByRole('tab', { name: 'Схема' }).click();
  await spare.getByRole('button', { name: '+ Добавить лендинг' }).click();
  await spare.getByLabel('Лендинг', { exact: true }).selectOption('lp-ui');
  await spare.getByRole('button', { name: 'Применить' }).click();
  await page.locator('.stream', { hasText: 'Лендинги: UI landing' }).waitFor();
  await ui.save(page);

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
  await ui.save(page);
  const filtered = (await ui.json('/api/campaigns')).campaigns['ui-flows'].streams[0].conditions;
  assert.deepEqual([filtered.countries, filtered.not, filtered.referrers, filtered.params], [['US'], ['countries'], ['facebook.com'], { sub_id_3: ['fb', 'tt'] }]);

  const stored = (await ui.json('/api/campaigns')).campaigns['ui-flows'].streams;
  assert.equal(stored[0].action, 'url', 'reopening the editor keeps action streams intact');
  assert.equal(stored[0].url, 'https://landing.example.net/?c={campaign}');
  assert.equal(stored[0].countClicks, false);
  assert.ok(!('offers' in stored[0]));
  assert.equal(stored[1].name, 'Spare');
  assert.deepEqual(stored[1].landings, [{ landingId: 'lp-ui', weight: 1 }], 'landing attached through the UI is saved');

  // Connection type: stream filter checkboxes (with «НЕ») and the «Тип соединения» report grouping.
  await ui.campaign('conn-ui', 'Conn UI');
  await ui.click('/r/conn-ui');
  await ui.go(page, '/campaigns/conn-ui');
  await page.locator('.stream .title').first().click();
  const connDlg = page.getByRole('dialog', { name: 'Редактирование потока' });
  await connDlg.getByRole('tab', { name: 'Фильтры' }).click();
  await connDlg.getByLabel('Мобильный', { exact: true }).check();
  // No cloaking: data centers are not offered, and a bot User-Agent is refused in Russian before anything is saved.
  assert.equal(await connDlg.getByLabel('Дата-центр', { exact: true }).count(), 0, 'no data-center option');
  await connDlg.getByLabel('Тип соединения: НЕ').check();
  await connDlg.getByLabel('User-Agent', { exact: true }).fill('facebookexternalhit');
  await connDlg.getByRole('button', { name: 'Применить' }).click();
  await connDlg.locator('.err', { hasText: 'клоакинг не допускается' }).waitFor();
  await connDlg.getByRole('tab', { name: 'Фильтры' }).click();
  await connDlg.getByLabel('User-Agent', { exact: true }).fill('');
  await connDlg.getByRole('button', { name: 'Применить' }).click();
  await page.locator('.stream', { hasText: 'Соединение НЕ: Мобильный' }).waitFor();
  await ui.save(page);
  const connSaved = (await ui.json('/api/campaigns')).campaigns['conn-ui'].streams[0].conditions;
  assert.deepEqual([connSaved.connections, connSaved.not], [['mobile'], ['connections']], 'connection filter saved');
  await ui.go(page, '/reports?group=connection&campaign=conn-ui');
  await page.locator('.chip-btn.on', { hasText: 'Тип соединения' }).waitFor();
  await page.locator('table.grid tbody tr', { hasText: '(неизвестно)' }).waitFor();

  // Visitor binding: «Привязка посетителя» and «Срок привязки, часов» round-trip through save.
  await ui.api('/api/campaigns', { id: 'bind-ui', name: 'Bind UI', streams: MAIN_STREAM });
  await ui.go(page, '/campaigns/bind-ui');
  const bindSelect = page.getByRole('combobox', { name: 'Привязка посетителя' });
  await bindSelect.waitFor();
  assert.equal(await bindSelect.inputValue(), 'off', 'binding is off by default');
  assert.deepEqual(await bindSelect.locator('option').allTextContents(), ['Нет', 'К потоку', 'К потоку и офферу']);
  await bindSelect.selectOption('stream_offer');
  await page.getByRole('spinbutton', { name: 'Срок привязки, часов' }).fill('48');
  await ui.save(page);
  const bindSaved = (await ui.json('/api/campaigns')).campaigns['bind-ui'];
  assert.deepEqual([bindSaved.bindVisitors, bindSaved.bindTtlHours], ['stream_offer', 48], 'binding settings saved');
});
