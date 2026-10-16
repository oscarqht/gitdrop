import path from 'node:path';
import { mediaReference, parseMediaReference, mediaHash } from './media';
import { randomUUID } from 'node:crypto';
import { applyOperation } from '../domain/operations';
import { validateLibrary, type Operation } from '../domain/types';
import { decodeFiles, encodeFiles, gitBlobHash, safePath, type Files } from './codec';
import { applyIntent } from './reconcile';
import type { Store, Snapshot } from './types';
type LoadedState = { head: string; tree: string; entries: any[]; files: Files; parsed: ReturnType<typeof decodeFiles> };
export class GitHubStore implements Store {
  private blobs = new Map<string, Buffer>();
  private blobBytes = 0;
  private pendingBlobs = new Map<string, Promise<Buffer>>();
  private pendingHead?: Promise<string>;
  private cachedState?: { key: string; state: LoadedState };
  private pendingStates = new Map<string, Promise<LoadedState>>();
  async currentRevision(): Promise<string> {
    if (!this.pendingHead) this.pendingHead = this.api(`/git/ref/heads/${encodeURIComponent(this.branch)}`).then(ref => ref.object.sha as string).finally(() => { this.pendingHead = undefined; });
    return this.pendingHead;
  }
  private async blob(sha: string, limit = 64 * 1024 * 1024): Promise<Buffer> {
    const cached = this.blobs.get(sha);
    if (cached) { if(cached.length > limit) throw new Error('GitHub blob exceeds size limit'); this.blobs.delete(sha); this.blobs.set(sha,cached); return cached; }
    let pending = this.pendingBlobs.get(sha);
    if (!pending) {
      pending = (async () => {
        const value = await this.api(`/git/blobs/${sha}`, 'GET', undefined, Math.ceil(limit * 1.5) + 4096);
        const data = Buffer.from(value.content, 'base64');
        if (data.length > limit) throw new Error('GitHub blob exceeds size limit');
        if (gitBlobHash(data) !== sha) throw new Error('GitHub blob hash mismatch');
        if (data.length <= 64 * 1024 * 1024) {
          while(this.blobBytes + data.length > 64 * 1024 * 1024 && this.blobs.size) { const first = this.blobs.keys().next().value!; this.blobBytes -= this.blobs.get(first)!.length; this.blobs.delete(first); }
          this.blobs.set(sha,data); this.blobBytes += data.length;
        }
        return data;
      })().finally(() => this.pendingBlobs.delete(sha));
      this.pendingBlobs.set(sha,pending);
    }
    const data = await pending;
    if (data.length > limit) throw new Error('GitHub blob exceeds size limit');
    return data;
  }
  async readMediaByHash(hash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error('Invalid image hash');
    return Buffer.from(await this.blob(hash, 8 * 1024 * 1024));
  }
  private copyState(state: LoadedState): LoadedState {
    return { ...state, entries: structuredClone(state.entries), files: new Map(state.files), parsed: structuredClone(state.parsed) };
  }
  private async load(fast = false): Promise<LoadedState> {
    const head = await this.currentRevision(); const key = `${head}:${fast}`;
    if (this.cachedState?.key === key) return this.copyState(this.cachedState.state);
    let pending = this.pendingStates.get(key);
    if (!pending) {
      pending = this.loadHead(head,fast).then(state => {
        // At most one 32 MiB decoded state plus a 64 MiB immutable blob LRU.
        const size = Buffer.byteLength(JSON.stringify(state.parsed)) + [...state.files.values()].reduce((sum,b)=>sum+b.length,0);
        if (size <= 32 * 1024 * 1024) this.cachedState = {key,state};
        else this.cachedState = undefined;
        return state;
      }).finally(() => this.pendingStates.delete(key));
      this.pendingStates.set(key,pending);
    }
    return this.copyState(await pending);
  }
  constructor(
    private owner: string,
    private repo: string,
    private token: string,
    private branch = 'main',
  ) {}
  private async api(route: string, method = 'GET', body?: unknown, maxBytes?: number): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${route}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: 'no-store',
          signal: AbortSignal.timeout(30000),
        },
      );
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has('retry-after') ||
            response.headers.get('x-ratelimit-remaining') === '0'))
      ) {
        const raw = response.headers.get('retry-after');
        const seconds = raw === null ? 1 : Number(raw);
        const delay = Number.isFinite(seconds)
          ? Math.max(0, seconds * 1000)
          : Math.max(0, Date.parse(raw!) - Date.now());
        if (attempt < 2 && delay <= 5000) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw Object.assign(
          new Error(
            'GitHub rate limit reached; pending changes are safe. Retry after the server limit resets.',
          ),
          { status: response.status, rateLimited: true },
        );
      }
      if (!response.ok)
        throw Object.assign(
          new Error(
            `GitHub request failed (${response.status}); verify credentials, branch, and rate limits`,
          ),
          { status: response.status },
        );
      if (!maxBytes) return response.json();
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('GitHub response exceeds size limit'); }
      const reader = response.body?.getReader(); if (!reader) throw new Error('Empty GitHub response');
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) { const {done,value} = await reader.read(); if(done)break; bytes += value.length; if(bytes > maxBytes) { await reader.cancel(); throw new Error('GitHub response exceeds size limit'); } chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString());
    }
    throw new Error('GitHub retries exhausted');
  }
  private async loadHead(head: string, fast: boolean): Promise<LoadedState> {
    const commit = await this.api(`/git/commits/${head}`);
    const tree = await this.api(`/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated)
      throw new Error('Repository tree is too large; refusing an incomplete library');
    const entries = tree.tree.filter((e: any) => e.type === 'blob');
    const files: Files = new Map();
    // Bounded concurrency protects the API and memory; images are fetched only on demand.
    const snapshotEntry = entries.find((e: any) => e.path === '.gitdrop/index/snapshot.json');
    if (fast && snapshotEntry) {
      const blob = await this.blob(snapshotEntry.sha);
      try {
        const snapshot = JSON.parse(blob.toString());
        const current = entries.filter(
          (e: any) => e.path.endsWith('.json') && !e.path.startsWith('.gitdrop/index/'),
        );
        if (
          current.length === Object.keys(snapshot.sourceHashes).length &&
          current.every((e: any) => snapshot.sourceHashes[e.path] === e.sha)
        ) {
          if (snapshot.shards) {
            let index = 0;
            await Promise.all(
              Array.from({ length: 6 }, async () => {
                while (index < snapshot.shards.length) {
                  const name = snapshot.shards[index++];
                  const entry = entries.find((e: any) => e.path === name);
                  if (!entry || snapshot.shardHashes?.[name] !== entry.sha)
                    throw new Error('Missing or stale snapshot shard');
                  const blob = await this.blob(entry.sha);
                  for (const item of JSON.parse(blob.toString()))
                    snapshot.library.records[item.id] = item;
                }
              }),
            );
          }
          const library = validateLibrary(snapshot.library);
          const files = encodeFiles(library, new Map(), snapshot.paths);
          return {
            head,
            tree: commit.tree.sha,
            entries,
            files,
            parsed: { library, paths: snapshot.paths, diagnostics: [] as string[] },
          };
        }
      } catch {
        /* stale or invalid snapshot: read canonical files */
      }
    }
    const sources = entries.filter((e: any) => e.path.endsWith('.json'));
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (cursor < sources.length) {
          const entry = sources[cursor++];
          if (!safePath(entry.path) || entry.mode === '120000')
            throw new Error('Unsupported repository path');
          const blob = await this.blob(entry.sha);
          files.set(entry.path, blob);
        }
      }),
    );
    const parsed = decodeFiles(files, 'external-github');
    return { head, tree: commit.tree.sha, entries, files, parsed };
  }
  async read(): Promise<Snapshot> {
    const state = await this.load(true);
    return {
      library: state.parsed.library,
      diagnostics: state.parsed.diagnostics,
      revision: state.head,
      status: 'Synced',
    };
  }
  private async write(
    change: (state: Awaited<ReturnType<GitHubStore['load']>>) => Promise<Files>,
  ): Promise<Snapshot> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await this.load(true);
      if (state.parsed.diagnostics.length) throw new Error(state.parsed.diagnostics.join('\n'));
      const next = await change(state);
      const entries: any[] = [];
      for (const [file, data] of next) {
        if (state.files.get(file)?.equals(data)) continue;
        const existing = state.entries.find((e: any) => e.path === file);
        if (existing?.sha === gitBlobHash(data)) continue;
        const reused = parseMediaReference(data);
        if (reused && existing?.sha === reused.sha) continue;
        const blob = reused
          ? { sha: reused.sha }
          : await this.api('/git/blobs', 'POST', {
              content: data.toString('base64'),
              encoding: 'base64',
            });
        entries.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
      }
      for (const file of new Set([
        ...state.files.keys(),
        ...state.entries
          .filter((e: any) => e.path.startsWith('.gitdrop/media/'))
          .map((e: any) => e.path),
        ...Object.values(state.parsed.paths as Record<string, string>)
          .map((p) => p.replace(/\.json$/, '.webp'))
          .filter((p) => state.entries.some((e: any) => e.path === p)),
      ]))
        if (!next.has(file)) entries.push({ path: file, mode: '100644', type: 'blob', sha: null });
      if (!entries.length)
        return {
          library: state.parsed.library,
          diagnostics: [],
          revision: state.head,
          status: 'Synced',
        };
      const tree = await this.api('/git/trees', 'POST', { base_tree: state.tree, tree: entries });
      const commit = await this.api('/git/commits', 'POST', {
        message: 'Update bookmark library',
        tree: tree.sha,
        parents: [state.head],
      });
      try {
        await this.api(`/git/refs/heads/${encodeURIComponent(this.branch)}`, 'PATCH', {
          sha: commit.sha,
          force: false,
        });
        return await this.read();
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (attempt === 3 || (status !== undefined && ![409, 422].includes(status))) throw error;
      }
    }
    throw new Error('GitHub publication failed; retry pending changes');
  }
  async mutate(operation: Operation) {
    return this.write(async (state) =>
      encodeFiles(
        applyIntent(state.parsed.library, operation),
        await this.mediaFiles(state),
        state.parsed.paths,
      ),
    );
  }
  async sync() {
    return this.read();
  }
  private async mediaFiles(state: Awaited<ReturnType<GitHubStore['load']>>, download = false) {
    const files = new Map(state.files);
    for (const entry of state.entries.filter((e: any) => e.path.endsWith('.webp'))) {
      if (download) {
        const blob = await this.blob(entry.sha);
        files.set(entry.path, blob);
      } else
        files.set(
          entry.path,
          mediaReference({ sha: entry.sha, source: 'git', location: entry.sha }),
        );
    }
    return files;
  }
  async readMedia(id: string) {
    const state = await this.load(true);
    const item = state.parsed.library.records[id] ?? state.parsed.library.tombstones[id]?.record;
    const filename = state.parsed.paths[id]
      ? path.posix.join(path.posix.dirname(state.parsed.paths[id]), item?.cover.imageFile || '')
      : `.gitdrop/media/${id}.webp`;
    const entry = state.entries.find((e: any) => e.path === filename);
    if (!entry) return null;
    return this.readMediaByHash(entry.sha);
  }
  async writeMedia(id: string, data: Buffer, mode: 'automatic' | 'image' = 'image') {
    return this.write(async (state) => {
      const item = state.parsed.library.records[id];
      if (!item) throw new Error('Record not found');
      if (mode === 'automatic' && item.cover.mode !== 'automatic') return state.files;
      const file = state.parsed.paths[id].replace(/\.json$/, '.webp');
      const files = await this.mediaFiles(state);
      const old = files.get(file);
      if (old) files.set(`.gitdrop/media/by-hash/${mediaHash(old)}.webp`, old);
      files.set(file, data);
      const library = applyOperation(state.parsed.library, {
        id: randomUUID(),
        actor: 'hosted',
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
      return encodeFiles(library, files, state.parsed.paths);
    });
  }
  async *exportEntries(): AsyncGenerator<{ name: string; data: Buffer }> {
    const state = await this.load(true);
    // The tree pins an immutable snapshot even if another client publishes meanwhile.
    for (const entry of state.entries) {
      if (!safePath(entry.path) || entry.mode === '120000')
        throw new Error('Unsupported repository path');
      const cached = state.files.get(entry.path);
      if (cached && gitBlobHash(cached) === entry.sha) {
        yield { name: entry.path, data: cached };
        continue;
      }
      const blob = await this.blob(entry.sha);
      yield { name: entry.path, data: blob };
    }
  }
  async exportFiles() {
    const files: Record<string, Buffer> = {};
    for await (const entry of this.exportEntries()) files[entry.name] = entry.data;
    return files;
  }
}
