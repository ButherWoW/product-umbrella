// The server serves the panel shell only for the paths in src/panel-routes.js; the panel's own router (PAGES in
// public/admin/admin.js) and its menu must name the same sections, or a deep link would 404 or a page would be missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANEL_SECTIONS, isPanelPath } from '../src/panel-routes.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adminJs = readFileSync(resolve(root, 'public/admin/admin.js'), 'utf8');
const indexHtml = readFileSync(resolve(root, 'public/admin/index.html'), 'utf8');

test('panel sections: server list = panel router = menu', () => {
  const pages = adminJs.match(/const PAGES = \{([\s\S]*?)\n\};/);
  assert.ok(pages, 'PAGES table not found in admin.js');
  const routed = [...pages[1].matchAll(/(\w+): \(/g)].map((m) => m[1]).sort();
  assert.deepEqual(routed, [...PANEL_SECTIONS].sort());
  const menu = [...indexHtml.matchAll(/href="\/([a-z]+)" data-nav="([a-z]+)"/g)];
  assert.ok(menu.length >= 10, 'menu links not found');
  for (const [, href, nav] of menu) {
    assert.equal(href, nav);
    assert.ok(PANEL_SECTIONS.includes(href), `menu link /${href} is not a panel path`);
  }
});

test('isPanelPath: panel pages only, never API, tracking or static paths', () => {
  for (const p of ['/', '/login', '/dashboard', '/campaigns', '/campaigns/', '/campaigns/new', '/campaigns/a%2Fb', '/reports', '/keys']) {
    assert.ok(isPanelPath(p), p);
  }
  for (const p of ['/admin', '/admin/', '/admin/admin.js', '/api/campaigns', '/stats', '/r/demo', '/lp/click', '/postback', '/health',
    '/campaigns/a/b', '/reports/x', '/nope', '/login/x', '//campaigns', '/assets/x.js']) {
    assert.ok(!isPanelPath(p), p);
  }
});

test('no hash routes left in the panel', () => {
  assert.ok(!/['"`]#\/[a-z]/.test(adminJs), 'admin.js still has a #/ link');
  assert.ok(!indexHtml.includes('href="#/'), 'index.html still has a #/ link');
  assert.ok(!/location\.hash\s*=/.test(adminJs), 'admin.js still navigates through location.hash');
});
