// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useLibrary } from '../src/client/use-library';
import { applyOperation, createLibrary, makeItem } from '../src/domain/operations';
import type { Operation } from '../src/domain/types';
import type { Cache, Snapshot } from '../src/client/store';
const memory = vi.hoisted(() => new Map<string, Cache>());
vi.mock('../src/client/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client/store')>()),
  readCache: async (scope: string) => structuredClone(memory.get(scope)),
  writeCache: async (scope: string, cache: Cache) => {
    memory.set(scope, structuredClone(cache));
  },
  clearCache: async (scope: string) => {
    memory.delete(scope);
  },
  actorId: () => 'browser-test',
}));
const response = (value: unknown, status = 200) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as Response);
let snapshot: Snapshot;
let online = true;
let scope = 'account/repo';
let operations: Operation[];
let rejectOnce = false;
let authenticated = true;
beforeEach(() => {
  memory.clear();
  localStorage.clear();
  online = true;
  scope = 'account/repo';
  operations = [];
  rejectOnce = false;
  authenticated = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  const bookmark = makeItem('bookmark', { title: 'Original', url: 'https://example.com' });
  snapshot = {
    mode: 'github',
    revision: 'initial',
    library: { ...createLibrary(), records: { [bookmark.id]: bookmark } },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/session') return response({ authenticated, scope, mode: snapshot.mode });
      if (url.startsWith('/api/library')) return response(structuredClone(snapshot));
      if (url === '/api/operations') {
        const operation = JSON.parse(init!.body as string) as Operation;
        operations.push(operation);
        snapshot = {
          ...snapshot,
          revision: 'published',
          library: applyOperation(snapshot.library, operation),
        };
        if (rejectOnce) {
          rejectOnce = false;
          throw new Error('Response lost');
        }
        return response(structuredClone(snapshot));
      }
      if (url === '/api/metadata') return response(structuredClone(snapshot));
      throw new Error(`Unexpected ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function mounted() {
  const hook = renderHook(() => useLibrary());
  await waitFor(() => expect(hook.result.current.data?.revision).toBe('initial'));
  return hook;
}

describe('library browser orchestration', () => {
  it('publishes a mutation and persists confirmed snapshot with an empty queue', async () => {
    const hook = await mounted();
    const item = Object.values(snapshot.library.records)[0];
    await act(async () => {
      await hook.result.current.mutate({
        type: 'update',
        recordId: item.id,
        base: item,
        patch: { title: 'Edited' },
      });
    });
    await waitFor(() => expect(hook.result.current.status).toBe('Synced'));
    expect(hook.result.current.data?.library.records[item.id].title).toBe('Edited');
    expect(memory.get(scope)?.pending).toEqual([]);
    expect(operations).toHaveLength(1);
  });
  it('retries the same operation after a published response is lost', async () => {
    const hook = await mounted();
    const item = Object.values(snapshot.library.records)[0];
    rejectOnce = true;
    await act(async () => {
      await hook.result.current.mutate({
        type: 'update',
        recordId: item.id,
        base: item,
        patch: { title: 'Recovered' },
      });
    });
    await waitFor(() => expect(hook.result.current.status).toBe('Failed'));
    expect(memory.get(scope)?.pending).toHaveLength(1);
    await act(async () => {
      await hook.result.current.refresh();
    });
    await waitFor(() => expect(hook.result.current.status).toBe('Synced'));
    expect(operations).toHaveLength(2);
    expect(operations[0].id).toBe(operations[1].id);
    expect(memory.get(scope)?.pending).toEqual([]);
    expect(snapshot.library.appliedOperations.filter((id) => id === operations[0].id)).toHaveLength(
      1,
    );
  });
  it('continues local saves with wifi offline', async () => {
    snapshot.mode = 'local';
    online = false;
    const hook = await mounted();
    const item = Object.values(snapshot.library.records)[0];
    expect(hook.result.current.disabled).toBe(false);
    await act(async () => {
      await hook.result.current.mutate({
        type: 'update',
        recordId: item.id,
        patch: { title: 'Offline desktop' },
        base: item,
      });
    });
    await waitFor(() => expect(operations).toHaveLength(1));
    await waitFor(() => expect(hook.result.current.status).toBe('Saved locally'));
  });
  it('does not create hosted edits while offline', async () => {
    const hook = await mounted();
    online = false;
    act(() => window.dispatchEvent(new Event('offline')));
    const item = Object.values(snapshot.library.records)[0];
    await act(async () => {
      await hook.result.current.mutate({
        type: 'update',
        recordId: item.id,
        patch: { title: 'Blocked' },
        base: item,
      });
    });
    expect(operations).toHaveLength(0);
    expect(hook.result.current.disabled).toBe(true);
    expect(hook.result.current.error).toContain('Reconnect');
  });
  it('replays a persisted pending operation after reload and then acknowledges it', async () => {
    const item = Object.values(snapshot.library.records)[0];
    const op: Operation = {
      id: 'persisted',
      actor: 'browser',
      type: 'update',
      recordId: item.id,
      base: item,
      patch: { title: 'From previous tab' },
    };
    memory.set(scope, { snapshot: structuredClone(snapshot), pending: [op] });
    localStorage.setItem('gitdrop:lastScope', scope);
    const hook = renderHook(() => useLibrary());
    await waitFor(() => expect(hook.result.current.status).toBe('Synced'));
    expect(hook.result.current.data?.library.records[item.id].title).toBe('From previous tab');
    expect(operations[0].id).toBe('persisted');
  });
  it('never submits another account repository queue', async () => {
    const oldScope = 'old/account';
    const item = Object.values(snapshot.library.records)[0];
    memory.set(oldScope, {
      snapshot: structuredClone(snapshot),
      pending: [
        {
          id: 'old-private-op',
          actor: 'old',
          type: 'update',
          recordId: item.id,
          patch: { title: 'Private old edit' },
        },
      ],
    });
    localStorage.setItem('gitdrop:lastScope', oldScope);
    const hook = await mounted();
    expect(hook.result.current.data?.library.records[item.id].title).toBe('Original');
    expect(operations).toEqual([]);
    expect(memory.get(oldScope)?.pending).toHaveLength(1);
  });
  it('renders cached data before session verification finishes', async () => {
    memory.set(scope, { snapshot: structuredClone(snapshot), pending: [] });
    localStorage.setItem('gitdrop:lastScope', scope);
    let resolveSession!: (value: Response) => void;
    const previous = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        url === '/api/session'
          ? new Promise<Response>((resolve) => {
              resolveSession = resolve;
            })
          : previous(url, init),
      ),
    );
    const hook = renderHook(() => useLibrary());
    await waitFor(() => expect(hook.result.current.status).toBe('Cached'));
    expect(hook.result.current.data?.revision).toBe('initial');
    expect(hook.result.current.disabled).toBe(true);
    const item = Object.values(snapshot.library.records)[0];
    await act(async () => {
      await hook.result.current.mutate({
        type: 'update',
        recordId: item.id,
        patch: { title: 'Premature edit' },
      });
    });
    expect(operations).toEqual([]);
    await act(async () => {
      resolveSession(await response({ authenticated: true, scope }));
    });
    await waitFor(() => expect(hook.result.current.status).toBe('Synced'));
  });
});

it('keeps edits queued during a slow write response and serializes their publication', async () => {
  const hook = await mounted();
  const item = Object.values(snapshot.library.records)[0];
  const previous = globalThis.fetch;
  let release!: (response: Response) => void;
  let first = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const response = await previous(url, init);
      if (url === '/api/operations' && first) {
        first = false;
        return new Promise<Response>((resolve) => {
          release = () => resolve(response);
        });
      }
      return response;
    }),
  );
  await act(async () => {
    await hook.result.current.mutate({
      type: 'update',
      recordId: item.id,
      base: item,
      patch: { title: 'First edit' },
    });
  });
  await waitFor(() => expect(operations).toHaveLength(1));
  await act(async () => {
    await hook.result.current.mutate({
      type: 'update',
      recordId: item.id,
      base: hook.result.current.data!.library.records[item.id],
      patch: { description: 'Second edit' },
    });
  });
  expect(hook.result.current.data!.library.records[item.id].description).toBe('Second edit');
  await act(async () => {
    release({} as Response);
  });
  await waitFor(() => expect(hook.result.current.status).toBe('Synced'));
  expect(operations).toHaveLength(2);
  expect(hook.result.current.data!.library.records[item.id]).toMatchObject({
    title: 'First edit',
    description: 'Second edit',
  });
  expect(memory.get(scope)?.pending).toEqual([]);
});

it('ignores an older refresh arriving after a mutation has been acknowledged', async () => {
  const hook = await mounted();
  const item = Object.values(snapshot.library.records)[0];
  const previous = globalThis.fetch;
  let release!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const response = await previous(url, init);
      if (url.startsWith('/api/library'))
        return new Promise<Response>((resolve) => {
          release = () => resolve(response);
        });
      return response;
    }),
  );
  let refresh!: Promise<void>;
  act(() => {
    refresh = hook.result.current.refresh();
  });
  await waitFor(() => expect(release).toBeDefined());
  await act(async () => {
    await hook.result.current.mutate({
      type: 'update',
      recordId: item.id,
      base: item,
      patch: { title: 'Latest edit' },
    });
  });
  await waitFor(() => expect(hook.result.current.status).toBe('Synced'));
  await act(async () => {
    release({} as Response);
    await refresh;
  });
  expect(hook.result.current.data!.library.records[item.id].title).toBe('Latest edit');
  expect(memory.get(scope)?.snapshot.library.records[item.id].title).toBe('Latest edit');
});

it('keeps cached snapshot for an unchanged remote head and drains its pending queue', async () => {
  const item = Object.values(snapshot.library.records)[0];
  const operation: Operation = {
    id: 'pending-unchanged',
    actor: 'browser',
    type: 'update',
    recordId: item.id,
    base: item,
    patch: { title: 'Queued' },
  };
  memory.set(scope, { snapshot: structuredClone(snapshot), pending: [operation] });
  localStorage.setItem('gitdrop:lastScope', scope);
  const previous = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      url === '/api/library?revision=initial'
        ? response({ unchanged: true, revision: 'initial', mode: 'github' })
        : previous(url, init),
    ),
  );
  const hook = renderHook(() => useLibrary());
  await waitFor(() => expect(hook.result.current.status).toBe('Synced'));
  expect(hook.result.current.data?.library.records[item.id].title).toBe('Queued');
  expect(operations[0].id).toBe('pending-unchanged');
  expect(memory.get(scope)?.pending).toEqual([]);
});
