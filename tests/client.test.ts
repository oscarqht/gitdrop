import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import {
  canReachServer,
  authorOperation,
  acknowledge,
  readCache,
  writeCache,
  clearCache,
  replay,
  confirmedStatus,
  type Snapshot,
} from '../src/client/store';
import { makeItem, createLibrary } from '../src/domain/operations';

describe('browser snapshots', () => {
  it('keeps pending edits over a refreshed snapshot and does not mutate confirmed data', () => {
    const item = makeItem('bookmark', { title: 'Shared title', url: 'https://example.com' });
    const snapshot: Snapshot = {
      mode: 'github',
      revision: 'remote',
      library: { ...createLibrary(), records: { [item.id]: item } },
    };
    const optimistic = replay(snapshot, [
      {
        id: 'pending',
        actor: 'browser',
        type: 'update',
        recordId: item.id,
        base: item,
        patch: { title: 'My pending title' },
      },
    ]);
    expect(optimistic.library.records[item.id].title).toBe('My pending title');
    expect(snapshot.library.records[item.id].title).toBe('Shared title');
    expect(optimistic.library.records[item.id].variants![0].name).toBe('Default');
  });
  it('scopes persisted snapshots and clears private data', async () => {
    const snapshot: Snapshot = { mode: 'github', revision: 'a', library: createLibrary() };
    await writeCache('one', { snapshot, pending: [] });
    expect((await readCache('one'))?.snapshot.revision).toBe('a');
    expect(await readCache('two')).toBeUndefined();
    await clearCache('one');
    expect(await readCache('one')).toBeUndefined();
  });
  it('does not describe an unpushed desktop save as synced', () => {
    const snapshot: Snapshot = { mode: 'local', revision: 'a', library: createLibrary() };
    expect(confirmedStatus(snapshot)).toBe('Saved locally');
    expect(confirmedStatus({ ...snapshot, syncStatus: 'synced' })).toBe('Synced');
    expect(confirmedStatus({ ...snapshot, mode: 'github' })).toBe('Synced');
  });
});

it('acknowledges only the response operation, preserving edits queued in flight', () => {
  const snapshot: Snapshot = { mode: 'github', revision: 'remote', library: createLibrary() };
  const cache = {
    snapshot,
    pending: [
      { id: 'first', actor: 'a', type: 'clearRecovery' as const, recordId: 'x' },
      { id: 'second', actor: 'a', type: 'clearRecovery' as const, recordId: 'y' },
    ],
  };
  const next = acknowledge(cache, { ...snapshot, revision: 'published' }, 'first');
  expect(next.pending.map((op) => op.id)).toEqual(['second']);
  expect(acknowledge(next, next.snapshot, 'first').pending).toEqual(next.pending);
  expect(cache.pending).toHaveLength(2);
});

it('captures a collection deletion subtree before a remote child arrives', () => {
  const folder = makeItem('collection', { title: 'Folder' });
  const child = makeItem('bookmark', {
    title: 'Original',
    url: 'https://original.example',
    parentId: folder.id,
  });
  const snapshot: Snapshot = {
    mode: 'github',
    revision: 'old',
    library: { ...createLibrary(), records: { [folder.id]: folder, [child.id]: child } },
  };
  const operation = authorOperation(snapshot, [], {
    id: 'delete',
    actor: 'browser',
    type: 'delete',
    recordId: folder.id,
  });
  const added = makeItem('bookmark', {
    title: 'Concurrent',
    url: 'https://concurrent.example',
    parentId: folder.id,
  });
  snapshot.library.records[added.id] = added;
  expect(operation.baseRecords?.map((record) => record.id)).toContain(child.id);
  expect(operation.baseRecords?.map((record) => record.id)).not.toContain(added.id);
  expect(authorOperation(snapshot, [], operation).baseRecords).toEqual(operation.baseRecords);
});

it('permits localhost saves when wifi is offline but blocks hosted writes', () => {
  expect(canReachServer('local', false)).toBe(true);
  expect(canReachServer('github', false)).toBe(false);
  expect(canReachServer('github', true)).toBe(true);
});
