// docs/openapi.json is the source of truth for the HTTP API. This test keeps it in sync with
// src/server.js in both directions: every route the server handles is documented, and every
// documented operation exists in the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(resolve(root, 'docs/openapi.json'), 'utf8'));
const server = readFileSync(resolve(root, 'src/server.js'), 'utf8');
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// Routes the server answers but that are deliberately not part of the API description.
const EXCEPTIONS = new Map([
  ['/', 'redirect to /admin'],
  ['/admin/', 'same page as /admin'],
  ['/admin/admin.js', 'static file of the panel'],
  ['/admin/admin.css', 'static file of the panel'],
  ['/admin/stream-policy.js', 'src/stream-policy.js served to the panel (same no-cloaking check in the browser)'],
]);

// "/api/users/{id}" and the regex form "/api/users/([0-9a-f-]{36})" both become "/api/users/{}".
const norm = (p) => p.replace(/\{[^}]+\}/g, '{}');

/** Route extraction from src/server.js: `pathname === '/x' && req.method === 'GET'`,
 *  `const m = pathname.match(/^\/x\/([^/]+)$/)` + `if (m && req.method === 'POST')`,
 *  plus bare `pathname === '/x'` (path known, method from the spec). */
export function serverRoutes(source) {
  const ops = new Set();
  const paths = new Set();
  for (const m of source.matchAll(/\b(?:url\.pathname|path)\s*===\s*'(\/[^']*)'(?:\s*&&\s*req\.method\s*===\s*'([A-Z]+)')?/g)) {
    paths.add(m[1]);
    if (m[2]) ops.add(`${m[2].toLowerCase()} ${m[1]}`);
  }
  const vars = new Map();
  for (const m of source.matchAll(/const\s+(\w+)\s*=\s*(?:url\.pathname|path)\.match\(\/\^(.+?)\$\/\)/g)) {
    vars.set(m[1], m[2].replace(/\([^)]*\)/g, '{}').replace(/\\\//g, '/'));
  }
  for (const m of source.matchAll(/\b(\w+)\s*&&\s*req\.method\s*===\s*'([A-Z]+)'/g)) {
    if (!vars.has(m[1])) continue;
    paths.add(vars.get(m[1]));
    ops.add(`${m[2].toLowerCase()} ${vars.get(m[1])}`);
  }
  // Static files served from lookup tables: { '/admin': ['index.html', …] } and new Map([['/assets/x.js', [...]]]).
  for (const m of source.matchAll(/\[?'(\/(?:admin|assets)[^']*)'\s*[:,]\s*\['[^']+',\s*'text\//g)) {
    paths.add(m[1]);
    ops.add(`get ${m[1]}`);
  }
  return { ops, paths };
}

const { ops: codeOps, paths: codePaths } = serverRoutes(server);
const specOps = new Set();
const specPaths = new Set();
for (const [p, item] of Object.entries(spec.paths)) {
  specPaths.add(norm(p));
  for (const m of METHODS) if (m in item) specOps.add(`${m} ${norm(p)}`);
}

test('openapi.json is a 3.1 document with both auth schemes', () => {
  assert.equal(spec.openapi.slice(0, 3), '3.1');
  const schemes = Object.keys(spec.components?.securitySchemes ?? {});
  assert.ok(schemes.includes('bearerAuth') && schemes.includes('cookieAuth'));
  for (const [p, item] of Object.entries(spec.paths)) {
    assert.ok(METHODS.some((m) => m in item), `${p} has no HTTP methods`);
  }
});

test('route extraction sees the server (guards against a silently broken regex)', () => {
  assert.ok(codeOps.size >= 40, `only ${codeOps.size} routes extracted`);
  for (const op of ['get /r/{}', 'get /r/{}/{}', 'patch /api/users/{}', 'post /api/campaigns/{}/clear-stats', 'get /stats/bots']) {
    assert.ok(codeOps.has(op), `extractor missed ${op}`);
  }
});

test('every server route is documented (server ⊆ spec)', () => {
  const missingPaths = [...codePaths].filter((p) => !EXCEPTIONS.has(p) && !specPaths.has(p));
  assert.deepEqual(missingPaths, [], `paths handled in src/server.js but missing in docs/openapi.json: ${missingPaths.join(', ')}`);
  const missingOps = [...codeOps].filter((op) => !EXCEPTIONS.has(op.split(' ')[1]) && !specOps.has(op));
  assert.deepEqual(missingOps, [], `operations missing in docs/openapi.json: ${missingOps.join(', ')}`);
});

test('every documented operation exists (spec ⊆ server)', () => {
  const stale = [...specOps].filter((op) => {
    const p = op.split(' ')[1];
    if (codeOps.has(op)) return false;
    // A bare `pathname === '/health'` answers any method; the spec names it.
    return !(codePaths.has(p) && ![...codeOps].some((o) => o.endsWith(` ${p}`)));
  });
  assert.deepEqual(stale, [], `documented in docs/openapi.json but not handled by src/server.js: ${stale.join(', ')}`);
});

test('exceptions are still real and still undocumented', () => {
  for (const [p, why] of EXCEPTIONS) {
    assert.ok(codePaths.has(p), `exception ${p} (${why}) no longer exists in src/server.js — drop it`);
    assert.ok(!specPaths.has(p), `exception ${p} is documented now — drop it from EXCEPTIONS`);
  }
});

test('operationIds are unique and tags are declared', () => {
  const ids = [];
  const declared = new Set((spec.tags || []).map((t) => t.name));
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of METHODS) {
      if (!item[m]) continue;
      if (item[m].operationId) ids.push(item[m].operationId);
      for (const t of item[m].tags || []) assert.ok(declared.has(t), `${m.toUpperCase()} ${p}: tag "${t}" is not declared in spec.tags`);
    }
  }
  assert.equal(new Set(ids).size, ids.length, 'duplicate operationId');
});
