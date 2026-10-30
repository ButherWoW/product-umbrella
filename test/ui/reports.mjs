// Reports: saved reports, hour heatmap, expandable rows, CSV export, period comparison.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runUi, pageOverflow } from './setup.mjs';

await runUi('reports', async (ui) => {
  await ui.campaign('ui-flows', 'UI flows');
  for (let i = 0; i < 3; i++) await ui.click('/r/ui-flows');
  const page = await ui.newPage();
  await ui.openWithKey(page, '/reports');

  // Saved reports: two reports with different groups+periods survive a reload and restore their filters.
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.getByLabel('Период').selectOption('yesterday');
  await page.getByRole('button', { name: 'Страна' }).click();
  await page.locator('.chip-btn.on', { hasText: 'Страна' }).waitFor();
  await page.getByRole('button', { name: '💾 Сохранить' }).click();
  const repSaveDialog = page.getByRole('dialog', { name: 'Сохранить отчёт' });
  await repSaveDialog.waitFor();
  await repSaveDialog.getByLabel('Название отчёта').fill('Rep-1');
  await repSaveDialog.getByRole('button', { name: 'Сохранить' }).click();
  await repSaveDialog.waitFor({ state: 'detached' });
  await page.getByLabel('Период').selectOption('last_7_days');
  await page.getByRole('button', { name: 'Оффер' }).click();
  await page.locator('.chip-btn.on', { hasText: 'Оффер' }).waitFor();
  await page.getByRole('button', { name: '💾 Сохранить' }).click();
  await repSaveDialog.waitFor();
  await repSaveDialog.getByLabel('Название отчёта').fill('Rep-2');
  await repSaveDialog.getByRole('button', { name: 'Сохранить' }).click();
  await repSaveDialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Открыть Rep-1' }).waitFor();
  await page.getByRole('button', { name: 'Открыть Rep-2' }).waitFor();
  await page.reload();
  await page.goto(ui.url + '/reports');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.getByRole('button', { name: 'Открыть Rep-1' }).waitFor();
  await page.getByRole('button', { name: 'Открыть Rep-2' }).waitFor();
  await page.getByRole('button', { name: 'Открыть Rep-1' }).click();
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.locator('.chip-btn.on', { hasText: 'Страна' }).waitFor();
  assert.equal(await page.getByLabel('Период').inputValue(), 'yesterday', 'Rep-1 period restored');
  await page.getByRole('button', { name: 'Открыть Rep-2' }).click();
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.locator('.chip-btn.on', { hasText: 'Оффер' }).waitFor();
  assert.equal(await page.getByLabel('Период').inputValue(), 'last_7_days', 'Rep-2 period restored');

  // The reload dropped the in-memory key.
  await ui.openWithKey(page, '/reports');
  // Heatmap: 7×24 grid (168 cells), click sum matches /stats, no page horizontal scroll at 390px.
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  const statsForHeatmap = await ui.json('/stats');
  assert.equal(statsForHeatmap.clicks, 3);
  await page.getByRole('button', { name: 'Карта по часам' }).click();
  await page.locator('table.heatmap').waitFor();
  const hmCells = await page.locator('table.heatmap tbody td').count();
  assert.equal(hmCells, 168, `heatmap must have 7×24=168 cells, got ${hmCells}`);
  const hmClickSum = await page.locator('table.heatmap tbody td').evaluateAll((tds) => tds.reduce((s, td) => s + Number(td.dataset.clicks || 0), 0));
  assert.equal(hmClickSum, statsForHeatmap.clicks, 'heatmap click sum matches /stats total');
  await page.setViewportSize({ width: 390, height: 844 });
  const hmOverflow = await pageOverflow(page);
  assert.ok(hmOverflow <= 1, `heatmap page overflows at 390px by ${hmOverflow}px`);
  await page.setViewportSize({ width: 1280, height: 900 });

  // D12: expandable rows in the report.
  await ui.api('/api/campaigns', { id: 'd12-camp', name: 'D12 Camp', streams: [{ name: 'S1', offers: [{ offerId: 'offer-1', weight: 1 }] }] });
  await ui.click('/r/d12-camp');
  await ui.go(page, '/reports?group=campaign');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  const d12Row = page.locator('table.grid tbody tr', { hasText: 'D12 Camp' });
  await d12Row.waitFor();
  const expandBtn = d12Row.locator('button[aria-label="Развернуть"]');
  await expandBtn.click();
  const subRow = page.locator('tr.sub-row');
  await subRow.waitFor();
  assert.ok(await subRow.isVisible(), 'sub-row visible after expand');
  await expandBtn.click();
  await subRow.waitFor({ state: 'detached' });
  assert.equal(await page.locator('tr.sub-row').count(), 0, 'sub-row removed on second click');

  // D17: CSV export from reports.
  await ui.go(page, '/reports?group=campaign');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.locator('table.grid tbody tr', { hasText: 'UI flows' }).waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button[aria-label="CSV"]').click()]);
  assert.ok(download.suggestedFilename().endsWith('.csv'), `download filename should end with .csv, got: ${download.suggestedFilename()}`);
  const csvContent = await readFile(await download.path(), 'utf8');
  assert.ok(/Клики|clicks/i.test(csvContent), `CSV should contain headers, got: ${csvContent.slice(0, 200)}`);
  assert.ok(/UI flows|ui-flows/i.test(csvContent), 'CSV should contain campaign data');

  // Task 8: period comparison adds Δ% columns, «—» without previous data, disabled for «За всё время».
  await ui.campaign('t8-compare', 'T8 Compare');
  await ui.click('/r/t8-compare');
  await ui.go(page, '/reports?group=campaign&campaign=t8-compare');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.getByRole('combobox', { name: 'Период' }).selectOption('today');
  await page.locator('table.grid tbody tr', { hasText: 'T8 Compare' }).waitFor();
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
});
