'use client';
import { Copy, Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
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
  collections?: Item[];
  onDelete?: (item: Item) => void;
};
const GRID_ROW_HEIGHT = 296;
const GRID_ROW_GAP = 21;
const LIST_ROW_HEIGHT = 114;
const LIST_ROW_GAP = 10;
const DEFAULT_GRID_COLUMNS = 4;
const OVERSCAN_ROWS = 2;

export function BookmarkGrid({
  layout,
  filtered,
  selected,
  setSelected,
  sort,
  disabled,
  setDrag,
  move,
  onDelete,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800,
  );
  const [columns, setColumns] = useState(DEFAULT_GRID_COLUMNS);
  const [measuredHeight, setMeasuredHeight] = useState<{ grid?: number; list?: number }>({});

  const updateMetrics = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const vh =
      (typeof window !== 'undefined' && window.innerHeight) ||
      (typeof document !== 'undefined' && document.documentElement?.clientHeight) ||
      800;
    const winScrollY =
      (typeof window !== 'undefined' && (window.scrollY || window.pageYOffset)) ||
      (typeof document !== 'undefined' && document.documentElement?.scrollTop) ||
      0;
    const rect = container.getBoundingClientRect();
    const hasLayoutRect = rect.width > 0 || rect.height > 0 || rect.top !== 0 || rect.bottom !== 0;
    const relativeScrollTop = hasLayoutRect ? -rect.top : winScrollY - (container.offsetTop || 0);
    const nextScrollTop = Math.max(0, relativeScrollTop, container.scrollTop || 0);

    setViewportHeight((prev) => (prev === vh ? prev : vh));
    setScrollTop((prev) => (Math.abs(prev - nextScrollTop) < 1 ? prev : nextScrollTop));

    if (layout === 'grid') {
      let nextCols = DEFAULT_GRID_COLUMNS;
      const computedCols =
        typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
          ? window.getComputedStyle(container).gridTemplateColumns
          : '';
      if (computedCols && /^\d+(\.\d+)?px(\s+\d+(\.\d+)?px)*$/.test(computedCols.trim())) {
        nextCols = computedCols.trim().split(/\s+/).length;
      } else {
        const width = container.clientWidth || rect.width;
        if (width > 0) {
          const winW = (typeof window !== 'undefined' && window.innerWidth) || width;
          if (winW <= 360) nextCols = 1;
          else if (winW <= 760) nextCols = 2;
          else {
            const minW = winW >= 1500 ? 260 : 230;
            nextCols = Math.max(1, Math.floor((width + GRID_ROW_GAP) / (minW + GRID_ROW_GAP)));
          }
        }
      }
      setColumns((prev) => (prev === nextCols ? prev : nextCols));
    }

    const firstCard = container.querySelector<HTMLElement>('.bookmark');
    if (firstCard) {
      const cardHeight = Math.round(firstCard.getBoundingClientRect().height);
      if (cardHeight > 40) {
        setMeasuredHeight((prev) => {
          const current = prev[layout];
          if (current !== undefined && Math.abs(current - cardHeight) <= 2) return prev;
          return { ...prev, [layout]: cardHeight };
        });
      }
    }
  }, [layout]);

  useEffect(() => {
    updateMetrics();
    window.addEventListener('scroll', updateMetrics, { passive: true });
    window.addEventListener('resize', updateMetrics);
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updateMetrics()) : undefined;
    if (observer && containerRef.current) observer.observe(containerRef.current);
    return () => {
      window.removeEventListener('scroll', updateMetrics);
      window.removeEventListener('resize', updateMetrics);
      observer?.disconnect();
    };
  }, [updateMetrics, filtered.length]);

  const effectiveColumns = layout === 'list' ? 1 : Math.max(1, columns);
  const rowGap = layout === 'list' ? LIST_ROW_GAP : GRID_ROW_GAP;
  const rowHeight =
    (layout === 'list' ? measuredHeight.list : measuredHeight.grid) ??
    (layout === 'list' ? LIST_ROW_HEIGHT : GRID_ROW_HEIGHT);
  const rowStride = rowHeight + rowGap;
  const totalItems = filtered.length;
  const totalRows = Math.ceil(totalItems / effectiveColumns);
  const visibleRowCount = Math.max(1, Math.ceil(viewportHeight / rowStride) + 1);
  const maxFirstRow = Math.max(0, totalRows - visibleRowCount);
  const firstVisibleRow = Math.min(maxFirstRow, Math.max(0, Math.floor(scrollTop / rowStride)));
  const startRow = Math.max(0, firstVisibleRow - OVERSCAN_ROWS);
  const endRow = Math.min(totalRows, firstVisibleRow + visibleRowCount + OVERSCAN_ROWS);
  const startIndex = startRow * effectiveColumns;
  const endIndex = Math.min(totalItems, endRow * effectiveColumns);
  const visibleBookmarks = filtered.slice(startIndex, endIndex);
  const paddingTop = startRow * rowStride;
  const paddingBottom = Math.max(0, totalRows - endRow) * rowStride;

  return (
    <div
      ref={containerRef}
      className={`bookmarks ${layout}`}
      onScroll={updateMetrics}
      style={paddingTop || paddingBottom ? { paddingTop, paddingBottom } : undefined}
    >
      {visibleBookmarks.map((b) => (
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
          <div className="bookmark-actions">
            <button
              type="button"
              className="icon-button"
              title="Copy link"
              aria-label="Copy link"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const url = primaryVariant(b)?.url;
                if (url) void navigator.clipboard?.writeText(url);
              }}
            >
              <Copy size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Edit"
              aria-label="Edit"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSelected(b.id);
              }}
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              className="icon-button danger"
              title="Delete"
              aria-label="Delete"
              disabled={disabled}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (confirm('Move this bookmark to trash?')) onDelete?.(b);
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <a
            className="bookmark-main"
            href={primaryVariant(b)?.url}
            target="_blank"
            rel="noreferrer"
          >
            <Cover item={b} />
            <div className="bookmark-info">
              <div className="domain">{hostname(primaryVariant(b)?.url)}</div>
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
          </a>
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
