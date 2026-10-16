'use client';
import { ArrowUpRight } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { primaryVariant, type Item } from '../domain/types';
import { Cover } from './cover';
type Props = {
  layout: 'grid' | 'list';
  filtered: Item[];
  selected?: string;
  setSelected: Dispatch<SetStateAction<string | undefined>>;
  sort: string;
  disabled: boolean;
  setDrag: Dispatch<SetStateAction<string | undefined>>;
  move: (item: Item) => void;
  collections: Item[];
};
export function BookmarkGrid({
  layout,
  filtered,
  selected,
  setSelected,
  sort,
  disabled,
  setDrag,
  move,
  collections,
}: Props) {
  return (
    <div className={`bookmarks ${layout}`}>
      {filtered.map((b) => (
        <article
          key={b.id}
          className={`bookmark ${selected === b.id ? 'selected' : ''}`}
          draggable={!disabled && sort === 'manual'}
          onDragStart={(e) => {
            setDrag(b.id);
            e.dataTransfer.setData('text/plain', b.id);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (sort === 'manual') move(b);
          }}
        >
          <button className="bookmark-main" onClick={() => setSelected(b.id)}>
            <Cover item={b} />
            <div className="bookmark-info">
              <div className="domain">
                {hostname(primaryVariant(b)?.url)}
                <ArrowUpRight size={12} />
              </div>
              <h3>{b.title}</h3>
              {(b.variants?.length || 0) > 1 && (
                <small className="variant-count">{b.variants?.length} links</small>
              )}
              <p>{b.description || 'A good find, saved for later.'}</p>
              <div className="tags">
                {b.tags.slice(0, 3).map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            </div>
          </button>
          <footer>
            <span>{collections.find((c) => c.id === b.parentId)?.title || 'Unfiled'}</span>
            <a href={primaryVariant(b)?.url} target="_blank" rel="noreferrer" title="Open bookmark">
              <ArrowUpRight size={15} />
            </a>
          </footer>
        </article>
      ))}
    </div>
  );
}
function hostname(url?: string) {
  try {
    return new URL(url || '').hostname.replace(/^www\./, '');
  } catch {
    return 'Bookmark';
  }
}
