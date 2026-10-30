// Production copy of the panel's browser files in build/panel/, served instead of the sources when PANEL_BUILD=1
// (src/server.js). JS: renamed identifiers, every string in an encoded array (javascript-obfuscator); no eval or
// self-defending code, so it runs under ADMIN_CSP. CSS and the HTML shell: comments removed. Run by the deploy job.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'build', 'panel');
const OPTIONS = {
  target: 'browser', compact: true, identifierNamesGenerator: 'mangled-shuffled', renameGlobals: false,
  stringArray: true, stringArrayEncoding: ['base64'], stringArrayThreshold: 1, stringArrayRotate: true, stringArrayShuffle: true,
  stringArrayWrappersCount: 2, stringArrayWrappersType: 'function', splitStrings: false, controlFlowFlattening: false,
  deadCodeInjection: false, selfDefending: false, debugProtection: false, numbersToExpressions: false, sourceMap: false,
};
// Published name -> source. Module imports between them ('./stream-policy.js', './demo.js') keep these names.
const PANEL_FILES = {
  'admin.js': 'public/admin/admin.js', 'demo.js': 'public/admin/demo.js',
  'stream-policy.js': 'src/stream-policy.js', 'stats-report.js': 'src/stats-report.js',
  'admin.css': 'public/admin/admin.css', 'index.html': 'public/admin/index.html',
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const [name, source] of Object.entries(PANEL_FILES)) {
  const text = await readFile(join(root, source), 'utf8');
  const result = name.endsWith('.js') ? JavaScriptObfuscator.obfuscate(text, OPTIONS).getObfuscatedCode()
    : name.endsWith('.css') ? text.replace(/\/\*[\s\S]*?\*\//g, '')
      : text.replace(/<!--[\s\S]*?-->/g, '');
  await writeFile(join(out, name), result);
  console.log(`${name}: ${text.length} -> ${result.length}`);
}
