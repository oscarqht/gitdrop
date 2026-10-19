import { orderBetween, ordersBetween } from './order';
import { itemSchema, type Item } from './types';

export function parseCsvRows(text: string): Record<string, string>[] {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0]?.trim() !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0]?.trim() !== '') rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      if (headers[i]) record[headers[i]] = cells[i] ?? '';
    }
    return record;
  });
}

export interface RaindropImportOptions {
  parentId?: string | null;
  baseParentId?: string | null;
  beforeOrder?: string | null;
  actor?: string;
  existingCollections?: Item[];
  existingBookmarks?: Item[];
  preserveCollections?: boolean;
}

export interface RaindropImportEntry {
  item: Item;
  coverUrl?: string;
  folderPath?: string;
}

function importUrl(raw: string): URL | undefined {
  const value = raw.trim();
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (['http:', 'https:'].includes(url.protocol)) return url;
  } catch {
    // Invalid URLs cannot identify an imported bookmark.
  }
}

export function parseRaindropCsvWithCovers(
  text: string,
  options: RaindropImportOptions = {},
): RaindropImportEntry[] {
  const rows = parseCsvRows(text);
  if (!rows.length) throw new Error('No bookmarks found in CSV file');
  if (!Object.hasOwn(rows[0], 'url')) throw new Error('CSV file must include a url column');

  const actor = options.actor || 'local';
  const now = new Date().toISOString();
  const preserveCollections = options.preserveCollections ?? true;

  const validRows: {
    url: string;
    title: string;
    description: string;
    note: string;
    tags: string[];
    createdAt: string;
    coverUrl?: string;
    folder?: string;
  }[] = [];

  const knownUrls = new Set<string>();
  for (const item of options.existingBookmarks ?? []) {
    if (item.kind !== 'bookmark') continue;
    for (const variant of item.variants ?? []) {
      const url = importUrl(variant.url);
      if (url) knownUrls.add(url.href);
    }
  }
  let validBookmarkCount = 0;
  for (const row of rows) {
    const rawUrl = (row.url ?? '').trim();
    if (!rawUrl) continue;
    const parsedUrl = importUrl(rawUrl);
    if (!parsedUrl) continue;
    validBookmarkCount++;
    // Deduplicate before creating folders, including repeated rows in this CSV.
    if (knownUrls.has(parsedUrl.href)) continue;
    knownUrls.add(parsedUrl.href);

    const title = (row.title ?? '').trim() || parsedUrl.hostname;
    const description = (row.excerpt ?? row.description ?? '').trim();
    const rawNote = (row.note ?? '').trim();
    const rawHighlights = (row.highlights ?? '').trim();
    const note =
      rawNote && rawHighlights ? `${rawNote}\n\n${rawHighlights}` : rawNote || rawHighlights;
    const tags = [
      ...new Set(
        (row.tags ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ];
    const rawCreated = (row.created ?? '').trim();
    const parsedTime = rawCreated ? Date.parse(rawCreated) : Number.NaN;
    const createdAt = Number.isNaN(parsedTime) ? now : new Date(parsedTime).toISOString();

    let coverUrl: string | undefined;
    const rawCover = (row.cover ?? '').trim();
    if (rawCover) {
      try {
        const parsedCover = new URL(rawCover.includes('://') ? rawCover : `https://${rawCover}`);
        if (['http:', 'https:'].includes(parsedCover.protocol)) coverUrl = parsedCover.href;
      } catch {
        // Ignore invalid cover URLs
      }
    }

    validRows.push({
      url: parsedUrl.href,
      title,
      description,
      note,
      tags,
      createdAt,
      coverUrl,
      folder: (row.folder ?? '').trim(),
    });
  }

  if (!validBookmarkCount) throw new Error('No valid bookmarks found in CSV file');
  if (!validRows.length) return [];

  const colKey = (pId: string | null | undefined, title: string) =>
    `${pId ?? ''}:::${title.trim().toLowerCase()}`;

  const knownCollections = new Map<string, Item>();
  const lastSiblingOrder = new Map<string, string>();

  if (options.existingCollections) {
    for (const col of options.existingCollections) {
      if (col.kind !== 'collection') continue;
      const key = colKey(col.parentId, col.title);
      if (!knownCollections.has(key)) {
        knownCollections.set(key, col);
      }
      const pKey = col.parentId ?? '';
      const prevOrder = lastSiblingOrder.get(pKey);
      if (!prevOrder || col.order > prevOrder) {
        lastSiblingOrder.set(pKey, col.order);
      }
    }
  }

  const defaultParentId =
    options.parentId ??
    options.existingCollections?.find(
      (c) => c.kind === 'collection' && c.title.toLowerCase() === 'inbox' && c.parentId === null,
    )?.id ??
    null;

  const createdCollections: Item[] = [];

  function getOrCreateCollection(segments: string[]): string | null {
    let currentParentId: string | null = options.baseParentId ?? null;

    for (const segment of segments) {
      const key = colKey(currentParentId, segment);
      const existing = knownCollections.get(key);
      if (existing) {
        currentParentId = existing.id;
      } else {
        const id = crypto.randomUUID();
        const pKey = currentParentId ?? '';
        const prevOrder = lastSiblingOrder.get(pKey) ?? null;
        const order = orderBetween(prevOrder, null);
        lastSiblingOrder.set(pKey, order);

        const newCol = itemSchema.parse({
          id,
          kind: 'collection',
          title: segment,
          parentId: currentParentId,
          description: '',
          note: '',
          tags: [],
          order,
          cover: { mode: 'emoji', emoji: '📁' },
          createdAt: now,
          updatedAt: now,
          revision: { counter: 1, actor },
        });

        knownCollections.set(key, newCol);
        createdCollections.push(newCol);
        currentParentId = id;
      }
    }

    return currentParentId;
  }

  const rowParentIds = validRows.map((entry) => {
    const rawFolder = entry.folder ?? '';
    const isUnsorted = !rawFolder || rawFolder.toLowerCase() === 'unsorted';

    if (preserveCollections && !isUnsorted) {
      const segments = rawFolder.split(/\s+[\/\\]\s+/).map((s) => s.trim()).filter(Boolean);
      if (segments.length > 0) {
        return getOrCreateCollection(segments);
      }
    }
    return defaultParentId;
  });

  const orders = ordersBetween(validRows.length, null, options.beforeOrder ?? null);
  const variantOrder = orderBetween();

  const collectionEntries: RaindropImportEntry[] = createdCollections.map((col) => ({
    item: col,
  }));

  const bookmarkEntries: RaindropImportEntry[] = validRows.map((entry, index) => ({
    item: itemSchema.parse({
      id: crypto.randomUUID(),
      kind: 'bookmark',
      title: entry.title,
      variants: [
        {
          id: 'primary',
          name: 'Default',
          url: entry.url,
          order: variantOrder,
        },
      ],
      defaultVariantId: 'primary',
      parentId: rowParentIds[index],
      description: entry.description,
      note: entry.note,
      tags: entry.tags,
      order: orders[index],
      cover: { mode: 'automatic' },
      createdAt: entry.createdAt,
      updatedAt: now,
      revision: { counter: 1, actor },
    }),
    ...(entry.coverUrl ? { coverUrl: entry.coverUrl } : {}),
    ...(entry.folder ? { folderPath: entry.folder } : {}),
  }));

  return [...collectionEntries, ...bookmarkEntries];
}

export function parseRaindropCsv(text: string, options: RaindropImportOptions = {}): Item[] {
  return parseRaindropCsvWithCovers(text, options).map((entry) => entry.item);
}

export async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  if (!items.length) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const i = index++;
      try {
        await fn(items[i]);
      } catch {
        // Individual item errors do not stop remaining tasks
      }
    }
  });
  await Promise.all(workers);
}
