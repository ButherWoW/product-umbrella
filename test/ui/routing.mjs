// Path URLs: deep links load directly, old /admin#/… links land on the same page, links and back/forward work without
// a reload, unknown panel paths show «Страница не найдена»; /login with ?next= when logged out (REQUIRE_LOGIN=1).
import assert from 'node:assert/strict';
import { runUi } from './setup.mjs';

await runUi('routing', async (ui) => {
  await ui.campaign('route-camp', 'Route campaign');
  const page = await ui.newPage();
  const path = () => page.evaluate(() => location.pathname + location.search);
  const editorName = () => page.getByLabel('Название кампании');

  // Deep link: the server answers /campaigns/<id> with the panel and the editor opens.
  const res = await page.goto(ui.url + '/campaigns/route-camp');
  assert.equal(res.status(), 200);
  await editorName().waitFor();
  assert.equal(await editorName().inputValue(), 'Route campaign');
  assert.equal(await page.locator('[data-nav=campaigns]').getAttribute('class'), 'active');

  // Old bookmarks: /admin#/campaigns → /campaigns, /admin#/reports?group=… keeps the query.
  await page.goto(ui.url + '/admin#/campaigns');
  await page.locator('table.grid tbody tr', { hasText: 'Route campaign' }).waitFor();
  assert.equal(await path(), '/campaigns');
  assert.equal(await page.evaluate(() => location.hash), '');
  await page.goto(ui.url + '/admin#/reports?group=stream&campaign=route-camp');
  await page.locator('table.grid').first().waitFor();
  assert.equal(await path(), '/reports?group=stream&campaign=route-camp');
  await page.goto(ui.url + '/#/offers');
  await page.waitForFunction(() => location.pathname === '/offers');

  // Links: no page reload (the marker survives), the URL follows, back and forward re-render.
  await page.goto(ui.url + '/campaigns');
  await page.locator('table.grid tbody tr', { hasText: 'Route campaign' }).waitFor();
  await page.evaluate(() => { window.__noReload = true; });
  await page.locator('table.grid tbody tr a', { hasText: 'Route campaign' }).click();
  await editorName().waitFor();
  assert.equal(await path(), '/campaigns/route-camp');
  await page.locator('[data-nav=offers]').click();
  await page.waitForFunction(() => location.pathname === '/offers');
  await page.locator('table.grid tbody tr', { hasText: 'offer-1' }).waitFor();
  await page.goBack();
  await editorName().waitFor();
  assert.equal(await path(), '/campaigns/route-camp');
  await page.goBack();
  await page.locator('table.grid tbody tr', { hasText: 'Route campaign' }).waitFor();
  assert.equal(await path(), '/campaigns');
  await page.goForward();
  await editorName().waitFor();
  assert.equal(await path(), '/campaigns/route-camp');
  assert.equal(await page.evaluate(() => window.__noReload), true, 'in-panel navigation does not reload the page');

  // The root is the dashboard; an unknown section inside the panel shows a not-found view.
  await page.goto(ui.url + '/');
  await page.getByRole('heading', { name: 'Дашборд' }).waitFor();
  await ui.go(page, '/campaigns/route-camp/extra');
  await page.getByRole('heading', { name: 'Страница не найдена' }).waitFor();
  await page.getByRole('link', { name: 'На дашборд' }).click();
  await page.getByRole('heading', { name: 'Дашборд' }).waitFor();
  assert.equal(await path(), '/dashboard');
});

await runUi('routing-login', { env: { REQUIRE_LOGIN: '1' } }, async (ui) => {
  await ui.api('/api/auth/setup', { email: 'route-owner@example.com', password: 'owner-password-1' });
  const page = await ui.newPage();
  const path = () => page.evaluate(() => location.pathname + location.search);
  const login = async () => {
    await page.getByRole('heading', { name: 'Вход в Umbrella' }).waitFor();
    await page.getByLabel('Email').fill('route-owner@example.com');
    await page.getByLabel('Пароль').fill('owner-password-1');
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.locator('#user-box', { hasText: 'route-owner@example.com' }).waitFor();
  };

  // Logged out: a deep link goes to /login?next=…, and after the login back to that page.
  await page.goto(ui.url + '/reports?group=offer');
  await page.getByRole('heading', { name: 'Вход в Umbrella' }).waitFor();
  assert.equal(await path(), '/login?next=%2Freports%3Fgroup%3Doffer');
  await login();
  await page.waitForFunction(() => location.pathname === '/reports');
  assert.equal(await path(), '/reports?group=offer');

  // /login when already signed in goes on to the dashboard.
  await page.goto(ui.url + '/login');
  await page.getByRole('heading', { name: 'Дашборд' }).waitFor();
  assert.equal(await path(), '/dashboard');

  // Logout → /login.
  await page.getByRole('button', { name: 'Выйти' }).click();
  await page.getByRole('heading', { name: 'Вход в Umbrella' }).waitFor();
  assert.equal(await path(), '/login');

  // ?next= only accepts a path inside the panel.
  await page.goto(ui.url + '/login?next=' + encodeURIComponent('//evil.example/x'));
  await login();
  await page.getByRole('heading', { name: 'Дашборд' }).waitFor();
  assert.equal(new URL(page.url()).origin, new URL(ui.url).origin);
  assert.equal(await path(), '/dashboard');
});
