#!/usr/bin/env node
// Renders the API table in README.md from docs/openapi.json (the source of truth).
//   node scripts/gen-api-table.mjs          rewrite the block between the markers
//   node scripts/gen-api-table.mjs --check  exit 1 if README.md is out of date (CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const START = '<!-- api-table:start -->';
const END = '<!-- api-table:end -->';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

export function renderTable(spec) {
  const groups = new Map((spec.tags || []).map((t) => [t.name, []]));
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const summary = op['x-summary-ru'];
      if (!summary) throw new Error(`${method.toUpperCase()} ${path}: x-summary-ru is missing in docs/openapi.json`);
      const tag = op.tags?.[0] || 'other';
      if (!groups.has(tag)) groups.set(tag, []);
      const access = !op.security?.length ? 'публично'
        : op.security.some((s) => !Object.keys(s).length) ? 'вход не обязателен'
          : op.security.some((s) => 'bearerAuth' in s) ? 'вход или токен' : 'только сессия';
      groups.get(tag).push({ path, order: METHODS.indexOf(method), row: `| \`${method.toUpperCase()} ${path}\` | ${summary.replace(/\|/g, '\\|')} | ${access} |` });
    }
  }
  for (const rows of groups.values()) rows.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : x.order - y.order));
  const out = [START, '<!-- Сгенерировано из docs/openapi.json: node scripts/gen-api-table.mjs. Руками не править. -->', ''];
  for (const [tag, rows] of groups) {
    if (!rows.length) continue;
    const t = (spec.tags || []).find((x) => x.name === tag);
    const title = t?.['x-title-ru'] || t?.description || tag;
    out.push(`**${title}**`, '', '| Метод и путь | Назначение | Доступ |', '|---|---|---|', ...rows.map((r) => r.row), '');
  }
  out.push(END);
  return out.join('\n');
}

export function updateReadme(readme, table) {
  const a = readme.indexOf(START), b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error(`README.md must contain ${START} … ${END}`);
  return readme.slice(0, a) + table + readme.slice(b + END.length);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const spec = JSON.parse(readFileSync(resolve(root, 'docs/openapi.json'), 'utf8'));
  const readmePath = resolve(root, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');
  const next = updateReadme(readme, renderTable(spec));
  if (process.argv.includes('--check')) {
    if (next !== readme) {
      console.error('README.md API table is out of date: run `node scripts/gen-api-table.mjs` and commit the result.');
      process.exit(1);
    }
    console.log('README.md API table is up to date');
  } else if (next !== readme) {
    writeFileSync(readmePath, next);
    console.log('README.md API table updated');
  } else console.log('README.md API table already up to date');
}
