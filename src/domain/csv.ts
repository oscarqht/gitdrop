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
  beforeOrder?: string | null;
  actor?: string;
}

export interface RaindropImportEntry {
  item: Item;
  coverUrl?: string;
}

export function parseRaindropCsvWithCovers(
  text: string,
  options: RaindropImportOptions = {},
): RaindropImportEntry[] {
  const rows = parseCsvRows(text);
  if (!rows.length) throw new Error('No bookmarks found in CSV file');
  if (!Object.hasOwn(rows[0], 'url')) throw new Error('CSV file must include a url column');

  const actor = options.actor || 'local';
  const parentId = options.parentId ?? null;
  const now = new Date().toISOString();

  const validRows: {
    url: string;
    title: string;
    description: string;
    note: string;
    tags: string[];
    createdAt: string;
    coverUrl?: string;
  }[] = [];

  for (const row of rows) {
    const rawUrl = (row.url ?? '').trim();
    if (!rawUrl) continue;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) continue;

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
    });
  }

  if (!validRows.length) throw new Error('No valid bookmarks found in CSV file');

  const orders = ordersBetween(validRows.length, null, options.beforeOrder ?? null);
  const variantOrder = orderBetween();

  return validRows.map((entry, index) => ({
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
      parentId,
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
  }));
}

export function parseRaindropCsv(text: string, options: RaindropImportOptions = {}): Item[] {
  return parseRaindropCsvWithCovers(text, options).map((entry) => entry.item);
}
