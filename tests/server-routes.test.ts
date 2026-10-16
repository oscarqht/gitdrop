import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    expect(updated.variants[0].name).toBe('Default');
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
    expect(media.headers.get('cache-control')).toContain('private');
    expect(store.readMediaByHash).toHaveBeenCalledWith(head);
    const invalid = await mediaGet(
      new Request('https://library.example/api/media?recordId=book&hash=bad', { headers }),
    );
    expect(invalid.status).toBe(400);
  });
});
