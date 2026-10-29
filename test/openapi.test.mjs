import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(__dirname, '../docs/openapi.json');

let spec;
try {
  spec = JSON.parse(readFileSync(specPath, 'utf8'));
} catch (e) {
  assert.fail(`Failed to parse docs/openapi.json: ${e.message}`);
}

assert.equal(spec.openapi.slice(0, 3), '3.1', 'openapi version must be 3.1.x');
assert.ok(spec.paths && typeof spec.paths === 'object', 'spec.paths must be an object');

const paths = Object.keys(spec.paths);

// All routes from README that must appear in the spec.
// Express :param notation → OpenAPI {param} notation.
const required = [
  '/r/{campaign}',
  '/r/{campaign}/{offer}',
  '/lp/click',
  '/postback',
  '/health',
  '/stats',
  '/stats/timeseries',
  '/stats/compare',
  '/stats/export',
  '/stats/referrers',
  '/stats/paths',
  '/stats/params',
  '/api/clicks',
  '/api/conversions',
  '/api/offers',
  '/api/offers/{id}',
  '/api/campaigns',
  '/api/campaigns/{id}',
  '/api/campaigns/{id}/streams',
  '/api/landings',
  '/api/landings/{id}',
  '/api/auth/me',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/users',
  '/api/users/{id}',
  '/api/keys',
  '/api/keys/{id}',
  '/api/security',
  '/api/settings',
  '/api/audit',
  '/api/domains',
  '/api/rates',
];

const missing = required.filter(p => !paths.includes(p));
assert.deepEqual(missing, [], `Missing paths in spec: ${missing.join(', ')}`);

// Every path entry must have at least one HTTP method.
for (const [p, item] of Object.entries(spec.paths)) {
  const methods = ['get','post','put','patch','delete','head','options'].filter(m => m in item);
  assert.ok(methods.length > 0, `Path ${p} has no HTTP methods`);
}

// Security schemes must include both auth mechanisms.
const schemes = Object.keys(spec.components?.securitySchemes ?? {});
assert.ok(schemes.includes('bearerAuth'), 'bearerAuth security scheme required');
assert.ok(schemes.includes('cookieAuth'), 'cookieAuth security scheme required');

console.log(`✓ openapi.json parsed — ${paths.length} paths, all ${required.length} required paths present`);
