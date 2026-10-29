// Accounts (REQUIRE_LOGIN=1): setup screen, owner creates a buyer, API keys, buyers summary, buyer view, logout.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUi, TOKEN, MAIN_STREAM } from './setup.mjs';

await runUi('accounts', { env: { REQUIRE_LOGIN: '1' } }, async (ui) => {
  const p2 = await ui.newPage();
  await p2.goto(ui.url + '/admin#/campaigns');
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
  const me = await fetch(ui.url + '/api/auth/me', { headers: { authorization: 'Bearer ' + secret } }).then((r) => r.json());
  assert.equal(me.user.email, 'owner@example.com', 'the shown key works');
  await secretDlg.getByRole('button', { name: 'Готово' }).click();
  const keyRow = p2.locator('table.grid tbody tr', { hasText: 'UI script' });
  await keyRow.waitFor();
  assert.ok((await keyRow.innerText()).includes('umb_…' + secret.slice(-4)));
  assert.ok(!(await p2.locator('body').innerText()).includes(secret), 'the secret is gone after closing the dialog');
  await p2.setViewportSize({ width: 390, height: 844 });
  for (const hash of ['#/keys', '#/users']) {
    await p2.goto(ui.url + '/admin' + hash);
    await p2.locator('table.grid').waitFor();
    const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${hash} overflows by ${overflow}px at 390px`);
  }
  await p2.setViewportSize({ width: 1280, height: 900 });
  await p2.goto(ui.url + '/admin#/keys');
  const del = p2.locator('table.grid tbody tr', { hasText: 'UI script' }).getByRole('button', { name: 'Удалить ключ UI script' });
  await del.click();
  await p2.locator('table.grid tbody tr', { hasText: 'Удалить?' }).waitFor();
  await del.click();
  await p2.locator('#toast', { hasText: 'Ключ удалён' }).waitFor();
  await p2.locator('table.grid tbody tr', { hasText: 'UI script' }).waitFor({ state: 'detached' });
  assert.equal((await fetch(ui.url + '/api/auth/me', { headers: { authorization: 'Bearer ' + secret } })).status, 401, 'deleted key stops working');
  await p2.locator('[data-nav=dashboard]').click();
  await p2.getByRole('heading', { name: 'Баеры' }).waitFor();

  // D9: buyers summary — 2 campaigns, 2 rows (buyer + unassigned), click total matches /stats.
  const buyerUser = (await ui.json('/api/users')).users.find((u) => u.email === 'buyer@example.com');
  await ui.api('/api/campaigns', { id: 'buyers-c1', name: 'Buyers C1', streams: MAIN_STREAM, ownerId: buyerUser.id });
  await ui.api('/api/campaigns', { id: 'buyers-c2', name: 'Buyers C2', streams: MAIN_STREAM });
  await ui.click('/r/buyers-c1');
  await ui.click('/r/buyers-c1');
  await ui.click('/r/buyers-c2');
  await p2.goto(ui.url + '/admin#/buyers');
  await p2.getByRole('heading', { name: 'Сводка по баерам' }).waitFor();
  assert.ok(await p2.locator('[data-nav=buyers]').isVisible(), 'owner sees buyers summary nav item');
  await p2.locator('table.grid tfoot tr').waitFor();
  assert.equal(await p2.locator('table.grid tbody tr').count(), 2, 'buyers summary: buyer + unassigned');
  const lockedStats = await ui.json('/stats');
  assert.equal(lockedStats.clicks, 3);
  const buyersClickTotal = await p2.locator('table.grid tfoot tr').evaluateAll(
    (rows) => { const td = rows[0]?.querySelectorAll('td')[2]; return parseInt(td?.textContent?.replace(/\D/g, '') || '0', 10) || 0; });
  assert.equal(buyersClickTotal, lockedStats.clicks, 'buyers report tfoot clicks matches /stats');

  await p2.getByRole('button', { name: 'Выйти' }).click();
  await p2.getByRole('heading', { name: 'Вход в Umbrella' }).waitFor();
  await p2.getByLabel('Email').fill('buyer@example.com');
  await p2.getByLabel('Пароль').fill('buyer-password-1');
  await p2.getByRole('button', { name: 'Войти' }).click();
  await p2.locator('#user-box', { hasText: 'buyer@example.com' }).waitFor();
  assert.ok(await p2.locator('[data-nav=users]').isHidden(), 'buyers do not see the users section');
  assert.ok(await p2.locator('[data-nav=buyers]').isHidden(), 'buyers do not see the buyers summary nav item');
  // Navigating directly to #/buyers redirects a buyer to the dashboard.
  await p2.goto(ui.url + '/admin#/buyers');
  await p2.getByRole('heading', { name: 'Дашборд' }).waitFor();
  await p2.locator('[data-nav=dashboard]').click();
  await p2.locator('.kpi', { hasText: 'Заработок баера' }).waitFor();
  assert.equal(await p2.getByRole('heading', { name: 'Баеры' }).count(), 0, 'buyers do not see the per-buyer table');
  await p2.screenshot({ path: join(tmpdir(), 'umbrella-admin-buyer.png') });
});
