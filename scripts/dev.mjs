import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const env = { ...process.env, NODE_ENV: 'development' };
// Next.js desktop hosts can pass their own pre-resolved standalone config to
// child processes. This app must resolve its own config and version's defaults.
delete env.__NEXT_PRIVATE_STANDALONE_CONFIG;

const child = spawn(
  process.execPath,
  [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', ...process.argv.slice(2)],
  { stdio: 'inherit', env },
);

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
});
