// Phone width (390px): no horizontal page scroll on the main screens.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUi, pageOverflow } from './setup.mjs';

await runUi('mobile', async (ui) => {
  await ui.campaign('ui-flows', 'UI flows');
  for (let i = 0; i < 3; i++) await ui.click('/r/ui-flows');
  const page = await ui.newPage({ width: 390, height: 844 });
  await ui.openWithKey(page, '/dashboard');
  // What each screen shows once its data has arrived.
  const ready = {
    '/dashboard': () => page.locator('.kpi').first(),
    '/campaigns': () => page.locator('table.grid tbody tr', { hasText: 'UI flows' }),
    '/campaigns/ui-flows': () => page.locator('.stream').first(),
    '/reports': () => page.locator('table.grid tbody tr').first(),
    '/clicks': () => page.locator('table.grid tbody tr').first(),
  };
  for (const [path, locator] of Object.entries(ready)) {
    await ui.go(page, path);
    await locator().waitFor();
    const overflow = await pageOverflow(page);
    assert.ok(overflow <= 1, `${path} overflows by ${overflow}px at 390px`);
  }
  await page.screenshot({ path: join(tmpdir(), 'umbrella-admin-mobile.png'), fullPage: true });
});
