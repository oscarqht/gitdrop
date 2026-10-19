// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, renderHook, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { useLibrary } from '../src/client/use-library';
import LibraryApp from '../src/components/library-app';
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
if (!globalThis.localStorage) {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  if (typeof window !== 'undefined')
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
}
beforeEach(() => {
  window.history.replaceState(null, '', '/');
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
      if (url === '/api/import-covers') {
        const { entries } = JSON.parse(init!.body as string);
        return response({ ...structuredClone(snapshot), coverOutcomes: entries.map((e: { recordId: string }) => ({ recordId: e.recordId, status: 'unavailable' })) });
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

it('opens repository setup from sidebar or local status button and saves remote URL and GitHub PAT', async () => {
  snapshot.mode = 'local';
  let repoUrl: string | null = null;
  let hasToken = false;
  let savedToken: string | undefined;
  const previous = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/repository' && (!init?.method || init.method === 'GET')) {
        return response({ url: repoUrl, branch: 'main', ...(hasToken ? { hasToken: true } : {}) });
      }
      if (url === '/api/repository' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as { url: string; token?: string };
        repoUrl = body.url;
        if (body.token) {
          savedToken = body.token;
          hasToken = true;
        }
        snapshot = { ...snapshot, syncStatus: 'synced' };
        return response(structuredClone(snapshot));
      }
      return previous(url, init);
    }),
  );
  const { container } = render(createElement(LibraryApp));
  await waitFor(() => expect(screen.getByText('Saved locally')).toBeTruthy());
  expect(screen.getByText('Connect repository')).toBeTruthy();
  fireEvent.click(screen.getByTitle('Connect repository to sync'));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.closest('.sidebar')).toBeNull();
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  expect(
    container.querySelector('.bookmarks')!.compareDocumentPosition(dialog) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const input = (await screen.findByLabelText(/Git repository URL/i)) as HTMLInputElement;
  const tokenInput = (await screen.findByLabelText(
    /GitHub personal access token/i,
  )) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'https://github.com/you/library.git' } });
  fireEvent.change(tokenInput, { target: { value: 'github_pat_test123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save & sync' }));
  await waitFor(() => expect(screen.getByText('Repository settings')).toBeTruthy());
  expect(savedToken).toBe('github_pat_test123');
  expect(screen.getByText('https://github.com/you/library.git')).toBeTruthy();
  expect(screen.getByText('Synced')).toBeTruthy();
  fireEvent.click(screen.getByText('Repository settings'));
  expect(await screen.findByText(/GitHub personal access token \(saved on server\)/i)).toBeTruthy();
});

it('shows the full collections hierarchy in the breadcrumb', async () => {
  const parent = makeItem('collection', { title: 'foo' });
  const child = makeItem('collection', { title: 'test', parentId: parent.id });
  snapshot.library.records[parent.id] = parent;
  snapshot.library.records[child.id] = child;
  const { container } = render(createElement(LibraryApp));
  await waitFor(() => expect(screen.getByText('test')).toBeTruthy());
  fireEvent.click(screen.getByText('test'));
  const breadcrumb = container.querySelector('.breadcrumb');
  expect(breadcrumb?.textContent).toBe('My libraryfootest');
  expect(breadcrumb?.querySelector('span')?.textContent).toBe('test');
  expect(breadcrumb?.querySelectorAll('svg')).toHaveLength(2);
});

it('renders only direct bookmarks for a selected collection while ignoring descendant bookmarks', async () => {
  const parentCol = makeItem('collection', { id: 'col-foo', title: 'foo', order: 'a0' });
  const childCol = makeItem('collection', {
    id: 'col-test',
    title: 'test',
    parentId: parentCol.id,
    order: 'a1',
  });
  const directBookmark = makeItem('bookmark', {
    id: 'bm-direct',
    title: 'Direct Bookmark',
    url: 'https://direct.example.com',
    parentId: parentCol.id,
    order: 'a0',
  });
  const nestedBookmark = makeItem('bookmark', {
    id: 'bm-nested',
    title: 'Nested Google',
    url: 'https://google.com',
    parentId: childCol.id,
    order: 'a1',
  });
  snapshot = {
    mode: 'github',
    revision: 'initial',
    library: {
      ...createLibrary(),
      records: {
        [parentCol.id]: parentCol,
        [childCol.id]: childCol,
        [directBookmark.id]: directBookmark,
        [nestedBookmark.id]: nestedBookmark,
      },
    },
  };
  render(createElement(LibraryApp));
  await waitFor(() => expect(screen.getByText('Direct Bookmark')).toBeTruthy());
  expect(screen.getByText('Nested Google')).toBeTruthy();

  const fooLink = screen
    .getAllByRole('button')
    .find((btn) => btn.classList.contains('collection-link') && btn.textContent?.includes('foo'))!;
  fireEvent.click(fooLink);

  await waitFor(() =>
    expect(screen.getByText('1 bookmark · Your ideas, in good company.')).toBeTruthy(),
  );
  expect(screen.getByText('Direct Bookmark')).toBeTruthy();
  expect(screen.queryByText('Nested Google')).toBeNull();

  const testLink = screen
    .getAllByRole('button')
    .find((btn) => btn.classList.contains('collection-link') && btn.textContent?.includes('test'))!;
  fireEvent.click(testLink);

  await waitFor(() => expect(screen.getByText('Nested Google')).toBeTruthy());
  expect(screen.queryByText('Direct Bookmark')).toBeNull();
});

it('virtualizes collection content rendering when there are many bookmarks', async () => {
  const { orderBetween } = await import('../src/domain/order');
  const col = makeItem('collection', { id: 'col-big', title: 'Big Collection', order: 'a0' });
  const records: Record<string, ReturnType<typeof makeItem>> = { [col.id]: col };
  let prevOrder: string | undefined;
  for (let i = 0; i < 200; i++) {
    prevOrder = orderBetween(prevOrder, undefined);
    const bm = makeItem('bookmark', {
      id: `bm-${String(i).padStart(3, '0')}`,
      title: `Item ${i}`,
      url: `https://example.com/${i}`,
      parentId: col.id,
      order: prevOrder,
    });
    records[bm.id] = bm;
  }
  snapshot = {
    mode: 'github',
    revision: 'initial',
    library: { ...createLibrary(), records },
  };

  const { container } = render(createElement(LibraryApp));
  await waitFor(() => expect(screen.getByText('Item 0')).toBeTruthy());

  const colLink = screen
    .getAllByRole('button')
    .find(
      (btn) =>
        btn.classList.contains('collection-link') && btn.textContent?.includes('Big Collection'),
    )!;
  fireEvent.click(colLink);

  await waitFor(() =>
    expect(screen.getByText('200 bookmarks · Your ideas, in good company.')).toBeTruthy(),
  );

  const renderedCards = container.querySelectorAll('article.bookmark');
  expect(renderedCards.length).toBeGreaterThan(0);
  expect(renderedCards.length).toBeLessThan(40);
  expect(screen.getByText('Item 0')).toBeTruthy();
  expect(screen.queryByText('Item 199')).toBeNull();

  const grid = container.querySelector('.bookmarks') as HTMLElement;
  Object.defineProperty(grid, 'scrollTop', { configurable: true, writable: true, value: 10000 });
  fireEvent.scroll(grid);

  await waitFor(() => expect(screen.queryByText('Item 0')).toBeNull());
  const midCards = container.querySelectorAll('article.bookmark');
  expect(midCards.length).toBeGreaterThan(0);
  expect(midCards.length).toBeLessThan(40);
});

it('renders bookmark cards as external links without arrows or footer and supports hover actions and confirmed deletion', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  const confirmSpy = vi.spyOn(window, 'confirm');

  const { container } = render(createElement(LibraryApp));
  await waitFor(() => expect(screen.getByText('Original')).toBeTruthy());

  const card = container.querySelector('article.bookmark')!;
  expect(card).toBeTruthy();
  expect(card.querySelector('footer')).toBeNull();
  expect(card.querySelector('.domain svg')).toBeNull();

  const mainLink = card.querySelector('a.bookmark-main') as HTMLAnchorElement;
  expect(mainLink).toBeTruthy();
  expect(mainLink.getAttribute('href')).toBe('https://example.com');
  expect(mainLink.getAttribute('target')).toBe('_blank');
  expect(mainLink.getAttribute('rel')).toContain('noreferrer');

  const copyBtn = screen.getByTitle('Copy link');
  const editBtn = screen.getByTitle('Edit');
  const deleteBtn = screen.getByTitle('Delete');
  expect(copyBtn).toBeTruthy();
  expect(editBtn).toBeTruthy();
  expect(deleteBtn).toBeTruthy();

  fireEvent.click(copyBtn);
  expect(writeText).toHaveBeenCalledWith('https://example.com');
  expect(copyBtn.classList.contains('copied')).toBe(true);
  expect(copyBtn.getAttribute('title')).toBe('Copied!');

  fireEvent.click(editBtn);
  expect(await screen.findByText('Bookmark details')).toBeTruthy();
  expect(editBtn.classList.contains('active')).toBe(true);

  const detailDeleteBtn = screen.getByLabelText('Move to trash');
  confirmSpy.mockReturnValueOnce(false);
  fireEvent.click(detailDeleteBtn);
  expect(confirmSpy).toHaveBeenCalledTimes(1);
  expect(operations).toHaveLength(0);
  expect(screen.getByText('Bookmark details')).toBeTruthy();

  confirmSpy.mockReturnValueOnce(false);
  fireEvent.click(deleteBtn);
  expect(confirmSpy).toHaveBeenCalledTimes(2);
  expect(operations).toHaveLength(0);
  expect(screen.getByText('Original')).toBeTruthy();

  confirmSpy.mockReturnValueOnce(true);
  fireEvent.click(deleteBtn);
  expect(confirmSpy).toHaveBeenCalledTimes(3);
  await waitFor(() => expect(operations).toHaveLength(1));
  expect(operations[0].type).toBe('delete');
  expect(screen.queryByText('Original')).toBeNull();
  expect(screen.queryByText('Bookmark details')).toBeNull();
});

it('syncs selected collection, bookmark editing, and special views with the URL path', async () => {
  const col = makeItem('collection', { id: 'col-design', title: 'Design' });
  const bm = makeItem('bookmark', {
    id: 'bm-123',
    title: 'Design System',
    url: 'https://design.example.com',
    parentId: col.id,
  });
  snapshot = {
    mode: 'github',
    revision: 'initial',
    library: {
      ...createLibrary(),
      records: { [col.id]: col, [bm.id]: bm },
    },
  };

  render(createElement(LibraryApp));
  await waitFor(() => expect(screen.getByText('Design System')).toBeTruthy());
  expect(window.location.pathname).toBe('/');

  fireEvent.click(screen.getByRole('button', { name: /Inbox/i }));
  expect(window.location.pathname).toBe('/inbox');

  fireEvent.click(screen.getByRole('button', { name: /Trash/i }));
  expect(window.location.pathname).toBe('/trash');

  fireEvent.click(screen.getByRole('button', { name: /Recovery/i }));
  expect(window.location.pathname).toBe('/recovery');

  fireEvent.click(screen.getByRole('button', { name: /All bookmarks/i }));
  expect(window.location.pathname).toBe('/');

  const colLink = screen
    .getAllByRole('button')
    .find((btn) => btn.classList.contains('collection-link') && btn.textContent?.includes('Design'))!;
  fireEvent.click(colLink);
  expect(window.location.pathname).toBe('/collections/col-design');

  fireEvent.click(screen.getByTitle('Edit'));
  expect(await screen.findByText('Bookmark details')).toBeTruthy();
  expect(window.location.pathname).toBe('/collections/col-design/bookmarks/bm-123');

  fireEvent.click(screen.getByLabelText('Close details'));
  expect(screen.queryByText('Bookmark details')).toBeNull();
  expect(window.location.pathname).toBe('/collections/col-design');
});

it('initializes view and bookmark details from initial URL path and responds to popstate', async () => {
  const col = makeItem('collection', { id: 'col-reading', title: 'Reading' });
  const bm = makeItem('bookmark', {
    id: 'bm-456',
    title: 'Deep Reading',
    url: 'https://reading.example.com',
    parentId: col.id,
  });
  snapshot = {
    mode: 'github',
    revision: 'initial',
    library: {
      ...createLibrary(),
      records: { [col.id]: col, [bm.id]: bm },
    },
  };

  window.history.replaceState(null, '', '/collections/col-reading/bookmarks/bm-456');
  render(createElement(LibraryApp));

  expect(await screen.findByText('Bookmark details')).toBeTruthy();
  expect(window.location.pathname).toBe('/collections/col-reading/bookmarks/bm-456');
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Reading');

  act(() => {
    window.history.pushState(null, '', '/trash');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(screen.queryByText('Bookmark details')).toBeNull();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Trash');
  expect(window.location.pathname).toBe('/trash');
});

it('opens import dialog when clicking Import and imports Raindrop CSV bookmarks into current collection', async () => {
  const colWork = makeItem('collection', { id: 'col-work', title: 'Work' });
  const colOther = makeItem('collection', { id: 'col-other', title: 'Other' });
  const existing = makeItem('bookmark', {
    id: 'bm-existing',
    title: 'Existing Work Link',
    url: 'https://work.example.com',
    parentId: colWork.id,
  });
  snapshot = {
    mode: 'github',
    revision: 'initial',
    library: {
      ...createLibrary(),
      records: {
        [colWork.id]: colWork,
        [colOther.id]: colOther,
        [existing.id]: existing,
      },
    },
  };

  render(createElement(LibraryApp));
  await waitFor(() => expect(screen.getByText('Existing Work Link')).toBeTruthy());

  // Navigate to 'Work' collection
  const workLink = screen
    .getAllByRole('button')
    .find((btn) => btn.classList.contains('collection-link') && btn.textContent?.includes('Work'))!;
  fireEvent.click(workLink);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Work');

  // Click Import button
  fireEvent.click(screen.getByRole('button', { name: /^Import$/i }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByText('Importing to Work')).toBeTruthy();

  const csvContent = [
    'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite',
    '1039405875,"The ""Wait, Not Like That"" Free Speech Panic",Important note,"In February, 2021, an article",https://www.techdirt.com/2025/04/17/free-speech/,Unsorted,"politics, media",2025-04-17T23:54:51.630Z,https://img.example.com/1.png,,false',
    '1075498448,AI Is Polytheistic,,Emergent Gods,https://www.noemamag.com/ai-is-polytheistic/,SomeOtherFolder,ai,2025-05-06T03:06:16.597Z,,,true',
  ].join('\n');

  const csvFile = new File([csvContent], 'export.csv', { type: 'text/csv' });
  const fileInput = screen.getByLabelText(/CSV file/i) as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [csvFile] } });

  const submitBtn = screen.getByRole('button', { name: /Import bookmarks/i });
  expect((submitBtn as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(submitBtn);

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(operations).toHaveLength(2));
  expect(operations.every(op => op.type === 'create')).toBe(true);
  const importedRecords = operations.flatMap(op => op.records!);
  expect(importedRecords).toHaveLength(3);
  const createdCol = importedRecords.find((r) => r.kind === 'collection');
  expect(createdCol?.title).toBe('SomeOtherFolder');

  const [firstImported, secondImported] = importedRecords.filter((r) => r.kind === 'bookmark');
  expect(firstImported.parentId).toBe('col-work');
  expect(secondImported.parentId).toBe(createdCol!.id);

  await waitFor(() => {
    const metadataCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => url === '/api/import-covers')
      .flatMap(([, init]) => JSON.parse(String(init?.body)).entries);
    expect(metadataCalls).toHaveLength(2);
    expect(metadataCalls).toContainEqual({
      recordId: firstImported.id,
      coverUrl: 'https://img.example.com/1.png',
    });
    expect(metadataCalls).toContainEqual({
      recordId: secondImported.id,
    });
  });

  expect(await screen.findByText('The "Wait, Not Like That" Free Speech Panic')).toBeTruthy();
  expect(screen.getByText('SomeOtherFolder')).toBeTruthy();
});

it('hides Import button on Trash and Recovery pages and clears Trash via Clear button', async () => {
  const b1 = makeItem('bookmark', {
    id: 'bm-1',
    title: 'Trashed One',
    url: 'https://one.example.com',
  });
  const b2 = makeItem('bookmark', {
    id: 'bm-2',
    title: 'Trashed Two',
    url: 'https://two.example.com',
  });
  let lib = createLibrary();
  lib = applyOperation(lib, { id: 'c1', actor: 'a', type: 'create', record: b1 });
  lib = applyOperation(lib, { id: 'c2', actor: 'a', type: 'create', record: b2 });
  lib = applyOperation(lib, { id: 'd1', actor: 'a', type: 'delete', recordId: b1.id });
  lib = applyOperation(lib, { id: 'd2', actor: 'a', type: 'delete', recordId: b2.id });
  snapshot = {
    mode: 'github',
    revision: 'initial',
    library: lib,
  };

  vi.stubGlobal('confirm', vi.fn(() => true));

  render(createElement(LibraryApp));
  await waitFor(() => expect(screen.getByRole('button', { name: /^Import$/i })).toBeTruthy());
  expect(screen.queryByRole('button', { name: /^Clear$/i })).toBeNull();

  // Navigate to Recovery page
  fireEvent.click(screen.getByRole('button', { name: /^Recovery$/i }));
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Recovery');
  expect(screen.queryByRole('button', { name: /^Import$/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Clear$/i })).toBeNull();

  // Navigate to Trash page
  fireEvent.click(screen.getByRole('button', { name: /^Trash$/i }));
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Trash');
  expect(screen.queryByRole('button', { name: /^Import$/i })).toBeNull();
  expect(screen.getByText('Trashed One')).toBeTruthy();
  expect(screen.getByText('Trashed Two')).toBeTruthy();

  const clearBtn = screen.getByRole('button', { name: /^Clear$/i }) as HTMLButtonElement;
  expect(clearBtn.disabled).toBe(false);
  fireEvent.click(clearBtn);

  await waitFor(() => expect(screen.getByText('Trash is empty')).toBeTruthy());
  expect(screen.queryByText('Trashed One')).toBeNull();
  expect(screen.queryByText('Trashed Two')).toBeNull();
  expect(clearBtn.disabled).toBe(true);
  expect(operations).toHaveLength(1);
  expect(operations[0].type).toBe('purge');
  expect(operations[0].recordId).toBeUndefined();
});

it('keeps cover image URLs stable across non-cover updates when imageHash is present', async () => {
  const { Cover } = await import('../src/components/cover');
  const hash = 'a'.repeat(40);
  const item = makeItem('bookmark', {
    id: 'bm-cover',
    title: 'Cover Item',
    url: 'https://cover.example.com',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cover: { mode: 'image', imageFile: 'bm-cover.webp', imageHash: hash },
  });
  const { container, rerender } = render(createElement(Cover, { item }));
  const img = container.querySelector('img') as HTMLImageElement;
  expect(img.getAttribute('src')).toBe(`/api/media?recordId=bm-cover&v=${hash}&hash=${hash}`);

  rerender(
    createElement(Cover, {
      item: { ...item, title: 'Renamed', updatedAt: '2026-02-01T00:00:00.000Z' },
    }),
  );
  expect((container.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(
    `/api/media?recordId=bm-cover&v=${hash}&hash=${hash}`,
  );
});

it('renders Settings dialog with vertical tabs and toggles bookmark and collection cover image rendering mode between cover and contain', async () => {
  snapshot.mode = 'local';
  const col = makeItem('collection', {
    id: 'col-art',
    title: 'Art Collection',
    cover: { mode: 'image', imageFile: 'col-art.webp' },
  });
  const bm = makeItem('bookmark', {
    id: 'bm-art',
    title: 'Art Piece',
    url: 'https://art.example.com',
    parentId: col.id,
    cover: { mode: 'image', imageFile: 'bm-art.webp' },
  });
  snapshot.library.records[col.id] = col;
  snapshot.library.records[bm.id] = bm;

  const previous = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/repository' && (!init?.method || init.method === 'GET')) {
        return response({ url: null, branch: 'main' });
      }
      return previous(url, init);
    }),
  );

  const { container } = render(createElement(LibraryApp));
  await waitFor(() => expect(screen.getByText('Art Piece')).toBeTruthy());

  // Default rendering mode is cover
  const bookmarkCoverImg = container.querySelector('.bookmarks .cover img') as HTMLImageElement;
  expect(bookmarkCoverImg).toBeTruthy();
  expect(bookmarkCoverImg.style.objectFit).toBe('cover');
  expect(bookmarkCoverImg.closest('.cover')?.getAttribute('data-fit')).toBe('cover');
  expect(container.querySelector('.app-shell')?.getAttribute('data-cover-fit')).toBe('cover');

  // Open Settings dialog from sidebar
  fireEvent.click(screen.getByText('Connect repository'));
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  expect(dialog.classList.contains('settings-dialog')).toBe(true);

  const tablist = screen.getByRole('tablist', { name: 'Settings' });
  expect(tablist.getAttribute('aria-orientation')).toBe('vertical');

  const repoTab = screen.getByRole('tab', { name: /Connect your repository/i });
  const appearanceTab = screen.getByRole('tab', { name: /Appearance/i });
  expect(repoTab.getAttribute('aria-selected')).toBe('true');
  expect(appearanceTab.getAttribute('aria-selected')).toBe('false');
  expect(await screen.findByLabelText(/Git repository URL/i)).toBeTruthy();

  // Switch to Appearance tab
  fireEvent.click(appearanceTab);
  expect(appearanceTab.getAttribute('aria-selected')).toBe('true');
  expect(repoTab.getAttribute('aria-selected')).toBe('false');
  expect(screen.queryByLabelText(/Git repository URL/i)).toBeNull();

  const coverFitSwitch = screen.getByRole('switch') as HTMLInputElement;
  expect(coverFitSwitch.checked).toBe(false);
  expect(coverFitSwitch.getAttribute('aria-checked')).toBe('false');

  // Toggle switch to contain
  fireEvent.click(coverFitSwitch);
  expect(coverFitSwitch.checked).toBe(true);
  expect(coverFitSwitch.getAttribute('aria-checked')).toBe('true');
  expect(localStorage.getItem('gitdrop:coverFit')).toBe('contain');
  expect(bookmarkCoverImg.style.objectFit).toBe('contain');
  expect(bookmarkCoverImg.closest('.cover')?.getAttribute('data-fit')).toBe('contain');
  expect(container.querySelector('.app-shell')?.getAttribute('data-cover-fit')).toBe('contain');

  // Close settings and open collection details to verify collection cover also uses contain
  fireEvent.click(screen.getByLabelText('Close settings'));
  const colLink = screen
    .getAllByRole('button')
    .find(
      (btn) =>
        btn.classList.contains('collection-link') && btn.textContent?.includes('Art Collection'),
    )!;
  fireEvent.click(colLink);
  fireEvent.click(screen.getByTitle('Edit collection'));
  expect(await screen.findByText('Collection details')).toBeTruthy();
  const collectionCoverImg = container.querySelector('.detail .cover img') as HTMLImageElement;
  expect(collectionCoverImg).toBeTruthy();
  expect(collectionCoverImg.style.objectFit).toBe('contain');
  expect(collectionCoverImg.closest('.cover')?.getAttribute('data-fit')).toBe('contain');

  // Reopen Settings and toggle back to cover
  fireEvent.click(screen.getByText('Connect repository'));
  fireEvent.click(await screen.findByRole('tab', { name: /Appearance/i }));
  fireEvent.click(screen.getByRole('switch'));
  expect(localStorage.getItem('gitdrop:coverFit')).toBe('cover');
  expect(bookmarkCoverImg.style.objectFit).toBe('cover');
  expect(collectionCoverImg.style.objectFit).toBe('cover');
});

it('automatically follows the OS light/dark theme and provides no manual theme switch control', async () => {
  snapshot.mode = 'local';
  const previous = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/repository' && (!init?.method || init.method === 'GET')) {
        return response({ url: null, branch: 'main' });
      }
      return previous(url, init);
    }),
  );

  let isDark = false;
  const listeners = new Set<() => void>();
  const mql = {
    get matches() {
      return isDark;
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn((type: string, cb: () => void) => {
      if (type === 'change') listeners.add(cb);
    }),
    removeEventListener: vi.fn((type: string, cb: () => void) => {
      if (type === 'change') listeners.delete(cb);
    }),
    addListener: vi.fn((cb: () => void) => {
      listeners.add(cb);
    }),
    removeListener: vi.fn((cb: () => void) => {
      listeners.delete(cb);
    }),
    dispatchEvent: vi.fn(),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => (query === '(prefers-color-scheme: dark)' ? mql : { ...mql, matches: false })),
  );

  const { container } = render(createElement(LibraryApp));
  expect(await screen.findByText('Original')).toBeTruthy();

  // Defaults to light theme when OS prefers light
  const appShell = container.querySelector('.app-shell')!;
  expect(appShell.getAttribute('data-theme')).toBe('light');
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(document.documentElement.style.colorScheme).toBe('light');

  // Auto-switches to dark theme when OS theme changes to dark
  act(() => {
    isDark = true;
    listeners.forEach((cb) => cb());
  });
  expect(appShell.getAttribute('data-theme')).toBe('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.style.colorScheme).toBe('dark');

  // Auto-switches back to light theme when OS theme changes to light
  act(() => {
    isDark = false;
    listeners.forEach((cb) => cb());
  });
  expect(appShell.getAttribute('data-theme')).toBe('light');
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(document.documentElement.style.colorScheme).toBe('light');

  // Verify there is no manual theme switch control in Settings -> Appearance or anywhere in the UI
  fireEvent.click(screen.getByText('Connect repository'));
  const appearanceTab = await screen.findByRole('tab', { name: /Appearance/i });
  fireEvent.click(appearanceTab);

  const switches = screen.getAllByRole('switch');
  expect(switches).toHaveLength(1); // Only the existing "Scale cover image to fit" switch
  expect(screen.queryByLabelText(/theme|dark mode|light mode|color scheme/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /theme|dark mode|light mode/i })).toBeNull();
});





it('keeps saved counts at zero until acknowledgement, pauses after the batch, and resumes across remount', async () => {
  const { parseRaindropCsvWithCovers } = await import('../src/domain/csv');
  const previous = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/operations' && operations.length === 0) {
      await gate;
    }
    return previous(url, init);
  }));
  const hook = await mounted();
  const entries = parseRaindropCsvWithCovers('url,folder\nhttps://a.test,Parent\nhttps://b.test,Parent');
  await act(async () => { await hook.result.current.startImport('large.csv', entries); });
  expect(hook.result.current.importJob?.saved).toBe(0);
  await act(async () => { await hook.result.current.controlImport('pause'); release(); });
  await waitFor(() => expect(hook.result.current.importJob?.saved).toBe(1));
  expect(operations).toHaveLength(1);
  expect(hook.result.current.importJob?.paused).toBe(true);
  hook.unmount();
  const resumed = renderHook(() => useLibrary());
  await waitFor(() => expect(resumed.result.current.importJob?.saved).toBe(1));
  await waitFor(() => expect(resumed.result.current.disabled).toBe(false));
  expect(resumed.result.current.importJob?.saved).toBe(1);
  expect(resumed.result.current.importJob?.paused).toBe(true);
  await act(async () => { await resumed.result.current.controlImport('resume'); });
  await waitFor(() => expect(resumed.result.current.importJob?.entries.filter(e => e.coverStatus === 'unavailable')).toHaveLength(2));
  expect(resumed.result.current.importJob?.saved).toBe(3);
  expect(operations).toHaveLength(2);
});

it('retries an unacknowledged import batch with its original operation ID', async () => {
  const { parseRaindropCsvWithCovers } = await import('../src/domain/csv');
  const hook = await mounted();
  rejectOnce = true;
  await act(async () => { await hook.result.current.startImport('lost.csv', parseRaindropCsvWithCovers('url\nhttps://a.test')); });
  await waitFor(() => expect(hook.result.current.importJob?.error).toBeTruthy());
  expect(hook.result.current.importJob?.saved).toBe(0);
  await act(async () => { await hook.result.current.controlImport('resume'); });
  await waitFor(() => expect(hook.result.current.importJob?.saved).toBe(1));
  expect(operations).toHaveLength(2);
  expect(operations[1].id).toBe(operations[0].id);
  expect(Object.values(snapshot.library.records).filter(r => r.variants?.[0]?.url === 'https://a.test/')).toHaveLength(1);
});

it('resumes unfinished covers automatically and retries only failed covers', async () => {
  const { parseRaindropCsvWithCovers } = await import('../src/domain/csv');
  const { createImportJob } = await import('../src/client/import-job');
  const entries = parseRaindropCsvWithCovers('url\nhttps://a.test\nhttps://b.test');
  const job = createImportJob('covers.csv', entries);
  job.saved = entries.length;
  for (const entry of entries) snapshot.library.records[entry.item.id] = entry.item;
  memory.set(scope, { snapshot, pending: [], importJob: job });
  const previous = globalThis.fetch;
  let first = true;
  const calls: string[][] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/import-covers') {
      const body = JSON.parse(init!.body as string);
      calls.push(body.entries.map((e: any) => e.recordId));
      const coverOutcomes = body.entries.map((e: any, i: number) => ({ recordId: e.recordId, status: first && i === 0 ? 'failed' : 'fetched' }));
      first = false;
      return response({ ...structuredClone(snapshot), coverOutcomes });
    }
    return previous(url, init);
  }));
  const hook = await mounted();
  await waitFor(() => expect(hook.result.current.importJob?.entries.map(e => e.coverStatus)).toEqual(['failed', 'fetched']));
  await act(async () => { await hook.result.current.controlImport('retry'); });
  await waitFor(() => expect(hook.result.current.importJob?.entries.every(e => e.coverStatus === 'fetched')).toBe(true));
  expect(calls).toEqual([[entries[0].item.id, entries[1].item.id], [entries[0].item.id]]);
});

it('saves ordinary edits between import batches without losing progress or reverting the edit', async () => {
  const { parseRaindropCsvWithCovers } = await import('../src/domain/csv');
  const previous = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/operations' && operations.length === 0) await gate;
    return previous(url, init);
  }));
  const hook = await mounted();
  const original = Object.values(snapshot.library.records)[0];
  await act(async () => { await hook.result.current.startImport('edit.csv', parseRaindropCsvWithCovers('url,folder\nhttps://a.test,Folder')); });
  await act(async () => {
    await hook.result.current.mutate({ type: 'update', recordId: original.id, base: original, patch: { title: 'Edited during import' } });
    release();
  });
  await waitFor(() => expect(hook.result.current.importJob?.entries[1].coverStatus).toBe('unavailable'));
  expect(operations.map(op => op.type)).toEqual(['create', 'update', 'create']);
  expect(hook.result.current.data?.library.records[original.id].title).toBe('Edited during import');
  expect(hook.result.current.importJob?.saved).toBe(2);
});

it('stops a stalled import request and retries the same durable batch', async () => {
  const { parseRaindropCsvWithCovers } = await import('../src/domain/csv');
  const previous = globalThis.fetch;
  let stalled = true;
  const attempted: Operation[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/operations') {
        attempted.push(JSON.parse(String(init?.body)));
        if (stalled)
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });
      }
      return previous(url, init);
    }),
  );
  const hook = await mounted();
  vi.useFakeTimers();
  try {
    await act(async () => {
      await hook.result.current.startImport(
        'stalled.csv',
        parseRaindropCsvWithCovers('url\nhttps://a.test'),
      );
    });
    expect(attempted).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(hook.result.current.importJob?.error).toMatch(/timed out/i);
    expect(hook.result.current.importJob?.saved).toBe(0);
    expect(memory.get(scope)?.importJob?.saved).toBe(0);
    stalled = false;
    await act(async () => {
      await hook.result.current.controlImport('resume');
    });
    expect(hook.result.current.importJob?.saved).toBe(1);
    expect(attempted).toHaveLength(2);
    expect(attempted[1]).toEqual(attempted[0]);
  } finally {
    vi.useRealTimers();
  }
});

it('batches 20 covers and reschedules entries omitted by a slow batch without losing progress', async () => {
  const { parseRaindropCsvWithCovers } = await import('../src/domain/csv');
  const previous = globalThis.fetch;
  const calls: string[][] = [];
  const completed: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/import-covers') {
        const entries = JSON.parse(String(init?.body)).entries as {
          recordId: string;
        }[];
        calls.push(entries.map((entry) => entry.recordId));
        const processed = calls.length === 1 ? entries.slice(0, 4) : entries;
        completed.push(...processed.map((entry) => entry.recordId));
        return response({
          ...structuredClone(snapshot),
          coverOutcomes: processed.map((entry) => ({
            recordId: entry.recordId,
            status: 'unavailable',
          })),
        });
      }
      return previous(url, init);
    }),
  );
  const hook = await mounted();
  const entries = parseRaindropCsvWithCovers(
    'url\n' +
      Array.from({ length: 45 }, (_, i) => `https://example.test/${i}`).join(
        '\n',
      ),
  );
  await act(async () => {
    await hook.result.current.startImport('batch.csv', entries);
  });
  await waitFor(() =>
    expect(
      hook.result.current.importJob?.entries.every(
        (entry) => entry.coverStatus === 'unavailable',
      ),
    ).toBe(true),
  );
  expect(calls.map((batch) => batch.length)).toEqual([20, 20, 20, 1]);
  expect(completed).toEqual(entries.map((entry) => entry.item.id));
  expect(hook.result.current.importJob?.saved).toBe(45);
});
