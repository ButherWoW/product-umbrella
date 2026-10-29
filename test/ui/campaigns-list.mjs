// Campaigns list and editor: metric columns (D11), comparing two campaigns (D15), «Очистить статистику».
import assert from 'node:assert/strict';
import { runUi, rowCells } from './setup.mjs';

await runUi('campaigns-list', async (ui) => {
  const page = await ui.newPage();

  // D11: uEPC, Approve %, CR (холд), CPA columns.
  await ui.campaign('d11', 'D11 Test');
  const d11cid = await ui.click('/r/d11');
  await ui.click('/r/d11');
  await ui.postback(`click_id=${d11cid}&revenue=10&currency=USD`);
  const d11Stats = await ui.json('/stats?campaign=d11');
  assert.deepEqual([d11Stats.sales, d11Stats.leads, d11Stats.rejected], [1, 0, 0], 'one sale, nothing else');
  await ui.openWithKey(page, '#/campaigns');
  await page.locator('table.grid tbody tr', { hasText: 'D11 Test' }).waitFor();
  await page.locator('button[aria-label="Колонки"]').click();
  const d11Chooser = page.getByRole('dialog', { name: 'Выбор колонок' });
  await d11Chooser.waitFor();
  for (const label of ['uEPC', 'Approve %', 'CR (холд)', 'CPA']) await d11Chooser.locator('.col-list label', { hasText: label }).waitFor();
  await d11Chooser.locator('.col-list label', { hasText: 'uEPC' }).locator('input[type=checkbox]').check();
  await d11Chooser.locator('.col-list label', { hasText: 'Approve %' }).locator('input[type=checkbox]').check();
  await d11Chooser.getByRole('button', { name: 'Применить' }).click();
  await d11Chooser.waitFor({ state: 'detached' });
  await page.locator('table.grid th', { hasText: 'uEPC' }).waitFor();
  await page.locator('table.grid th', { hasText: 'Approve %' }).waitFor();
  assert.ok(!(await page.locator('table.grid').innerText()).includes('[object'), 'no stringified DOM nodes with new metric columns');
  const approvePct = (await rowCells(page, 'D11 Test'))['Approve %'];
  assert.match(approvePct || '', /100/, `Approve % should show 100% for 1 sale, got: ${approvePct}`);

  // D15: compare two campaigns.
  await ui.campaign('d15-alpha', 'D15 Alpha');
  await ui.campaign('d15-beta', 'D15 Beta');
  for (let i = 0; i < 3; i++) await ui.click('/r/d15-alpha');
  await ui.click('/r/d15-beta');
  await ui.go(page, '#/campaigns/d15-alpha'); // the editor refreshes the cached campaign list
  await page.locator('.editor').waitFor();
  await ui.go(page, '#/campaigns');
  await page.locator('table.grid tbody tr', { hasText: 'D15 Alpha' }).locator('input[type=checkbox]').check();
  await page.locator('table.grid tbody tr', { hasText: 'D15 Beta' }).locator('input[type=checkbox]').check();
  await page.locator('button', { hasText: 'Сравнить' }).click();
  const cmpDialog = page.getByRole('dialog', { name: 'Сравнение кампаний' });
  await cmpDialog.waitFor();
  const cmpText = await cmpDialog.innerText();
  assert.ok(cmpText.includes('D15 Alpha'), `compare dialog should show first campaign, got: ${cmpText.slice(0, 200)}`);
  assert.ok(cmpText.includes('D15 Beta'), 'compare dialog should show second campaign');
  assert.ok(cmpText.includes('Клики'), 'compare dialog should show metrics');
  assert.equal(await cmpDialog.locator('table.grid tbody tr').count(), 9, 'compare table should have 9 metric rows');
  await page.keyboard.press('Escape');

  // Danger zone «Очистить статистику»: typed campaign id unlocks the button; clears only this campaign.
  await ui.campaign('ui-clear', 'UI Clear');
  for (let i = 0; i < 2; i++) await ui.click('/r/ui-clear');
  const statsOf = async (id) => (await ui.json('/stats?campaign=' + id)).clicks;
  const otherBefore = await statsOf('d15-alpha');
  assert.equal(otherBefore, 3);
  await ui.go(page, '#/campaigns/ui-clear');
  const zone = page.getByRole('region', { name: 'Очистить статистику' });
  await zone.waitFor();
  const clearBtn = zone.getByRole('button', { name: 'Очистить статистику' });
  const confirmInput = zone.getByLabel('Идентификатор кампании для подтверждения');
  assert.ok(await clearBtn.isDisabled(), 'locked until the id is typed');
  await confirmInput.fill('ui-clea');
  assert.ok(await clearBtn.isDisabled(), 'a wrong id keeps it locked');
  await confirmInput.fill('ui-clear');
  assert.ok(await clearBtn.isEnabled());
  await clearBtn.click();
  await page.locator('#toast', { hasText: 'Удалено: 2 кликов' }).waitFor();
  assert.equal(await statsOf('ui-clear'), 0, 'campaign stats cleared');
  assert.equal(await statsOf('d15-alpha'), otherBefore, 'other campaign untouched');
  assert.equal(await confirmInput.inputValue(), '', 'confirmation is reset');
  assert.ok(await clearBtn.isDisabled());
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1280, 'no horizontal scroll');
});
