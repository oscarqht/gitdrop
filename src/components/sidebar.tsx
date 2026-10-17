'use client';
import {
  Plus,
  Inbox,
  Layers,
  Trash2,
  History,
  ChevronRight,
  Download,
  GitBranch,
  X,
  LogOut,
} from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { Item } from '../domain/types';
import type { useLibrary } from '../client/use-library';
import { RepositorySetup } from './repository-setup';
export const builtins = [
  { id: 'all', name: 'All bookmarks', icon: Layers },
  { id: 'inbox', name: 'Inbox', icon: Inbox },
  { id: 'trash', name: 'Trash', icon: Trash2 },
  { id: 'recovery', name: 'Recovery', icon: History },
];
type Props = {
  api: ReturnType<typeof useLibrary>;
  drawer: boolean;
  setDrawer: Dispatch<SetStateAction<boolean>>;
  setAdd: Dispatch<SetStateAction<boolean>>;
  view: string;
  navigate: (id: string) => void;
  bookmarks: Item[];
  collections: Item[];
  createCollection: () => Promise<void>;
  collapsed: Set<string>;
  setCollapsed: Dispatch<SetStateAction<Set<string>>>;
  setDrag: Dispatch<SetStateAction<string | undefined>>;
  move: (target: Item, asChild?: boolean) => void;
};
export function Sidebar({
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
}: Props) {
  function tree(parent: string | null, depth = 0, seen = new Set<string>()): React.ReactNode {
    return collections
      .filter((c) => (c.parentId || null) === parent && !seen.has(c.id))
      .map((c) => (
        <div key={c.id}>
          <div
            className={`collection-row ${view === c.id ? 'active' : ''}`}
            style={{ paddingLeft: 12 + depth * 15 }}
            draggable={!api.disabled}
            onDragStart={(e) => {
              setDrag(c.id);
              e.dataTransfer.setData('text/plain', c.id);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              move(c, !e.shiftKey);
            }}
          >
            <button
              className="tree-chevron"
              aria-label={`Toggle ${c.title}`}
              onClick={() =>
                setCollapsed((old) => {
                  const n = new Set(old);
                  n.has(c.id) ? n.delete(c.id) : n.add(c.id);
                  return n;
                })
              }
            >
              <ChevronRight size={12} className={collapsed.has(c.id) ? '' : 'expanded'} />
            </button>
            <button className="collection-link" onClick={() => navigate(c.id)}>
              <span>{c.cover.mode === 'emoji' ? c.cover.emoji : '▧'}</span>
              <span className="ellipsis">{c.title}</span>
              <small>{bookmarks.filter((b) => b.parentId === c.id).length || ''}</small>
            </button>
          </div>
          {!collapsed.has(c.id) && tree(c.id, depth + 1, new Set([...seen, c.id]))}
        </div>
      ));
  }
  return (
    <aside className={`sidebar ${drawer ? 'open' : ''}`}>
      <div className="brand">
        <div className="brand-mark">
          <GitBranch size={21} />
        </div>
        <strong>
          gitdrop<span>personal library</span>
        </strong>
        <button
          className="mobile-only icon-button"
          aria-label="Close navigation"
          onClick={() => setDrawer(false)}
        >
          <X size={18} />
        </button>
      </div>
      <button className="quick-add" disabled={api.disabled} onClick={() => setAdd(true)}>
        <Plus size={17} /> Save a bookmark <kbd>＋</kbd>
      </button>
      <nav>
        {builtins.map(({ id, name, icon: Icon }) => (
          <button
            className={`nav-item ${view === id ? 'active' : ''}`}
            key={id}
            onClick={() => navigate(id)}
          >
            <Icon size={17} />
            <span>{name}</span>
            {id === 'all' && <small>{bookmarks.length}</small>}
          </button>
        ))}
      </nav>
      <div className="sidebar-label">
        <span>COLLECTIONS</span>
        <button
          className="icon-button"
          aria-label="New collection"
          disabled={api.disabled}
          onClick={createCollection}
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="collection-hint">Drop to nest · Shift-drop to reorder</div>
      <div className="collection-tree">{tree(null)}</div>
      <div className="sidebar-bottom">
        {api.data?.mode === 'local' && <RepositorySetup api={api} />}
        {api.data?.mode === 'github' && (
          <div className="repository">
            <GitBranch size={15} />
            <span>
              Private repository
              <small>Connected through GitHub</small>
            </span>
            <span className="green-dot" />
          </div>
        )}
        <div className="sidebar-tools">
          <a href="/api/export?format=zip" title="Export library ZIP">
            <Download size={15} /> Export
          </a>
          <a href="/api/export?format=html" title="Export bookmarks HTML">
            HTML
          </a>
          {api.data?.mode === 'github' && (
            <button aria-label="Sign out" onClick={api.logout}>
              <LogOut size={15} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
