import { z } from 'zod';
import { compareOrder } from './order';
import { generateKeyBetween } from 'fractional-indexing';
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id), 'Reserved ID');
const orderSchema = z.string().refine((key) => {
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}, 'Invalid order key');
export const revisionSchema = z.object({
  counter: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  actor: z.string().min(1),
});
export type Revision = z.infer<typeof revisionSchema>;
export const coverSchema = z
  .object({
    mode: z.enum(['automatic', 'image', 'emoji', 'none']),
    emoji: z.string().optional(),
    imageFile: z.string().optional(),
    imageHash: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  })
  .superRefine((cover, ctx) => {
    if (
      cover.mode === 'emoji' &&
      (!cover.emoji ||
        !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(cover.emoji) ||
        [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(cover.emoji)]
          .length !== 1)
    )
      ctx.addIssue({ code: 'custom', message: 'Choose one complete emoji' });
    if (cover.mode === 'image' && !cover.imageFile)
      ctx.addIssue({ code: 'custom', message: 'Image cover requires a filename' });
    if (
      cover.imageFile &&
      (cover.imageFile.includes('/') ||
        cover.imageFile.includes('\\') ||
        cover.imageFile === '..' ||
        cover.imageFile === '.' ||
        /[\x00-\x1f:]/.test(cover.imageFile))
    )
      ctx.addIssue({ code: 'custom', message: 'Cover must be a sibling filename' });
  });
export const variantSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
  order: orderSchema,
  url: z.string().refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Variants require an HTTP or HTTPS URL'),
});
export type URLVariant = z.infer<typeof variantSchema>;
export const itemSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['bookmark', 'collection']),
    title: z.string(),
    parentId: idSchema.nullable(),
    variants: z.array(variantSchema).optional(),
    defaultVariantId: idSchema.optional(),
    description: z.string(),
    note: z.string(),
    tags: z.array(z.string()),
    order: orderSchema,
    cover: coverSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    revision: revisionSchema,
    fieldRevisions: z.record(z.string(), revisionSchema).optional(),
    metadata: z
      .object({
        title: z.object({ value: z.string(), revision: revisionSchema }).optional(),
        description: z.object({ value: z.string(), revision: revisionSchema }).optional(),
      })
      .optional(),
  })
  .superRefine((item, ctx) => {
    if (item.kind === 'bookmark') {
      if (!item.variants?.length)
        ctx.addIssue({
          code: 'custom',
          path: ['variants'],
          message: 'Bookmarks require at least one URL variant',
        });
      if (!item.variants?.some((v) => v.id === item.defaultVariantId))
        ctx.addIssue({
          code: 'custom',
          path: ['defaultVariantId'],
          message: 'Default variant must exist',
        });
      if (new Set(item.variants?.map((v) => v.id)).size !== item.variants?.length)
        ctx.addIssue({ code: 'custom', path: ['variants'], message: 'Variant IDs must be unique' });
    }
  });
export type Item = z.infer<typeof itemSchema>;
export type Cover = Item['cover'];
export interface Tombstone {
  id: string;
  revision: Revision;
  deletedAt: string;
  purgedRevision?: Revision;
  restoredRevision?: Revision;
  record?: Item;
}
export interface Recovery {
  id: string;
  recordId: string;
  reason: string;
  record: Item;
  createdAt: string;
}
export interface Library {
  schemaVersion: 1;
  records: Record<string, Item>;
  tombstones: Record<string, Tombstone>;
  recovery: Record<string, Recovery>;
  appliedOperations: string[];
  clearedRecovery?: Record<string, Revision>;
  diagnostics?: string[];
}
export interface Operation {
  id: string;
  actor: string;
  type: 'create' | 'update' | 'delete' | 'restore' | 'purge' | 'clearRecovery';
  recordId?: string;
  record?: Item;
  patch?: Partial<Item>;
  base?: Item;
  baseRecords?: Item[];
}
export const librarySchema = z.object({
  schemaVersion: z.literal(1),
  records: z.record(idSchema, itemSchema),
  tombstones: z.record(
    idSchema,
    z.object({
      id: idSchema,
      revision: revisionSchema,
      deletedAt: z.string(),
      purgedRevision: revisionSchema.optional(),
      restoredRevision: revisionSchema.optional(),
      record: itemSchema.optional(),
    }),
  ),
  recovery: z.record(
    idSchema,
    z.object({
      id: idSchema,
      recordId: idSchema,
      reason: z.string(),
      record: itemSchema,
      createdAt: z.string(),
    }),
  ),
  appliedOperations: z.array(z.string()),
  clearedRecovery: z.record(idSchema, revisionSchema).optional(),
  diagnostics: z.array(z.string()).optional(),
});
export function validateLibrary(value: unknown): Library {
  const parsed = librarySchema.parse(value);
  for (const items of [parsed.records, parsed.tombstones, parsed.recovery])
    for (const [key, item] of Object.entries(items))
      if (key !== item.id) throw new Error('Record key must match its ID');
  return parsed;
}
export function compareRevision(a: Revision, b: Revision): number {
  return a.counter - b.counter || (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0);
}
export function clone<T>(value: T): T {
  return structuredClone(value);
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export const editableFields = [
  'title',
  'parentId',
  'variants',
  'defaultVariantId',
  'description',
  'note',
  'tags',
  'order',
  'cover',
] as const;

export function primaryVariant(item: Item): URLVariant | undefined {
  return item.variants?.find((v) => v.id === item.defaultVariantId) ?? sortedVariants(item)[0];
}

export function sortedVariants(item: Item): URLVariant[] {
  return [...(item.variants ?? [])].sort(compareOrder);
}
