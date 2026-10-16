import { compareOrder } from './order';
import type { Item, Library } from './types';
export interface SearchOptions {
  query?: string;
  collectionId?: string;
  descendants?: boolean;
  tags?: string[];
  tagMode?: 'all' | 'any';
  sort?: 'manual' | 'title' | 'created' | 'updated';
}
export function searchBookmarks(library: Library, options: SearchOptions = {}): Item[] {
  const parents = new Set(options.collectionId ? [options.collectionId] : []);
  if (options.descendants && parents.size) {
    let added = true;
    while (added) {
      added = false;
      for (const item of Object.values(library.records))
        if (
          item.kind === 'collection' &&
          item.parentId &&
          parents.has(item.parentId) &&
          !parents.has(item.id)
        ) {
          parents.add(item.id);
          added = true;
        }
    }
  }
  const words = (options.query ?? '').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return Object.values(library.records)
    .filter((item) => {
      if (item.kind !== 'bookmark' || (parents.size && !parents.has(item.parentId ?? '')))
        return false;
      const text = [
        item.title,
        ...(item.variants ?? []).flatMap((v) => [v.name, v.url]),
        item.description,
        item.note,
      ]
        .join('\n')
        .toLocaleLowerCase();
      if (!words.every((word) => text.includes(word))) return false;
      const tags = options.tags ?? [];
      return (
        !tags.length ||
        (options.tagMode === 'any'
          ? tags.some((t) => item.tags.includes(t))
          : tags.every((t) => item.tags.includes(t)))
      );
    })
    .sort((a, b) =>
      options.sort === 'title'
        ? a.title.localeCompare(b.title) || compareOrder(a, b)
        : options.sort === 'created'
          ? b.createdAt.localeCompare(a.createdAt) || compareOrder(a, b)
          : options.sort === 'updated'
            ? b.updatedAt.localeCompare(a.updatedAt) || compareOrder(a, b)
            : compareOrder(a, b),
    );
}
