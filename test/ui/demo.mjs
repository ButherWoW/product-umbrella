// Public demo (/demo): every section renders on made-up data without a login (REQUIRE_LOGIN=1 here), the browser never
// requests anything outside /demo (no /api, no /stats), and every attempt to create or change something shows «Хуй тебе».
import assert from 'node:assert/strict';
import { pageOverflow, runUi } from './setup.mjs';

const DENIED = 'Хуй тебе';
const SECTIONS = ['', '/dashboard', '/campaigns', '/campaigns/demo-fr-audio', '/campaigns/new', '/landings', '/offers', '/trends', '/networks', '/sources',
  '/reports', '/reports?group=offer', '/reports?group=stream&campaign=demo-fr-audio', '/reports?group=country', '/reports?group=day', '/reports?group=hour',
  '/reports?group=os', '/reports?group=referrer', '/reports?group=conversions', '/clicks', '/conversions', '/botlog', '/buyers', '/users', '/keys'];

await runUi('demo', { env: { REQUIRE_LOGIN: '1' } }, async (ui) => {
  const page = await ui.newPage();
  const outside = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.origin === ui.url && !u.pathname.startsWith('/demo')) outside.push(u.pathname); });
  const viewText = () => page.locator('#view').innerText();
  // Sections and their reports fill in asynchronously (each shows «Загрузка…» until its data lands).
  const settled = () => page.waitForFunction(() => {
    const v = document.getElementById('view');
    return v && !v.textContent.includes('Загрузка…') && v.textContent.length > 40;
  });

  for (const p of SECTIONS) {
    await page.goto(ui.url + '/demo' + p);
    await settled();
    const text = await viewText();
    assert.doesNotMatch(text, /Ошибка|Не удалось|Страница не найдена/, `/demo${p}: ${text.slice(0, 200)}`);
    assert.ok(new URL(page.url()).pathname.startsWith('/demo'), `/demo${p} stays in the demo (${page.url()})`);
    await page.locator('.demo-banner', { hasText: 'ДЕМО-РЕЖИМ — данные выдуманные, изменения не сохраняются' }).waitFor();
  }
  // Data on the main pages: tables with rows.
  for (const [p, needle] of [['/campaigns', 'Demo Campaign FR'], ['/offers', 'demo-offer-headphones'], ['/landings', 'demo-lp-quiz'], ['/networks', 'Alpha Leads (demo)'],
    ['/users', 'anna.buyer@demo.example'], ['/clicks', 'demo-'], ['/conversions', 'demo-'], ['/reports?group=day', '2']]) {
    await ui.go(page, '/demo' + p);
    await page.locator('table.grid tbody tr', { hasText: needle }).first().waitFor();
  }
  // The login page is skipped (the demo user is signed in), in-demo links stay in the demo.
  await page.goto(ui.url + '/demo/login?next=%2Foffers');
  await page.waitForFunction(() => location.pathname === '/demo/offers');
  await page.locator('[data-nav=networks]').click();
  await page.waitForFunction(() => location.pathname === '/demo/networks');
  assert.equal(await page.locator('[data-nav=users]').isVisible(), true, 'owner sections are shown');

  // Writes: refused with the demo's answer, shown where the panel shows errors.
  await ui.go(page, '/demo/campaigns/new');
  await page.getByLabel('Идентификатор').fill('my-campaign');
  await page.getByLabel('Название кампании').fill('My campaign');
  await page.locator('.editor-head .btn.primary').click();
  await page.getByText(DENIED).first().waitFor();

  await ui.go(page, '/demo/campaigns/demo-fr-audio');
  await page.getByLabel('Название кампании').fill('Renamed');
  await page.locator('.editor-head .btn.primary').click();
  await page.getByText(DENIED).first().waitFor();

  const dialogWrite = async (section, button, fill) => {
    await page.goto(ui.url + '/demo' + section);
    await page.locator('table.grid').first().waitFor();
    await page.getByRole('button', { name: button, exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    for (const [label, value] of fill) await dialog.getByLabel(label).first().fill(value);
    await dialog.locator('.modal-foot .btn.primary').click();
    await dialog.getByText(DENIED).waitFor();
  };
  await dialogWrite('/offers', 'Создать', [['ID оффера', 'my-offer'], ['URL', 'https://offer.test/x']]);
  await dialogWrite('/landings', 'Создать', [['ID лендинга', 'my-lp'], ['URL лендинга', 'https://lp.test/x']]);
  await dialogWrite('/networks', 'Создать сеть', [['ID', 'my-net'], ['Название', 'My network']]);
  await dialogWrite('/users', 'Создать', [['Email', 'new@test.example'], ['Пароль', 'new-password-1']]);
  await dialogWrite('/keys', 'Создать', [['Название', 'my key']]);

  // Mobile: the strip fits, no sideways scroll.
  const mobile = await ui.newPage({ width: 390, height: 844 });
  mobile.on('request', (r) => { const u = new URL(r.url()); if (u.origin === ui.url && !u.pathname.startsWith('/demo')) outside.push(u.pathname); });
  await mobile.goto(ui.url + '/demo/dashboard');
  await mobile.locator('.kpi').first().waitFor();
  assert.ok(await mobile.locator('.demo-banner').evaluate((el) => el.scrollWidth <= el.clientWidth), 'demo strip text fits at 390px');
  assert.ok(await pageOverflow(mobile) <= 0, 'no horizontal scroll at 390px');
  await mobile.close();

  assert.deepEqual(outside, [], 'the demo requests nothing outside /demo');

  // «Выйти» leaves the demo for the real panel, which asks for its own login.
  await page.goto(ui.url + '/demo/dashboard');
  await page.getByRole('button', { name: 'Выйти' }).click();
  await page.waitForFunction(() => location.pathname === '/login');
  await page.locator('body.auth-mode').waitFor();
  assert.equal(await page.locator('.demo-banner').count(), 0);
});
