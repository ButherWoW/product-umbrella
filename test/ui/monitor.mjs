// Offer monitor: the mode is chosen in the campaign editor; a dead offer shows on the dashboard after two failed checks.
import assert from 'node:assert/strict';
import { runUi } from './setup.mjs';

await runUi('monitor', async (ui) => {
  await ui.campaign('ui-flows', 'UI flows');
  const page = await ui.newPage();
  await ui.openWithKey(page, '/campaigns/ui-flows');
  await page.getByLabel('Мониторинг офферов').selectOption('off');
  await ui.save(page);
  assert.equal((await ui.json('/api/campaigns')).campaigns['ui-flows'].monitoring, 'off');

  await ui.api('/api/offers', { id: 'dead-ui', url: 'https://127.0.0.1:9/gone?token=x' });
  await ui.api('/api/campaigns', { id: 'ui-dead', name: 'UI dead', monitoring: 'disable', streams: [{ name: 'Dead', offers: [{ offerId: 'dead-ui', weight: 1 }] }] });
  for (let i = 0; i < 2; i++) assert.equal((await ui.api('/api/monitor/check', {})).status, 200);
  await ui.go(page, '/dashboard');
  const downCard = page.locator('.monitor-down');
  await downCard.filter({ hasText: 'Не отвечают' }).waitFor();
  assert.match(await downCard.innerText(), /https:\/\/127\.0\.0\.1:9\/gone(?!\?)/, 'the URL is shown without its query (token)');
  assert.equal(await downCard.getByRole('link', { name: 'UI dead' }).getAttribute('href'), '/campaigns/ui-dead');
  await downCard.getByRole('link', { name: 'UI dead' }).click();
  await page.locator('.stream', { hasText: 'Выключен монитором' }).waitFor();
  assert.equal(await page.getByLabel('Мониторинг офферов').inputValue(), 'disable');
});
