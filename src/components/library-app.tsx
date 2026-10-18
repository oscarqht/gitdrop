'use client';
import { AddBookmark } from './add-bookmark';
import { ImportBookmarks } from './import-bookmarks';
import { Sidebar, builtins } from './sidebar';
import { TrashView, RecoveryView } from './recovery-views';
import { BookmarkGrid } from './bookmark-grid';

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Upload,
  Search,
  Inbox,
  ChevronRight,
  Menu,
  Grid2X2,
  List,
  ArrowUpDown,
  RefreshCw,
  FolderPlus,
  ArrowUpRight,
  Check,
  CloudOff,
  GitBranch,
  Trash2,
  X,
} from 'lucide-react';
import { type Item } from '../domain/types';
import { orderBetween } from '../domain/order';
import { parseRaindropCsvWithCovers } from '../domain/csv';
import { useLibrary } from '../client/use-library';
import { actorId } from '../client/store';
import { Detail } from './detail';
import { useCoverFit, useSystemTheme } from './cover';
import type { RepositoryInfo } from './repository-setup';
export default function LibraryApp() {
  const api = useLibrary();
  const [coverFit] = useCoverFit();
  const theme = useSystemTheme();
  const [view, setView] = useState(
    () => parseUrlPath(typeof window !== 'undefined' ? window.location.pathname : '/').view,
  );
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState('manual');
  const [selected, setSelected] = useState<string | undefined>(
    () => parseUrlPath(typeof window !== 'undefined' ? window.location.pathname : '/').selected,
  );
  const [drawer, setDrawer] = useState(false);
  const [add, setAdd] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [openRepository, setOpenRepository] = useState(false);
  const [repository, setRepository] = useState<RepositoryInfo>();
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [tagMode, setTagMode] = useState('all');
  const [scoped, setScoped] = useState(false);
  const [drag, setDrag] = useState<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const records = useMemo(
    () => Object.values(api.data?.library.records || {}) as Item[],
    [api.data],
  );
  const trashCount = useMemo(
    () =>
      (Object.values(api.data?.library.tombstones || {}) as any[]).filter(
        (t) => t.record && !api.data?.library.records[t.id],
      ).length,
    [api.data],
  );
  const collections = useMemo(
    () =>
      records
        .filter((r) => r.kind === 'collection')
        .sort(
          (a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0) || a.id.localeCompare(b.id),
        ),
    [records],
  );
  const inbox = collections.find((c) => c.title === 'Inbox');
  const current = collections.find((c) => c.id === view);
  const breadcrumb: Item[] = [];
  if (current) {
    const seen = new Set<string>();
    let node: Item | undefined = current;
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      breadcrumb.unshift(node);
      node = node.parentId ? collections.find((c) => c.id === node?.parentId) : undefined;
    }
  }
  const item = records.find((r) => r.id === selected);
  useEffect(() => {
    function onPopState() {
      const next = parseUrlPath(window.location.pathname);
      setView(next.view);
      setSelected(next.selected);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const nextPath = buildUrlPath(view, selected, item, inbox?.id);
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, '', nextPath);
    }
  }, [view, selected, item, inbox?.id]);
  const bookmarks = useMemo(() => records.filter((r) => r.kind === 'bookmark'), [records]);
  const filtered = useMemo(
    () =>
      bookmarks
        .filter((r) => {
          if (view === 'trash' || view === 'recovery') return false;
          if ((!query || scoped) && view !== 'all') {
            if (view === 'inbox' && r.parentId !== inbox?.id) return false;
            if (current && r.parentId !== current.id) return false;
          }
          const q = query.toLowerCase();
          if (
            q &&
            ![r.title, ...(r.variants || []).flatMap((v) => [v.name, v.url]), r.description, r.note]
              .join(' ')
              .toLowerCase()
              .includes(q)
          )
            return false;
          const tags = tagQuery
            .split(',')
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);
          return (
            !tags.length ||
            (tagMode === 'all'
              ? tags.every((t) => r.tags.some((rt) => rt.toLowerCase() === t))
              : tags.some((t) => r.tags.some((rt) => rt.toLowerCase() === t)))
          );
        })
        .sort((a, b) =>
          sort === 'title'
            ? a.title.localeCompare(b.title)
            : sort === 'updated'
              ? b.updatedAt.localeCompare(a.updatedAt)
              : sort === 'added'
                ? b.createdAt.localeCompare(a.createdAt)
                : (a.order < b.order ? -1 : a.order > b.order ? 1 : 0) || a.id.localeCompare(b.id),
        ),
    [bookmarks, view, query, scoped, inbox?.id, current, tagQuery, tagMode, sort],
  );
  function navigate(id: string) {
    setView(id);
    setDrawer(false);
    setSelected(undefined);
  }
  function update(recordId: string, patch: Partial<Item>) {
    void api
      .mutate({ type: 'update', recordId, patch, base: records.find((r) => r.id === recordId) })
      .catch(() => {});
  }
  async function createCollection() {
    const title = prompt('Collection name');
    if (!title?.trim()) return;
    const now = new Date().toISOString();
    await api.mutate({
      type: 'create',
      record: {
        id: crypto.randomUUID(),
        kind: 'collection',
        title: title.trim(),
        parentId: current?.id || null,
        description: '',
        note: '',
        tags: [],
        order: orderBefore(collections[0]?.order),
        cover: { mode: 'emoji', emoji: '📁' },
        createdAt: now,
        updatedAt: now,
        revision: { counter: 1, actor: actorId() },
      },
    });
  }
  async function saveUrl(e: React.FormEvent) {
    e.preventDefault();
    try {
      let parsed = new URL(url.includes('://') ? url : `https://${url}`);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw Error('Enter an HTTP or HTTPS URL');
      const existing = bookmarks.find((b) => b.variants?.some((v) => v.url === parsed.href));
      if (existing && !confirm('This URL is already saved. Create another copy?')) {
        setSelected(existing.id);
        setAdd(false);
        return;
      }
      setAdding(true);
      const id = crypto.randomUUID(),
        now = new Date().toISOString();
      await api.mutate({
        type: 'create',
        record: {
          id,
          kind: 'bookmark',
          title: parsed.hostname,
          variants: [
            {
              id: 'primary',
              name: 'Default',
              url: parsed.href,
              order: orderBetween(),
            },
          ],
          defaultVariantId: 'primary',
          parentId: current?.id || inbox?.id || null,
          description: '',
          note: '',
          tags: [],
          order: orderBefore(
            bookmarks
              .filter((b) => b.parentId === (current?.id || inbox?.id || null))
              .sort((a, b) => (a.order < b.order ? -1 : 1))[0]?.order,
          ),
          cover: { mode: 'automatic' },
          createdAt: now,
          updatedAt: now,
          revision: { counter: 1, actor: actorId() },
        },
      });
      setAdd(false);
      setUrl('');
      void api.action('/api/metadata', JSON.stringify({ recordId: id }));
    } catch (e) {
      api.setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  }
  async function importCsv(e: React.FormEvent) {
    e.preventDefault();
    if (!importFile) return;
    try {
      setImporting(true);
      const text = await readFileText(importFile);
      const parentId = current?.id || inbox?.id || null;
      const beforeOrder = bookmarks
        .filter((b) => b.parentId === parentId)
        .sort((a, b) => (a.order < b.order ? -1 : 1))[0]?.order;
      const entries = parseRaindropCsvWithCovers(text, {
        parentId,
        beforeOrder,
        actor: actorId(),
      });
      await api.mutate({
        type: 'create',
        records: entries.map((entry) => entry.item),
      });
      setImportOpen(false);
      setImportFile(null);
      void (async () => {
        for (const entry of entries) {
          await api.action(
            '/api/metadata',
            JSON.stringify({
              recordId: entry.item.id,
              ...(entry.coverUrl ? { coverUrl: entry.coverUrl } : {}),
            }),
          );
        }
      })();
    } catch (e) {
      api.setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }
  function move(target: Item, asChild = false) {
    const source = records.find((r) => r.id === drag);
    setDrag(undefined);
    if (!source || source.id === target.id) return;
    let ancestor: Item | undefined = target;
    const visited = new Set<string>();
    while (ancestor) {
      if (ancestor.id === source.id || visited.has(ancestor.id)) {
        api.setError('A collection cannot be moved inside itself.');
        return;
      }
      visited.add(ancestor.id);
      ancestor = records.find((r) => r.id === ancestor?.parentId);
    }
    if (asChild)
      update(source.id, {
        parentId: target.id,
        order: orderBefore(
          records
            .filter((r) => r.parentId === target.id)
            .sort((a, b) => (a.order < b.order ? -1 : 1))[0]?.order,
        ),
      });
    else {
      const siblings = records
        .filter(
          (r) => r.kind === source.kind && r.parentId === target.parentId && r.id !== source.id,
        )
        .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
      const index = siblings.findIndex((r) => r.id === target.id);
      update(source.id, {
        parentId: target.parentId,
        order: orderBetween(siblings[index - 1]?.order, target.order),
      });
    }
  }
  if (api.login)
    return (
      <main className="welcome" data-theme={theme}>
        <div className="brand-mark">
          <img src="/icon.png" alt="Gitdrop" width={60} height={60} />
        </div>
        <h1>Your corner of the internet.</h1>
        <p>A private home for everything worth keeping.</p>
        <a className="primary button" href="/api/auth/login">
          Continue with GitHub <ArrowUpRight size={17} />
        </a>
      </main>
    );
  return (
    <div className="app-shell" data-cover-fit={coverFit} data-theme={theme}>
      {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}
      <Sidebar
        {...{
          api,
          drawer,
          setDrawer,
          setAdd,
          view,
          navigate,
          bookmarks,
          collections,
          createCollection,
          collapsed,
          setCollapsed,
          setDrag,
          move,
          openRepository,
          setOpenRepository,
          onRepositoryChange: setRepository,
        }}
      />
      <main className="main">
        <header className="topbar">
          <button
            className="mobile-only icon-button"
            aria-label="Open navigation"
            onClick={() => setDrawer(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            My library
            {(breadcrumb.length
              ? breadcrumb.map((c) => c.title)
              : [builtins.find((b) => b.id === view)?.name]
            ).map((label, i, items) => (
              <Fragment key={i}>
                <ChevronRight size={13} />
                {i < items.length - 1 ? label : <span>{label}</span>}
              </Fragment>
            ))}
          </div>
          <button
            className={`sync-status ${api.status.toLowerCase().replaceAll(' ', '-')}`}
            onClick={() => {
              if (!repository?.url || api.status === 'Connect repository') {
                api.setError('');
                setOpenRepository(true);
                return;
              }
              void api.action('/api/sync');
            }}
            title={
              !repository?.url || api.status === 'Connect repository'
                ? 'Connect repository to sync'
                : 'Sync now'
            }
          >
            {api.status === 'Synced' ? (
              <Check size={13} />
            ) : !api.online ? (
              <CloudOff size={13} />
            ) : (
              <RefreshCw size={13} />
            )}
            <span>{api.status}</span>
          </button>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">A LITTLE LESS LOST. A LITTLE MORE FOUND.</div>
              <h1>{current?.title || builtins.find((b) => b.id === view)?.name}</h1>
              <p>
                {view === 'trash'
                  ? 'A second chance for things you let go.'
                  : view === 'recovery'
                    ? 'Alternative versions, safely kept.'
                    : `${filtered.length} ${filtered.length === 1 ? 'bookmark' : 'bookmarks'} · Your ideas, in good company.`}
              </p>
            </div>
            <div className="heading-actions">
              {current && (
                <button
                  className="icon-button"
                  title="Edit collection"
                  onClick={() => setSelected(current.id)}
                >
                  <FolderPlus size={19} />
                </button>
              )}
              {view === 'trash' && (
                <button
                  className="secondary danger"
                  disabled={api.disabled || !trashCount}
                  onClick={() => {
                    if (
                      confirm(
                        'Permanently remove all items in Trash from the current library? Git history may retain them.',
                      )
                    ) {
                      void api.mutate({ type: 'purge' });
                    }
                  }}
                >
                  <Trash2 size={16} />
                  <span>Clear</span>
                </button>
              )}
              {view !== 'trash' && view !== 'recovery' && (
                <button
                  className="secondary"
                  disabled={api.disabled}
                  onClick={() => {
                    setImportFile(null);
                    setImportOpen(true);
                  }}
                >
                  <Upload size={16} />
                  <span>Import</span>
                </button>
              )}
              <button className="primary" disabled={api.disabled} onClick={() => setAdd(true)}>
                <Plus size={17} />
                <span>Save bookmark</span>
              </button>
            </div>
          </div>
          {api.error && (
            <div role="alert" className="notice">
              <span>{api.error}</span>
              {(api.error.includes('Settings') || !repository?.url) && (
                <button
                  onClick={() => {
                    api.setError('');
                    setOpenRepository(true);
                  }}
                >
                  Open Settings
                </button>
              )}
              <button
                onClick={() => {
                  api.setError('');
                  void api.refresh();
                }}
              >
                Retry
              </button>
              {api.pendingCount > 0 && (
                <button onClick={api.recoverPending}>Export & reset pending edits</button>
              )}
              <button aria-label="Dismiss error" onClick={() => api.setError('')}>
                <X size={14} />
              </button>
            </div>
          )}
          {api.data?.diagnostics?.map((d, i) => (
            <div className="notice" key={i}>
              {typeof d === 'string' ? d : [d.path, d.message].filter(Boolean).join(': ')}
            </div>
          ))}
          {view !== 'trash' && view !== 'recovery' && (
            <>
              <div className="toolbar">
                <div className="search">
                  <Search size={17} />
                  <input
                    aria-label="Search bookmarks"
                    placeholder="Search your library…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button aria-label="Clear search" onClick={() => setQuery('')}>
                      <X size={14} />
                    </button>
                  )}
                </div>
                <div className="sort-control">
                  <ArrowUpDown size={14} />
                  <select
                    aria-label="Sort bookmarks"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="manual">Manual order</option>
                    <option value="added">Recently added</option>
                    <option value="updated">Recently updated</option>
                    <option value="title">Title</option>
                  </select>
                </div>
                <div className="view-toggle">
                  <button
                    className={layout === 'grid' ? 'chosen' : ''}
                    aria-label="Card view"
                    onClick={() => setLayout('grid')}
                  >
                    <Grid2X2 size={16} />
                  </button>
                  <button
                    className={layout === 'list' ? 'chosen' : ''}
                    aria-label="List view"
                    onClick={() => setLayout('list')}
                  >
                    <List size={17} />
                  </button>
                </div>
              </div>
              <div className="filters">
                <input
                  aria-label="Filter tags"
                  placeholder="Filter by tags…"
                  value={tagQuery}
                  onChange={(e) => setTagQuery(e.target.value)}
                />
                <select
                  aria-label="Tag matching"
                  value={tagMode}
                  onChange={(e) => setTagMode(e.target.value)}
                >
                  <option value="all">All tags</option>
                  <option value="any">Any tag</option>
                </select>
                {current && (
                  <label>
                    <input
                      type="checkbox"
                      checked={scoped}
                      onChange={(e) => setScoped(e.target.checked)}
                    />{' '}
                    Search this collection
                  </label>
                )}
                <span className="muted">
                  {sort === 'manual' ? 'Drag to reorder · Drop on a collection to move' : ''}
                </span>
              </div>
              <BookmarkGrid
                {...{ layout, filtered, selected, setSelected, sort, setDrag, move, collections }}
                disabled={api.disabled}
                onDelete={(b) => {
                  void api.mutate({ type: 'delete', recordId: b.id, base: b });
                  if (selected === b.id) setSelected(undefined);
                }}
              />
              {!filtered.length && (
                <div className="empty">
                  <div className="empty-icon">
                    <Inbox size={28} />
                  </div>
                  <h2>
                    {query || tagQuery
                      ? 'Nothing here just yet.'
                      : (api.data?.mode === 'github' || api.mode === 'github') && !repository?.url
                        ? 'Connect your GitHub repository.'
                        : 'Make room for your next discovery.'}
                  </h2>
                  <p>
                    {query || tagQuery
                      ? 'Try another search or clear your filters.'
                      : (api.data?.mode === 'github' || api.mode === 'github') && !repository?.url
                        ? 'Connect your private data repository to store and sync your bookmarks.'
                        : 'Save a link. Give it a home. Find it when it matters.'}
                  </p>
                  {!query && !tagQuery && (
                    (api.data?.mode === 'github' || api.mode === 'github') && !repository?.url ? (
                      <button
                        className="primary"
                        onClick={() => setOpenRepository(true)}
                      >
                        <GitBranch size={16} />
                        Connect your GitHub repository
                      </button>
                    ) : (
                      <button
                        className="primary"
                        disabled={api.disabled}
                        onClick={() => setAdd(true)}
                      >
                        <Plus size={16} />
                        Save your first bookmark
                      </button>
                    )
                  )}
                </div>
              )}
            </>
          )}
          {view === 'trash' && (
            <TrashView data={api.data?.library} mutate={api.mutate} disabled={api.disabled} />
          )}
          {view === 'recovery' && (
            <RecoveryView data={api.data?.library} mutate={api.mutate} disabled={api.disabled} />
          )}
        </div>
        <div className="main-footer">
          <span>
            <GitBranch size={12} /> YOUR BOOKMARKS. YOUR FILES. YOURS.
          </span>
          <span>
            {(api.data?.mode ?? api.mode) === 'github' ? 'GitHub connected' : 'Stored locally, synced with Git'}
          </span>
        </div>
      </main>
      {item && (
        <Detail
          key={item.id}
          item={item}
          collections={collections}
          disabled={api.disabled}
          onClose={() => setSelected(undefined)}
          onSave={(patch, base) => {
            void api.mutate({ type: 'update', recordId: item.id, patch, base }).catch(() => {});
          }}
          onDelete={() => {
            void api.mutate({ type: 'delete', recordId: item.id, base: item });
            setSelected(undefined);
          }}
          onMetadata={() => api.action('/api/metadata', JSON.stringify({ recordId: item.id }))}
          onUpload={(file) => {
            const form = new FormData();
            form.set('recordId', item.id);
            form.set('file', file);
            void api.action('/api/media', form);
          }}
        />
      )}
      {add && (
        <AddBookmark
          {...{ setAdd, saveUrl, url, setUrl, adding }}
          collectionTitle={current?.title}
          disabled={api.disabled}
        />
      )}
      {importOpen && (
        <ImportBookmarks
          setImportOpen={setImportOpen}
          importCsv={importCsv}
          file={importFile}
          setFile={setImportFile}
          collectionTitle={current?.title}
          importing={importing}
          disabled={api.disabled}
        />
      )}
    </div>
  );
}
function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsText(file);
  });
}
function orderBefore(next?: string) {
  return orderBetween(undefined, next);
}
const builtinViews = new Set(['all', 'inbox', 'trash', 'recovery']);
export function parseUrlPath(pathname: string): { view: string; selected?: string } {
  const parts = pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (parts.length === 0) return { view: 'all' };
  if (parts.length === 1) {
    if (parts[0] === 'inbox') return { view: 'inbox' };
    if (parts[0] === 'trash') return { view: 'trash' };
    if (parts[0] === 'recovery') return { view: 'recovery' };
  }
  if (parts[0] === 'collections' && parts[1]) {
    const colId = parts[1];
    const view = colId === 'all' ? 'all' : colId === 'inbox' ? 'inbox' : colId;
    if (parts[2] === 'bookmarks' && parts[3]) {
      return { view, selected: parts[3] };
    }
    return { view };
  }
  if (parts[0] === 'bookmarks' && parts[1]) {
    return { view: 'all', selected: parts[1] };
  }
  if (parts[0] === 'inbox' && parts[1] === 'bookmarks' && parts[2]) {
    return { view: 'inbox', selected: parts[2] };
  }
  return { view: 'all' };
}
export function buildUrlPath(
  view: string,
  selected: string | undefined,
  item: Item | undefined,
  inboxId: string | undefined,
): string {
  if (selected && item?.kind !== 'collection' && selected !== view) {
    const colId =
      item?.parentId ||
      (!builtinViews.has(view) ? view : view === 'inbox' ? inboxId || 'inbox' : 'all');
    return `/collections/${encodeURIComponent(colId)}/bookmarks/${encodeURIComponent(selected)}`;
  }
  if (view === 'all') return '/';
  if (view === 'inbox') return '/inbox';
  if (view === 'trash') return '/trash';
  if (view === 'recovery') return '/recovery';
  return `/collections/${encodeURIComponent(view)}`;
}
