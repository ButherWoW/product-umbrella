// Task 9: click card in the click log — all fields, a hostile User-Agent stays text, Enter opens the card.
import assert from 'node:assert/strict';
import { runUi } from './setup.mjs';

await runUi('click-log', async (ui) => {
  await ui.campaign('t9-card', 'T9 Card');
  const t9Ua = '<img src=x onerror=alert(1)>';
  const t9cid = await ui.click('/r/t9-card?sub_id_1=t9-sub-one', { 'user-agent': t9Ua });
  const page = await ui.newPage();
  await ui.openWithKey(page, '/clicks?campaign=t9-card');
  await page.getByRole('heading', { name: 'Лог кликов' }).waitFor();
  const t9Row = page.locator('table.grid tbody tr', { hasText: t9cid.slice(0, 13) });
  await t9Row.click();
  const t9Card = page.getByRole('dialog', { name: 'Клик' });
  await t9Card.waitFor();
  const t9Text = await t9Card.innerText();
  assert.ok(t9Text.includes(t9Ua), 'hostile UA shown as text');
  assert.equal(await t9Card.locator('img').count(), 0, 'UA must never become HTML');
  assert.ok(t9Text.includes(t9cid), 'full click id visible');
  assert.ok(t9Text.includes('sub_id_1') && t9Text.includes('t9-sub-one'), 'sub_id_1 visible');
  await t9Card.getByRole('link', { name: 'T9 Card' }).waitFor();
  await t9Card.getByRole('button', { name: 'Копировать' }).click();
  await page.locator('#toast', { hasText: /скопир/i }).waitFor(); // copied, or fallback: ID selected for Ctrl+C
  await page.keyboard.press('Escape');
  await t9Card.waitFor({ state: 'detached' });
  await t9Row.focus();
  await page.keyboard.press('Enter');
  await t9Card.waitFor();
  await page.keyboard.press('Escape');
});
