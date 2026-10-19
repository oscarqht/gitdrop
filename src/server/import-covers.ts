import { z } from 'zod';
import { idSchema } from '../domain/types';
import { getStore, GitHubStore } from '../storage';
import { hosted } from './auth';
import { handler, json, readJson } from './http';
import { resolveGitHubCredentials } from './routes';
import { fetchCover, fetchMetadata } from './metadata';
import type { CoverStatus } from '../client/import-job';

export const importCoversPost = handler(async (request) => {
  const { entries } = z
    .object({
      entries: z
        .array(
          z
            .object({
              recordId: idSchema,
              coverUrl: z.string().url().max(10000).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(4),
    })
    .strict()
    .parse(await readJson(request, 60000));
  const store = getStore(resolveGitHubCredentials(request));
  const initial = await store.read();
  const downloads: { id: string; url: string; data: Buffer }[] = [];
  const outcomes = await Promise.all(
    entries.map(async ({ recordId, coverUrl }) => {
      const item = initial.library.records[recordId];
      const variant =
        item?.variants?.find((v) => v.id === item.defaultVariantId) || item?.variants?.[0];
      const result = (status: CoverStatus, error?: string) => ({
        recordId,
        status,
        error,
      });
      if (!item || item.kind !== 'bookmark' || item.cover.mode !== 'automatic' || !variant)
        return result('unavailable');
      if (item.cover.imageHash) return result('fetched');
      try {
        let data: Buffer | undefined;
        if (coverUrl) {
          try {
            data = await fetchCover(coverUrl);
          } catch {
            /* Try the page's cover instead. */
          }
        }
        if (!data) {
          const metadata = await fetchMetadata(variant.url);
          if (metadata.warning) return result('failed', metadata.warning);
          data = metadata.cover;
        }
        if (!data) return result('unavailable');
        downloads.push({ id: recordId, url: variant.url, data });
        return result('fetched');
      } catch {
        return result('failed', 'Could not fetch this cover. Retry when the site is available.');
      }
    }),
  );
  let next = initial;
  if (!downloads.length) next = await store.read();
  if (downloads.length) {
    if (store instanceof GitHubStore) next = await store.writeImportCovers(downloads);
    else
      for (const cover of downloads) {
        const current = (await store.read()).library.records[cover.id];
        const variant =
          current?.variants?.find((v) => v.id === current.defaultVariantId) ||
          current?.variants?.[0];
        if (
          current?.cover.mode === 'automatic' &&
          !current.cover.imageHash &&
          variant?.url === cover.url
        )
          next = await store.writeMedia(cover.id, cover.data, 'automatic');
      }
  }
  // A bookmark may have been edited or removed during the fetch. Don't report its image as saved.
  for (const outcome of outcomes)
    if (outcome.status === 'fetched' && !next.library.records[outcome.recordId]?.cover.imageHash)
      outcome.status = 'unavailable';
  return json({
    ...next,
    mode: hosted() ? 'github' : 'local',
    coverOutcomes: outcomes,
  });
}, true);
