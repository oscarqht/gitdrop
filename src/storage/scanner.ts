import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { safePath, type Files } from './codec';
import { mediaReference } from './media';
type Signature = { mtime: number; ctime: number; size: number };
export class FileScanner {
  private cache = new Map<string, Signature & { data: Buffer }>();
  constructor(private directory: string) {}
  async scan(): Promise<Files> {
    const files: Files = new Map();
    files.directories = [];
    const pending: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(path.join(this.directory, dir), {
        withFileTypes: true,
      })) {
        if (
          ['.git', '.gitdrop-lock', '.gitdrop-transaction.json', '.gitdrop-stage'].includes(
            entry.name,
          ) ||
          entry.name.includes('.gitdrop-tmp-')
        )
          continue;
        const relative = path.posix.join(dir, entry.name);
        if (!safePath(relative)) throw new Error('Unsafe library path');
        if (entry.isSymbolicLink()) throw new Error(`Symlink not supported: ${relative}`);
        if (entry.isDirectory()) {
          if (relative !== '.gitdrop' && !relative.startsWith('.gitdrop/'))
            files.directories!.push(relative);
          await walk(relative);
        } else if (entry.isFile()) pending.push(relative);
      }
    };
    await walk('');
    let cursor = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, async () => {
        while (cursor < pending.length) {
          const relative = pending[cursor++];
          const absolute = path.join(this.directory, relative);
          const stat = await fs.lstat(absolute);
          if (stat.isSymbolicLink()) throw new Error(`Symlink not supported: ${relative}`);
          const signature = { mtime: stat.mtimeMs, ctime: stat.ctimeMs, size: stat.size };
          let cached = this.cache.get(relative);
          if (
            !cached ||
            cached.mtime !== signature.mtime ||
            cached.ctime !== signature.ctime ||
            cached.size !== signature.size
          ) {
            let data: Buffer;
            if (relative.endsWith('.webp')) {
              const hash = createHash('sha1').update(`blob ${stat.size}\0`);
              for await (const chunk of createReadStream(absolute)) hash.update(chunk);
              data = mediaReference({
                sha: hash.digest('hex'),
                source: 'file',
                location: absolute,
              });
            } else data = await fs.readFile(absolute);
            const after = await fs.lstat(absolute);
            if (
              after.isSymbolicLink() ||
              after.mtimeMs !== signature.mtime ||
              after.ctimeMs !== signature.ctime ||
              after.size !== signature.size
            )
              throw new Error('Files changed during scan; retry to preserve external edits');
            cached = { ...signature, data };
            this.cache.set(relative, cached);
          }
          files.set(relative, cached.data);
        }
      }),
    );
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    for (const key of this.cache.keys()) if (!files.has(key)) this.cache.delete(key);
    const sorted: Files = new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
    sorted.directories = files.directories;
    return sorted;
  }
}
