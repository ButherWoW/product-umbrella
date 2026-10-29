// Dashboard: currency switch, buyer earnings and share, «Требуют внимания» block, daily goals.
import assert from 'node:assert/strict';
import { runUi } from './setup.mjs';

await runUi('dashboard', async (ui) => {
  await ui.campaign('ui-flows', 'UI flows');
  for (let i = 0; i < 3; i++) await ui.click('/r/ui-flows');
  const paidClick = await ui.click('/r/demo/offer-1');
  await ui.postback(`click_id=${paidClick}&revenue=25&currency=USD`);
  const page = await ui.newPage();
  await ui.openWithKey(page, '#/dashboard');

  // Currency switch: 25 USD = 20 EUR = 2000 RUB at the fixed test rates.
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

  // D13: attention block lists a campaign with bad ROI (100 clicks at 1 EUR CPC, no revenue).
  await ui.campaign('d13-bad', 'D13 Bad ROI', { costModel: 'cpc', cpc: 1.0 });
  await Promise.all(Array.from({ length: 100 }, () => ui.click('/r/d13-bad')));
  await ui.go(page, '#/');
  await page.getByRole('heading', { name: 'Дашборд' }).waitFor();
  const attentionCard = page.locator('.card', { hasText: 'Требуют внимания' });
  await attentionCard.waitFor({ timeout: 10000 });
  assert.ok(await attentionCard.isVisible(), 'attention block appears with bad-ROI campaign');
  const attentionText = await attentionCard.innerText();
  assert.ok(/D13 Bad ROI|d13-bad/.test(attentionText) && /ROI/.test(attentionText), `attention block has campaign info, got: ${attentionText.slice(0, 100)}`);

  // D18: team daily goals (server-side /api/settings) → progress bars on «Доход» and «Прибыль» for «Сегодня».
  await ui.campaign('d18-goals', 'D18 Goals');
  const d18Click = await ui.click('/r/d18-goals');
  await ui.postback(`click_id=${d18Click}&revenue=25&currency=EUR`);
  await ui.go(page, '#/campaigns/d18-goals'); // the editor refreshes the cached campaign list (no reload: the key stays in memory)
  await page.locator('.editor').waitFor();
  await ui.go(page, '#/dashboard');
  await page.getByRole('heading', { name: 'Дашборд' }).waitFor();
  await page.getByRole('combobox', { name: 'Период' }).selectOption('today');
  await page.getByRole('combobox', { name: 'Валюта' }).selectOption('EUR');
  await page.getByRole('button', { name: 'Цели', exact: true }).click();
  const goalsDlg = page.getByRole('dialog', { name: 'Цели' });
  await goalsDlg.getByLabel('План по доходу').fill('100');
  await goalsDlg.getByLabel('План по прибыли').fill('20');
  await goalsDlg.getByRole('button', { name: 'Сохранить' }).click();
  await page.locator('#toast', { hasText: 'Цели сохранены' }).waitFor();
  const d18Settings = await ui.json('/api/settings');
  assert.deepEqual([d18Settings.dailyRevenueGoal, d18Settings.dailyProfitGoal], [100, 20], 'goals stored on the server');
  await page.getByRole('combobox', { name: 'Кампания' }).selectOption('d18-goals');
  const d18Tile = (label) => page.locator('.kpi').filter({ has: page.locator('.k', { hasText: new RegExp(`^${label}$`) }) });
  await d18Tile('Доход').locator('.goal-cap', { hasText: '25% плана' }).waitFor();
  assert.equal(await d18Tile('Доход').locator('.goal-fill').evaluate((el) => el.style.width), '25%');
  await d18Tile('Прибыль').locator('.goal.done .goal-cap', { hasText: 'план выполнен' }).waitFor();
  await page.getByRole('combobox', { name: 'Валюта' }).selectOption('USD');
  await d18Tile('Доход').locator('.v', { hasText: '31,25' }).waitFor();
  assert.equal(await d18Tile('Доход').locator('.goal-cap').innerText(), '25% плана', 'goal converted into the selected currency');
  await page.getByRole('combobox', { name: 'Период' }).selectOption('yesterday');
  await d18Tile('Доход').locator('.v', { hasText: /^0,00/ }).waitFor();
  assert.equal(await page.locator('.kpi .goal').count(), 0, 'no goal bar outside «Сегодня»');
});
