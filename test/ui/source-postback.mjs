// Source postback: fields in the source modal and the campaign editor, «Тестовый постбэк» shows the HTTP status.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUi, TOKEN } from './setup.mjs';

const hits = [];
const mock = createServer((req, res) => { hits.push(req.url); res.writeHead(204); res.end(); });
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;
try {
  await runUi('source-postback', { env: { SOURCE_POSTBACK_ALLOW_PRIVATE: '1' } }, async (ui) => {
    const pbPage = await ui.newPage();
    await pbPage.goto(ui.url + '/admin#/sources');
    await pbPage.getByRole('button', { name: 'Создать', exact: true }).click();
    const srcDialog = pbPage.getByRole('dialog', { name: 'Создание источника' });
    await srcDialog.locator('input').nth(0).fill('fb-pb');
    await srcDialog.locator('input').nth(1).fill('FB postback');
    await srcDialog.getByRole('tab', { name: 'Постбэк' }).click();
    await srcDialog.getByLabel('URL постбэка в источник').fill(`${mockUrl}/fb?cid={external_id}&s={status}`);
    await srcDialog.getByLabel('Лид (lead)').check();
    // Without the key the test postback asks for it instead of failing silently.
    await srcDialog.getByRole('button', { name: 'Тестовый постбэк' }).click();
    const keyDialog = pbPage.getByRole('dialog', { name: 'Ключ администратора' });
    await keyDialog.waitFor();
    await keyDialog.locator('input[type=password]').fill(TOKEN);
    await keyDialog.getByRole('button', { name: 'Сохранить' }).click();
    await srcDialog.getByRole('button', { name: 'Тестовый постбэк' }).click();
    await srcDialog.getByRole('status', { name: 'Результат тестового постбэка' }).filter({ hasText: 'HTTP 204' }).waitFor();
    assert.ok(hits.at(-1).startsWith('/fb?cid=test_external_id&s=sale'), 'test postback filled sample macros');
    await srcDialog.screenshot({ path: join(tmpdir(), 'umbrella-admin-source-postback.png') });
    await srcDialog.getByRole('button', { name: 'Создать', exact: true }).click();
    await pbPage.locator('table.grid tbody tr', { hasText: 'fb-pb' }).filter({ hasText: 'lead, sale' }).waitFor();
    const saved = (await ui.json('/api/sources')).sources['fb-pb'];
    assert.deepEqual([saved.postbackUrl, saved.postbackStatuses], [`${mockUrl}/fb?cid={external_id}&s={status}`, ['lead', 'sale']]);

    await pbPage.goto(ui.url + '/admin#/campaigns/new');
    await pbPage.getByLabel('Название кампании').fill('PB campaign');
    await pbPage.getByRole('combobox', { name: 'Источник трафика' }).selectOption('fb-pb');
    await pbPage.getByLabel('Постбэк в источник').fill(`${mockUrl}/camp?s={status}`);
    await pbPage.getByLabel('Продажа (sale)').check();
    await pbPage.getByRole('button', { name: 'Тестовый постбэк' }).click();
    await pbPage.getByRole('status', { name: 'Результат тестового постбэка' }).filter({ hasText: 'HTTP 204' }).waitFor();
    assert.ok(hits.at(-1).startsWith('/camp?s=sale'));
    await ui.save(pbPage, 'Кампания создана');
    const pbCamp = Object.values((await ui.json('/api/campaigns')).campaigns).find((c) => c.name === 'PB campaign');
    assert.deepEqual([pbCamp.sourceId, pbCamp.sourcePostbackUrl, pbCamp.sourcePostbackStatuses], ['fb-pb', `${mockUrl}/camp?s={status}`, ['sale']]);
    await pbPage.screenshot({ path: join(tmpdir(), 'umbrella-admin-campaign-postback.png') });
  });
} finally {
  await new Promise((resolve) => mock.close(resolve));
}
