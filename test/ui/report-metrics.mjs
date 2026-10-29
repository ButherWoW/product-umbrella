// Report metrics: black/white lists for parameter reports (D10), «Конверсии» preset by day (D14),
// landing LP CTR and CR columns (D16).
import assert from 'node:assert/strict';
import { runUi, rowCells } from './setup.mjs';

await runUi('report-metrics', async (ui) => {
  const page = await ui.newPage();

  // D10: black/white lists for parameter reports.
  await ui.campaign('d10-bw', 'D10 BW', { costModel: 'cpc', cpc: 1.0 });
  const d10cid = await ui.click('/r/d10-bw?sub_id_1=value-a');
  await ui.postback(`click_id=${d10cid}&revenue=10&currency=USD`);
  await ui.click('/r/d10-bw?sub_id_1=value-b');
  await ui.click('/r/d10-bw?sub_id_1=value-b');
  await ui.openWithKey(page, '#/reports?field=sub_id_1&campaign=d10-bw');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.locator('table.grid tbody tr').first().waitFor();
  assert.ok(await page.getByRole('button', { name: 'Списки' }).isVisible(), 'lists button visible when list-type parameter field selected');
  await page.getByRole('button', { name: 'Списки' }).click();
  const listsDialog = page.getByRole('dialog', { name: 'Списки' });
  await listsDialog.waitFor();
  await listsDialog.getByLabel('Минимум кликов').fill('1');
  await listsDialog.getByLabel('Минимум кликов').dispatchEvent('input');
  await listsDialog.locator('h3:has-text("Чёрный список") + div', { hasText: 'value-b' }).waitFor();
  const listOrder = await listsDialog.evaluate((el) => {
    const headings = [...el.querySelectorAll('h3')].map((h) => h.textContent.trim());
    const texts = [...el.querySelectorAll('h3 + div')].map((d) => d.textContent.replace('Копировать', '').trim());
    return headings.map((h, i) => ({ list: h, values: texts[i] || '' }));
  });
  const blackEntry = listOrder.find((e) => e.list === 'Чёрный список');
  const whiteEntry = listOrder.find((e) => e.list === 'Белый список');
  assert.ok(blackEntry?.values.includes('value-b'), `black list should contain value-b, got: ${blackEntry?.values}`);
  assert.ok(!blackEntry?.values.includes('value-a'), `the converting value is not black-listed, got: ${blackEntry?.values}`);
  assert.ok(whiteEntry?.values.includes('value-a'), `white list should contain value-a, got: ${whiteEntry?.values}`);
  await page.keyboard.press('Escape');

  // D14: «Конверсии» preset — conversions by day. A lead that became a sale the same day counts once, as a sale (as /stats does).
  await ui.campaign('d14-conv', 'D14 Conv');
  const d14cid = await ui.click('/r/d14-conv');
  await ui.click('/r/d14-conv');
  await ui.postback(`click_id=${d14cid}&status=lead&revenue=10&currency=EUR`);
  await ui.postback(`click_id=${d14cid}&status=sale&revenue=10&currency=EUR`);
  const d14Stats = await ui.json('/stats?campaign=d14-conv');
  assert.deepEqual([d14Stats.leads, d14Stats.sales], [0, 1], '/stats: the lead turned into a sale');
  await ui.go(page, '#/reports?group=conversions&campaign=d14-conv');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.getByRole('combobox', { name: 'Период' }).selectOption('today');
  await page.getByRole('combobox', { name: 'Валюта' }).selectOption('USD'); // 10 EUR = 12,50 $ at the test rate
  assert.ok(await page.locator('button.chip-btn.on', { hasText: 'Конверсии' }).isVisible(), 'conversions preset is active');
  const d14Today = new Date().toISOString().slice(0, 10);
  await page.locator('table.grid tbody tr', { hasText: d14Today }).filter({ hasText: '$' }).waitFor();
  const d14Cells = await rowCells(page, d14Today);
  assert.equal(await page.locator('table.grid tbody tr').count(), 1, 'one day row');
  assert.deepEqual([d14Cells['Клики'], d14Cells['Лиды'], d14Cells['Продажи'], d14Cells['Отклонённые']], ['2', String(d14Stats.leads), String(d14Stats.sales), '0'], `day row matches /stats: ${JSON.stringify(d14Cells)}`);
  assert.equal(d14Cells['Approve %'], '100,00%');
  assert.match(d14Cells['Доход'] || '', /^12,50\s?\$$/, `revenue of the sale in USD: ${d14Cells['Доход']}`);
  assert.match(d14Cells['Доход (ожидаемый)'] || '', /^0,00\s?\$$/, 'nothing pending');
  // Totals row: one day, so the totals equal the day row.
  const d14Totals = await rowCells(page, '', 'tfoot');
  assert.deepEqual([d14Totals['Клики'], d14Totals['Лиды'], d14Totals['Продажи'], d14Totals['Отклонённые']], ['2', '0', '1', '0'], `totals row: ${JSON.stringify(d14Totals)}`);
  assert.match(d14Totals['Доход'] || '', /^12,50\s?\$$/, `totals revenue: ${d14Totals['Доход']}`);

  // D16: landing LP CTR and CR columns in reports.
  await ui.api('/api/landings', { id: 'landing-d16', name: 'D16 Landing', url: ui.url + '/admin' });
  await ui.api('/api/campaigns', { id: 'd16-camp', name: 'D16 Camp', streams: [{ name: 'Main', landingId: 'landing-d16', offers: [{ offerId: 'offer-1', weight: 1 }] }] });
  const d16cid = await ui.click('/r/d16-camp');
  await ui.click('/r/d16-camp');
  await ui.click('/r/d16-camp');
  if (d16cid) await fetch(ui.url + '/lp/click?click_id=' + d16cid, { redirect: 'manual' });
  await ui.go(page, '#/reports?group=landing');
  await page.getByRole('heading', { name: 'Отчёт' }).waitFor();
  await page.locator('button.chip-btn', { hasText: 'Лендинг' }).click();
  await page.locator('table.grid').waitFor({ timeout: 5000 });
  const lpHeaders = await page.locator('table.grid thead th').allInnerTexts();
  assert.ok(lpHeaders.some((h) => h === 'LP CTR'), `landing report should have LP CTR column, got: ${lpHeaders.join(', ')}`);
  assert.ok(lpHeaders.some((h) => h.includes('CR (LP)')), 'landing report should have CR (LP) column');
});
