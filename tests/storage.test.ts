import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LocalStore } from '../src/storage/local';
import { makeItem, createLibrary } from '../src/domain/operations';
import { decodeFiles, encodeFiles } from '../src/storage/codec';
const git = (directory: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
describe('file storage', () => {
  it('round trips named variants and an image beside a bookmark', () => {
    const library = createLibrary();
    const item = makeItem('bookmark', { title: 'Example', url: 'https://example.com' });
    library.records[item.id] = item;
    const decoded = decodeFiles(encodeFiles(library));
    expect(decoded.diagnostics).toEqual([]);
    expect(decoded.library.records[item.id].variants?.[0].name).toBe('Default');
  });
  it('preserves malformed external files and rejects writes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-'));
    try {
      const store = new LocalStore(dir);
      await store.initialize();
      await fs.writeFile(path.join(dir, 'broken.json'), '{');
      expect((await store.read()).diagnostics.length).toBe(1);
      await expect(
        store.mutate({
          id: 'x',
          actor: 'test',
          type: 'create',
          record: makeItem('bookmark', { title: 'Example', url: 'https://example.com' }),
        }),
      ).rejects.toThrow();
      expect(await fs.readFile(path.join(dir, 'broken.json'), 'utf8')).toBe('{');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it('rejects symlink traversal from a replay journal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-guard-'));
    try {
      const dir = path.join(root, 'library');
      const outside = path.join(root, 'outside');
      await fs.mkdir(dir);
      await fs.mkdir(outside);
      await fs.symlink(outside, path.join(dir, 'linked'));
      await fs.writeFile(
        path.join(dir, '.gitdrop-transaction.json'),
        JSON.stringify({
          writes: [['linked/secret', Buffer.from('bad').toString('base64')]],
          deletes: [],
        }),
      );
      await expect(new LocalStore(dir).read()).rejects.toThrow('Symlink');
      await expect(fs.stat(path.join(outside, 'secret'))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('merges edits from independent offline checkouts without losing fields', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-sync-'));
    try {
      const remote = path.join(root, 'remote.git');
      await fs.mkdir(remote);
      git(remote, 'init', '--bare', '--initial-branch=main');
      const a = path.join(root, 'a');
      const storeA = new LocalStore(a);
      await storeA.initialize();
      await storeA.sync();
      expect(git(a, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('.gitdrop-lock');
      git(a, 'remote', 'add', 'origin', remote);
      git(a, 'push', '-u', 'origin', 'main');
      const item = makeItem('bookmark', {
        title: 'Original',
        url: 'https://example.com',
        parentId: 'inbox',
      });
      await storeA.mutate({ id: 'create', actor: 'a', type: 'create', record: item });
      await storeA.sync();
      const b = path.join(root, 'b');
      git(root, 'clone', remote, b);
      const storeB = new LocalStore(b);
      await storeA.mutate({
        id: 'a-edit',
        actor: 'a',
        type: 'update',
        recordId: item.id,
        patch: { title: 'Edited title' },
      });
      await storeB.mutate({
        id: 'b-edit',
        actor: 'b',
        type: 'update',
        recordId: item.id,
        patch: { note: 'Offline note' },
      });
      await storeA.sync();
      await storeB.sync();
      await storeA.sync();
      const result = (await storeA.read()).library.records[item.id];
      expect(result.title).toBe('Edited title');
      expect(result.note).toBe('Offline note');
      expect((await storeB.read()).library.records[item.id]).toEqual(result);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30000);
});

it('converges concurrent cover replacements and keeps the losing bytes recoverable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-media-'));
  try {
    const remote = path.join(root, 'remote.git');
    await fs.mkdir(remote);
    git(remote, 'init', '--bare', '--initial-branch=main');
    const a = path.join(root, 'a');
    const sa = new LocalStore(a);
    await sa.initialize();
    await sa.sync();
    git(a, 'remote', 'add', 'origin', remote);
    await sa.sync();
    const item = makeItem('bookmark', {
      title: 'Image',
      url: 'https://example.com',
      parentId: 'inbox',
    });
    await sa.mutate({ id: 'create', actor: 'a', type: 'create', record: item });
    await sa.sync();
    const b = path.join(root, 'b');
    git(root, 'clone', remote, b);
    const sb = new LocalStore(b);
    const first = Buffer.from('first-cover');
    const second = Buffer.from('second-cover');
    await sa.writeMedia(item.id, first);
    await sb.writeMedia(item.id, second);
    await sa.sync();
    await sb.sync();
    await sa.sync();
    expect(await sa.readMedia(item.id)).toEqual(await sb.readMedia(item.id));
    const snapshot = await sa.read();
    expect(Object.values(snapshot.library.recovery).some((r) => r.record.cover.imageHash)).toBe(
      true,
    );
    const exported = await sa.exportFiles();
    const selected = await sa.readMedia(item.id);
    const losing = selected?.equals(first) ? second : first;
    expect(
      Object.entries(exported).some(([p, data]) => p.includes('/by-hash/') && data.equals(losing)),
    ).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30000);

it('rescues a child added after a browser collection deletion snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-delete-'));
  try {
    const store = new LocalStore(dir);
    await store.initialize();
    const folder = makeItem('collection', { title: 'Folder' });
    await store.mutate({ id: 'folder', actor: 'a', type: 'create', record: folder });
    const before = (await store.read()).library.records[folder.id];
    const child = makeItem('bookmark', {
      title: 'New child',
      url: 'https://example.com',
      parentId: folder.id,
    });
    await store.mutate({ id: 'child', actor: 'b', type: 'create', record: child });
    const result = await store.mutate({
      id: 'delete',
      actor: 'a',
      type: 'delete',
      recordId: folder.id,
      base: before,
      baseRecords: [before],
    });
    expect(result.library.records[folder.id]).toBeUndefined();
    expect(result.library.records[child.id]).toBeDefined();
    expect(result.library.records[child.id].parentId).not.toBe(folder.id);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('does not buffer cover contents while loading a local snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-lazy-'));
  try {
    const store = new LocalStore(dir);
    await store.initialize();
    const item = makeItem('bookmark', { title: 'Cover', url: 'https://example.com' });
    await store.mutate({ id: 'create', actor: 'a', type: 'create', record: item });
    await store.writeMedia(item.id, Buffer.alloc(500000, 2));
    const { vi } = await import('vitest');
    const spy = vi.spyOn(fs, 'readFile');
    try {
      await store.read();
      expect(spy.mock.calls.some(([file]) => String(file).endsWith('.webp'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('turns a manually removed JSON file into a durable tombstone', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-unlink-'));
  try {
    const store = new LocalStore(dir);
    await store.initialize();
    const item = makeItem('bookmark', { title: 'Remove', url: 'https://example.com' });
    await store.mutate({ id: 'create', actor: 'a', type: 'create', record: item });
    const files = await store.exportFiles();
    const source = Object.entries(files).find(
      ([p, b]) =>
        !p.startsWith('.') && p.endsWith('.json') && JSON.parse(b.toString()).id === item.id,
    )![0];
    await fs.unlink(path.join(dir, source));
    expect((await store.read()).library.tombstones[item.id]?.record?.title).toBe('Remove');
    await store.sync();
    expect((await store.read()).library.records[item.id]).toBeUndefined();
    expect((await store.read()).library.tombstones[item.id]).toBeDefined();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('streams export entries and releases the library lock when cancelled', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-export-'));
  try {
    const store = new LocalStore(dir);
    await store.initialize();
    const item = makeItem('bookmark', { title: 'Export', url: 'https://example.com' });
    await store.mutate({ id: 'create', actor: 'a', type: 'create', record: item });
    await store.writeMedia(item.id, Buffer.alloc(500000, 3));
    const { vi } = await import('vitest');
    const spy = vi.spyOn(fs, 'readFile');
    const iterator = store.exportEntries();
    try {
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(spy.mock.calls.some(([file]) => String(file).endsWith('.webp'))).toBe(false);
      await expect(fs.stat(path.join(dir, '.gitdrop-lock'))).resolves.toBeDefined();
    } finally {
      await iterator.return(undefined);
      spy.mockRestore();
    }
    await expect(fs.stat(path.join(dir, '.gitdrop-lock'))).rejects.toThrow();
    expect((await store.read()).library.records[item.id]).toBeDefined();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('preserves external deletions independently of disposable indexes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-indexless-'));
  try {
    const store = new LocalStore(dir);
    await store.initialize();
    const item = makeItem('bookmark', {
      title: 'Delete without index',
      url: 'https://example.com',
    });
    await store.mutate({ id: 'create', actor: 'a', type: 'create', record: item });
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, '.gitdrop/manifest.json'), 'utf8'),
    );
    await fs.unlink(path.join(dir, manifest[item.id].path));
    await fs.rm(path.join(dir, '.gitdrop/index'), { recursive: true });
    expect((await store.read()).library.tombstones[item.id]?.record?.title).toBe(item.title);
    await store.sync();
    expect((await store.read()).library.tombstones[item.id]).toBeDefined();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it('adopts manually created empty folders as collections', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-empty-'));
  try {
    const store = new LocalStore(dir);
    await store.initialize();
    await fs.mkdir(path.join(dir, 'Empty', 'Nested'), { recursive: true });
    const snapshot = await store.read();
    expect(
      Object.values(snapshot.library.records).filter((i) => ['Empty', 'Nested'].includes(i.title)),
    ).toHaveLength(2);
    await store.sync();
    expect(await fs.readFile(path.join(dir, 'Empty', '_collection.json'), 'utf8')).toContain(
      'Empty',
    );
    expect(
      await fs.readFile(path.join(dir, 'Empty', 'Nested', '_collection.json'), 'utf8'),
    ).toContain('Nested');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('preserves unknown images and diagnoses missing control state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-control-'));
  try {
    const store = new LocalStore(dir);
    await store.initialize();
    await fs.writeFile(path.join(dir, 'unrelated.webp'), Buffer.from('user image'));
    await store.sync();
    expect(await fs.readFile(path.join(dir, 'unrelated.webp'), 'utf8')).toBe('user image');
    await fs.unlink(path.join(dir, '.gitdrop/state.json'));
    expect((await store.read()).diagnostics.join()).toContain('Missing .gitdrop/state.json');
    await expect(store.sync()).rejects.toThrow('Missing');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('does not rewrite identical covers when internal media references use different paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-same-cover-'));
  try {
    const store = new LocalStore(dir);
    await store.initialize();
    const items = [
      makeItem('bookmark', { title: 'First', url: 'https://example.com/a' }),
      makeItem('bookmark', { title: 'Second', url: 'https://example.com/b' }),
    ];
    for (const item of items) {
      await store.mutate({ id: `create-${item.id}`, actor: 'a', type: 'create', record: item });
      await store.writeMedia(item.id, Buffer.from('same-cover'));
    }
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, '.gitdrop/manifest.json'), 'utf8'),
    );
    const image = path.join(dir, manifest[items[0].id].path.replace(/\.json$/, '.webp'));
    const before = await fs.stat(image);
    await store.mutate({
      id: 'note',
      actor: 'a',
      type: 'update',
      recordId: items[0].id,
      patch: { note: 'Only metadata' },
    });
    expect((await fs.stat(image)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('rejects absent control files and malformed manifest shapes', () => {
  const library = createLibrary();
  const item = makeItem('bookmark', { title: 'Managed', url: 'https://example.com' });
  library.records[item.id] = item;
  const files = encodeFiles(library);
  files.delete('.gitdrop/state.json');
  files.delete('.gitdrop/manifest.json');
  expect(decodeFiles(files).diagnostics.join()).toContain('Missing Gitdrop control files');
  const valid = encodeFiles(library);
  valid.set('.gitdrop/manifest.json', Buffer.from('[]'));
  expect(decodeFiles(valid).diagnostics.join()).toContain('Invalid source manifest');
  valid.set(
    '.gitdrop/manifest.json',
    Buffer.from(JSON.stringify({ bad: { hash: 'a'.repeat(64), path: '../outside.json' } })),
  );
  expect(decodeFiles(valid).diagnostics.join()).toContain('Invalid source manifest');
});
