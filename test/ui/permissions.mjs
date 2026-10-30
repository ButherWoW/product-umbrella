// User permissions (REQUIRE_LOGIN=1): the owner sets role «Только чтение» and flags on the users page;
// a viewer gets no write controls, a hideRevenue buyer gets no revenue tiles or columns.
import assert from 'node:assert/strict';
import { runUi, MAIN_STREAM } from './setup.mjs';

await runUi('permissions', { env: { REQUIRE_LOGIN: '1' } }, async (ui) => {
  await (await ui.api('/api/auth/setup', { email: 'perm-owner@example.com', password: 'owner-password-1' })).json();
  const login = async (email, password) => {
    const ctx = await ui.browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pg = await ctx.newPage();
    pg.on('pageerror', (error) => ui.errors.push(error.message));
    await pg.goto(ui.url + '/dashboard');
    await pg.getByLabel('Email').fill(email);
    await pg.getByLabel('Пароль').fill(password);
    await pg.getByRole('button', { name: 'Войти' }).click();
    await pg.locator('#user-box', { hasText: email }).waitFor();
    return { ctx, pg };
  };
  const own = await login('perm-owner@example.com', 'owner-password-1');
  await own.pg.goto(ui.url + '/users');
  await own.pg.getByRole('heading', { name: 'Пользователи' }).waitFor();
  const createUser = async (email, role) => {
    await own.pg.getByRole('button', { name: 'Создать', exact: true }).click();
    const dlg = own.pg.getByRole('dialog', { name: 'Новый пользователь' });
    await dlg.locator('input[type=email]').fill(email);
    await dlg.locator('input[type=password]').fill('user-password-1');
    if (role) await dlg.getByRole('combobox', { name: 'Роль' }).selectOption({ label: role });
    await dlg.getByRole('button', { name: 'Создать' }).click();
    await own.pg.locator('table.grid tbody tr', { hasText: email }).waitFor();
  };
  await createUser('perm-viewer@example.com', 'Только чтение');
  await createUser('perm-buyer@example.com');
  await own.pg.locator('table.grid tbody tr', { hasText: 'perm-viewer@example.com' }).getByText('Только чтение').waitFor();
  await own.pg.getByRole('button', { name: 'Права пользователя perm-buyer@example.com' }).click();
  const permDlg = own.pg.getByRole('dialog', { name: 'Права пользователя' });
  await permDlg.getByLabel('Скрывать доход').check();
  await permDlg.getByLabel('Только офферы своих кампаний').check();
  assert.ok(await permDlg.getByLabel('Видит все кампании').isHidden(), 'viewAll only for viewers');
  await permDlg.getByRole('button', { name: 'Сохранить' }).click();
  await own.pg.locator('#toast', { hasText: 'Права сохранены' }).waitFor();
  await own.pg.locator('table.grid tbody tr', { hasText: 'perm-buyer@example.com' }).getByText('без дохода, свои офферы').waitFor();
  const permUsers = (await ui.json('/api/users')).users;
  const pb = permUsers.find((u) => u.email === 'perm-buyer@example.com');
  assert.deepEqual([pb.role, pb.hideRevenue, pb.offersAccess], ['buyer', true, 'own'], 'flags saved from the dialog');
  assert.equal(permUsers.find((u) => u.email === 'perm-viewer@example.com').role, 'viewer');
  await ui.api('/api/campaigns', { id: 'perm-camp', name: 'Perm camp', ownerId: pb.id, streams: MAIN_STREAM });
  await own.ctx.close();

  const hid = await login('perm-buyer@example.com', 'user-password-1');
  await hid.pg.locator('.kpi', { hasText: 'Расход' }).waitFor();
  assert.equal(await hid.pg.locator('.kpi', { hasText: 'Доход' }).count(), 0, 'no revenue tile');
  assert.equal(await hid.pg.locator('.kpi', { hasText: 'ROI' }).count(), 0, 'no ROI tile');
  await hid.pg.goto(ui.url + '/campaigns');
  await hid.pg.locator('table.grid tbody tr', { hasText: 'Perm camp' }).waitFor();
  const heads = await hid.pg.locator('table.grid thead').innerText();
  assert.ok(!/Доход|Прибыль|ROI|EPC/.test(heads), `revenue columns hidden: ${heads}`);
  await hid.pg.goto(ui.url + '/reports?group=conversions');
  await hid.pg.locator('table.grid thead th', { hasText: 'Лиды' }).waitFor();
  const convHeads = await hid.pg.locator('table.grid thead').innerText();
  assert.ok(!/Доход/.test(convHeads), `conversions report hides revenue: ${convHeads}`);
  await hid.ctx.close();

  const ro = await login('perm-viewer@example.com', 'user-password-1');
  assert.ok(await ro.pg.evaluate(() => document.body.classList.contains('read-only')));
  await ro.pg.goto(ui.url + '/campaigns');
  await ro.pg.locator('table.grid').waitFor();
  assert.ok(await ro.pg.locator('a.btn.primary', { hasText: 'Создать' }).isHidden(), 'viewer has no create button');
  await ro.pg.getByRole('button', { name: 'Выйти' }).click();
  await ro.pg.getByRole('button', { name: 'Войти' }).waitFor({ state: 'visible' });
  await ro.ctx.close();
});
