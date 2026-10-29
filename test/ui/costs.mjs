// Task 11 «Обновить расходы» and the Facebook spend CSV import (campaigns list).
import assert from 'node:assert/strict';
import { runUi, rowCells } from './setup.mjs';

await runUi('costs', async (ui) => {
  await ui.campaign('cost-ui', 'Cost UI');
  for (let i = 0; i < 4; i++) await ui.click('/r/cost-ui');
  const page = await ui.newPage();
  await ui.openWithKey(page, '#/campaigns');
  await page.getByRole('combobox', { name: 'Период' }).selectOption('today');
  await page.getByRole('combobox', { name: 'Валюта' }).selectOption('EUR');
  const costRow = page.locator('table.grid tbody tr', { hasText: 'Cost UI' });
  await costRow.waitFor();
  const costCell = async () => (await rowCells(page, 'Cost UI'))?.['Расход'];
  const costIs = (re) => page.waitForFunction((source) => {
    const ths = [...document.querySelectorAll('table.grid thead th')].map((th) => th.textContent.trim());
    const row = [...document.querySelectorAll('table.grid tbody tr')].find((r) => r.textContent.includes('Cost UI'));
    return new RegExp(source).test([...row.querySelectorAll('td')][ths.indexOf('Расход')]?.textContent.trim() || '');
  }, re.source);

  await costRow.getByRole('button', { name: 'Обновить расходы' }).click();
  const costDlg = page.getByRole('dialog', { name: 'Обновить расходы' });
  await costDlg.getByRole('button', { name: 'Обновить' }).click();
  await costDlg.locator('.err', { hasText: 'Сумма — число не меньше нуля.' }).waitFor();
  await costDlg.getByLabel('Сумма расхода').fill('2');
  await costDlg.getByLabel('Валюта расхода').selectOption('EUR');
  await costDlg.getByRole('button', { name: 'Обновить' }).click();
  await page.locator('#toast', { hasText: /Распределено 4 клика, 2,00\s?€/ }).waitFor();
  assert.equal(await costDlg.count(), 0, 'dialog closed');
  await costIs(/^2,00\s?€$/);

  // FB CSV (Russian headers, BOM, «;», decimal comma, a totals row and an ad set without clicks): preview → apply.
  for (let i = 0; i < 2; i++) await ui.click('/r/cost-ui?sub_id_2=777');
  const csvToday = new Date().toISOString().slice(0, 10);
  const csv = '﻿Дата начала отчётности;Дата окончания отчётности;Название группы объявлений;ID группы объявлений;Потраченная сумма (EUR)\r\n'
    + `${csvToday};${csvToday};"Группа; №1";777;"3,50"\r\n${csvToday};${csvToday};Пустая;999;1,00\r\n${csvToday};${csvToday};;;4,50\r\n`;
  await page.getByRole('button', { name: 'Импорт расходов' }).click();
  const fbDlg = page.getByRole('dialog', { name: 'Импорт расходов из Facebook' });
  await fbDlg.getByRole('button', { name: 'Применить' }).click();
  await fbDlg.locator('.err', { hasText: 'Сначала выберите CSV файл.' }).waitFor();
  await fbDlg.getByLabel('CSV файл расходов').setInputFiles({ name: 'fb-spend.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  const fbPreview = fbDlg.getByRole('table', { name: 'Предпросмотр расходов' });
  await fbPreview.locator('tbody tr', { hasText: '777' }).waitFor();
  assert.equal(await fbPreview.locator('tbody tr').count(), 3, 'all rows in the preview');
  assert.match(await fbPreview.locator('tbody tr', { hasText: '777' }).innerText(), /3,50\s?€[\s\S]*готово/);
  assert.match(await fbPreview.locator('tbody tr').nth(2).innerText(), /нет ID/);
  assert.equal(await fbDlg.getByLabel('Параметр с ID').inputValue(), 'sub_id_2', 'ad set ID → sub_id_2 by default');
  await fbDlg.getByRole('button', { name: 'Применить' }).click();
  await fbDlg.locator('.err', { hasText: 'Отметьте хотя бы одну кампанию.' }).waitFor();
  await fbDlg.getByLabel('Cost UI (cost-ui)').check();
  await fbDlg.getByRole('button', { name: 'Применить' }).click();
  await page.locator('#toast', { hasText: /Импортировано строк: 1, 2 клика, 3,50\s?€; без кликов: 1/ }).waitFor();
  assert.match(await fbPreview.locator('tbody tr', { hasText: '777' }).innerText(), /применено/);
  assert.match(await fbPreview.locator('tbody tr', { hasText: '999' }).innerText(), /нет кликов/);
  await fbDlg.getByRole('button', { name: 'Закрыть' }).last().click();
  await costIs(/^5,50\s?€$/);
  assert.match(await costCell(), /^5,50\s?€$/);
});
