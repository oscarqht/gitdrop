import type { Item, Library } from '../domain/types';
import { compareOrder } from '../domain/order';
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function exportHtml(library: Library): string {
  const visited = new Set<string>();
  function branch(parentId: string | null): string {
    return Object.values(library.records)
      .filter((i) => i.parentId === parentId)
      .sort(compareOrder)
      .map((item) => {
        if (visited.has(item.id)) return '';
        visited.add(item.id);
        if (item.kind === 'collection')
          return `<DT><H3>${escape(item.title)}</H3>\n<DL><p>\n${branch(item.id)}</DL><p>\n`;
        return links(item);
      })
      .join('');
  }
  function links(item: Item) {
    return (item.variants || [])
      .slice()
      .sort((a, b) => a.order.localeCompare(b.order) || a.id.localeCompare(b.id))
      .map(
        (v) =>
          `<DT><A HREF="${escape(v.url)}" TAGS="${escape(item.tags.join(','))}">${escape(item.title)}${(item.variants?.length || 0) > 1 ? ` — ${escape(v.name)}` : ''}</A>\n`,
      )
      .join('');
  }
  return (
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Gitdrop bookmarks</TITLE>\n<H1>Gitdrop bookmarks</H1>\n<DL><p>\n' +
    branch(null) +
    '</DL><p>\n'
  );
}
