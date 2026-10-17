import { randomUUID } from 'node:crypto';
import { archiveStream } from './archive';
import { z } from 'zod';
import {
  idSchema,
  itemSchema,
  coverSchema,
  compareRevision,
  type Operation,
  type Item,
} from '../domain/types';
import { getStore, LocalStore, GitHubStore } from '../storage';
import { handler, json, readBody, readJson, snapshot } from './http';
import {
  HttpError,
  hosted,
  oauthStart,
  oauthCallback,
  requireAccess,
  sessionCookie,
  sessionScope,
} from './auth';
import { fetchMetadata, optimizeImage } from './metadata';
import { exportHtml } from './export';
import { startSyncWorker, syncNow } from './sync-worker';
import { repositoryUrl } from '../storage/repository';

const operationSchema = z
  .object({
    id: idSchema,
    actor: z.string().min(1).max(200),
    type: z.enum(['create', 'update', 'delete', 'restore', 'purge', 'clearRecovery']),
    recordId: idSchema.optional(),
    record: itemSchema.optional(),
    base: itemSchema.optional(),
    baseRecords: z.array(itemSchema).max(50000).optional(),
    patch: z
      .object({
        title: z.string().max(10000).optional(),
        parentId: idSchema.nullable().optional(),
        description: z.string().max(100000).optional(),
        note: z.string().max(500000).optional(),
        tags: z.array(z.string().max(200)).max(1000).optional(),
        order: z.string().max(500).optional(),
        cover: coverSchema.optional(),
        variants: z
          .array(
            z.object({
              id: idSchema,
              name: z.string().trim().min(1).max(500),
              url: z.string().max(10000),
              order: z.string().max(500),
            }),
          )
          .min(1)
          .max(1000)
          .optional(),
        defaultVariantId: idSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const initialized = new WeakMap<LocalStore, Promise<unknown>>();
export const libraryGet = handler(async (request) => {
  const store = getStore();
  const known = new URL(request.url).searchParams.get('revision');
  if (
    store instanceof GitHubStore &&
    known &&
    /^[a-f0-9]{40}$/.test(known) &&
    (await store.currentRevision()) === known
  )
    return json({ unchanged: true, revision: known, mode: 'github' });
  if (store instanceof LocalStore) {
    if (!initialized.has(store))
      initialized.set(
        store,
        store.initialize().catch((error) => {
          initialized.delete(store);
          throw error;
        }),
      );
    await initialized.get(store);
  }
  const data = await store.read();
  startSyncWorker();
  return snapshot(data);
});
export const operationPost = handler(async (request) => {
  const op = operationSchema.parse(await readJson(request, 20_000_000)) as Operation;
  if (op.base && op.base.id !== op.recordId)
    throw new HttpError(400, 'Base record ID must match the operation.');
  if (op.record && op.recordId && op.record.id !== op.recordId)
    throw new HttpError(400, 'Record IDs must match.');
  return snapshot(await (await getStore()).mutate(op));
}, true);
export const syncPost = handler(async () => snapshot(await syncNow()), true);
export const repositoryGet = handler(async () => {
  const store = getStore();
  if (hosted() || !(store instanceof LocalStore))
    throw new HttpError(
      400,
      'Repository setup is available in local mode. Hosted repositories use server environment settings.',
    );
  return json(await store.repository());
});
export const repositoryPost = handler(async (request) => {
  if (hosted() || !(getStore() instanceof LocalStore))
    throw new HttpError(
      400,
      'Repository setup is available in local mode. Hosted repositories use server environment settings.',
    );
  const { url } = z
    .object({ url: z.string().max(2048) })
    .strict()
    .parse(await readJson(request, 4096));
  const validated = repositoryUrl(url);
  try {
    return snapshot(await syncNow(validated));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection failed.';
    throw new HttpError(
      400,
      `${message}. The repository URL is saved once configured; retry here or use Sync now. Check Git access on the server if needed.`,
    );
  }
}, true);
export const metadataPost = handler(async (request) => {
  const { recordId } = z.object({ recordId: idSchema }).parse(await readJson(request));
  const store = await getStore();
  const initial = await store.read();
  const original = initial.library.records[recordId];
  if (!original || original.kind !== 'bookmark') throw new HttpError(404, 'Bookmark not found.');
  const variant =
    original.variants?.find((v) => v.id === original.defaultVariantId) || original.variants?.[0];
  if (!variant) throw new HttpError(400, 'Bookmark requires a URL variant.');
  const result = await fetchMetadata(variant.url);
  const current = await store.read();
  const item = current.library.records[recordId];
  if (!item) throw new HttpError(409, 'Bookmark was deleted while fetching metadata.');
  const selected = item.variants?.find((v) => v.id === item.defaultVariantId) || item.variants?.[0];
  if (selected?.url !== variant.url || selected?.id !== variant.id) return snapshot(current);
  const patch: Partial<Item> = {};
  const fallback = new URL(variant.url).hostname;
  const eligible = (field: 'title' | 'description') => {
    const marker = item.metadata?.[field];
    const revision = item.fieldRevisions?.[field];
    return (
      !!marker &&
      !!revision &&
      marker.value === item[field] &&
      compareRevision(marker.revision, revision) === 0
    );
  };
  if (
    result.title &&
    item.title === original.title &&
    (!item.title || item.title === fallback || item.title === variant.url || eligible('title'))
  )
    patch.title = result.title;
  if (
    result.description &&
    item.description === original.description &&
    (!item.description || eligible('description'))
  )
    patch.description = result.description;
  if (Object.keys(patch).length)
    await store.mutate({
      id: randomUUID(),
      actor: 'metadata',
      type: 'update',
      recordId,
      base: item,
      patch,
    });
  let next = await store.read();
  if (result.cover && next.library.records[recordId]?.cover.mode === 'automatic')
    next = await store.writeMedia(recordId, result.cover, 'automatic');
  return json({ ...next, mode: hosted() ? 'github' : 'local', warning: result.warning });
}, true);
export const mediaGet = handler(async (request) => {
  const id = idSchema.parse(new URL(request.url).searchParams.get('recordId'));
  const store = getStore();
  const hash = new URL(request.url).searchParams.get('hash');
  if (hash && !/^[a-f0-9]{40}$/.test(hash)) throw new HttpError(400, 'Invalid image hash.');
  const image =
    hash && store instanceof GitHubStore
      ? await store.readMediaByHash(hash)
      : await store.readMedia(id);
  if (!image) throw new HttpError(404, 'Cover not found.');
  return new Response(new Uint8Array(image), {
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control':
        hash && store instanceof GitHubStore
          ? 'private, max-age=3600, immutable'
          : 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
export const mediaPost = handler(async (request) => {
  const bytes = await readBody(request, 8_200_000);
  const data = await new Response(new Uint8Array(bytes), {
    headers: { 'Content-Type': request.headers.get('Content-Type') || '' },
  }).formData();
  const id = idSchema.parse(data.get('recordId'));
  const file = data.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'An image file is required.');
  return snapshot(
    await (
      await getStore()
    ).writeMedia(id, await optimizeImage(Buffer.from(await file.arrayBuffer()))),
  );
}, true);
export const exportGet = handler(async (request) => {
  const store = await getStore();
  const format = new URL(request.url).searchParams.get('format');
  if (format === 'html')
    return new Response(exportHtml((await store.read()).library), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="gitdrop-bookmarks.html"',
        'Cache-Control': 'no-store',
      },
    });
  if (format !== 'zip') throw new HttpError(400, 'Choose html or zip export.');
  return new Response(archiveStream(store), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="gitdrop-library.zip"',
      'Cache-Control': 'no-store',
    },
  });
});
export const sessionGet = handler(
  async (request) => {
    try {
      requireAccess(request);
      return json({
        authenticated: true,
        scope: sessionScope(),
        mode: hosted() ? 'github' : 'local',
        loginUrl: '/api/auth/login',
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 401)
        return json({ authenticated: false, mode: 'github', loginUrl: '/api/auth/login' });
      throw e;
    }
  },
  false,
  false,
);
export const loginGet = handler(async (request) => oauthStart(request), false, false);
export const callbackGet = handler(oauthCallback, false, false);
export const logoutPost = handler(
  async () =>
    new Response(null, {
      status: 204,
      headers: {
        'Set-Cookie': sessionCookie('gitdrop-session', '', 0),
        'Cache-Control': 'no-store',
        'Clear-Site-Data': '"cache", "storage"',
      },
    }),
  true,
);
