import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import { LocalStore } from '../src/storage/local';
import { makeItem } from '../src/domain/operations';
const shared = vi.hoisted(() => ({ store: null as any }));
vi.mock('../src/storage', async (original) => ({
  ...(await original<any>()),
  getStore: () => shared.store,
}));
vi.mock('../src/server/metadata', async (original) => ({
  ...(await original<any>()),
  fetchCover: vi.fn(async () => {
    throw new Error('No direct cover');
  }),
  fetchMetadata: vi.fn(async () => ({
    title: 'Fetched title',
    description: 'Fetched description',
  })),
}));
import {
  libraryGet,
  operationPost,
  metadataPost,
  mediaPost,
  mediaGet,
  exportGet,
  sessionGet,
  syncPost,
  repositoryGet,
  repositoryPost,
} from '../src/server/routes';
const request = (route: string, body?: unknown) =>
  new Request(
    `http://127.0.0.1:3000/api/${route}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
let directory: string;
beforeEach(async () => {
  vi.stubEnv('GITDROP_MODE', 'local');
  vi.stubEnv('GITDROP_DISABLE_AUTO_SYNC', '1');
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-routes-'));
  shared.store = new LocalStore(directory);
  await shared.store.initialize();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});
async function create() {
  const record = makeItem('bookmark', {
    id: 'book',
    title: 'example.com',
    url: 'https://example.com',
    parentId: 'inbox',
  });
  const response = await operationPost(
    request('operations', { id: 'create', actor: 'browser', type: 'create', record }),
  );
  expect(response.status).toBe(200);
  return (await response.json()).library.records.book;
}
describe('application API', () => {
  it('boots an Inbox and returns a scoped session', async () => {
    const data = await (await libraryGet(request('library'))).json();
    expect(data.library.records.inbox.title).toBe('Inbox');
    expect(data.mode).toBe('local');
    expect((await (await sessionGet(request('session'))).json()).authenticated).toBe(true);
  });
  it('persists named variants independently of shared title and exports every URL', async () => {
    const record = await create();
    const variants = [
      ...record.variants,
      { id: 'docs', name: 'Documentation', url: 'https://example.com/docs', order: 'a1' },
    ];
    const result = await operationPost(
      request('operations', {
        id: 'variant',
        actor: 'browser',
        type: 'update',
        recordId: 'book',
        base: record,
        patch: { variants, defaultVariantId: 'docs', title: 'Shared title' },
      }),
    );
    expect(result.status).toBe(200);
    const updated = (await result.json()).library.records.book;
    expect(updated.variants.find((variant: { id: string }) => variant.id === record.variants[0].id)?.name).toBe('Default');
    expect(updated.title).toBe('Shared title');
    const html = await (await exportGet(request('export?format=html'))).text();
    expect(html).toContain('Shared title — Documentation');
    expect(html).toContain('https://example.com/docs');
    const zipResponse = await exportGet(request('export?format=zip'));
    const zip = new AdmZip(Buffer.from(await zipResponse.arrayBuffer()));
    expect(zip.getEntries().some((e) => e.entryName.endsWith('book.json'))).toBe(true);
  });
  it('metadata never changes URL names or a custom bookmark title', async () => {
    const record = await create();
    let result = await metadataPost(request('metadata', { recordId: 'book' }));
    expect(result.status).toBe(200);
    let item = (await result.json()).library.records.book;
    expect(item.title).toBe('Fetched title');
    expect(item.variants[0].name).toBe('Default');
    await operationPost(
      request('operations', {
        id: 'custom',
        actor: 'browser',
        type: 'update',
        recordId: 'book',
        patch: { title: 'My title' },
      }),
    );
    result = await metadataPost(request('metadata', { recordId: 'book' }));
    item = (await result.json()).library.records.book;
    expect(item.title).toBe('My title');
  });
  it('fetches cover thumbnail for imported bookmark via coverUrl or falls back to page metadata', async () => {
    const { fetchCover, fetchMetadata } = await import('../src/server/metadata');
    const coverBytes = await sharp({
      create: { width: 20, height: 20, channels: 3, background: 'blue' },
    })
      .webp()
      .toBuffer();
    vi.mocked(fetchCover).mockResolvedValueOnce(coverBytes);

    const record = makeItem('bookmark', {
      id: 'imported-bm',
      title: 'Imported Title',
      url: 'https://example.com/article',
      parentId: 'inbox',
    });
    await operationPost(
      request('operations', { id: 'import-op', actor: 'browser', type: 'create', records: [record] }),
    );

    const res = await metadataPost(
      request('metadata', {
        recordId: 'imported-bm',
        coverUrl: 'https://up.raindrop.io/raindrop/thumbs/1.jpg',
      }),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()).library.records['imported-bm'];
    expect(updated.title).toBe('Imported Title');
    expect(updated.cover.mode).toBe('automatic');
    expect(updated.cover.imageFile).toBeTruthy();
    expect(fetchCover).toHaveBeenCalledWith('https://up.raindrop.io/raindrop/thumbs/1.jpg');

    const mediaRes = await mediaGet(request('media?recordId=imported-bm'));
    expect(mediaRes.status).toBe(200);
    expect((await mediaRes.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // When fetchCover fails, falls back to fetchMetadata
    vi.mocked(fetchCover).mockRejectedValueOnce(new Error('404'));
    vi.mocked(fetchMetadata).mockResolvedValueOnce({
      title: 'Page OG Title',
      description: 'Page OG Description',
      cover: coverBytes,
      warning: undefined,
    });
    const fallbackRes = await metadataPost(
      request('metadata', {
        recordId: 'imported-bm',
        coverUrl: 'https://up.raindrop.io/raindrop/thumbs/missing.jpg',
      }),
    );
    expect(fallbackRes.status).toBe(200);
    expect(fetchMetadata).toHaveBeenCalledWith('https://example.com/article');
  });
  it('accepts cover uploads and serves optimized bytes', async () => {
    await create();
    const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set('recordId', 'book');
    form.set('file', new Blob([new Uint8Array(image)]), 'cover.png');
    const saved = await mediaPost(
      new Request('http://127.0.0.1:3000/api/media', {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:3000' },
        body: form,
      }),
    );
    expect(saved.status).toBe(200);
    const response = await mediaGet(request('media?recordId=book'));
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
  it('rejects cross-site writes, path-shaped IDs, empty variants and malformed bodies', async () => {
    await create();
    expect(
      (
        await operationPost(
          new Request('http://127.0.0.1:3000/api/operations', { method: 'POST', body: '{}' }),
        )
      ).status,
    ).toBe(403);
    for (const patch of [
      { variants: [] },
      { variants: [{ id: '../bad', name: 'x', url: 'https://example.com', order: 'a0' }] },
      { cover: { mode: 'emoji', emoji: 'abc' } },
    ])
      expect(
        (
          await operationPost(
            request('operations', {
              id: 'bad',
              actor: 'browser',
              type: 'update',
              recordId: 'book',
              patch,
            }),
          )
        ).status,
      ).toBe(400);
    expect((await mediaGet(request('media?recordId=..%2Fsecret'))).status).toBe(400);
  });
  it('keeps local saves usable without a configured remote', async () => {
    await create();
    const response = await syncPost(request('sync', {}));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toContain('Local only');
  });
});

describe('hosted conditional reads', () => {
  it('returns unchanged after one head lookup and fetches a cover directly by hash', async () => {
    const { GitHubStore } = await import('../src/storage/github');
    const { sign } = await import('../src/server/auth');
    vi.stubEnv('GITDROP_MODE', 'github');
    vi.stubEnv('GITDROP_APP_URL', 'https://library.example');
    vi.stubEnv('GITDROP_GITHUB_USER', 'owner');
    vi.stubEnv('GITDROP_SESSION_SECRET', 'x'.repeat(40));
    const store = new GitHubStore('owner', 'repo', 'token');
    shared.store = store;
    const head = 'a'.repeat(40);
    const read = vi.spyOn(store, 'read');
    vi.spyOn(store, 'currentRevision').mockResolvedValue(head);
    vi.spyOn(store, 'readMediaByHash').mockResolvedValue(Buffer.from('image'));
    const headers = {
      cookie: `gitdrop-session=${sign({ user: 'owner', purpose: 'session', exp: Date.now() + 10000 })}`,
    };
    const unchanged = await libraryGet(
      new Request(`https://library.example/api/library?revision=${head}`, { headers }),
    );
    expect((await unchanged.json()).unchanged).toBe(true);
    expect(read).not.toHaveBeenCalled();
    const media = await mediaGet(
      new Request(`https://library.example/api/media?recordId=book&hash=${head}`, { headers }),
    );
    expect(await media.text()).toBe('image');
    expect(media.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(store.readMediaByHash).toHaveBeenCalledWith(head);
    const invalid = await mediaGet(
      new Request('https://library.example/api/media?recordId=book&hash=bad', { headers }),
    );
    expect(invalid.status).toBe(400);
  });
});

describe('web repository setup', () => {
  const url = 'https://example.test/library.git';
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  async function remote() {
    const location = path.join(directory, 'remote.git');
    await fs.mkdir(location);
    git(location, 'init', '--bare', '--initial-branch=main');
    const credentialFile = path.join(directory, '.git-credentials').split(path.sep).join('/');
    // Exercise real Git operations and isolated credential storage without touching external services or OS keychains.
    vi.stubEnv('GIT_CONFIG_COUNT', '3');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.file://${location}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', url);
    vi.stubEnv('GIT_CONFIG_KEY_1', 'credential.helper');
    vi.stubEnv('GIT_CONFIG_VALUE_1', '');
    vi.stubEnv('GIT_CONFIG_KEY_2', 'credential.helper');
    vi.stubEnv('GIT_CONFIG_VALUE_2', `store --file=${credentialFile}`);
    shared.store = new LocalStore(path.join(directory, 'library'));
    await shared.store.initialize();
    return location;
  }
  it('initializes, publishes, remembers the URL after restart, and connects another device', async () => {
    const location = await remote();
    expect(await (await repositoryGet(request('repository'))).json()).toEqual({
      url: null,
      branch: 'main',
    });
    await create();
    const connected = await repositoryPost(request('repository', { url }));
    expect(connected.status).toBe(200);
    expect((await connected.json()).library.records.book.title).toBe('example.com');
    expect(git(location, 'ls-tree', '-r', '--name-only', 'main')).toContain('.gitdrop/state.json');
    shared.store = new LocalStore(path.join(directory, 'library'));
    expect(await (await repositoryGet(request('repository'))).json()).toEqual({
      url,
      branch: 'main',
    });
    expect((await syncPost(request('sync', {}))).status).toBe(200);
    shared.store = new LocalStore(path.join(directory, 'second-device'));
    await shared.store.initialize();
    await shared.store.mutate({
      id: 'local',
      actor: 'second',
      type: 'create',
      record: makeItem('bookmark', {
        id: 'local-book',
        title: 'Local bookmark',
        url: 'https://local.example',
      }),
    });
    const second = await repositoryPost(request('repository', { url }));
    expect(second.status).toBe(200);
    const library = (await second.json()).library;
    expect(library.records.book.title).toBe('example.com');
    expect(library.records['local-book'].title).toBe('Local bookmark');
    expect((await shared.store.read()).diagnostics).toEqual([]);
    expect(await new LocalStore(path.join(directory, 'library')).sync()).toMatchObject({
      status: 'Synced',
    });
  });
  it('saves and remembers a GitHub PAT via git credential without storing secrets in .git/config or touching github.com credentials', async () => {
    const location = await remote();
    await create();
    const token = 'github_pat_secretToken123';
    const connected = await repositoryPost(request('repository', { url, token }));
    expect(connected.status).toBe(200);
    // Recreate store to verify server persistence across restarts
    shared.store = new LocalStore(path.join(directory, 'library'));
    const info = await (await repositoryGet(request('repository'))).json();
    expect(info).toEqual({
      url,
      branch: 'main',
      hasToken: true,
    });
    expect(JSON.stringify(info)).not.toContain(token);
    const gitConfig = await fs.readFile(
      path.join(directory, 'library', '.git', 'config'),
      'utf8',
    );
    expect(gitConfig).not.toContain(token);
    expect(gitConfig).not.toContain('extraheader');
    expect(gitConfig).not.toContain('gitdrop.token');
    const savedCredentials = await fs.readFile(path.join(directory, '.git-credentials'), 'utf8');
    expect(savedCredentials).toContain('.gitdrop.local');
    expect(savedCredentials).not.toContain('github.com');
    // Subsequent updates without re-entering token preserve the remembered token
    const reconnected = await repositoryPost(request('repository', { url }));
    expect(reconnected.status).toBe(200);
    expect(await (await repositoryGet(request('repository'))).json()).toEqual({
      url,
      branch: 'main',
      hasToken: true,
    });
    expect(git(location, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('config');
  });
  it('keeps a saved URL and local edits when credentials or connectivity fail', async () => {
    await remote();
    await create();
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.file://${path.join(directory, 'missing.git')}.insteadOf`);
    const failed = await repositoryPost(request('repository', { url }));
    expect(failed.status).toBe(400);
    expect((await failed.json()).error).toContain('Check Git access');
    expect(await shared.store.repository()).toEqual({ url, branch: 'main' });
    expect((await shared.store.read()).library.records.book).toBeDefined();
  });
  it('rejects a non-Gitdrop repository without overwriting it', async () => {
    const location = await remote();
    const seed = path.join(directory, 'seed');
    await fs.mkdir(seed);
    git(seed, 'init', '-b', 'main');
    await fs.writeFile(path.join(seed, 'README.md'), 'Unrelated repository');
    git(seed, 'add', '.');
    git(seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Seed');
    git(seed, 'push', location, 'main');
    const head = git(location, 'rev-parse', 'main');
    const response = await repositoryPost(request('repository', { url }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Remote must be empty');
    expect(git(location, 'rev-parse', 'main')).toBe(head);
  });
  it('rejects invalid URLs, cross-origin writes, and hosted setup', async () => {
    for (const url of [
      '--upload-pack=evil',
      'ext::command',
      'file:///tmp/repo',
      'https://token@github.com/you/repo',
      'ssh://git:secret@host/repo',
      'git@host:repo\ncommand',
    ]) {
      expect((await repositoryPost(request('repository', { url }))).status).toBe(400);
    }
    expect((await shared.store.repository()).url).toBeNull();
    expect(
      (
        await repositoryPost(
          new Request('http://127.0.0.1:3000/api/repository', {
            method: 'POST',
            headers: { origin: 'https://evil.example' },
            body: JSON.stringify({ url }),
          }),
        )
      ).status,
    ).toBe(403);
    vi.stubEnv('GITDROP_MODE', 'github');
    vi.stubEnv('GITDROP_APP_URL', 'https://library.example');
    vi.stubEnv('GITDROP_SESSION_SECRET', 'x'.repeat(32));
    vi.stubEnv('GITDROP_GITHUB_USER', 'owner');
    const { sign } = await import('../src/server/auth');
    const headers = {
      origin: 'https://library.example',
      cookie: `gitdrop-session=${sign({ user: 'owner', purpose: 'session', exp: Date.now() + 10000 })}`,
    };
    expect(
      (
        await repositoryPost(
          new Request('https://library.example/api/repository', {
            method: 'POST',
            headers,
            body: JSON.stringify({ url }),
          }),
        )
      ).status,
    ).toBe(400);
  });
  it('returns authenticated session in hosted mode even when OAuth is not configured', async () => {
    vi.stubEnv('GITDROP_MODE', 'github');
    vi.stubEnv('GITDROP_APP_URL', 'https://library.example');
    vi.stubEnv('GITHUB_CLIENT_ID', '');
    const res = await sessionGet(new Request('https://library.example/api/session', {
      headers: {
        'x-github-repository': 'owner/bookmarks',
        'x-github-token': 'ghp_pat',
      },
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.authenticated).toBe(true);
    expect(data.configured).toBe(true);
    expect(data.repository).toBe('owner/bookmarks');
    expect(data.loginUrl).toBeNull();
  });
});

it('processes import covers independently and reports unavailable images without failing the batch', async () => {
  const { importCoversPost } = await import('../src/server/import-covers');
  const { fetchMetadata } = await import('../src/server/metadata');
  await create();
  vi.mocked(fetchMetadata).mockResolvedValueOnce({ title: 'Ignored', description: 'Ignored', cover: undefined, warning: undefined });
  const res = await importCoversPost(request('import-covers', { entries: [{ recordId: 'book' }, { recordId: 'gone' }] }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.coverOutcomes.map((e: any) => e.status)).toEqual(['unavailable', 'unavailable']);
  expect(body.library.records.book.title).toBe('example.com');
});

it('reports a failed cover, persists successful images, and does not download them again on retry', async () => {
  const { importCoversPost } = await import('../src/server/import-covers');
  const { fetchMetadata, fetchCover } = await import('../src/server/metadata');
  await create();
  vi.mocked(fetchMetadata).mockRejectedValueOnce(new Error('Network error'));
  let res = await importCoversPost(request('import-covers', { entries: [{ recordId: 'book' }] }));
  expect((await res.json()).coverOutcomes[0].status).toBe('failed');
  const data = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#abcdef' } }).webp().toBuffer();
  vi.mocked(fetchCover).mockResolvedValueOnce(data);
  res = await importCoversPost(request('import-covers', { entries: [{ recordId: 'book', coverUrl: 'https://cover.test/image' }] }));
  expect((await res.json()).coverOutcomes[0].status).toBe('fetched');
  expect((await shared.store.read()).library.records.book.cover.imageHash).toBeTruthy();
  const before = vi.mocked(fetchMetadata).mock.calls.length;
  res = await importCoversPost(request('import-covers', { entries: [{ recordId: 'book' }] }));
  expect((await res.json()).coverOutcomes[0].status).toBe('fetched');
  expect(vi.mocked(fetchMetadata).mock.calls.length).toBe(before);
});
