import { nativeGit, nativeGitFiles } from './git';
import {
  parseCredentialPassword,
  repositoryAuthHeader,
  repositoryCredentialInput,
  repositoryToken,
  repositoryUrl,
} from './repository';
import fs from 'node:fs/promises';
import { FileScanner } from './scanner';
import { mediaHash, mediaReference, parseMediaReference } from './media';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLibrary, makeItem, applyOperation } from '../domain/operations';
import { mergeLibraries } from '../domain/merge';
import type { Library, Operation } from '../domain/types';
import { decodeFiles, encodeFiles, safePath, type Files } from './codec';
import { applyIntent } from './reconcile';
import type { Snapshot, Store } from './types';
const exec = promisify(execFile);
export class LocalStore implements Store {
  private scanner: FileScanner;
  private actor = `desktop-${process.pid}`;
  private queue: Promise<unknown> = Promise.resolve();
  private mediaIndex?: { revision: string; decoded: ReturnType<typeof decodeFiles> };
  constructor(
    public readonly directory: string,
    private readonly branch = 'main',
  ) {
    this.scanner = new FileScanner(directory);
  }
  private async acquire(): Promise<() => Promise<void>> {
    await fs.mkdir(this.directory, { recursive: true });
    if ((await fs.lstat(this.directory)).isSymbolicLink())
      throw new Error('Data directory cannot be a symlink');
    const lock = path.join(this.directory, '.gitdrop-lock');
    for (let n = 0; ; n++) {
      try {
        await fs.mkdir(lock);
        await fs.writeFile(path.join(lock, 'owner'), `${process.pid}`);
        break;
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        // Only recover locks whose owning local process is known to have exited.
        const pid = Number(await fs.readFile(path.join(lock, 'owner'), 'utf8').catch(() => ''));
        if (pid)
          try {
            process.kill(pid, 0);
          } catch (err: any) {
            if (err.code === 'ESRCH') {
              await fs.rm(lock, { recursive: true, force: true });
              continue;
            }
          }
        if (n >= 100) throw new Error('Library is busy; retry shortly');
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const release = () => fs.rm(lock, { recursive: true, force: true });
    try {
      await this.recover();
      return release;
    } catch (error) {
      await release();
      throw error;
    }
  }
  private async lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const release = await this.acquire();
      try {
        return await fn();
      } finally {
        await release();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
  private scan() {
    return this.scanner.scan();
  }
  private async guard(file: string) {
    if (!safePath(file)) throw new Error('Unsafe path');
    let current = this.directory;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new Error(`Symlink not supported: ${file}`);
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  private async atomic(file: string, data: Buffer) {
    await this.guard(file);
    const target = path.join(this.directory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.gitdrop-tmp-${randomUUID()}`;
    const reference = parseMediaReference(data);
    if (reference?.source === 'file') {
      const source = path.relative(this.directory, reference.location).split(path.sep).join('/');
      await this.guard(source);
      await fs.copyFile(reference.location, temp);
    } else if (reference) {
      const { stdout } = await exec('git', ['cat-file', 'blob', reference.sha], {
        cwd: this.directory,
        encoding: 'buffer',
        maxBuffer: 2 * 1024 * 1024,
      });
      await fs.writeFile(temp, stdout);
    } else await fs.writeFile(temp, data);
    await fs.rename(temp, target);
  }
  private async recover() {
    const journal = path.join(this.directory, '.gitdrop-transaction.json');
    const text = await fs.readFile(journal, 'utf8').catch((e: any) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (!text) return;
    const transaction = JSON.parse(text) as { writes: [string, string][]; deletes: string[] };
    for (const [p, data] of transaction.writes) await this.atomic(p, Buffer.from(data, 'base64'));
    for (const p of transaction.deletes) {
      await this.guard(p);
      await fs.rm(path.join(this.directory, p), { force: true });
    }
    await fs.rm(journal);
    await fs.rm(path.join(this.directory, '.gitdrop-stage'), { recursive: true, force: true });
  }
  private sameContent(a: Buffer | undefined, b: Buffer) {
    if (!a) return false;
    if (a.equals(b)) return true;
    return parseMediaReference(a) || parseMediaReference(b) ? mediaHash(a) === mediaHash(b) : false;
  }
  private async write(next: Files, previous: Files) {
    const current = await this.scan();
    if (this.digest(current) !== this.digest(previous))
      throw new Error('Files changed during save; retry to preserve external edits');
    const prepared = new Map(next);
    for (const [p, b] of prepared) {
      if (this.sameContent(previous.get(p), b)) continue;
      const ref = parseMediaReference(b);
      if (ref?.source === 'file') {
        await this.guard(path.relative(this.directory, ref.location).split(path.sep).join('/'));
        const stage = path.join(this.directory, '.gitdrop-stage', ref.sha);
        await this.guard(`.gitdrop-stage/${ref.sha}`);
        await fs.mkdir(path.dirname(stage), { recursive: true });
        await fs.copyFile(ref.location, stage);
        prepared.set(p, mediaReference({ ...ref, location: stage }));
      }
    }
    const writes = [...prepared]
      .filter(([p, b]) => !this.sameContent(previous.get(p), b))
      .map(([p, b]) => [p, b.toString('base64')]);
    const deletes = [...previous.keys()].filter((p) => !next.has(p));
    await this.atomic(
      '.gitdrop-transaction.json',
      Buffer.from(JSON.stringify({ writes, deletes })),
    );
    await this.recover();
    // Remove obsolete empty collection folders, deepest first.
    const dirs = new Set(
      [...previous.keys()].map((p) => path.posix.dirname(p)).filter((p) => p !== '.'),
    );
    for (const dir of [...dirs].sort((a, b) => b.length - a.length))
      await fs.rmdir(path.join(this.directory, dir)).catch(() => {});
  }
  private digest(files: Files) {
    const hash = createHash('sha256');
    for (const [p, b] of [...files].sort(([a], [b]) => a.localeCompare(b)))
      hash.update(p).update(b);
    for (const dir of [...(files.directories || [])].sort()) hash.update(`directory:${dir}`);
    return hash.digest('hex');
  }
  private async load(): Promise<Snapshot> {
    const files = await this.scan();
    const decoded = decodeFiles(files, this.actor);
    return {
      library: decoded.library,
      diagnostics: decoded.diagnostics,
      revision: this.digest(files),
    };
  }
  async read() {
    return this.lock(() => this.load());
  }
  async initialize() {
    return this.lock(async () => {
      const files = await this.scan();
      if (!files.has('.gitdrop/state.json')) {
        if ([...files.keys()].some((p) => p.endsWith('.json')))
          throw new Error('Initialize requires an empty library or an existing Gitdrop repository');
        await this.write(
          encodeFiles(
            (() => {
              const library = createLibrary();
              const inbox = makeItem('collection', { id: 'inbox', title: 'Inbox' });
              library.records[inbox.id] = inbox;
              return library;
            })(),
            files,
          ),
          files,
        );
      }
      return this.load();
    });
  }
  async mutate(operation: Operation) {
    return this.lock(async () => {
      const files = await this.scan();
      const parsed = decodeFiles(files, this.actor);
      if (parsed.diagnostics.length) throw new Error(parsed.diagnostics.join('\n'));
      const library = applyIntent(parsed.library, operation);
      await this.write(encodeFiles(library, files, parsed.paths), files);
      return this.load();
    });
  }
  private async materialize(data: Buffer | null): Promise<Buffer | null> {
    if (!data) return null;
    const ref = parseMediaReference(data);
    if (!ref) return data;
    if (ref.source === 'file') {
      await this.guard(path.relative(this.directory, ref.location).split(path.sep).join('/'));
      return fs.readFile(ref.location);
    }
    return (
      await exec('git', ['cat-file', 'blob', ref.sha], {
        cwd: this.directory,
        encoding: 'buffer',
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout;
  }
  async readMedia(id: string) {
    return this.lock(async () => {
      const files = await this.scan();
      const revision = this.digest(files);
      if (this.mediaIndex?.revision !== revision)
        this.mediaIndex = { revision, decoded: decodeFiles(files) };
      const { library, paths } = this.mediaIndex.decoded;
      const item = library.records[id] ?? library.tombstones[id]?.record;
      const name = item?.cover.imageFile;
      if (!name) return null;
      if (!paths[id])
        return this.materialize(
          files.get(`.gitdrop/media/${id}.webp`) ??
            (item?.cover.imageHash
              ? files.get(`.gitdrop/media/by-hash/${item.cover.imageHash}.webp`)
              : null) ??
            null,
        );
      return this.materialize(
        files.get(path.posix.join(path.posix.dirname(paths[id]), name)) ?? null,
      );
    });
  }
  async writeMedia(id: string, data: Buffer, mode: 'automatic' | 'image' = 'image') {
    return this.lock(async () => {
      const files = await this.scan();
      const parsed = decodeFiles(files, this.actor);
      if (parsed.diagnostics.length) throw new Error(parsed.diagnostics.join('\n'));
      const item = parsed.library.records[id];
      if (!item) throw new Error('Bookmark or collection not found');
      if (mode === 'automatic' && item.cover.mode !== 'automatic') return this.load();
      const file = parsed.paths[id].replace(/\.json$/, '.webp');
      const modified = new Map(files);
      const old = files.get(file);
      if (old) modified.set(`.gitdrop/media/by-hash/${mediaHash(old)}.webp`, old);
      modified.set(file, data);
      const library = applyOperation(parsed.library, {
        id: randomUUID(),
        actor: this.actor,
        type: 'update',
        recordId: id,
        patch: {
          cover: {
            ...item.cover,
            mode,
            imageFile: path.posix.basename(file),
            imageHash: mediaHash(data),
          },
        },
      });
      await this.write(encodeFiles(library, modified, parsed.paths), files);
      return this.load();
    });
  }
  async *exportEntries(): AsyncGenerator<{ name: string; data: Buffer }> {
    const release = await this.acquire();
    try {
      const files = await this.scan();
      for (const [name, reference] of files) {
        const data = (await this.materialize(reference))!;
        const ref = parseMediaReference(reference);
        if (ref && mediaHash(data) !== ref.sha)
          throw new Error('Cover changed externally during export; retry export');
        yield { name, data };
      }
    } finally {
      await release();
    }
  }
  async exportFiles() {
    const output: Record<string, Buffer> = {};
    for await (const entry of this.exportEntries()) output[entry.name] = entry.data;
    return output;
  }
  private git(args: string[], input?: string) {
    return nativeGit(this.directory, args, input);
  }
  private remoteGit(args: string[], authHeader?: string) {
    return this.git(authHeader ? ['-c', `http.extraheader=${authHeader}`, ...args] : args);
  }
  private gitFiles(ref: string) {
    return nativeGitFiles(this.directory, ref);
  }
  private async credentialArgs(action: 'fill' | 'approve' | 'reject'): Promise<string[]> {
    const helper = await this.git(['config', '--get', 'credential.helper']).catch(() => '');
    if (helper) return ['credential', action];
    const file = path
      .join(this.directory, '.git', 'gitdrop-credentials')
      .split(path.sep)
      .join('/');
    return ['-c', `credential.helper=store --file=${file}`, 'credential', action];
  }
  private async saveToken(url: string, token: string): Promise<void> {
    await this.git(['config', '--local', '--unset-all', 'gitdrop.token']).catch(() => {});
    await this.git(['config', '--local', '--unset-all', 'http.extraheader']).catch(() => {});
    const input = repositoryCredentialInput(url, token);
    await this.git(await this.credentialArgs('approve'), input);
    if (!(await this.readToken(url, true))) {
      const file = path
        .join(this.directory, '.git', 'gitdrop-credentials')
        .split(path.sep)
        .join('/');
      await this.git(['config', '--local', '--replace-all', 'credential.helper', '']);
      await this.git(['config', '--local', '--add', 'credential.helper', `store --file=${file}`]);
      await this.git(['credential', 'approve'], input);
    }
    await fs
      .chmod(path.join(this.directory, '.git', 'gitdrop-credentials'), 0o600)
      .catch(() => {});
    await this.git(['config', '--local', 'gitdrop.hasToken', 'true']);
  }
  private async readToken(url: string, force = false): Promise<string | undefined> {
    if (!force) {
      const legacy = await this.git(['config', '--local', '--get', 'gitdrop.token']).catch(
        () => '',
      );
      if (legacy) {
        const validated = repositoryToken(legacy);
        if (validated) {
          await this.saveToken(url, validated);
          return validated;
        }
      }
      const hasToken = await this.git(['config', '--local', '--get', 'gitdrop.hasToken']).catch(
        () => '',
      );
      if (hasToken !== 'true') return undefined;
    }
    const output = await this.git(
      await this.credentialArgs('fill'),
      repositoryCredentialInput(url),
    ).catch(() => '');
    return parseCredentialPassword(output);
  }
  private async ensureGit() {
    // Do not accidentally use a parent checkout when the data directory is nested.
    const ownGit = await fs.lstat(path.join(this.directory, '.git')).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!ownGit) await this.git(['init', '-b', this.branch]);
    else if (ownGit.isSymbolicLink()) throw new Error('Git directory cannot be a symlink');
  }
  async repository() {
    return this.lock(async () => {
      const exists = await fs.lstat(path.join(this.directory, '.git')).catch(() => null);
      const url = exists
        ? await this.git(['config', '--local', '--get', 'remote.origin.url']).catch(() => null)
        : null;
      const hasToken = exists && url ? Boolean(await this.readToken(url)) : false;
      return { url, branch: this.branch, ...(hasToken ? { hasToken: true } : {}) };
    });
  }
  async connectRepository(value: string, token?: string) {
    const url = repositoryUrl(value);
    const pat = repositoryToken(token);
    return this.lock(async () => {
      await this.ensureGit();
      const remotes = (await this.git(['remote'])).split('\n');
      const current = remotes.includes('origin')
        ? await this.git(['config', '--local', '--get', 'remote.origin.url'])
        : null;
      if (current !== url) {
        // Remove stale tracking refs and push URLs when switching repositories.
        if (current) await this.git(['remote', 'remove', 'origin']);
        await this.git(['remote', 'add', 'origin', url]);
      }
      if (pat !== undefined) {
        await this.saveToken(url, pat);
      }
      const savedToken = pat ?? (await this.readToken(url));
      await this.git(['config', '--local', '--unset-all', 'http.extraheader']).catch(() => {});
      await this.git([
        'config',
        '--local',
        '--unset-all',
        'url.https://github.com/.insteadOf',
      ]).catch(() => {});
      if (savedToken) {
        if (url.startsWith('git@github.com:') || url.startsWith('ssh://git@github.com/')) {
          await this.git([
            'config',
            '--local',
            'url.https://github.com/.insteadOf',
            'git@github.com:',
          ]);
          await this.git([
            'config',
            '--local',
            '--add',
            'url.https://github.com/.insteadOf',
            'ssh://git@github.com/',
          ]);
        }
      }
      return { url, branch: this.branch, ...(savedToken ? { hasToken: true } : {}) };
    });
  }
  async sync() {
    return this.lock(async () => {
      let files = await this.scan();
      let parsed = decodeFiles(files, this.actor);
      if (parsed.diagnostics.length) throw new Error(parsed.diagnostics.join('\n'));
      await this.write(encodeFiles(parsed.library, files, parsed.paths), files);
      await this.ensureGit();
      await this.git([
        'add',
        '--all',
        '--',
        '.',
        ':(exclude).gitdrop-lock',
        ':(exclude).gitdrop-transaction.json',
        ':(exclude).gitdrop-stage',
      ]);
      if (await this.git(['diff', '--cached', '--name-only']))
        await this.git([
          '-c',
          'user.name=Gitdrop',
          '-c',
          'user.email=gitdrop@localhost',
          'commit',
          '-m',
          'Update bookmark library',
        ]);
      const remotes = await this.git(['remote']);
      if (!remotes.split('\n').includes('origin'))
        return { ...(await this.load()), status: 'Local only — configure a Git origin to sync' };
      const originUrl = await this.git(['config', '--local', '--get', 'remote.origin.url']).catch(
        () => '',
      );
      const token = originUrl ? await this.readToken(originUrl) : undefined;
      const authHeader = token ? repositoryAuthHeader(token) : undefined;
      try {
        await this.remoteGit(['fetch', 'origin', this.branch], authHeader);
      } catch (error) {
        const refs = await this.remoteGit(
          ['ls-remote', '--heads', 'origin', `refs/heads/${this.branch}`],
          authHeader,
        );
        if (refs) throw error;
        await this.remoteGit(['push', 'origin', `HEAD:refs/heads/${this.branch}`], authHeader);
        return { ...(await this.load()), status: 'Synced' };
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const local = await this.git(['rev-parse', 'HEAD']);
        const remote = await this.git(['rev-parse', `refs/remotes/origin/${this.branch}`]);
        if (local !== remote) {
          const base = await this.git(['merge-base', local, remote]).catch(() => null);
          if (base !== remote) {
            const [baseFiles, remoteFiles] = await Promise.all([
              base ? this.gitFiles(base) : Promise.resolve(new Map() as Files),
              this.gitFiles(remote),
            ]);
            if (!remoteFiles.has('.gitdrop/state.json'))
              throw new Error('Remote must be empty or contain an existing Gitdrop library.');
            files = await this.scan();
            parsed = decodeFiles(files, this.actor);
            const remoteParsed = decodeFiles(remoteFiles, 'external-remote');
            const baseParsed = decodeFiles(baseFiles, 'external-base');
            if (
              [...parsed.diagnostics, ...remoteParsed.diagnostics, ...baseParsed.diagnostics].length
            )
              throw new Error('Invalid files block synchronization; repair diagnostics first');
            const merged = mergeLibraries(
              baseParsed.library,
              parsed.library,
              remoteParsed.library,
            );
            const media = new Map([...remoteFiles, ...files]);
            for (const [p, b] of [...remoteFiles, ...files])
              if (p.endsWith('.webp')) media.set(`.gitdrop/media/by-hash/${mediaHash(b)}.webp`, b);
            const next = encodeFiles(merged, media, { ...remoteParsed.paths, ...parsed.paths });
            await this.write(next, files);
            await this.git([
              'add',
              '--all',
              '--',
              '.',
              ':(exclude).gitdrop-lock',
              ':(exclude).gitdrop-transaction.json',
              ':(exclude).gitdrop-stage',
            ]);
            const tree = await this.git(['write-tree']);
            const commit = await this.git(
              [
                '-c',
                'user.name=Gitdrop',
                '-c',
                'user.email=gitdrop@localhost',
                'commit-tree',
                tree,
                '-p',
                local,
                '-p',
                remote,
              ],
              'Merge bookmark changes\n',
            );
            await this.git(['update-ref', 'HEAD', commit, local]);
          }
        }
        try {
          await this.remoteGit(['push', 'origin', `HEAD:refs/heads/${this.branch}`], authHeader);
          return { ...(await this.load()), status: 'Synced' };
        } catch {
          if (attempt === 2)
            throw new Error('Remote changed or push failed; local changes are safe. Retry sync.');
          await this.remoteGit(['fetch', 'origin', this.branch], authHeader);
        }
      }
      return this.load();
    });
  }
}
