import { spawn } from 'node:child_process';
import { once } from 'node:events';

export async function startTestServer(dataDir, environment = {}) {
  const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env,
    DATABASE_URL: '', ADMIN_TOKEN: '', GEOIP_DB: '', CLICK_RATE_LIMIT: '0', FX_REFRESH: '0',
    PORT: '0', DATA_DIR: dataDir, POSTBACK_SECRET: 'conversion-test-secret', RETENTION_DAYS: '', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '', output = '';
  child.stderr.on('data', (chunk) => { diagnostics += chunk; });
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(timer);
  }
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Test server startup timeout: ${diagnostics}`)), 5000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Test server exit ${code}: ${diagnostics}`)); });
    });
    return { url, stop };
  } catch (error) { await stop(); throw error; }
}
