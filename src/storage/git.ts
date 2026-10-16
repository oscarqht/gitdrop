import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safePath, type Files } from './codec';
import { mediaReference } from './media';
const exec = promisify(execFile);
export async function nativeGit(
  directory: string,
  args: string[],
  input?: string,
): Promise<string> {
  if (input !== undefined) {
    return await new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        args,
        { cwd: directory, maxBuffer: 100 * 1024 * 1024 },
        (e, out) => (e ? reject(new Error(`Git ${args[0]} failed`)) : resolve(out.trim())),
      );
      child.stdin?.end(input);
    });
  }
  try {
    return (
      await exec('git', args, { cwd: directory, maxBuffer: 100 * 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw new Error(`Git ${args[0]} failed; check repository configuration and credentials`);
  }
}
export async function nativeGitFiles(directory: string, ref: string): Promise<Files> {
  const files: Files = new Map();
  const listing = await nativeGit(directory, ['ls-tree', '-r', '-z', ref]);
  const entries = listing
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, p] = line.split('\t');
      const [mode, , sha] = meta.split(' ');
      if (!safePath(p) || mode === '120000') throw new Error('Unsafe Git path');
      return { p, sha };
    });
  const metadata = entries.filter((e) => !e.p.endsWith('.webp'));
  for (const entry of entries.filter((e) => e.p.endsWith('.webp')))
    files.set(entry.p, mediaReference({ source: 'git', sha: entry.sha, location: entry.sha }));
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      'git',
      ['cat-file', '--batch'],
      { cwd: directory, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
      (error, out) => (error ? reject(error) : resolve(out)),
    );
    child.stdin?.end(metadata.map((e) => e.sha).join('\n') + '\n');
  });
  let offset = 0;
  for (const entry of metadata) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString().split(' ');
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size)) throw new Error('Invalid Git blob');
    offset = end + 1;
    files.set(entry.p, output.subarray(offset, offset + size));
    offset += size + 1;
  }
  return files;
}
