import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be between 1 and 65535.');
const child = spawn(
  process.execPath,
  [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
  { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
const url = `http://127.0.0.1:${port}`;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    if (response.ok) {
      const command =
        process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      const browser = spawn(command, args, { stdio: 'ignore' });
      browser.on('error', () => console.info(`Open ${url} in your browser.`));
      browser.unref();
      break;
    }
  } catch {
    /* Wait for the server to listen. */
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
