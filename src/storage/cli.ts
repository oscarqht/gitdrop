import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { LocalStore } from './local';
const [command = 'init', argument, destination] = process.argv.slice(2);
async function main() {
  const directory = path.resolve(
    (command === 'clone' ? destination : argument) ||
      process.env.GITDROP_DATA_DIR ||
      path.join(os.homedir(), '.gitdrop', 'library'),
  );
  if (command === 'clone') {
    if (!argument) throw new Error('Usage: npm run library -- clone <remote> <directory>');
    execFileSync('git', ['clone', '--', argument, directory], { stdio: 'inherit' });
  }
  const store = new LocalStore(directory, process.env.GITDROP_BRANCH || 'main');
  const result =
    command === 'sync'
      ? await store.sync()
      : command === 'init' || command === 'clone'
        ? await store.initialize()
        : await store.read();
  console.log(
    JSON.stringify(
      {
        directory,
        records: Object.keys(result.library.records).length,
        diagnostics: result.diagnostics,
        status: result.status || 'Ready',
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
